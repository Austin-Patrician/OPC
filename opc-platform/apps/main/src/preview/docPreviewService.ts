import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ChatAttachmentRef } from '@opc/shared/domain';
import type { DocPreviewOpenResult, DocPreviewSource, SpreadsheetPageResult } from '@opc/shared/ipc';
import { DOC_ORIGIN, classifyDocPreview } from './docTypes';
import { readSpreadsheetPageFromFile, type ReadSpreadsheetPageInput } from './spreadsheetReader';
import type { SpreadsheetWorkerResponse } from './spreadsheetWorker';

const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 40;
const MAX_STAGED_REFS = 200;
const WORKER_IDLE_MS = 60 * 1000;
const WORKER_TIMEOUT_MS = 30 * 1000;

interface ActivePreviewSession {
  id: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  ext: string;
  bytes: number;
  source: DocPreviewSource;
  expiresAt: number;
}

interface PendingWorkerJob {
  resolve: (result: SpreadsheetPageResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SpreadsheetWorkerHandle {
  postMessage(message: unknown): void;
  onMessage(listener: (response: SpreadsheetWorkerResponse) => void): void;
  onError(listener: (error: Error) => void): void;
  onExit(listener: (code: number) => void): void;
  terminate(): Promise<void> | void;
}

export interface DocPreviewServiceOptions {
  workspaceRoot: string;
  getTask: (taskId: string) => { workspaceRelPath: string; artifacts: Array<{ relPath: string }> } | undefined;
  findAttachment: (messageId: string, attachmentId: string, conversationId?: string) => ChatAttachmentRef | null;
  openPath: (absPath: string) => Promise<string>;
  workerPath?: string;
  /** Optional custom worker launcher (e.g. Electron `utilityProcess.fork` with ASAR support). */
  createWorker?: (workerPath: string) => SpreadsheetWorkerHandle;
}

/**
 * Authorizes document preview sessions, resolves workspace/attachment paths safely
 * inside the main process, and offloads spreadsheet slicing to an idle-reclaimed Worker.
 */
export class DocPreviewService {
  private readonly sessions = new Map<string, ActivePreviewSession>();
  private readonly stagedAttachments = new Map<string, { path: string; name: string; expiresAt: number }>();
  private worker: SpreadsheetWorkerHandle | null = null;
  private workerIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private nextJobId = 1;
  private readonly pendingJobs = new Map<number, PendingWorkerJob>();
  private disposed = false;

  constructor(private readonly options: DocPreviewServiceOptions) {}

  authorizeStagedAttachments(attachments: readonly ChatAttachmentRef[]): void {
    const now = Date.now();
    for (const [key, item] of this.stagedAttachments) {
      if (item.expiresAt <= now) this.stagedAttachments.delete(key);
    }
    for (const item of attachments) {
      if (!item.id || !item.path) continue;
      while (this.stagedAttachments.size >= MAX_STAGED_REFS) {
        const oldest = this.stagedAttachments.keys().next().value;
        if (!oldest) break;
        this.stagedAttachments.delete(oldest);
      }
      this.stagedAttachments.set(item.id, {
        path: path.resolve(item.path),
        name: item.name,
        expiresAt: now + SESSION_TTL_MS * 4,
      });
    }
  }

  resolveSourceFile(source: DocPreviewSource):
    | { ok: true; filePath: string; fileName: string; canSaveAs: boolean }
    | { ok: false; error: string } {
    if (source.kind === 'artifact') {
      const task = this.options.getTask(source.taskId);
      if (!task) return { ok: false, error: '找不到对应任务' };
      const taskDir = path.resolve(this.options.workspaceRoot, task.workspaceRelPath);
      const lexicalTarget = path.resolve(taskDir, source.relPath);
      const workspaceRoot = path.resolve(this.options.workspaceRoot);
      if (
        lexicalTarget === taskDir ||
        !lexicalTarget.startsWith(`${taskDir}${path.sep}`) ||
        !lexicalTarget.startsWith(`${workspaceRoot}${path.sep}`)
      ) {
        return { ok: false, error: '产物路径越界' };
      }
      let realTaskDir: string;
      let realTarget: string;
      try {
        realTaskDir = fs.realpathSync(taskDir);
        realTarget = fs.realpathSync(lexicalTarget);
      } catch {
        return { ok: false, error: '产物文件不存在' };
      }
      if (!realTarget.startsWith(`${realTaskDir}${path.sep}`)) {
        return { ok: false, error: '产物路径越界' };
      }
      const stat = fs.statSync(realTarget, { throwIfNoEntry: false });
      if (!stat?.isFile()) return { ok: false, error: '产物文件不存在' };
      return {
        ok: true,
        filePath: realTarget,
        fileName: path.basename(source.relPath),
        canSaveAs: true,
      };
    }

    if (source.kind === 'attachment') {
      const ref = this.options.findAttachment(
        source.messageId,
        source.attachmentId,
        source.conversationId,
      );
      if (!ref?.path) return { ok: false, error: '找不到对应附件记录' };
      const resolved = path.resolve(ref.path);
      const stat = fs.statSync(resolved, { throwIfNoEntry: false });
      if (!stat?.isFile()) return { ok: false, error: '原文件已移动或删除' };
      return {
        ok: true,
        filePath: resolved,
        fileName: ref.name || path.basename(resolved),
        canSaveAs: true,
      };
    }

    if (source.kind === 'staged') {
      const staged = this.stagedAttachments.get(source.attachmentId);
      if (!staged || staged.expiresAt <= Date.now()) {
        this.stagedAttachments.delete(source.attachmentId);
        return { ok: false, error: '附件授权已过期，请重新添加' };
      }
      const stat = fs.statSync(staged.path, { throwIfNoEntry: false });
      if (!stat?.isFile()) return { ok: false, error: '文件不存在或无法访问' };
      return {
        ok: true,
        filePath: staged.path,
        fileName: staged.name || path.basename(staged.path),
        canSaveAs: false,
      };
    }

    return { ok: false, error: '未知的文档来源' };
  }

  openSession(source: DocPreviewSource): DocPreviewOpenResult {
    const resolved = this.resolveSourceFile(source);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const stat = fs.statSync(resolved.filePath, { throwIfNoEntry: false });
    if (!stat?.isFile()) return { ok: false, error: '文件不存在' };

    const classification = classifyDocPreview(resolved.fileName, stat.size);
    if (stat.size === 0 && classification.kind !== 'text') {
      return {
        ok: true,
        kind: 'unsupported',
        fileName: resolved.fileName,
        ext: classification.ext,
        bytes: 0,
        canSaveAs: resolved.canSaveAs,
        error: '文件内容为空（0 字节），无法预览',
      };
    }

    if (classification.kind === 'unsupported' || classification.tooLargeForInApp) {
      return {
        ok: true,
        kind: classification.kind,
        fileName: resolved.fileName,
        ext: classification.ext,
        bytes: stat.size,
        tooLargeForInApp: classification.tooLargeForInApp,
        canSaveAs: resolved.canSaveAs,
      };
    }

    this.pruneExpiredSessions();
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }

    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, {
      id: sessionId,
      filePath: resolved.filePath,
      fileName: resolved.fileName,
      mimeType: classification.mimeType,
      ext: classification.ext,
      bytes: stat.size,
      source,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });

    return {
      ok: true,
      sessionId,
      docUrl: `${DOC_ORIGIN}/${sessionId}`,
      kind: classification.kind,
      fileName: resolved.fileName,
      ext: classification.ext,
      bytes: stat.size,
      tooLargeForInApp: false,
      canSaveAs: resolved.canSaveAs,
    };
  }

  closeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    if (this.sessions.size === 0 && this.pendingJobs.size === 0) {
      this.terminateWorker();
    }
  }

  resolveProtocolFile(sessionId: string): { filePath: string; mimeType: string } | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return { filePath: session.filePath, mimeType: session.mimeType };
  }

  async readSpreadsheetPage(input: {
    sessionId: string;
    sheetIndex?: number;
    offset?: number;
    limit?: number;
  }): Promise<SpreadsheetPageResult> {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(input.sessionId);
      return { ok: false, error: '预览会话已过期，请重新打开' };
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;

    const payload: ReadSpreadsheetPageInput = {
      filePath: session.filePath,
      ...(typeof input.sheetIndex === 'number' ? { sheetIndex: input.sheetIndex } : {}),
      ...(typeof input.offset === 'number' ? { offset: input.offset } : {}),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    };

    const rawWorkerPath = this.options.workerPath;
    const unpackedWorkerPath = rawWorkerPath?.replace('app.asar', 'app.asar.unpacked');
    const workerPath = this.options.createWorker
      ? rawWorkerPath && fs.existsSync(rawWorkerPath)
        ? rawWorkerPath
        : unpackedWorkerPath
      : unpackedWorkerPath && fs.existsSync(unpackedWorkerPath)
        ? unpackedWorkerPath
        : rawWorkerPath;
    if (!workerPath || !fs.existsSync(workerPath)) {
      return readSpreadsheetPageFromFile(payload);
    }

    return this.runInWorker(workerPath, payload);
  }

  async openExternal(source: DocPreviewSource): Promise<{ ok: boolean; error?: string }> {
    const resolved = this.resolveSourceFile(source);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const err = await this.options.openPath(resolved.filePath);
    return err ? { ok: false, error: err } : { ok: true };
  }

  dispose(): void {
    this.disposed = true;
    this.sessions.clear();
    this.stagedAttachments.clear();
    this.terminateWorker();
  }

  private pruneExpiredSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }

  private runInWorker(workerPath: string, payload: ReadSpreadsheetPageInput): Promise<SpreadsheetPageResult> {
    if (this.disposed) {
      return Promise.resolve({ ok: false, error: '预览服务已关闭' });
    }
    const worker = this.ensureWorker(workerPath);
    const id = this.nextJobId++;
    this.clearWorkerIdleTimer();

    return new Promise<SpreadsheetPageResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingJobs.delete(id);
        this.terminateWorker();
        reject(new Error('表格解析超时（30 秒）'));
      }, WORKER_TIMEOUT_MS);
      timer.unref?.();

      this.pendingJobs.set(id, { resolve, reject, timer });
      worker.postMessage({ id, payload });
    }).finally(() => {
      if (this.pendingJobs.size === 0) {
        this.touchWorkerIdle();
      }
    });
  }

  private ensureWorker(workerPath: string): SpreadsheetWorkerHandle {
    if (this.worker) return this.worker;
    const handle: SpreadsheetWorkerHandle = this.options.createWorker
      ? this.options.createWorker(workerPath)
      : (() => {
          const nodeWorker = new Worker(workerPath);
          return {
            postMessage: (msg) => nodeWorker.postMessage(msg),
            onMessage: (cb) => nodeWorker.on('message', cb),
            onError: (cb) => nodeWorker.on('error', cb),
            onExit: (cb) => nodeWorker.on('exit', cb),
            terminate: () => nodeWorker.terminate().then(() => undefined),
          };
        })();

    handle.onMessage((response: SpreadsheetWorkerResponse) => {
      const pending = this.pendingJobs.get(response.id);
      if (!pending) return;
      this.pendingJobs.delete(response.id);
      clearTimeout(pending.timer);
      pending.resolve(response.result);
    });
    handle.onError((error) => {
      this.failPendingJobs(error instanceof Error ? error : new Error(String(error)));
      this.terminateWorker();
    });
    handle.onExit((code) => {
      if (this.worker === handle) {
        this.worker = null;
        if (code !== 0) {
          this.failPendingJobs(new Error(`表格解析进程异常退出（code ${code}）`));
        }
      }
    });
    this.worker = handle;
    return handle;
  }

  private failPendingJobs(error: Error): void {
    for (const job of this.pendingJobs.values()) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    this.pendingJobs.clear();
  }

  private touchWorkerIdle(): void {
    this.clearWorkerIdleTimer();
    this.workerIdleTimer = setTimeout(() => {
      this.terminateWorker();
    }, WORKER_IDLE_MS);
    this.workerIdleTimer.unref?.();
  }

  private clearWorkerIdleTimer(): void {
    if (this.workerIdleTimer) {
      clearTimeout(this.workerIdleTimer);
      this.workerIdleTimer = null;
    }
  }

  private terminateWorker(): void {
    this.clearWorkerIdleTimer();
    const worker = this.worker;
    this.worker = null;
    this.failPendingJobs(new Error('表格解析线程已停止'));
    if (worker) {
      void Promise.resolve(worker.terminate()).catch(() => undefined);
    }
  }
}
