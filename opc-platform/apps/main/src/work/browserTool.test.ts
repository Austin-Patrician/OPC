import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolExecutionResult } from '@earendil-works/pi-durable';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserBroker } from '../browser/broker';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { TaskRepository } from '../data/taskRepository';
import { ThreadRepository } from '../data/threadRepository';
import { createBrowserToolExtension, type BrowserTakeoverRequest } from './browserTool';
import { WorkService } from './workService';

let dir: string;
let db: CompanyDatabase;
let threads: ThreadRepository;
let tasks: TaskRepository;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-browser-tool-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  threads = new ThreadRepository(db);
  tasks = new TaskRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeBrokerStub() {
  const show = vi.fn(async () => undefined);
  const command = vi.fn(async (_input: unknown, cmd: string) => {
    if (cmd === 'get') return { ok: true, text: 'https://www.xiaohongshu.com/explore' };
    if (cmd === 'snapshot') return { ok: true, text: '@e1 input "搜索笔记"\n@e2 button "搜索"' };
    return { ok: true, text: 'ok' };
  });
  const batch = vi.fn(async (_input: unknown, _commands: string[][]) => ({ ok: true, text: '[{"ok":true},{"ok":true}]' }));
  const screenshot = vi.fn(
    async (_input: unknown, _opts?: { annotate?: boolean; fullPage?: boolean; selector?: string }) => ({
      ok: true,
      text: '已标注截图',
      path: '',
    }),
  );
  const clickRisk = vi.fn(async () => ({ consequential: false }));

  const broker = {
    settings: () => ({
      enabled: true,
      mode: 'managed' as const,
      attachMethod: 'auto-connect' as const,
      cdpEndpoint: '9222',
      pinTab: true,
      headed: true,
      inputMode: 'human' as const,
      allowAllDomains: false,
      allowedDomains: ['xiaohongshu.com', '*.xiaohongshu.com'],
      blockedDomains: [],
      requireApprovalFor: ['external-submit', 'download', 'upload', 'authentication', 'destructive'],
      maxOutputBytes: 32_000,
    }),
    isUrlAllowed: (url: string) => url.includes('xiaohongshu.com'),
    sessionId: () => 'opc-session-1',
    show,
    command,
    batch,
    screenshot,
    clickRisk,
  } as unknown as BrowserBroker;

  return { broker, show, command, batch, screenshot, clickRisk };
}

function getTool(ext: ReturnType<typeof createBrowserToolExtension>, name: string) {
  const found = ext.tools?.find((t) => t.name === name);
  if (!found) throw new Error(`Tool ${name} not found`);
  return found as unknown as {
    execute: (args: Record<string, unknown>, api?: unknown, context?: { abortSignal?: AbortSignal }) => Promise<ToolExecutionResult>;
  };
}

describe('browserTool 人机接管与高效工具集', () => {
  it('browser_request_takeover 置顶浏览器、通过 WorkService 挂起等待并在用户点击继续后带回最新快照', async () => {
    const cards: Array<{ reportId: string; tool: string; browser?: { action: string; kind?: string; instructions?: string } }> = [];
    const resolvedCards: Array<{ reportId: string; state: string }> = [];

    const work = new WorkService({
      db,
      threads,
      paths: {
        userData: dir,
        database: path.join(dir, 'company.db'),
        workspaceDir: path.join(dir, 'workspace'),
        agentsDir: path.join(dir, 'agents'),
        artifactsDir: path.join(dir, 'artifacts'),
        attachmentsDir: path.join(dir, 'attachments'),
      } as never,
      upsertTaskCard: () => undefined,
      onApprovalCard: ({ report, tool, browser }) => {
        cards.push({ reportId: report.id, tool, browser });
      },
      onApprovalResolved: (reportId, state) => {
        resolvedCards.push({ reportId, state });
      },
    });

    const template = threads.createWorker({ name: '调研员', template: 'research' });
    const thread = threads.createThread({ title: '检索账号数据', goal: '抓小红书笔记' });
    const first = work.createTask({
      title: thread.title,
      contract: {
        objective: thread.goal,
        deliverable: 'output/notes.md',
        outputs: [{ kind: 'file', path: 'output/notes.md', description: '笔记摘要' }],
      },
      assigneeId: template.id,
      threadId: thread.id,
      estTokens: 5_000,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const created = first.task;
    tasks.setStatus(created.id, 'running');

    const { broker, show, command } = makeBrokerStub();
    let getCount = 0;
    command.mockImplementation(async (_input: unknown, cmd: string) => {
      if (cmd === 'get') {
        getCount += 1;
        return {
          ok: true,
          text: getCount === 1 ? 'https://www.xiaohongshu.com/login' : 'https://www.xiaohongshu.com/explore?loggedIn=1',
        };
      }
      return { ok: true, text: '@e10 textbox "搜索"\n@e11 button "发布"' };
    });

    const ext = createBrowserToolExtension({
      broker,
      taskId: () => created.id,
      threadId: () => thread.id,
      workerId: created.workerId!,
      userId: 'user',
      workspace: () => dir,
      requestTakeover: (req: BrowserTakeoverRequest) => work.requestBrowserTakeover(req),
    });

    const takeoverTool = getTool(ext, 'browser_request_takeover');
    const pendingPromise = takeoverTool.execute({
      reason: '需要扫码登录小红书',
      instructions: '请在打开的 Chrome 窗口用手机 App 扫码登录，完成后点击「我已完成，继续执行」。',
      kind: 'login',
    });

    // Wait for card emission
    for (let i = 0; i < 20 && cards.length === 0; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    expect(show).toHaveBeenCalledWith(created.id);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.tool).toBe('browser_request_takeover');
    expect(cards[0]?.browser).toMatchObject({ action: 'takeover', kind: 'login' });
    expect(threads.getThread(thread.id)?.state).toBe('waiting');

    // User clicks "我已完成，继续执行"
    const answerRes = await work.answerFor({
      reportId: cards[0]!.reportId,
      text: '已扫码登录成功',
      allow: true,
      scope: 'once',
    });
    expect(answerRes).toEqual({ ok: true, delivered: 'live' });

    const result = await pendingPromise;
    expect(result.isError).toBeUndefined();
    const outText = (result.output?.[0] as { text: string }).text;
    expect(outText).toContain('已扫码登录成功');
    expect(outText).toContain('https://www.xiaohongshu.com/explore?loggedIn=1');
    expect(outText).toContain('@e10 textbox "搜索"');
    expect(resolvedCards).toEqual([{ reportId: cards[0]!.reportId, state: 'allowed' }]);
    expect(threads.getThread(thread.id)?.state).toBe('running');

    await work.dispose();
  });

  it('browser_batch 拦截敏感字段、检查跳转权限并附带批处理后最新快照', async () => {
    const { broker, batch, command } = makeBrokerStub();
    const authorize = vi.fn(() => false);
    const ext = createBrowserToolExtension({
      broker,
      taskId: () => 't-1',
      threadId: () => 'th-1',
      workerId: 'w-1',
      userId: 'user',
      workspace: () => dir,
      authorize,
    });

    const batchTool = getTool(ext, 'browser_batch');

    // Reject sensitive fill inside batch
    const blockedSensitive = await batchTool.execute({
      steps: [{ action: 'fill', ref: '@e1', value: 'my-secret', sensitive: true }],
    });
    expect(blockedSensitive.isError).toBe(true);
    expect((blockedSensitive.output?.[0] as { text: string }).text).toContain('browser_request_takeover');

    // Reject unapproved domain navigation inside batch
    const blockedDomain = await batchTool.execute({
      steps: [{ action: 'open', url: 'https://unknown-evil.example.com' }],
    });
    expect(blockedDomain.isError).toBe(true);
    expect(authorize).toHaveBeenCalledTimes(1);

    // Valid batch executes and returns post-snapshot (including wait with numeric amount)
    const okRes = await batchTool.execute({
      steps: [
        { action: 'open', url: 'https://www.xiaohongshu.com/explore' },
        { action: 'type', ref: '@e1', value: 'AI 工作台' },
        { action: 'press', value: 'Enter' },
        { action: 'wait', value: '1200' },
        { action: 'wait', amount: 3500 },
      ],
    });
    expect(okRes.isError).toBeUndefined();
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[1]).toEqual([
      ['open', 'https://www.xiaohongshu.com/explore'],
      ['type', '@e1', 'AI 工作台'],
      ['press', 'Enter'],
      ['wait', '1200'],
      ['wait', '3500'],
    ]);
    expect(command).toHaveBeenCalledWith(expect.anything(), 'snapshot', ['-i']);
    expect((okRes.output?.[0] as { text: string }).text).toContain('最新页面快照');
  });

  it('browser_type / browser_hover / browser_screenshot({ annotate, fullPage }) 正确透传参数且遵循敏感约束', async () => {
    const { broker, command, screenshot } = makeBrokerStub();
    const ext = createBrowserToolExtension({
      broker,
      taskId: () => 't-1',
      threadId: () => 'th-1',
      workerId: 'w-1',
      userId: 'user',
      workspace: () => dir,
    });

    const typeTool = getTool(ext, 'browser_type');
    expect((await typeTool.execute({ ref: '@e1', value: 'pwd', sensitive: true })).isError).toBe(true);
    expect((await typeTool.execute({ ref: '@e1', value: 'hello' })).isError).toBeUndefined();
    expect(command).toHaveBeenCalledWith(expect.anything(), 'type', ['@e1', 'hello']);

    const hoverTool = getTool(ext, 'browser_hover');
    expect((await hoverTool.execute({ ref: '@e9' })).isError).toBeUndefined();
    expect(command).toHaveBeenCalledWith(expect.anything(), 'hover', ['@e9']);

    const shotTool = getTool(ext, 'browser_screenshot');
    expect((await shotTool.execute({ annotate: true, fullPage: true })).isError).toBeUndefined();
    expect(screenshot).toHaveBeenCalledWith(expect.anything(), { annotate: true, fullPage: true });
  });

  it('扫码登录接管自动附带元素截图且不强抢窗口焦点；选择器失败自动回退并在 CAPTCHA 时置顶窗口', async () => {
    const cards: Array<{
      reportId: string;
      browser?: {
        action: string;
        kind?: string;
        screenshot?: { taskId: string; relPath: string };
        screenshotSelector?: string;
      };
    }> = [];

    const work = new WorkService({
      db,
      threads,
      paths: {
        userData: dir,
        database: path.join(dir, 'company.db'),
        workspaceDir: path.join(dir, 'workspace'),
        agentsDir: path.join(dir, 'agents'),
        artifactsDir: path.join(dir, 'artifacts'),
        attachmentsDir: path.join(dir, 'attachments'),
      } as never,
      upsertTaskCard: () => undefined,
      onApprovalCard: ({ report, browser }) => {
        cards.push({ reportId: report.id, browser });
      },
    });

    const template = threads.createWorker({ name: '账号助手', template: 'research' });
    const thread = threads.createThread({ title: '扫码登录测试', goal: '登录并读取主页' });
    const first = work.createTask({
      title: thread.title,
      contract: {
        objective: thread.goal,
        deliverable: 'output/profile.md',
        outputs: [{ kind: 'file', path: 'output/profile.md', description: '主页数据' }],
      },
      assigneeId: template.id,
      threadId: thread.id,
      estTokens: 5_000,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const created = first.task;
    tasks.setStatus(created.id, 'running');

    const { broker, show, screenshot } = makeBrokerStub();
    screenshot.mockImplementation(async (_input: unknown, opts?: { selector?: string }) => {
      if (opts?.selector === '@e-missing') return { ok: false, text: 'missing', path: '' };
      return {
        ok: true,
        text: 'ok',
        path: path.join(dir, 'browser/screenshot-qr.png'),
        relPath: 'browser/screenshot-qr.png',
      } as never;
    });

    const ext = createBrowserToolExtension({
      broker,
      taskId: () => created.id,
      threadId: () => thread.id,
      workerId: created.workerId!,
      userId: 'user',
      workspace: () => dir,
      requestTakeover: (req: BrowserTakeoverRequest) => work.requestBrowserTakeover(req),
    });

    const takeoverTool = getTool(ext, 'browser_request_takeover');

    // 1. QR login with screenshot -> attaches artifact relPath and does NOT hijack window focus
    const loginPromise = takeoverTool.execute({
      reason: '扫码登录',
      instructions: '请使用手机扫码二维码后点击继续。',
      kind: 'login',
      screenshotSelector: '@e88',
    });
    for (let i = 0; i < 20 && cards.length < 1; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    expect(screenshot).toHaveBeenCalledWith(expect.anything(), { selector: '@e88' });
    expect(show).not.toHaveBeenCalled();
    expect(cards[0]?.browser).toMatchObject({
      action: 'takeover',
      kind: 'login',
      screenshot: { taskId: created.id, relPath: 'browser/screenshot-qr.png' },
      screenshotSelector: '@e88',
    });
    await work.answerFor({ reportId: cards[0]!.reportId, text: '已扫码', allow: true, scope: 'once' });
    await loginPromise;

    // 2. CAPTCHA with failing selector falls back to viewport screenshot AND pops up browser window
    const captchaPromise = takeoverTool.execute({
      reason: '滑块验证',
      instructions: '请在浏览器中完成滑块验证。',
      kind: 'captcha',
      screenshotSelector: '@e-missing',
    });
    for (let i = 0; i < 20 && cards.length < 2; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    expect(screenshot).toHaveBeenCalledWith(expect.anything(), { selector: '@e-missing' });
    expect(screenshot).toHaveBeenCalledWith(expect.anything());
    expect(show).toHaveBeenCalledWith(created.id);
    expect(cards[1]?.browser?.screenshot).toEqual({ taskId: created.id, relPath: 'browser/screenshot-qr.png' });
    await work.answerFor({ reportId: cards[1]!.reportId, text: '已通过', allow: true, scope: 'once' });
    await captchaPromise;

    await work.dispose();
  });

  it('默认密码登录页调用 browser_request_takeover(login) 时先切换扫码再截图，纯账密页才置顶窗口，preferQrLogin:false 时跳过切换', async () => {
    const cards: Array<{
      reportId: string;
      browser?: {
        action: string;
        kind?: string;
        instructions?: string;
        screenshot?: { taskId: string; relPath: string };
      };
    }> = [];

    const work = new WorkService({
      db,
      threads,
      paths: {
        userData: dir,
        database: path.join(dir, 'company.db'),
        workspaceDir: path.join(dir, 'workspace'),
        agentsDir: path.join(dir, 'agents'),
        artifactsDir: path.join(dir, 'artifacts'),
        attachmentsDir: path.join(dir, 'attachments'),
      } as never,
      upsertTaskCard: () => undefined,
      onApprovalCard: ({ report, browser }) => {
        cards.push({ reportId: report.id, browser });
      },
    });

    const template = threads.createWorker({ name: '扫码助手', template: 'research' });
    const thread = threads.createThread({ title: '自动切扫码测试', goal: '登录并处理业务' });
    const first = work.createTask({
      title: thread.title,
      contract: {
        objective: thread.goal,
        deliverable: 'output/done.md',
        outputs: [{ kind: 'file', path: 'output/done.md', description: '结果' }],
      },
      assigneeId: template.id,
      threadId: thread.id,
      estTokens: 5_000,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const created = first.task;
    tasks.setStatus(created.id, 'running');

    const { broker, show, screenshot } = makeBrokerStub();
    const callOrder: string[] = [];
    const trySwitchToQrLogin = vi.fn(async () => {
      callOrder.push('switch');
      return { switched: true, method: 'dom' as const, label: 'icon-qrcode' };
    });
    (broker as unknown as { trySwitchToQrLogin: typeof trySwitchToQrLogin }).trySwitchToQrLogin = trySwitchToQrLogin;
    screenshot.mockImplementation(async () => {
      callOrder.push('screenshot');
      return {
        ok: true,
        text: 'ok',
        path: path.join(dir, 'browser/screenshot-qr-switched.png'),
        relPath: 'browser/screenshot-qr-switched.png',
      } as never;
    });

    const ext = createBrowserToolExtension({
      broker,
      taskId: () => created.id,
      threadId: () => thread.id,
      workerId: created.workerId!,
      userId: 'user',
      workspace: () => dir,
      requestTakeover: (req: BrowserTakeoverRequest) => work.requestBrowserTakeover(req),
    });

    const takeoverTool = getTool(ext, 'browser_request_takeover');

    // 1. Default password page switches to QR BEFORE screenshot, appends QR note, skips show()
    const p1 = takeoverTool.execute({
      reason: '需要登录账号',
      instructions: '请输入账号密码完成登录。',
      kind: 'login',
    });
    for (let i = 0; i < 20 && cards.length < 1; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    expect(callOrder).toEqual(['switch', 'screenshot']);
    expect(show).not.toHaveBeenCalled();
    expect(cards[0]?.browser?.instructions).toContain('已自动切换至扫码登录视图');
    expect(cards[0]?.browser?.screenshot).toEqual({
      taskId: created.id,
      relPath: 'browser/screenshot-qr-switched.png',
    });
    await work.answerFor({ reportId: cards[0]!.reportId, text: '已扫码', allow: true, scope: 'once' });
    await p1;

    // 2. Password-only page still calls show() even when screenshot succeeds
    trySwitchToQrLogin.mockResolvedValueOnce({ switched: false, passwordOnly: true } as never);
    const p2 = takeoverTool.execute({
      reason: '请输入密码登录',
      instructions: '该站点仅支持账密登录，请在窗口完成登录。',
      kind: 'login',
    });
    for (let i = 0; i < 20 && cards.length < 2; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    expect(show).toHaveBeenCalledTimes(1);
    await work.answerFor({ reportId: cards[1]!.reportId, text: '已完成', allow: true, scope: 'once' });
    await p2;

    // 3. preferQrLogin: false skips trySwitchToQrLogin
    trySwitchToQrLogin.mockClear();
    const p3 = takeoverTool.execute({
      reason: '请使用邮箱登录',
      instructions: '请扫码或输入邮箱登录。',
      kind: 'login',
      preferQrLogin: false,
    });
    for (let i = 0; i < 20 && cards.length < 3; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    expect(trySwitchToQrLogin).not.toHaveBeenCalled();
    await work.answerFor({ reportId: cards[2]!.reportId, text: '已完成', allow: true, scope: 'once' });
    await p3;

    await work.dispose();
  });
});
