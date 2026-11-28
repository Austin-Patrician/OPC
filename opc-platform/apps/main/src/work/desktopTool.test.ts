import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolExecutionResult } from '@earendil-works/pi-durable';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBroker } from '../desktop/broker';
import { DEFAULT_DESKTOP_APPROVALS } from '../desktop/policy';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { TaskRepository } from '../data/taskRepository';
import { ThreadRepository } from '../data/threadRepository';
import { createDesktopToolExtension } from './desktopTool';
import { WorkService } from './workService';

let dir: string;
let db: CompanyDatabase;
let threads: ThreadRepository;
let tasks: TaskRepository;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-desktop-tool-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  threads = new ThreadRepository(db);
  tasks = new TaskRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function getTool(ext: ReturnType<typeof createDesktopToolExtension>, name: string) {
  const found = ext.tools?.find((t) => t.name === name);
  if (!found) throw new Error(`Tool ${name} not found`);
  return found as unknown as {
    execute: (
      args: Record<string, unknown>,
      api?: unknown,
      context?: { abortSignal?: AbortSignal },
    ) => Promise<ToolExecutionResult>;
  };
}

function makeDesktopBrokerStub(overrides: Partial<{
  controlMode: 'hybrid' | 'background';
  blockedApps: string[];
}> = {}) {
  const controlMode = overrides.controlMode ?? 'hybrid';
  const blockedApps = overrides.blockedApps ?? ['微信'];

  const execute = vi.fn(async (_input: unknown, command: string) => {
    if (command === 'snapshot') {
      return { ok: true, text: '{"ok":true,"data":{"ref_count":2,"tree":{"children":[{"ref_id":"@s1:e1","name":"输入"}]}}}' };
    }
    return { ok: true, text: JSON.stringify({ ok: true, command }) };
  });

  const shotPath = path.join(dir, 'shot.png');
  writeFileSync(shotPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 1]));

  const captureScreenshot = vi.fn(async () => ({
    ok: true,
    text: '{"ok":true}',
    path: shotPath,
    relPath: 'desktop-shots/shot.png',
    frame: {
      originX: 100,
      originY: 200,
      width: 1000,
      height: 600,
      scaleFactor: 2,
      app: 'Notes',
      windowId: 'w-1',
      capturedAt: Date.now(),
    },
  }));

  const broker = {
    settings: () => ({
      enabled: true,
      controlMode,
      cursorOverlay: true,
      blockedApps,
      requireApprovalFor: [...DEFAULT_DESKTOP_APPROVALS],
    }),
    assertAppAllowed: (target: unknown) => {
      const label = typeof target === 'string' ? target : '';
      if (/wechat|微信/i.test(label)) {
        throw new Error(`应用「${label}」在受保护黑名单中，已拒绝访问`);
      }
    },
    lookupRefMeta: (_taskId: string, refId: string) => {
      if (refId === '@s1:e9') {
        return { ref: '@s1:e9', role: 'button', name: '发送', app: 'Slack', windowId: 'w-9' };
      }
      if (refId === '@s1:e2') {
        return { ref: '@s1:e2', role: 'button', name: '新建笔记', app: 'Notes', windowId: 'w-1' };
      }
      return undefined;
    },
    lastCaptureFrame: () => ({
      originX: 100,
      originY: 200,
      width: 1000,
      height: 600,
      scaleFactor: 2,
      app: 'Notes',
      windowId: 'w-1',
      capturedAt: Date.now(),
    }),
    listApps: vi.fn(async () => [
      { name: 'Notes', bundleId: 'com.apple.Notes', icon: 'data:image/png;base64,AAA' },
      { name: 'WeChat', bundleId: 'com.tencent.xinWeChat', icon: 'data:image/png;base64,BBB' },
    ]),
    listWindowDetails: vi.fn(async () => [
      { id: 'w-1', app: 'Notes', title: '备忘录', visible: true },
      { id: 'w-2', app: 'WeChat', title: '微信', visible: true },
    ]),
    listDisplays: vi.fn(async () => []),
    execute,
    captureScreenshot,
  } as unknown as DesktopBroker;

  return { broker, execute, captureScreenshot };
}

describe('opc.desktop curated tool extension', () => {
  it('registers 11 deferred desktop_* tools and filters blacklisted apps in desktop_list', async () => {
    const { broker } = makeDesktopBrokerStub();
    const ext = createDesktopToolExtension({
      broker,
      taskId: () => 'task-1',
      workerId: 'worker-1',
    });

    expect(ext.name).toBe('opc.desktop');
    expect(ext.tools).toHaveLength(11);
    expect(ext.tools?.every((tool) => tool.deferred === true)).toBe(true);

    const listTool = getTool(ext, 'desktop_list');
    const appsRes = await listTool.execute({ kind: 'apps' });
    const parsedApps = JSON.parse((appsRes.output![0] as { type: 'text'; text: string }).text);
    expect(parsedApps.apps).toEqual([{ name: 'Notes', bundleId: 'com.apple.Notes' }]);

    const windowsRes = await listTool.execute({ kind: 'windows' });
    const parsedWins = JSON.parse((windowsRes.output![0] as { type: 'text'; text: string }).text);
    expect(parsedWins.windows).toHaveLength(1);
    expect(parsedWins.windows[0].app).toBe('Notes');
  });

  it('gates high-risk semantic clicks and quits via authorize, while forcing sensitive typing to takeover', async () => {
    const { broker, execute } = makeDesktopBrokerStub();
    const authorize = vi.fn(() => false);
    const ext = createDesktopToolExtension({
      broker,
      taskId: () => 'task-1',
      workerId: 'worker-1',
      authorize,
    });

    const actTool = getTool(ext, 'desktop_act');
    const denied = await actTool.execute({ action: 'click', ref: '@s1:e9' });
    expect(denied.isError).toBe(true);
    expect(authorize).toHaveBeenCalledWith(
      'desktop_act',
      expect.stringContaining('发送'),
      expect.objectContaining({ action: 'send-message', appId: 'Slack' }),
    );
    expect(execute).not.toHaveBeenCalled();

    const safeAllowed = await actTool.execute({ action: 'click', ref: '@s1:e2' });
    expect(safeAllowed.isError).toBeUndefined();
    expect(execute).toHaveBeenCalledWith({ taskId: 'task-1', workerId: 'worker-1' }, 'click', ['@s1:e2'], {});

    const typeTool = getTool(ext, 'desktop_type');
    const sensitiveDenied = await typeTool.execute({
      ref: '@s1:e2',
      text: 'hunter2',
      sensitive: true,
    });
    expect(sensitiveDenied.isError).toBe(true);
    expect((sensitiveDenied.output![0] as { text: string }).text).toContain('desktop_request_takeover');
  });

  it('maps normalized visual coordinates in hybrid mode and blocks visual clicks in background mode', async () => {
    const hybrid = makeDesktopBrokerStub({ controlMode: 'hybrid' });
    const hybridExt = createDesktopToolExtension({
      broker: hybrid.broker,
      taskId: () => 'task-1',
      workerId: 'worker-1',
    });

    const visualTool = getTool(hybridExt, 'desktop_visual_act');
    await visualTool.execute({ action: 'click', nx: 500, ny: 500 });
    expect(hybrid.execute).toHaveBeenCalledWith(
      { taskId: 'task-1', workerId: 'worker-1' },
      'mouse-click',
      ['--xy=600,500'],
      expect.objectContaining({ headed: true, appId: 'Notes' }),
    );

    const bg = makeDesktopBrokerStub({ controlMode: 'background' });
    const bgExt = createDesktopToolExtension({
      broker: bg.broker,
      taskId: () => 'task-1',
      workerId: 'worker-1',
    });
    const bgVisual = getTool(bgExt, 'desktop_visual_act');
    const blocked = await bgVisual.execute({ action: 'click', nx: 500, ny: 500 });
    expect(blocked.isError).toBe(true);
    expect((blocked.output![0] as { text: string }).text).toContain('纯后台无打扰模式');
  });

  it('desktop_request_takeover pauses via WorkService with screenshot card and resumes with fresh snapshot', async () => {
    const cards: Array<{ reportId: string; tool: string; desktop?: { action: string; appId?: string; screenshot?: { taskId: string; relPath: string } } }> = [];
    const workspaceDir = path.join(dir, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });

    const work = new WorkService({
      db,
      threads,
      paths: {
        userData: dir,
        database: path.join(dir, 'company.db'),
        workspaceDir,
        agentsDir: path.join(dir, 'agents'),
        artifactsDir: path.join(dir, 'artifacts'),
        logsDir: path.join(dir, 'logs'),
        probeDir: path.join(dir, 'probe'),
        cacheDir: path.join(dir, 'cache'),
      } as never,
      upsertTaskCard: () => undefined,
      onApprovalCard: ({ report, tool, desktop }) => {
        cards.push({ reportId: report.id, tool, desktop });
      },
    });

    const template = threads.createWorker({ name: '桌面助理', template: 'ops' });
    const thread = threads.createThread({ title: '桌面任务', goal: '完成桌面登录确认' });
    const created = work.createTask({
      title: thread.title,
      contract: {
        objective: thread.goal,
        deliverable: 'output/done.txt',
        outputs: [],
      },
      assigneeId: template.id,
      threadId: thread.id,
      estTokens: 5_000,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    tasks.setStatus(created.task.id, 'running');

    const { broker } = makeDesktopBrokerStub({ blockedApps: [] });
    const ext = createDesktopToolExtension({
      broker,
      taskId: () => created.task.id,
      workerId: template.id,
      requestTakeover: (req) => work.requestDesktopTakeover(req),
    });

    const takeoverTool = getTool(ext, 'desktop_request_takeover');
    const pending = takeoverTool.execute({
      reason: '需要确认登录桌面软件',
      instructions: '请在弹出的桌面窗口中完成登录后点击继续。',
      kind: 'login',
      app: 'Notes',
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      tool: 'desktop_request_takeover',
      desktop: {
        action: 'takeover',
        appId: 'Notes',
        screenshot: { taskId: created.task.id, relPath: 'desktop-shots/shot.png' },
      },
    });

    const answered = await work.answerFor({
      reportId: cards[0]!.reportId,
      text: '已登录完成',
      allow: true,
      scope: 'once',
    });
    expect(answered).toEqual({ ok: true, delivered: 'live' });

    const final = await pending;
    expect(final.isError).toBeUndefined();
    expect((final.output![0] as { text: string }).text).toContain('已登录完成');
  });

  it('turns Screen Recording permission errors into actionable instructions', async () => {
    const { broker } = makeDesktopBrokerStub();
    (broker.captureScreenshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      text: 'Screen Recording permission not granted',
    });

    const ext = createDesktopToolExtension({
      broker,
      taskId: () => 'task-1',
      workerId: 'worker-1',
    });

    const shotTool = getTool(ext, 'desktop_screenshot');
    const result = await shotTool.execute({});
    expect(result.isError).toBe(true);
    const message = (result.output![0] as { text: string }).text;
    expect(message).toContain('屏幕录制');
    expect(message).toContain('重启');
  });

  it('executes ref-less desktop_batch type via focus-window, clipboard-set, and paste in hybrid mode', async () => {
    const { broker, execute } = makeDesktopBrokerStub({ controlMode: 'hybrid' });
    const ext = createDesktopToolExtension({
      broker,
      taskId: () => 'task-1',
      workerId: 'worker-1',
    });

    const batchTool = getTool(ext, 'desktop_batch');
    const pasteKey = process.platform === 'darwin' ? 'cmd+v' : 'ctrl+v';
    const result = await batchTool.execute({
      app: 'Code',
      windowId: 'w-358717',
      steps: [{ action: 'type', text: 'Git: Stage All' }],
      snapshotAfter: false,
    });

    expect(result.isError).toBeUndefined();
    expect(execute).toHaveBeenNthCalledWith(
      1,
      { taskId: 'task-1', workerId: 'worker-1' },
      'focus-window',
      [],
      { appId: 'Code', windowId: 'w-358717' },
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      { taskId: 'task-1', workerId: 'worker-1' },
      'clipboard-set',
      ['--stdin'],
      { stdin: 'Git: Stage All' },
    );
    expect(execute).toHaveBeenNthCalledWith(
      3,
      { taskId: 'task-1', workerId: 'worker-1' },
      'press',
      [pasteKey],
      { appId: 'Code', windowId: 'w-358717', headed: true },
    );
  });

  it('reports failed step index, completed steps, and paste hint when desktop_batch type fails post-verification', async () => {
    const { broker, execute } = makeDesktopBrokerStub({ controlMode: 'hybrid' });
    execute.mockImplementation(async (_input: unknown, command: string) => {
      if (command === 'type') {
        return { ok: false, text: 'Post-action state does not match the requested change' };
      }
      return { ok: true, text: JSON.stringify({ ok: true, command }) };
    });

    const ext = createDesktopToolExtension({
      broker,
      taskId: () => 'task-1',
      workerId: 'worker-1',
    });

    const batchTool = getTool(ext, 'desktop_batch');
    const result = await batchTool.execute({
      app: 'Code',
      windowId: 'w-358717',
      steps: [
        { action: 'focus', ref: '@s1:e2' },
        { action: 'type', ref: '@s1:e2', text: 'git add -A' },
      ],
    });

    expect(result.isError).toBe(true);
    const text = (result.output![0] as { text: string }).text;
    expect(text).toContain('第 2/2 步 (type) 失败');
    expect(text).toContain('#1 focus: ok');
    expect(text).toContain('action: "paste"');
  });

  it('supports desktop_type with method: paste and formats hotkey keyboard layout errors', async () => {
    const { broker, execute } = makeDesktopBrokerStub({ controlMode: 'hybrid' });
    const ext = createDesktopToolExtension({
      broker,
      taskId: () => 'task-1',
      workerId: 'worker-1',
    });

    const typeTool = getTool(ext, 'desktop_type');
    const pasteKey = process.platform === 'darwin' ? 'cmd+v' : 'ctrl+v';
    const typed = await typeTool.execute({
      ref: '@s1:e2',
      text: '中文与终端命令',
      method: 'paste',
      app: 'Code',
    });

    expect(typed.isError).toBeUndefined();
    expect(execute).toHaveBeenNthCalledWith(
      1,
      { taskId: 'task-1', workerId: 'worker-1' },
      'focus',
      ['@s1:e2'],
      { appId: 'Code' },
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      { taskId: 'task-1', workerId: 'worker-1' },
      'clipboard-set',
      ['--stdin'],
      { stdin: '中文与终端命令' },
    );
    expect(execute).toHaveBeenNthCalledWith(
      3,
      { taskId: 'task-1', workerId: 'worker-1' },
      'press',
      [pasteKey],
      { appId: 'Code', headed: true },
    );

    execute.mockResolvedValueOnce({
      ok: false,
      text: "No unmodified key types '`' in the active keyboard layout",
    });
    const hotkeyTool = getTool(ext, 'desktop_hotkey');
    const hotkeyErr = await hotkeyTool.execute({ app: 'Code', combo: 'ctrl+`' });
    expect(hotkeyErr.isError).toBe(true);
    expect((hotkeyErr.output![0] as { text: string }).text).toContain('grave');
  });
});
