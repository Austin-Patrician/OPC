import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EntryId, ToolExecutionResult } from '@earendil-works/pi-durable';
import type { WorkTask } from '@opc/shared/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserBroker } from '../browser/broker';
import type { BrowserInstallService } from '../browser/install';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { TaskRepository } from '../data/taskRepository';
import { ThreadRepository } from '../data/threadRepository';
import { createBrowserToolExtension } from './browserTool';
import { buildDeltaPrompt, HarnessBrain } from './harnessBrain';
import { OwnerQueue } from './ownerQueue';
import { WorkService } from './workService';

let dir: string;
let db: CompanyDatabase;
let threads: ThreadRepository;
let tasks: TaskRepository;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-living-worker-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  threads = new ThreadRepository(db);
  tasks = new TaskRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makePaths() {
  return {
    userData: dir,
    database: path.join(dir, 'company.db'),
    workspaceDir: path.join(dir, 'workspace'),
    agentsDir: path.join(dir, 'agents'),
    artifactsDir: path.join(dir, 'artifacts'),
    attachmentsDir: path.join(dir, 'attachments'),
  };
}

describe('Living Worker：共享线程工作区、热上下文复用与安全转向', () => {
  it('同一工作线的初始任务与 continueThread 追加任务共享同一个 threads/<id> 工作区，且 steerThread 对已完成线程无缝续跑', async () => {
    const template = threads.createWorker({ name: '通用执行体', template: 'code', skills: ['code'] });
    const work = new WorkService({
      db,
      threads,
      paths: makePaths() as never,
      upsertTaskCard: () => undefined,
    });

    const thread = threads.createThread({ title: '落地页项目', goal: '写一个落地页' });
    const first = work.createTask({
      title: thread.title,
      contract: {
        objective: '写一个极简落地页',
        deliverable: 'index.html',
        outputs: [{ kind: 'file', path: 'index.html', description: '落地页 HTML' }],
      },
      assigneeId: template.id,
      threadId: thread.id,
      estTokens: 5_000,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(first.task.workspaceRelPath).toBe(`threads/${thread.id}`);

    // Mark first task accepted & thread done (WarmIdle).
    tasks.setStatus(first.task.id, 'accepted', { finishedAt: Date.now() });
    threads.setState(thread.id, 'done');

    // Calling steerThread on a done thread should NOT refuse — it seamlessly appends in the same workspace!
    const steered = await work.steerThread(thread.id, '右上角加个深色模式切换按钮');
    expect(steered.ok).toBe(true);
    expect(steered.continuedTaskId).toBeTruthy();

    const followUp = work.getTask(steered.continuedTaskId!);
    expect(followUp?.workspaceRelPath).toBe(first.task.workspaceRelPath);
    expect(followUp?.workerId).toBe(first.task.workerId);
    expect(followUp?.turnMode).toBe('append');

    // Clean up queued/running task before disposal
    await work.abortThread(thread.id, '测试清理');
    await work.dispose();
  });

  it('HarnessBrain 复用持久化的 worker.conversationId 并在 append 轮次发送增量 delta prompt，且支持 pruneAfterCheckpoint 清理跑偏轮次', async () => {
    const submitted: Array<{ type: string; content?: string; entry?: { kind: string; edits?: unknown[] } }> = [];
    const entries: Array<{ id: EntryId; kind: string }> = [
      { id: 1 as EntryId, kind: 'pi.system' },
    ];
    let createdCount = 0;

    const conversation = {
      id: 42,
      configure: async () => undefined,
      context: async () => ({
        head: undefined,
        entries: [...entries],
        contributions: [],
        messages: [],
      }),
      submit: async (draft: { type: string; content?: string; entry?: { kind: string; edits?: unknown[] } }) => {
        submitted.push(draft);
        if (draft.type === 'input') {
          const nextId = (entries.length + 1) as EntryId;
          entries.push({ id: nextId, kind: 'pi.user' }, { id: (Number(nextId) + 1) as EntryId, kind: 'pi.assistant' });
        }
        return {
          wait: async () => ({ type: 'input', status: 'done', answer: entries[entries.length - 1]!.id }),
        };
      },
      commit: async (fn: (tx: { entry: () => Promise<{ model: unknown[] }> }) => unknown) =>
        fn({
          entry: async () => ({
            model: [{ role: 'assistant', content: [{ type: 'text', text: '搞定了' }] }],
          }),
        }),
    };

    const harness = {
      createConversation: async () => {
        createdCount += 1;
        return conversation;
      },
      conversation: async () => conversation,
      usage: async () => ({}),
    };

    let savedConvId: string | null = null;
    let savedCleanEntry: number | null = null;

    const brain = new HarnessBrain({
      harnessFor: async () => ({ harness: harness as never }),
      context: async () => ({}) as never,
      model: () => ({ providerId: 'p', modelId: 'm' }),
      thinking: () => 'low',
      price: () => ({ inputUsdPerM: 0, outputUsdPerM: 0 }),
      onTokens: () => undefined,
      workerConversation: () => (savedConvId ? { conversationId: savedConvId, lastCleanEntryId: savedCleanEntry } : null),
      onWorkerConversation: (_workerId, convId, cleanEntryId) => {
        savedConvId = convId;
        if (cleanEntryId !== undefined) savedCleanEntry = cleanEntryId;
      },
    });

    const baseTask: WorkTask = {
      id: 't-1',
      title: '写工具',
      brief: '写个 CLI',
      deliverableSpec: 'cli.js',
      contract: { objective: '写个 CLI', deliverable: 'cli.js', outputs: [{ kind: 'text', description: '结论' }] },
      assigneeId: 'tpl-1',
      assigneeName: '助手',
      workerId: 'w-thread-1',
      turnMode: 'initial',
      priority: 'P2',
      labels: [],
      blockedBy: [],
      isReview: false,
      depth: 0,
      childCount: 0,
      estTokens: 1_000,
      acceptanceCommand: [],
      acceptanceTemplate: 'http-ok',
      status: 'running',
      workspaceRelPath: 'threads/th-1',
      createdAt: 0,
      updatedAt: 0,
      artifacts: [],
      attempts: 1,
      tokensUsed: 0,
      costUsd: 0,
      steps: [],
    };

    // Turn 1: cold start creates persistent ownerless conversation
    await brain.execute({ task: baseTask, workspaceDir: dir, log: () => undefined });
    expect(createdCount).toBe(1);
    expect(savedConvId).toBe('42');
    expect(savedCleanEntry).toBe(3);

    // Turn 2: append reuses conversation 42 without creating a new one, and sends concise delta prompt
    const turn2: WorkTask = {
      ...baseTask,
      id: 't-2',
      turnMode: 'append',
      contract: { objective: '加一个 --json 参数', deliverable: 'cli.js', outputs: [{ kind: 'text', description: '结论' }] },
    };
    await brain.execute({ task: turn2, workspaceDir: dir, log: () => undefined });
    expect(createdCount).toBe(1);
    expect(submitted[1]?.content).toContain('加一个 --json 参数');
    expect(submitted[1]?.content).toContain('增量要求');
    expect(buildDeltaPrompt({ ...turn2, turnMode: 'pivot' })).toContain('调整了方向');

    // Prune Turn 2 entries (4, 5) back to clean Turn 1 checkpoint (3)
    const pruned = await brain.pruneAfterCheckpoint(
      { runtimeKey: 'w-thread-1', ownerId: 'tpl-1' },
      '42',
      3,
      '改用 YAML 输出',
    );
    expect(pruned).toBe(2);
    const pruneEntry = submitted.find((s) => s.entry?.kind === 'opc.worker_prune');
    expect(pruneEntry?.entry?.edits).toHaveLength(2);
  });
});

describe('联动修复 #1：多工作线真正并行（OwnerQueue 按 workerId 分桶 + 支持取消排队）', () => {
  it('两个工作线共用同一模板 assigneeId 时，分配独立 workerId 并可按 workerKey 并行调度', async () => {
    const runningNow = new Set<string>();
    let maxConcurrency = 0;
    const resolvers = new Map<string, () => void>();

    const queue = new OwnerQueue({
      run: (taskId) =>
        new Promise<void>((resolve) => {
          runningNow.add(taskId);
          maxConcurrency = Math.max(maxConcurrency, runningNow.size);
          resolvers.set(taskId, () => {
            runningNow.delete(taskId);
            resolve();
          });
        }),
    });

    const template = threads.createWorker({ name: '模板执行体', template: 'research' });
    const thA = threads.createThread({ title: '调研 A', goal: 'A' });
    const thB = threads.createThread({ title: '调研 B', goal: 'B' });
    const wA = threads.ensureWorker({ threadId: thA.id, ownerId: template.id, name: template.name });
    const wB = threads.ensureWorker({ threadId: thB.id, ownerId: template.id, name: template.name });
    expect(wA.id).not.toBe(wB.id);

    // Enqueued by workerId (runtimeKey) -> runs truly in parallel!
    queue.enqueue(wA.id, 'task-A');
    queue.enqueue(wB.id, 'task-B');
    expect(maxConcurrency).toBe(2);

    // Queued third task on wA can be cancelled cleanly before starting
    queue.enqueue(wA.id, 'task-A-queued');
    expect(queue.cancelQueued(wA.id, 'task-A-queued')).toBe(true);
    expect(queue.waitingFor(wA.id)).toHaveLength(0);

    resolvers.get('task-A')?.();
    resolvers.get('task-B')?.();
  });
});

describe('联动修复 #2：浏览器截图多模态图像块与线程级会话复用', () => {
  it('browser_screenshot 返回 image(base64) + text 双内容块，且同线程不同任务共享同一浏览器 sessionId', async () => {
    const pngPath = path.join(dir, 'shot.png');
    const fakePngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(pngPath, fakePngBytes);

    const fakeInstall = {
      status: () => ({ healthy: true, installed: true }),
      settings: () => ({
        enabled: true,
        allowAllDomains: true,
        allowedDomains: [],
        blockedDomains: [],
        requireApprovalFor: [],
        maxOutputBytes: 32_000,
      }),
      profilePath: () => path.join(dir, 'profile'),
      binaryPath: () => 'agent-browser',
    } as unknown as BrowserInstallService;

    const broker = new BrowserBroker(fakeInstall, dir);
    const id1 = broker.sessionId({ taskId: 'task-turn-1', threadId: 'thread-shared', workerId: 'w-1' });
    const id2 = broker.sessionId({ taskId: 'task-turn-2', threadId: 'thread-shared', workerId: 'w-1' });
    expect(id1).toBe(id2);

    const fakeBroker = {
      ...broker,
      settings: () => fakeInstall.settings(),
      isUrlAllowed: () => true,
      sessionId: (input: { taskId: string; threadId?: string; workerId: string }) => broker.sessionId(input),
      screenshot: async () => ({ ok: true, text: '截图成功', path: pngPath }),
    } as unknown as BrowserBroker;

    const ext = createBrowserToolExtension({
      broker: fakeBroker,
      taskId: () => 'task-turn-1',
      threadId: () => 'thread-shared',
      workerId: 'w-1',
      userId: 'user',
      workspace: () => dir,
    });

    const shotTool = ext.tools?.find((t) => t.name === 'browser_screenshot') as unknown as {
      execute: (args: unknown) => Promise<ToolExecutionResult>;
    };
    const result = await shotTool.execute({});
    expect(result.isError).toBeUndefined();
    expect(result.output?.[0]).toEqual({
      type: 'image',
      data: fakePngBytes.toString('base64'),
      mimeType: 'image/png',
    });
    expect(result.output?.[1]).toMatchObject({ type: 'text' });

    await broker.dispose();
  });
});
