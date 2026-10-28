import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { OcrRequest, OcrResponse } from '@opc/shared/ocr';

/**
 * The OCR window's only bridge. It cannot read files, spawn processes, or reach
 * the network: `request` carries image bytes, `respond` carries text back.
 */
const bridge = {
  ready: (): void => {
    ipcRenderer.send('ocr:ready');
  },
  onRequest: (handler: (request: OcrRequest) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, request: OcrRequest): void => handler(request);
    ipcRenderer.on('ocr:request', listener);
    return () => {
      ipcRenderer.off('ocr:request', listener);
    };
  },
  respond: (response: OcrResponse): void => {
    ipcRenderer.send('ocr:result', response);
  },
};

contextBridge.exposeInMainWorld('opcOcr', bridge);
