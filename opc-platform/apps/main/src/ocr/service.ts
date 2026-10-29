import { BrowserWindow, ipcMain, session, type IpcMainEvent, type Session } from 'electron';
import type { OcrResponse, OcrResult, OcrSettings } from '@opc/shared/ocr';
import { assertOcrAssets } from './assets';
import { DEFAULT_OCR_SETTINGS, type OcrSettingsStore } from './settings';
import { handleOcrProtocol, OCR_ORIGIN, OCR_SCHEME } from './protocol';

const READY_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 90_000;
const IDLE_MS = 3 * 60_000;

/** What the `ocr_image` tool depends on; a fake implements this in tests. */
export interface OcrEngine {
  recognize(bytes: Uint8Array): Promise<OcrResult>;
  dispose(): Promise<void>;
  /**
   * Asset preflight, cheap enough to run per session: `false` means
   * `ocr_image` would fail on its first call, so the tool is not installed.
   * Absent on fakes, which are always usable.
   */
  assetsReady?(): boolean;
  /** 设置 → 运行时: on/off plus the default output shape. */
  settings?(): OcrSettings;
}

export interface OcrServiceOptions {
  preload: string;
  rendererDir: string;
  assetsDir: string;
  /**
   * The company-wide policy the tool reads at call time. Absent in the OCR probe
   * (`OPC_OCR_PROBE`), which runs without a company database.
   */
  settings?: OcrSettingsStore;
  /** Vite dev server (e.g. http://localhost:5173/), so the OCR page gets HMR-free dev assets. */
  devUrl?: string;
  logger?: (message: string) => void;
  idleMs?: number;
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (response: OcrResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs OCR in a dedicated hidden renderer.
 *
 * Why a window: `ppu-paddle-ocr` + `onnxruntime-web` need a browser surface for
 * WebGPU and WASM, and inference must never block the main process. The window is
 * created on the first call, kept warm between calls (engine init is the slow
 * part) and destroyed after three idle minutes.
 *
 * The window has no Node access, a throwaway session, and that session may only
 * request `opc-ocr://` (plus the dev server in development) — the models are
 * local, so recognisable content never leaves the machine.
 */
export class OcrService implements OcrEngine {
  private window: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private readySettle: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private protocolReady = false;
  private pending = new Map<number, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private readonly log: (message: string) => void;

  constructor(private readonly options: OcrServiceOptions) {
    this.log = options.logger ?? ((message) => console.warn(`[ocr] ${message}`));
    ipcMain.on('ocr:ready', this.onReady);
    ipcMain.on('ocr:result', this.onResult);
  }

  /** One image at a time: the engine holds a single WASM heap and is not reentrant. */
  async recognize(bytes: Uint8Array): Promise<OcrResult> {
    if (this.disposed) throw new Error('OCR 服务已关闭');
    if (bytes.byteLength === 0) throw new Error('图片内容为空');
    assertOcrAssets(this.options.assetsDir);

    const run = () => this.runRequest(bytes);
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Assets on disk: false means `ocr_image` would fail, so it is not installed. */
  assetsReady(): boolean {
    try {
      assertOcrAssets(this.options.assetsDir);
      return true;
    } catch {
      return false;
    }
  }

  /** Policy, re-read every call so a switch takes effect on the next picture. */
  settings(): OcrSettings {
    return this.options.settings?.get() ?? DEFAULT_OCR_SETTINGS;
  }

  setSettings(next: OcrSettings): OcrSettings {
    return this.options.settings ? this.options.settings.set(next) : next;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    ipcMain.off('ocr:ready', this.onReady);
    ipcMain.off('ocr:result', this.onResult);
    this.failPending(new Error('OCR 服务已关闭'));
    this.destroyWindow();
    this.ready = null;
  }

  private async runRequest(bytes: Uint8Array): Promise<OcrResult> {
    const window = await this.ensureWindow();
    const id = this.nextId++;

    const response = await new Promise<OcrResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OCR 超过 ${Math.round(this.timeoutMs / 1000)} 秒未完成，已放弃本次识别`));
      }, this.timeoutMs);
      // Node timers keep the app alive on quit; this one must not.
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      if (window.isDestroyed()) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error('OCR 窗口已关闭，请重试'));
        return;
      }
      window.webContents.send('ocr:request', { id, bytes });
    });

    this.touchIdle();
    if (!response.ok) throw new Error(response.error);
    return response.result;
  }

  private get timeoutMs(): number {
    return this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed() && this.ready) {
      await this.ready;
      return this.window;
    }

    this.destroyWindow();
    const preload = this.options.preload;
    const sessionPartition = session.fromPartition('opc-ocr');
    this.configureSession(sessionPartition);
    if (!this.protocolReady) {
      handleOcrProtocol(sessionPartition, {
        rendererDir: this.options.rendererDir,
        assetsDir: this.options.assetsDir,
      });
      this.protocolReady = true;
    }

    const window = new BrowserWindow({
      show: false,
      width: 480,
      height: 320,
      webPreferences: {
        preload,
        session: sessionPartition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        spellcheck: false,
        // The OCR page is a local, hidden surface: no need for a compositor.
        offscreen: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning') this.log(`console ${event.level}: ${event.message}`);
    });
    window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // Only the page itself matters: a blocked sub-resource has its own error
      // path (the worker reports it), and aborting during teardown is expected.
      if (!isMainFrame || code === -3) return;
      this.failReady(new Error(`OCR 页面加载失败（${code} ${description}，${url}）`));
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      this.log(`renderer gone: ${details.reason}`);
      this.failPending(new Error('OCR 进程异常退出，请重试'));
      this.failReady(new Error('OCR 进程异常退出'));
      this.destroyWindow();
    });
    window.on('closed', () => {
      if (this.window === window) this.window = null;
      this.failPending(new Error('OCR 窗口已关闭，请重试'));
    });

    this.window = window;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // `loadURL` can fail before the await below attaches, which Node reports as
    // an unhandled rejection; the await still sees it.
    void ready.catch(() => undefined);
    const timer = setTimeout(() => {
      this.failReady(new Error('OCR 引擎初始化超时（30 秒）'));
    }, READY_TIMEOUT_MS);
    timer.unref?.();
    this.readySettle = {
      resolve: () => {
        clearTimeout(timer);
        resolveReady();
      },
      reject: (error) => {
        clearTimeout(timer);
        rejectReady(error);
      },
    };
    this.ready = ready;

    const url = this.options.devUrl ? new URL('ocr.html', this.options.devUrl).toString() : `${OCR_ORIGIN}/ocr.html`;
    try {
      await window.loadURL(url);
    } catch (error) {
      this.failReady(error instanceof Error ? error : new Error(String(error)));
    }
    try {
      await this.ready;
    } catch (error) {
      this.destroyWindow();
      throw error;
    }
    this.touchIdle();
    return window;
  }

  /**
   * No network, no permissions: everything the page needs is on `opc-ocr://`.
   * A redirect or a stray import in a future dependency fails closed.
   */
  private configureSession(ocrSession: Session): void {
    const devUrl = this.options.devUrl;
    ocrSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed =
        details.url.startsWith(`${OCR_SCHEME}://`) || (devUrl !== undefined && details.url.startsWith(devUrl));
      if (!allowed) this.log(`blocked request: ${details.url}`);
      callback({ cancel: !allowed });
    });
    ocrSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ocrSession.setPermissionCheckHandler(() => false);
  }

  private onReady = (event: IpcMainEvent): void => {
    if (!this.isOcrSender(event)) return;
    this.readySettle?.resolve();
    this.readySettle = null;
  };

  private onResult = (event: IpcMainEvent, response: OcrResponse): void => {
    if (!this.isOcrSender(event)) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.resolve(response);
  };

  private isOcrSender(event: IpcMainEvent): boolean {
    return this.window !== null && !this.window.isDestroyed() && event.sender === this.window.webContents;
  }

  private failReady(error: Error): void {
    const settle = this.readySettle;
    this.readySettle = null;
    settle?.reject(error);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const idle = this.options.idleMs ?? IDLE_MS;
    if (idle <= 0) return;
    this.idleTimer = setTimeout(() => this.destroyWindow(), idle);
    this.idleTimer.unref?.();
  }

  private destroyWindow(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // Settle anyone waiting on `ready` first, or a concurrent `ensureWindow`
    // would hang on a promise nobody owns anymore.
    const settle = this.readySettle;
    const window = this.window;
    this.readySettle = null;
    this.window = null;
    this.ready = null;
    settle?.reject(new Error('OCR 窗口已关闭，请重试'));
    if (window && !window.isDestroyed()) window.destroy();
    // A request in flight would otherwise wait for its 90s timeout to hear about it.
    this.failPending(new Error('OCR 窗口已关闭，请重试'));
  }
}
