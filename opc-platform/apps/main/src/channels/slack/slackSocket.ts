import type { Agent } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';
import { SocksProxyAgent } from 'socks-proxy-agent';
import WebSocket, { type RawData } from 'ws';

export interface SlackSocketEnvelope {
  type?: string;
  envelope_id?: string;
  reason?: string;
  payload?: {
    event?: Record<string, unknown>;
  };
}

export interface SlackSocketHooks {
  openUrl: () => Promise<string>;
  onConnected: () => void;
  onReconnecting: () => void;
  onError: (message: string) => void;
  onEvent: (event: Record<string, unknown>) => Promise<void>;
}

const PING_INTERVAL_MS = 30_000;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

function createProxyAgent(wssUrl: string): Agent | undefined {
  const httpEquivalent = wssUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
  const proxyUrl = getProxyForUrl(httpEquivalent);
  if (!proxyUrl) return undefined;
  if (/^socks/i.test(proxyUrl)) {
    return new SocksProxyAgent(proxyUrl);
  }
  return new HttpsProxyAgent(proxyUrl);
}

/**
 * Lightweight Slack Socket Mode client supporting HTTP/HTTPS/SOCKS5 proxies via
 * `proxy-from-env`, fast `envelope_id` ACKs (< 5ms), `refresh_requested` rotation,
 * and exponential backoff.
 */
export class SlackSocketClient {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private alive = false;
  private stopped = false;
  private attempts = 0;

  constructor(private readonly hooks: SlackSocketHooks) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.attempts = 0;
    await this.connectOnce();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownSocket();
  }

  private teardownSocket(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        if (
          this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING
        ) {
          this.ws.terminate();
        }
      } catch {
        // Ignore teardown errors when terminating socket.
      }
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.hooks.onReconnecting();
    const delay = Math.min(
      BASE_BACKOFF_MS * 2 ** this.attempts + Math.floor(Math.random() * 500),
      MAX_BACKOFF_MS,
    );
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      void this.connectOnce().catch((err) => {
        if (this.stopped) return;
        this.hooks.onError(err instanceof Error ? err.message : String(err));
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async connectOnce(): Promise<void> {
    this.teardownSocket();
    const url = await this.hooks.openUrl();
    if (this.stopped) return;

    await new Promise<void>((resolve, reject) => {
      const agent = createProxyAgent(url);
      const ws = new WebSocket(url, agent ? { agent } : undefined);
      this.ws = ws;
      let settled = false;

      ws.on('open', () => {
        if (this.ws !== ws) return;
        this.alive = true;
        this.pingTimer = setInterval(() => {
          if (this.ws !== ws) return;
          if (!this.alive) {
            ws.terminate();
            return;
          }
          this.alive = false;
          ws.ping();
        }, PING_INTERVAL_MS);
        this.pingTimer.unref?.();
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on('pong', () => {
        if (this.ws !== ws) return;
        this.alive = true;
      });

      ws.on('message', (raw: RawData) => {
        if (this.ws !== ws) return;
        this.handleFrame(ws, raw.toString('utf8'));
      });

      ws.on('close', () => {
        if (this.ws !== ws) return;
        this.teardownSocket();
        if (!this.stopped) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err) => {
        if (this.ws !== ws) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (!settled) {
          settled = true;
          reject(err);
        } else {
          this.hooks.onError(msg);
        }
      });
    });
  }

  private handleFrame(ws: WebSocket, rawText: string): void {
    let frame: SlackSocketEnvelope;
    try {
      frame = JSON.parse(rawText) as SlackSocketEnvelope;
    } catch {
      return;
    }

    if (frame.type === 'hello') {
      this.attempts = 0;
      this.hooks.onConnected();
      return;
    }

    if (frame.type === 'disconnect') {
      if (frame.reason === 'link_disabled') {
        this.stop();
        this.hooks.onError('Socket Mode 已在 Slack 应用后台被关闭，请重新开启后重连');
        return;
      }
      // refresh_requested / warning: proactively cycle socket immediately.
      this.teardownSocket();
      if (!this.stopped) {
        this.attempts = 0;
        this.hooks.onReconnecting();
        void this.connectOnce().catch(() => {
          this.scheduleReconnect();
        });
      }
      return;
    }

    if (frame.type === 'events_api') {
      if (frame.envelope_id && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));
      }
      const event = frame.payload?.event;
      if (event && typeof event === 'object') {
        void this.hooks.onEvent(event).catch((err) => {
          console.warn('[channels:slack] 处理入站事件失败', err);
        });
      }
    }
  }
}
