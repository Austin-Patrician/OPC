import { describe, expect, it } from 'vitest';
import { openDocPreview, useDocPreviewStore } from './docPreviewStore';

describe('docPreviewStore', () => {
  it('keeps only a single active preview request and clears cleanly on close', () => {
    useDocPreviewStore.getState().closePreview();
    expect(useDocPreviewStore.getState().request).toBeNull();

    openDocPreview({
      source: { kind: 'artifact', taskId: 't1', relPath: 'output/a.docx' },
      fileName: 'a.docx',
      bytes: 1200,
    });
    expect(useDocPreviewStore.getState().request?.fileName).toBe('a.docx');

    openDocPreview({
      source: { kind: 'staged', attachmentId: 'att-1' },
      fileName: 'b.xlsx',
    });
    expect(useDocPreviewStore.getState().request?.fileName).toBe('b.xlsx');

    useDocPreviewStore.getState().closePreview();
    expect(useDocPreviewStore.getState().request).toBeNull();
  });
});
