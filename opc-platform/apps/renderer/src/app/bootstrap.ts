import { IpcChatTransport } from '@/shared/api/ipcTransport';
import { setChatTransport } from '@/shared/api/chatTransport';
import { IpcWorkTransport } from '@/shared/api/ipcWorkTransport';
import { setWorkTransport } from '@/shared/api/workTransport';

/**
 * Composition root for data plumbing.
 *
 * The desktop app is the only supported target: without the preload bridge there
 * is nothing to render, and we fail loudly instead of silently falling back to
 * mock data (that fallback was what made a "web version" possible in the first
 * place).
 */
export function bootstrap(): void {
  const bridge = window.opc;
  if (!bridge) {
    throw new Error('未检测到 Electron preload 桥（window.opc）。请用 pnpm dev 启动桌面应用。');
  }

  document.documentElement.dataset.shell = 'electron';
  document.documentElement.dataset.platform =
    bridge.platform === 'darwin' ? 'macos' : bridge.platform === 'win32' ? 'windows' : 'linux';

  setChatTransport(new IpcChatTransport(bridge));
  setWorkTransport(new IpcWorkTransport(bridge.work));
}
