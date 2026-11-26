import fs from 'node:fs';
import path from 'node:path';
import {
  partitionTaskArtifacts,
  type ObservatoryBlocker,
  type ObservatorySnapshot,
  type ObservatoryTaskDetail,
  type ObservatoryThreadItem,
  type ObservatoryThreadTaskSummary,
  type RouterObservatoryState,
  type WorkReport,
  type WorkTask,
  type Worker,
} from '@opc/shared/domain';
import type { ThreadRepository } from '../data/threadRepository';
import type { ModelConfigService } from '../models/modelConfigService';
import { resolveWorkerModelRef } from '../models/workerModel';
import type { WorkService } from '../work/workService';

/**
 * Resolves `target` and guarantees it stays inside `root` (including equal to `root`).
 */
export function resolveSafeWorkspacePath(root: string, target: string): string | null {
  if (!root || !target) return null;
  const rootResolved = path.resolve(root);
  const candidate = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(rootResolved, target);
  const rel = path.relative(rootResolved, candidate);
  if (rel === '') return candidate;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return candidate;
}

/**
 * Derives the active blocker for a task/thread in strict diagnostic priority:
 * unread approval > unread question > running/open children > failed/rejected error.
 */
export function detectTaskBlocker(input: {
  task: WorkTask | null;
  unreadReports: readonly WorkReport[];
  childTasks: readonly WorkTask[];
}): ObservatoryBlocker | null {
  const { task, unreadReports, childTasks } = input;
  const relevantReports = unreadReports
    .filter(
      (report) =>
        report.readAt === null &&
        (!task || report.taskId === null || report.taskId === task.id),
    )
    .sort((a, b) => b.createdAt - a.createdAt);

  const approval = relevantReports.find((report) => report.kind === 'approval');
  if (approval) {
    return {
      kind: 'approval',
      reportId: approval.id,
      title: approval.title,
      body: approval.body,
      ...(approval.subject ? { tool: approval.subject } : {}),
      createdAt: approval.createdAt,
    };
  }

  const question = relevantReports.find((report) => report.kind === 'question');
  if (question) {
    return {
      kind: 'question',
      reportId: question.id,
      title: question.title,
      body: question.body,
      createdAt: question.createdAt,
    };
  }

  if (task && (task.status === 'open' || task.status === 'running')) {
    const activeChildren = childTasks.filter(
      (child) => child.status === 'open' || child.status === 'running' || child.status === 'review',
    );
    if (activeChildren.length > 0) {
      return {
        kind: 'waiting_children',
        children: activeChildren.map((child) => ({
          id: child.id,
          title: child.title,
          status: child.status,
        })),
      };
    }
  }

  if (task && (task.status === 'failed' || task.status === 'rejected')) {
    const message =
      task.error?.trim() ||
      task.acceptance?.reason?.trim() ||
      (task.status === 'rejected' ? '任务验收未通过' : '任务执行失败');
    return {
      kind: 'error',
      message,
      ...(task.acceptance ? { exitCode: task.acceptance.evidence.exitCode } : {}),
      ...(task.acceptance?.evidence.stderrTail
        ? { stderrTail: task.acceptance.evidence.stderrTail }
        : {}),
    };
  }

  return null;
}

export interface ObservatoryServiceDeps {
  work: WorkService;
  threads: ThreadRepository;
  models: ModelConfigService;
  workspaceRoot: string;
  getRouterState: () => Promise<RouterObservatoryState>;
  openPath: (absPath: string) => Promise<string>;
  showItemInFolder: (absPath: string) => void;
}

const MAX_SNAPSHOT_THREADS = 30;
const MAX_DETAIL_TRACE = 200;

export class ObservatoryService {
  constructor(private readonly deps: ObservatoryServiceDeps) {}

  private workerModelLabel(worker: Worker | null): string {
    const resolved = resolveWorkerModelRef({
      worker,
      modelConfig: this.deps.models,
    });
    return resolved ? `${resolved.providerId}/${resolved.modelId}` : '未配置';
  }

  async snapshot(): Promise<ObservatorySnapshot> {
    const [router, allThreads, allWorkers, allTasks] = await Promise.all([
      this.deps.getRouterState(),
      Promise.resolve(this.deps.threads.listThreads({ limit: MAX_SNAPSHOT_THREADS })),
      Promise.resolve(this.deps.threads.listAllWorkers()),
      Promise.resolve(this.deps.work.listTasks(150)),
    ]);

    const visibleThreads = allThreads.filter((t) => t.state !== 'archived');
    const workerById = new Map<string, Worker>();
    const workerByThread = new Map<string, Worker>();
    for (const worker of allWorkers) {
      workerById.set(worker.id, worker);
      if (worker.threadId && worker.status !== 'retired') {
        workerByThread.set(worker.threadId, worker);
      }
    }

    const latestTaskByThread = new Map<string, WorkTask>();
    const tasksByThread = new Map<string, WorkTask[]>();
    const childrenByParent = new Map<string, WorkTask[]>();
    for (const task of allTasks) {
      if (task.parentTaskId) {
        const list = childrenByParent.get(task.parentTaskId) ?? [];
        list.push(task);
        childrenByParent.set(task.parentTaskId, list);
      }
      if (!task.threadId) continue;
      if (!task.isReview) {
        const threadTasks = tasksByThread.get(task.threadId) ?? [];
        threadTasks.push(task);
        tasksByThread.set(task.threadId, threadTasks);
      }
      const existing = latestTaskByThread.get(task.threadId);
      if (!existing) {
        latestTaskByThread.set(task.threadId, task);
        continue;
      }
      // Prefer running or primary non-review tasks created/updated most recently.
      const existingScore = (existing.status === 'running' ? 1_000_000_000_000 : 0) + existing.updatedAt;
      const candidateScore = (task.status === 'running' ? 1_000_000_000_000 : 0) + task.updatedAt;
      if (candidateScore > existingScore && !task.isReview) {
        latestTaskByThread.set(task.threadId, task);
      }
    }

    const items: ObservatoryThreadItem[] = [];
    let activeCount = 0;
    let blockedCount = 0;
    let errorCount = 0;

    for (const thread of visibleThreads) {
      const latestTask = latestTaskByThread.get(thread.id) ?? null;
      const threadTasksRaw = (tasksByThread.get(thread.id) ?? []).sort(
        (a, b) => a.createdAt - b.createdAt,
      );
      const worker =
        (latestTask ? workerById.get(latestTask.assigneeId) : undefined) ??
        workerByThread.get(thread.id) ??
        null;
      const reports = this.deps.threads.listReportsOf(thread.id);
      const childTasks = latestTask ? (childrenByParent.get(latestTask.id) ?? []) : [];
      const blocker = detectTaskBlocker({
        task: latestTask,
        unreadReports: reports,
        childTasks,
      });

      const traceRows = latestTask ? this.deps.work.listTrace(latestTask.id, MAX_DETAIL_TRACE) : [];
      const actionTraceCount = traceRows.filter((row) => row.kind !== 'usage').length;
      const lastTrace = [...traceRows].reverse().find((row) => row.kind !== 'usage') ?? traceRows.at(-1);
      const taskSummaries: ObservatoryThreadTaskSummary[] = threadTasksRaw.slice(-15).map((taskItem) => {
        const rows =
          latestTask && taskItem.id === latestTask.id
            ? traceRows
            : this.deps.work.listTrace(taskItem.id, MAX_DETAIL_TRACE);
        return {
          id: taskItem.id,
          title: taskItem.title,
          ...(taskItem.turnMode ? { turnMode: taskItem.turnMode } : {}),
          status: taskItem.status,
          createdAt: taskItem.createdAt,
          updatedAt: taskItem.updatedAt,
          traceCount: rows.filter((row) => row.kind !== 'usage').length,
          tokensUsed: taskItem.tokensUsed,
        };
      });

      const isBlocked =
        blocker?.kind === 'approval' ||
        blocker?.kind === 'question' ||
        blocker?.kind === 'waiting_children';
      const isRunning = latestTask?.status === 'running' || thread.state === 'running';
      if (isRunning) activeCount += 1;
      if (isBlocked) blockedCount += 1;
      if (blocker?.kind === 'error') errorCount += 1;

      items.push({
        threadId: thread.id,
        title: thread.title,
        goal: thread.goal,
        livingGoal: thread.livingGoal ?? null,
        state: thread.state,
        source: thread.source,
        lastActivityAt: thread.lastActivityAt,
        spentTokens: thread.spentTokens,
        ...(worker
          ? {
              worker: {
                id: worker.id,
                name: worker.name,
                template: worker.template,
                status: worker.status,
                modelLabel: this.workerModelLabel(worker),
              },
            }
          : {}),
        ...(latestTask
          ? {
              latestTask: {
                id: latestTask.id,
                title: latestTask.title,
                status: latestTask.status,
                ...(typeof latestTask.startedAt === 'number'
                  ? { startedAt: latestTask.startedAt }
                  : {}),
                ...(typeof latestTask.finishedAt === 'number'
                  ? { finishedAt: latestTask.finishedAt }
                  : {}),
                updatedAt: latestTask.updatedAt,
                totalTokens: latestTask.tokensUsed,
                costUsd: latestTask.costUsd,
                artifactCount: partitionTaskArtifacts(
                  latestTask.artifacts,
                  latestTask.contract?.outputs,
                ).deliverables.length,
                traceCount: actionTraceCount,
                ...(lastTrace
                  ? {
                      lastTool: {
                        name: lastTrace.name,
                        argsDigest: lastTrace.argsDigest,
                        ok: lastTrace.ok,
                        at: lastTrace.at,
                      },
                    }
                  : {}),
              },
            }
          : {}),
        ...(taskSummaries.length > 0 ? { tasks: taskSummaries } : {}),
        blocker,
      });
    }

    // Prioritize blocked & active threads at the front while keeping recent order within groups.
    items.sort((a, b) => {
      const rank = (item: ObservatoryThreadItem) => {
        if (item.blocker && item.blocker.kind !== 'error') return 0;
        if (item.latestTask?.status === 'running' || item.state === 'running') return 1;
        if (item.blocker?.kind === 'error') return 2;
        return 3;
      };
      const diff = rank(a) - rank(b);
      return diff !== 0 ? diff : b.lastActivityAt - a.lastActivityAt;
    });

    return {
      generatedAt: Date.now(),
      activeCount,
      blockedCount,
      errorCount,
      router,
      threads: items,
    };
  }

  taskDetail(taskId: string): ObservatoryTaskDetail | null {
    const task = this.deps.work.getTask(taskId);
    if (!task) return null;

    const trace = this.deps.work.listTrace(taskId, MAX_DETAIL_TRACE);
    const children = this.deps.work.listSubtasks(taskId);
    const reports = task.threadId ? this.deps.threads.listReportsOf(task.threadId) : [];
    const blocker = detectTaskBlocker({
      task,
      unreadReports: reports,
      childTasks: children,
    });

    const worker = this.deps.threads.listAllWorkers().find((w) => w.id === task.assigneeId) ?? null;
    const workspaceCandidate = resolveSafeWorkspacePath(
      this.deps.workspaceRoot,
      task.workspaceRelPath,
    );
    const workspaceAbsPath =
      workspaceCandidate && fs.existsSync(workspaceCandidate) ? workspaceCandidate : null;

    return {
      task,
      trace,
      children,
      blocker,
      workspaceAbsPath,
      modelLabel: this.workerModelLabel(worker),
    };
  }

  async openWorkspace(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.deps.work.getTask(taskId);
    if (!task) return { ok: false, error: '找不到对应任务' };
    const absPath = resolveSafeWorkspacePath(this.deps.workspaceRoot, task.workspaceRelPath);
    if (!absPath) return { ok: false, error: '工作区路径越界' };
    if (!fs.existsSync(absPath)) return { ok: false, error: '工作区目录不存在' };
    const err = await this.deps.openPath(absPath);
    return err ? { ok: false, error: err } : { ok: true };
  }

  revealArtifact(taskId: string, relPath: string): { ok: boolean; error?: string } {
    const task = this.deps.work.getTask(taskId);
    if (!task) return { ok: false, error: '找不到对应任务' };
    const workspaceDir = resolveSafeWorkspacePath(this.deps.workspaceRoot, task.workspaceRelPath);
    if (!workspaceDir) return { ok: false, error: '工作区路径越界' };
    const artifactAbs = resolveSafeWorkspacePath(workspaceDir, relPath);
    if (!artifactAbs) return { ok: false, error: '产物路径越界' };
    if (!fs.existsSync(artifactAbs)) return { ok: false, error: '产物文件不存在' };
    this.deps.showItemInFolder(artifactAbs);
    return { ok: true };
  }
}
