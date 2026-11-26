import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocPreviewService } from './docPreviewService';
import { DOC_PREVIEW_LIMITS } from './docTypes';

const roots: string[] = [];

function setupWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-preview-'));
  roots.push(root);
  const workspaceRoot = path.join(root, 'workspaces');
  const taskDir = path.join(workspaceRoot, 'tasks', 't1');
  const outsideDir = path.join(root, 'outside');
  fs.mkdirSync(path.join(taskDir, 'output'), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  const docxFile = path.join(taskDir, 'output', '周报.docx');
  const legacyFile = path.join(taskDir, 'output', 'old.doc');
  const hugeFile = path.join(taskDir, 'output', 'huge.docx');
  const secretFile = path.join(outsideDir, 'secret.docx');
  const userAttachment = path.join(outsideDir, 'user-sheet.csv');

  fs.writeFileSync(docxFile, 'PK\x03\x04fake-docx');
  fs.writeFileSync(legacyFile, 'legacy-binary');
  fs.writeFileSync(hugeFile, Buffer.alloc(16));
  fs.writeFileSync(secretFile, 'outside-secret');
  fs.writeFileSync(userAttachment, 'col1,col2\n1,2\n');

  return { root, workspaceRoot, taskDir, docxFile, legacyFile, hugeFile, secretFile, userAttachment };
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('DocPreviewService', () => {
  it('opens and closes artifact sessions while enforcing workspace confinement', () => {
    const { workspaceRoot, docxFile } = setupWorkspace();
    const openPath = vi.fn().mockResolvedValue('');
    const service = new DocPreviewService({
      workspaceRoot,
      getTask: (id) => (id === 't1' ? { workspaceRelPath: 'tasks/t1', artifacts: [] } : undefined),
      findAttachment: () => null,
      openPath,
    });

    const opened = service.openSession({ kind: 'artifact', taskId: 't1', relPath: 'output/周报.docx' });
    expect(opened.ok).toBe(true);
    expect(opened.kind).toBe('docx');
    expect(opened.sessionId).toBeTruthy();
    expect(service.resolveProtocolFile(opened.sessionId!)).toEqual({
      filePath: fs.realpathSync(docxFile),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    service.closeSession(opened.sessionId!);
    expect(service.resolveProtocolFile(opened.sessionId!)).toBeUndefined();

    const escaped = service.openSession({
      kind: 'artifact',
      taskId: 't1',
      relPath: '../../../outside/secret.docx',
    });
    expect(escaped.ok).toBe(false);
    expect(escaped.error).toContain('越界');
  });

  it('authorizes persisted message attachments and staged composer attachments separately', async () => {
    const { workspaceRoot, userAttachment } = setupWorkspace();
    const openPath = vi.fn().mockResolvedValue('');
    const service = new DocPreviewService({
      workspaceRoot,
      getTask: () => undefined,
      findAttachment: (msgId, attId) =>
        msgId === 'm1' && attId === 'a1'
          ? {
              id: 'a1',
              name: 'user-sheet.csv',
              path: userAttachment,
              size: 16,
              source: 'file',
            }
          : null,
      openPath,
    });

    const msgRes = service.openSession({
      kind: 'attachment',
      messageId: 'm1',
      attachmentId: 'a1',
    });
    expect(msgRes.ok).toBe(true);
    expect(msgRes.kind).toBe('spreadsheet');
    const page = await service.readSpreadsheetPage({ sessionId: msgRes.sessionId! });
    expect(page.ok).toBe(true);
    expect(page.rows).toEqual([
      ['col1', 'col2'],
      ['1', '2'],
    ]);

    const unauthorizedStaged = service.openSession({ kind: 'staged', attachmentId: 's1' });
    expect(unauthorizedStaged.ok).toBe(false);

    service.authorizeStagedAttachments([
      { id: 's1', name: 'user-sheet.csv', path: userAttachment, size: 16, source: 'file' },
    ]);
    const authorizedStaged = service.openSession({ kind: 'staged', attachmentId: 's1' });
    expect(authorizedStaged.ok).toBe(true);
    expect(authorizedStaged.canSaveAs).toBe(false);

    const extRes = await service.openExternal({ kind: 'staged', attachmentId: 's1' });
    expect(extRes).toEqual({ ok: true });
    expect(openPath).toHaveBeenCalledWith(path.resolve(userAttachment));
    service.dispose();
  });

  it('handles unsupported legacy formats and oversized files cleanly', () => {
    const { workspaceRoot, taskDir } = setupWorkspace();
    const service = new DocPreviewService({
      workspaceRoot,
      getTask: () => ({ workspaceRelPath: 'tasks/t1', artifacts: [] }),
      findAttachment: () => null,
      openPath: async () => '',
    });

    const legacy = service.openSession({ kind: 'artifact', taskId: 't1', relPath: 'output/old.doc' });
    expect(legacy.ok).toBe(true);
    expect(legacy.kind).toBe('unsupported');
    expect(legacy.sessionId).toBeUndefined();

    // Verify large file threshold check works end-to-end when file size exceeds limit.
    const bigPath = path.join(taskDir, 'output', 'huge-real.docx');
    const fd = fs.openSync(bigPath, 'w');
    fs.ftruncateSync(fd, DOC_PREVIEW_LIMITS.docx + 1);
    fs.closeSync(fd);

    const big = service.openSession({
      kind: 'artifact',
      taskId: 't1',
      relPath: 'output/huge-real.docx',
    });
    expect(big.ok).toBe(true);
    expect(big.kind).toBe('docx');
    expect(big.tooLargeForInApp).toBe(true);
    expect(big.sessionId).toBeUndefined();
  });

  it('delegates spreadsheet slicing to createWorker when configured and terminates on dispose', async () => {
    const { root, workspaceRoot, taskDir, docxFile } = setupWorkspace();
    const csvPath = path.join(taskDir, 'output', 'metrics.csv');
    fs.writeFileSync(csvPath, 'a,b\n1,2\n');
    const dummyWorkerFile = path.join(root, 'fake-worker.js');
    fs.writeFileSync(dummyWorkerFile, '// worker');

    let messageHandler: ((res: { id: number; result: { ok: boolean; rows?: string[][] } }) => void) | undefined;
    const terminateSpy = vi.fn();

    const service = new DocPreviewService({
      workspaceRoot,
      getTask: () => ({ workspaceRelPath: 'tasks/t1', artifacts: [] }),
      findAttachment: () => null,
      openPath: async () => '',
      workerPath: dummyWorkerFile,
      createWorker: () => ({
        postMessage: (msg) => {
          const req = msg as { id: number };
          queueMicrotask(() => {
            messageHandler?.({ id: req.id, result: { ok: true, rows: [['a', 'b'], ['1', '2']] } });
          });
        },
        onMessage: (cb) => {
          messageHandler = cb;
        },
        onError: () => undefined,
        onExit: () => undefined,
        terminate: terminateSpy,
      }),
    });

    const opened = service.openSession({ kind: 'artifact', taskId: 't1', relPath: 'output/metrics.csv' });
    expect(opened.ok).toBe(true);
    const page = await service.readSpreadsheetPage({ sessionId: opened.sessionId! });
    expect(page.ok).toBe(true);
    expect(page.rows).toEqual([['a', 'b'], ['1', '2']]);

    // Non-spreadsheet file does not break session lifecycle.
    expect(fs.existsSync(docxFile)).toBe(true);
    service.dispose();
    expect(terminateSpy).toHaveBeenCalledTimes(1);
  });
});
