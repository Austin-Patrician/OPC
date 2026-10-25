import type { OpcBridge } from '@opc/shared/ipc';

declare global {
  interface Window {
    /** Injected by the sandboxed preload; absent outside Electron. */
    opc?: OpcBridge;
  }
}

export {};
