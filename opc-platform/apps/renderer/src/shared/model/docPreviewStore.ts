import { create } from 'zustand';
import type { DocPreviewSource } from '@opc/shared/ipc';

export interface DocPreviewRequest {
  source: DocPreviewSource;
  fileName: string;
  bytes?: number;
}

interface DocPreviewStoreState {
  request: DocPreviewRequest | null;
  openPreview: (request: DocPreviewRequest) => void;
  closePreview: () => void;
}

/**
 * Single-instance modal preview state in `shared/` so every UI layer
 * (`entities/`, `features/`, `pages/`) can trigger document previews cleanly.
 */
export const useDocPreviewStore = create<DocPreviewStoreState>((set) => ({
  request: null,
  openPreview: (request) => set({ request }),
  closePreview: () => set({ request: null }),
}));

export function openDocPreview(request: DocPreviewRequest): void {
  useDocPreviewStore.getState().openPreview(request);
}
