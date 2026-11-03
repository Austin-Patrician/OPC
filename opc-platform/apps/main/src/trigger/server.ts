import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TriggerSource } from '@opc/shared/domain';
import type { TriggerRegistry, TriggerOutcome } from './registry';
import type { NormalizedTrigger } from './types';

/**
 * 本机的触发入口。
 *
 * 只监听 `127.0.0.1`：这是一个**本机应用里的一扇门**，不是对外服务。GitHub / 飞书 /
 * 钉钉都在公网上，所以真正把它接起来还需要一条隧道（`cloudflared`、`ngrok` 或你自己的
 * 反代）。我们不做的事就不假装做了——但门是真的：签名校验、归一、去重、开线，全都在
 * 这条路径上，一条 `curl` 就能验完。
 *
 * 正文上限 1 MiB。webhook 正文平时只有几 KB，但一个 push 带几百个 commit、一个 PR 带
 * 一整篇 markdown 的时候会突然变大；没有上限的"先全读进来"就是一个能被外部撑爆的
 * 内存漏洞。
 */

const MAX_BODY_BYTES = 1024 * 1024;

export interface TriggerServerDeps {
  registry: TriggerRegistry;
  /** 一条外部信号被接住之后的动作：落事件、（如果是结束信号）收线。 */
  onAccepted: (trigger: NormalizedTrigger, meta: { adapterId: string; source: TriggerSource }) => void;
  host?: string;
  port?: number;
  /** 每条请求的处理结果，日志与探针用它。 */
  onOutcome?: (outcome: TriggerOutcome) => void;
}

export interface TriggerServer {
  /** 实际监听端口（`port: 0` 时由系统分配，测试用它）。 */
  port: number;
  /** 每个入口的完整 URL，设置页直接显示，用户照抄。 */
  urls: { id: string; url: string }[];
  close: () => Promise<void>;
}

export async function startTriggerServer(deps: TriggerServerDeps): Promise<TriggerServer> {
  const host = deps.host ?? '127.0.0.1';

  const server = createServer((request, response) => {
    void handle(deps, request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (deps.port ?? 0);

  return {
    port,
    urls: deps.registry.entries.map((entry) => ({
      id: entry.id,
      url: `http://${host}:${port}/hook/${entry.id}`,
    })),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handle(
  deps: TriggerServerDeps,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const reply = (status: number, body: string): void => {
    response.writeHead(status, {
      'content-type': typeof body === 'string' && body.trim().startsWith('{') ? 'application/json' : 'text/plain',
    });
    response.end(body);
  };

  if (request.method !== 'POST') {
    reply(405, JSON.stringify({ ok: false, reason: 'method not allowed' }));
    return;
  }

  let body: string;
  try {
    body = await readBody(request);
  } catch (error) {
    reply(413, JSON.stringify({ ok: false, reason: String(error) }));
    return;
  }

  const outcome = deps.registry.handle({
    method: request.method ?? 'POST',
    path: new URL(request.url ?? '/', 'http://localhost').pathname,
    headers: request.headers as Record<string, string | string[] | undefined>,
    body,
  });

  deps.onOutcome?.(outcome);

  // 落事件在回 200 之前：平台收到 200 就不会重投，而我们还没落库的话那条事件就丢了。
  for (const trigger of outcome.accepted) {
    if (!outcome.adapterId || !outcome.source) break;
    try {
      deps.onAccepted(trigger, { adapterId: outcome.adapterId, source: outcome.source });
    } catch (error) {
      // 落库失败：回 5xx 让平台重投。宁可重复一次（有 deliveryId 兜着），不可丢一次。
      reply(500, JSON.stringify({ ok: false }));
      console.error('[trigger] 落事件失败', error);
      return;
    }
  }

  reply(outcome.status, outcome.body);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new Error('正文超过 1 MiB'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}
