import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, session, shell } from 'electron';
import { ChatService } from './chat/chatService';
import { agentsFromOrg, chatDepartmentsFromOrg, ensureFirstCompany } from './seed/firstCompany';
import { loadSmokeScript } from './smoke';
import { consolidateConversation } from './memory/consolidation';
import { ConsolidationRunStore } from './memory/consolidationRun';
import { MemoryService } from './memory/memoryService';
import { OrgFactService } from './memory/orgFactService';
import { ProjectService } from './org/projectService';
import { resetCompany } from './seed/resetCompany';
import { openCompanyDatabase } from './data/companyDatabase';
import { registerIpc } from './ipc/register';
import { AuthService } from './models/authService';
import { FileCredentialStore } from './models/credentialStore';
import { ImageService } from './models/imageService';
import { ModelConfigService } from './models/modelConfigService';
import { resolveEmployeeModelRef } from './models/employeeModel';
import { SpeechService } from './models/speechService';
import type { Agent, SubtaskDraft } from '@opc/shared/domain';
import { MarketService } from './market/marketService';
import { CompanyService } from './company/companyService';
import { NetworkProxyService } from './network/proxyService';
import { applyProxy, connectProxyRuntime, networkClient } from './network/proxyRuntime';
import { RuntimeService } from './runtime/service';
import { inspectOcrRuntime, resolveOcrAssetsDir } from './ocr/assets';
import { OcrSettingsStore } from './ocr/settings';
import { registerOcrScheme } from './ocr/protocol';
import { OcrService } from './ocr/service';
import { decryptSecret, encryptSecret } from './models/keyCipher';
import { OrgService } from './org/orgService';
import { initAppPaths, appPaths } from './paths';
import { WorkService } from './work/workService';
import { CommService, commSettingsFrom } from './comm/commService';
import { CommRepository } from './data/commRepository';
import { CommScheduler } from './comm/scheduler';
import { BudgetCenter } from './work/budgetCenter';
import { PayrollService } from './work/payroll';
import { applyCompanySetup, parseCompanySetup } from './setup/companySetup';
import { BudgetService } from './work/budgetService';
import { BudgetRepository } from './data/budgetRepository';
import { createInboxRunner } from './comm/inboxRunner';
import { DEMO_TASK } from './work/acceptanceTemplate';

/** §7.5: idle → cooling (no auto replies); much older → archived + consolidated. */
const IDLE_COOLING_MS = 60 * 60 * 1000;
const IDLE_ARCHIVE_MS = 24 * 60 * 60 * 1000;

const isDev = !app.isPackaged;

// Must happen before `app.whenReady()`: the OCR window loads over `opc-ocr://`.
registerOcrScheme();

/** Compile-time constant injected by electron-vite: `out/main`. */
const mainDir = __dirname;

const isSelfTest = process.argv.includes("--self-test");
/** `OPC_OCR_PROBE=<image>`: recognise one image end-to-end (hidden window, WebGPU/WASM), print JSON, exit. */
const isOcrProbe = process.env.OPC_OCR_PROBE;
/** `OPC_SMOKE=1`: boot the real window, exercise preload + IPC, print a report, exit. */
const isSmoke = process.env.OPC_SMOKE === "1";
/** `OPC_WORK_PROBE=1`: run the Phase 0 loop headlessly and print evidence. */
const isWorkProbe = process.env.OPC_WORK_PROBE === "1";
/** `OPC_BUDGET_PROBE=1`: prove reserve → refuse → settle → stop. */
const isBudgetProbe = process.env.OPC_BUDGET_PROBE === "1";
/** `OPC_MODEL_PROBE=1`: import the local pi provider config and run one task with the model brain. */
const isModelProbe = process.env.OPC_MODEL_PROBE === "1";
/** `OPC_DECOMPOSE_PROBE=1`: hierarchy, three hard constraints, children run. */
const isDecomposeProbe = process.env.OPC_DECOMPOSE_PROBE === "1";
/** `OPC_CONSOLIDATION_RUN_PROBE=1`: skipped and done runs are both recorded. */
const isConsolidationRunProbe = process.env.OPC_CONSOLIDATION_RUN_PROBE === '1';
/** `OPC_BLOCKER_PROBE=1`: a task with an unfinished blocker refuses to start. */
const isBlockerProbe = process.env.OPC_BLOCKER_PROBE === '1';
/** `OPC_ISSUE_META_PROBE=1`: priority / labels / due date round-trip through the repo. */
const isIssueMetaProbe = process.env.OPC_ISSUE_META_PROBE === '1';
/** `OPC_PRICING_PROBE=1`: decorated model ids map onto pi's official prices. */
const isPricingProbe = process.env.OPC_PRICING_PROBE === '1';
/** `OPC_PROJECT_PROBE=1`: project assignment scopes facts; other projects stay out. */
const isProjectProbe = process.env.OPC_PROJECT_PROBE === '1';
/** OPC_INBOX_PROBE=1: inbox → wake quota → heartbeat → guards, end to end (F5/F6). */
const isInboxProbe = process.env.OPC_INBOX_PROBE === '1';
/** `OPC_COMPANY_SETUP=<file.json>`: 用公司模板把部门/员工/项目/待办一次建好，然后退出。 */
const companySetupPath = process.env.OPC_COMPANY_SETUP;
/** `OPC_RUN_TASK=<issue key | task id>`: 用真实模型把一条任务跑到终态，然后退出。 */
const runTaskRef = process.env.OPC_RUN_TASK;
const isRunTask = Boolean(runTaskRef);
const isCompanySetup = Boolean(companySetupPath);
/** `OPC_FACT_PROBE=1`: company facts are versioned and reach the employee's prompt. */
const isFactProbe = process.env.OPC_FACT_PROBE === '1';
/** `OPC_ARCHIVE_PROBE=1`: idle conversation → archived → consolidated once. */
const isArchiveProbe = process.env.OPC_ARCHIVE_PROBE === '1';
/** `OPC_CONSOLIDATE_PROBE=1`: a settled conversation becomes long-term memory. */
const isConsolidateProbe = process.env.OPC_CONSOLIDATE_PROBE === '1';
/** `OPC_MEMORY_PROBE=1`: write → recall into the prompt → recall strengthens it. */
const isMemoryProbe = process.env.OPC_MEMORY_PROBE === '1';
/** `OPC_CHAT_PERSIST_PROBE=1`: messages survive a ChatService restart. */
const isChatPersistProbe = process.env.OPC_CHAT_PERSIST_PROBE === '1';
/** `OPC_MARKET_SEED=1`: leave one imported candidate in the market (for UI checks). */
const isMarketSeed = process.env.OPC_MARKET_SEED === '1';
/** `OPC_RESET_COMPANY=1`: wipe business rows, re-seed the clean two-department company. */
const isResetCompany = process.env.OPC_RESET_COMPANY === '1';
/** `OPC_FIRST_RUN_PROBE=1`: a temp userData dir → prove what a fresh install contains. */
const isFirstRunProbe = process.env.OPC_FIRST_RUN_PROBE === '1';
/** `OPC_CHAT_PROBE=1`: 1v1 + department group are created once and reused. */
const isChatProbe = process.env.OPC_CHAT_PROBE === "1";
/** `OPC_REVIEW_PROBE=1`: system pass → manager verdict.json → original accepted. */
const isReviewProbe = process.env.OPC_REVIEW_PROBE === "1";
/** `OPC_MARKET_PROBE=1`: import an agent package, hire it, verify it becomes an employee. */
const isMarketProbe = process.env.OPC_MARKET_PROBE === "1";
/** `OPC_ORG_PROBE=1`: department → hire → dispatch → fire → dispatch refused. */
const isOrgProbe = process.env.OPC_ORG_PROBE === "1";
/** `OPC_IMAGE_LOOP_PROBE=1`: mock image endpoint → agent tool → image-200 acceptance. */
const isImageLoopProbe = process.env.OPC_IMAGE_LOOP_PROBE === "1";
/** `OPC_CRASH_PROBE=start|resume`: kill the app mid-run, then prove it resumes. */
const crashProbe = process.env.OPC_CRASH_PROBE;
let mainWindow: BrowserWindow | null = null;
let chat: ChatService | null = null;
let work: WorkService | null = null;
let comm: CommService | null = null;
let ocrService: OcrService | null = null;
/** Kept at module scope so IPC can trigger a manual wake (§7.2 P0). */
let heartbeat: CommScheduler | null = null;
let disposeIpc: (() => void) | null = null;
function createMainWindow() {
	const window = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 1024,
		minHeight: 640,
		show: false,
		backgroundColor: "#dcdce0",
		title: "OPC Agent 工作台",
		...process.platform === "darwin" ? {
			titleBarStyle: "hiddenInset",
			trafficLightPosition: {
				x: 14,
				y: 6
			}
		} : process.platform === "win32" ? {
			titleBarStyle: "hidden",
			titleBarOverlay: {
				color: "#ebebec",
				symbolColor: "#4a4a4d",
				height: 24
			}
		} : { titleBarStyle: "default" },
		webPreferences: {
			preload: path.join(mainDir, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
			spellcheck: false
		}
	});
	window.once("ready-to-show", () => {
		if (!isSmoke) window.show();
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//.test(url)) shell.openExternal(url);
		return { action: "deny" };
	});
	window.webContents.on("will-navigate", (event, url) => {
		const devOrigin = process.env.ELECTRON_RENDERER_URL;
		if (!(devOrigin ? url.startsWith(devOrigin) : url.startsWith("file://"))) {
			event.preventDefault();
			if (/^https?:\/\//.test(url)) shell.openExternal(url);
		}
	});
	if (isSmoke) attachSmokeTest(window);
	if (isDev && process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL);
	else window.loadFile(path.join(mainDir, "../renderer/index.html"));
	return window;
}
/**
* End-to-end smoke test: proves that the window renders React, that the sandboxed
* preload injected `window.opc`, and that one IPC round-trip mutates the main-side
* service and streams a snapshot back.
*/
function attachSmokeTest(window: BrowserWindow) {
  window.webContents.once('did-finish-load', () => {
    void (async () => {
      try {
        const result = await window.webContents.executeJavaScript(loadSmokeScript());
        process.stdout.write(`SMOKE ${JSON.stringify(result)}\n`);
        app.exit(0);
      } catch (error) {
        console.error('SMOKE_FAILED', error);
        app.exit(1);
      }
    })();
  });
}

/** Where the shipped models live: beside the app in dev, in Resources when packaged. */
function ocrAssetsDir(): string {
  return resolveOcrAssetsDir({
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  });
}

/**
 * The OCR engine is a hidden renderer, created on first use. Constructing the
 * service only wires IPC; the window itself is lazy.
 */
function ensureOcr(settings?: OcrSettingsStore): OcrService {
  if (ocrService) return ocrService;
  ocrService = new OcrService({
    preload: path.join(mainDir, '../preload/ocr.cjs'),
    rendererDir: path.join(mainDir, '../renderer'),
    assetsDir: ocrAssetsDir(),
    ...(settings ? { settings } : {}),
    ...(process.env.ELECTRON_RENDERER_URL ? { devUrl: process.env.ELECTRON_RENDERER_URL } : {}),
  });
  return ocrService;
}

/** Lock the renderer down with a CSP once the window exists (dev needs HMR). */
function hardenSession() {
  if (isDev) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'",
        ],
      },
    });
  });
}

async function bootstrap(): Promise<void> {
  initAppPaths();

  const db = openCompanyDatabase(appPaths.database);
  // Smoke runs must not inherit an exhausted budget from earlier real runs.
  if (isSmoke) db.exec('DELETE FROM budget_reservation; DELETE FROM budget;');
  const credentialStore = new FileCredentialStore(`${appPaths.userData}/credentials.json`);
  const modelConfig = new ModelConfigService(db, credentialStore, networkClient);
  const network = new NetworkProxyService(db, {
    cipher: { encrypt: encryptSecret, decrypt: decryptSecret },
    apply: applyProxy,
  });
  const org = new OrgService(db);
  const market = new MarketService(db, org);
  // 首启不再塞演示公司：空的组织架构就是空的公司，老板自己建，
  // 或者用 `OPC_COMPANY_SETUP=<file>` 导入一个公司模板（同样走 hire/assign）。
  if (org.list().length === 0) {
    // `warn` and not `info`: an empty company is a state the boss must act on.
    console.warn(
      '[OPC] 公司还是空的：去「组织架构」创建部门并招聘，或运行 OPC_COMPANY_SETUP=<file.json> 导入公司模板。',
    );
  }

  chat = new ChatService({
    db,
    agents: agentsFromOrg(org),
    departments: chatDepartmentsFromOrg(org),
    conversations: [],
  });

  // Consolidation summariser: the same provider the agents answer with, so nothing
  // is invented when no model is configured (consolidation then writes nothing).
  const summarize = async ({ messages: turns }: { messages: { senderId: string; text: string }[] }) => {
    const defaults = modelConfig.getDefaults().llm;
    if (!defaults) throw new Error('未配置默认 LLM 模型');
    const models = await modelConfig.runtime.createModels();
    const model = await modelConfig.runtime.resolveModel(defaults.providerId, defaults.modelId);
    if (!model) throw new Error('找不到模型');
    const transcript = turns.map((turn) => `${turn.senderId === 'user' ? '老板' : '员工'}：${turn.text}`).join('\n');
    const answer = await models.complete(model, {
      systemPrompt:
        '把这段对话里值得长期记住的经验、事实和老板偏好提炼成条目。每条一行，格式为「类型|内容」，类型只能是 experience/fact/preference。只提炼对话里明确出现的，不要推测。',
      messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
    } as never);
    const text = ((answer as { content?: { type: string; text?: string }[] }).content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('|'))
      .map((line) => {
        const [rawKind, ...rest] = line.split('|');
        const kind = (['experience', 'fact', 'preference'] as const).includes(
          rawKind!.trim() as 'experience' | 'fact' | 'preference',
        )
          ? (rawKind!.trim() as 'experience' | 'fact' | 'preference')
          : 'fact';
        return { kind, content: rest.join('|').trim() };
      })
      .filter((lesson) => lesson.content.length > 0);
  };
  chat.consolidate = async ({ conversationId, employeeId, messages: turns }) =>
    consolidateConversation(memory, { conversationId, employeeId, messages: turns }, summarize, {
      runs: consolidationRuns,
    });

  // An agent answers with its own model. No provider → no answer, never a canned one.
  chat.replyWithModel = async ({ agent, text }) => {
    const ref = resolveEmployeeModelRef(modelConfig, org, agent.id);
    if (!ref) throw new Error('未配置默认 LLM 模型');
    const models = await modelConfig.runtime.createModels();
    const model = await modelConfig.runtime.resolveModel(ref.providerId, ref.modelId);
    if (!model) throw new Error(`找不到模型 ${ref.providerId}/${ref.modelId}`);

    const answer = await models.complete(model, {
      systemPrompt: [
        `你是「${agent.name}」，岗位是 ${agent.role}。`,
        agent.briefMd ? `你的工作规范：${agent.briefMd}` : '',
        '用中文直接回答老板的问题，简短、具体，不要复述他的原话，也不要编造成果。',
      ]
        .filter(Boolean)
        .join('\n'),
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    } as never);

    const content = (answer as { content?: { type: string; text?: string }[] }).content ?? [];
    return content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
      .trim();
  };

  const memory = new MemoryService(db);
  const facts = new OrgFactService(db);
  const consolidationRuns = new ConsolidationRunStore(db);
  const projects = new ProjectService(db);
  const imageService = new ImageService(modelConfig, networkClient);
  const speechService = new SpeechService(modelConfig, networkClient);

  /**
   * A trial run for the hiring market: the candidate's own charter, one real task,
   * and the tokens it actually cost.
   *
   * The cost is recorded because it is half the decision — a candidate who is right
   * but ten times as expensive is a different hire. Nothing is charged to a budget:
   * a candidate has no employee row and therefore no budget to charge.
   */
  market.runTrial = async ({ candidate, prompt }) => {
    const defaults = modelConfig.getDefaults().llm;
    if (!defaults) throw new Error('未配置默认 LLM 模型');
    const models = await modelConfig.runtime.createModels();
    const model = await modelConfig.runtime.resolveModel(defaults.providerId, defaults.modelId);
    if (!model) throw new Error(`找不到模型 ${defaults.providerId}/${defaults.modelId}`);

    const answer = await models.complete(model, {
      systemPrompt: [
        `你是「${candidate.name}」，应聘岗位是 ${candidate.role}（${candidate.level}）。`,
        candidate.skills.length > 0 ? `你的技能：${candidate.skills.join('、')}` : '',
        candidate.persona ? `你的工作规范：${candidate.persona}` : '',
        '这是一次试跑：直接完成交给你的任务，给出可检查的产出，不要描述你打算怎么做。',
      ]
        .filter(Boolean)
        .join('\n'),
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    } as never);

    const content = (answer as { content?: { type: string; text?: string }[] }).content ?? [];
    const text = content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
      .trim();
    const usage = (answer as { usage?: { totalTokens?: number; cost?: { total?: number } } }).usage;

    return {
      text: text || '（模型没有返回文本）',
      tokens: usage?.totalTokens ?? 0,
      costUsd: usage?.cost?.total ?? 0,
    };
  };

  // One runtime service for the whole process: employees, acceptance scripts and
  // the settings page must see exactly the same interpreters. The app-owned
  // `<userData>/runtimes` directory is where the PATH shims live.
  const runtimeService = new RuntimeService(db, {
    userDataDir: appPaths.userData,
    network: networkClient,
  });

  // Communication: inbox, wake quota, guards, relationships (F5/F6). Built before
  // WorkService so the task harness can carry `send_direct_message`.
  comm = new CommService({
    repository: new CommRepository(db),
    org,
    transcript: chat,
    settings: commSettingsFrom(db),
  });

  // 预算中心 (§8): 自己的 BudgetService 实例，读写同一批行；工作循环仍然通过
  // WorkService 扣费，老板通过这里改额度并解除硬停。
  const budgetService = new BudgetService(new BudgetRepository(db));
  const budgetCenter = new BudgetCenter({
    budgets: budgetService,
    org,
    projects,
  });
  // 薪酬视图是同一个账本的另一种读法，所以共用同一个 BudgetService 实例。
  const payroll = new PayrollService({ db, budgets: budgetService, org });

  // §7.4: 群聊 @ 的路由交给通信层。老板在部门群里说话，没人被 @ 就只叫负责人。
  chat.routeGroupMessage = (input) => {
    const result = comm?.routeGroupMessage(input);
    if (result && result.delegatedToOwner && result.targets[0]) {
      console.warn(`群消息没有 @，已交给负责人 ${result.targets[0].name}`);
    }
  };
  const ocrSettings = new OcrSettingsStore(db);
  const ocr = ensureOcr(ocrSettings);
  work = new WorkService({
    db,
    paths: appPaths,
    agents: agentsFromOrg(org),
    upsertTaskCard: (task) => chat?.upsertTaskCard(task),
    modelConfig,
    images: imageService,
    speech: speechService,
    org,
    memory,
    facts,
    projects,
    comm,
    network: networkClient,
    runtime: runtimeService,
    ocr,
  });

  // Rows created before issue keys existed get one now; new tasks allocate at insert.
  // Runs in headless mode too, so probes and the issue list see the same data.
  try {
    const filled = work.backfillIssueKeys();
    if (filled > 0) console.warn(`backfilled ${filled} issue keys`);
  } catch (error) {
    console.warn('issue key backfill failed', error);
  }

  disposeIpc = registerIpc({
    chat,
    work,
    models: modelConfig,
    speech: speechService,
    org,
    market,
    facts,
    projects,
    consolidationRuns,
    comm,
    budget: budgetCenter,
    payroll,
    company: new CompanyService(db),
    network,
    runtime: runtimeService,
    // 设置 → 运行时: engines we ship are read-only, so the page reads the disk
    // rather than a stored preference.
    bundled: { inspect: async () => [await inspectOcrRuntime(ocrAssetsDir())] },
    ocrSettings,
    wakeEmployee: async (employeeId) =>
      heartbeat
        ? heartbeat.wakeNow(employeeId)
        : { ok: false, message: '心跳未启动（无头模式），无法手动唤醒', items: 0 },
    auth: new AuthService(() => modelConfig.runtime.createModels(), credentialStore),
    workspaceRoot: appPaths.workspaceDir,
  });

  // Auto lifecycle (§7.5): an idle thread cools first — it stops auto-replying but
  // stays readable — and only a much older one is archived, which is what triggers
  // consolidation. Probes drive both explicitly instead of waiting.
  if (!isHeadlessMode) {
    const timer = setInterval(() => {
      chat?.coolIdleConversations(IDLE_COOLING_MS);
      void chat?.sweepIdleConversations(IDLE_ARCHIVE_MS).catch(() => undefined);
    }, 5 * 60 * 1000);
    app.on('before-quit', () => clearInterval(timer));
  }

  // The heartbeat (§10.3): an employee with an empty inbox is never woken, so an idle
  // company costs nothing. Signalled work (a colleague needs an answer) wakes its
  // recipient on the next tick instead of waiting for the full heartbeat interval.
  if (!isHeadlessMode && comm && chat) {
    const liveChat = chat;
    const inboxRunner = createInboxRunner({
      comm,
      agentFor: (employeeId) => agentsFromOrg(org).find((agent) => agent.id === employeeId),
      replyWithModel: async ({ agent, text, history }) => {
        if (!liveChat.replyWithModel) throw new Error('未配置模型');
        return liveChat.replyWithModel({ agent, text, history });
      },
      appendAgentMessage: (conversationId, agent, text) => {
        liveChat.appendAgentMessage(conversationId, agent, text);
      },
    });
    const scheduler = new CommScheduler({ comm, onWake: inboxRunner });
    heartbeat = scheduler;
    // A signalled message (a boss @, or a manager asking) must not wait up to a full
    // heartbeat: any change to the queues nudges one tick, debounced inside the scheduler.
    const unsubscribeNudge = comm.subscribe(() => heartbeat?.nudge());
    scheduler.start();
    app.on('before-quit', () => {
      unsubscribeNudge();
      scheduler.stop();
      heartbeat = null;
    });
  }

  // Outgoing traffic must already follow the boss's choice when the first window
  // paints: install the fetch bridge, then apply the stored config. A broken proxy
  // must not stop the app from opening — the settings page is where it gets fixed.
  connectProxyRuntime();
  try {
    await applyProxy(network.resolve());
  } catch (error) {
    console.error('[OPC] 代理配置未能生效，本次按原设置继续', error);
  }

  // Crash recovery: resume durable tasks the previous process left running, then
  // free any reservation whose task is gone.
  void work.recover();
  hardenSession();
  mainWindow = createMainWindow();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * One instance per installation: two writers on one SQLite file is a data bug.
 * Diagnostic/probe modes are short-lived by design and must stay runnable while
 * the app is open (otherwise CI and one-off probes silently no-op).
 */
const isHeadlessMode =
  isSelfTest ||
  isSmoke ||
  Boolean(isOcrProbe) ||
  isWorkProbe ||
  isBudgetProbe ||
  isModelProbe ||
  isConsolidationRunProbe ||
  isBlockerProbe ||
  isIssueMetaProbe ||
  isPricingProbe ||
  isProjectProbe ||
  isFactProbe ||
  isArchiveProbe ||
  isConsolidateProbe ||
  isMemoryProbe ||
  isChatPersistProbe ||
  isMarketSeed ||
  isResetCompany ||
  isFirstRunProbe ||
  isChatProbe ||
  isReviewProbe ||
  isMarketProbe ||
  isInboxProbe ||
  isCompanySetup ||
  isRunTask;
const hasLock = isHeadlessMode ? true : app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.opc.agent.workspace');

    if (isOcrProbe) {
      // Proves the whole path outside of a task: protocol → hidden window →
      // worker → WebGPU/WASM, with no model and no database involved.
      try {
        initAppPaths();
        const { readFile } = await import('node:fs/promises');
        const bytes = await readFile(path.resolve(isOcrProbe));
        const repeat = Math.max(1, Number(process.env.OPC_OCR_PROBE_REPEAT ?? '1'));
        for (let index = 0; index < repeat; index += 1) {
          const result = await ensureOcr().recognize(new Uint8Array(bytes));
          process.stdout.write(`OCR_PROBE ${JSON.stringify(result)}\n`);
        }
        await ocrService?.dispose();
        app.exit(0);
      } catch (error) {
        console.error('OCR_PROBE_FAILED', error);
        await ocrService?.dispose();
        app.exit(1);
      }
      return;
    }

    if (isRunTask) {
      // 单条任务跑到底：给"真实公司 + 真实模型"一个非交互的入口，也方便回归。
      // 用真库（就是老板正在用的公司），不改任何别的任务。
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const credentialStore = new FileCredentialStore(`${appPaths.userData}/credentials.json`);
      const modelConfig = new ModelConfigService(db, credentialStore, networkClient);
      const org = new OrgService(db);
      const projects = new ProjectService(db);
      const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(org),
        upsertTaskCard: () => undefined,
        modelConfig,
        org,
        projects,
        memory: new MemoryService(db),
        facts: new OrgFactService(db),
      });

      try {
        const tasks = work.listAllTasks(500);
        const target =
          tasks.find((task) => task.issueKey === runTaskRef) ?? tasks.find((task) => task.id === runTaskRef);
        if (!target) throw new Error(`找不到任务：${runTaskRef}`);

        // 被中断过的任务先回到 open，避免带着旧的 running 状态再跑一遍。
        if (target.status === 'running' || target.status === 'failed') {
          db.prepare("UPDATE task SET status = 'open', finished_at = NULL, error = NULL WHERE id = ?").run(target.id);
        }

        let finished = await work.runTaskAndWait(target.id);

        // 自动验收通过后任务会停在 `review`：`openManagerReview` 已经自己启动了负责人
        // 验收（fire-and-forget），这里等它落地，而不是再跑一遍（并发会写坏 session）。
        if (finished.status === 'review') {
          const deadline = Date.now() + 240_000;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            const current = work.getTask(finished.id);
            if (!current) break;
            finished = current;
            if (current.status !== 'review') break;
          }
        }
        process.stdout.write(
          `${JSON.stringify(
            {
              probe: 'run-task',
              task: finished.issueKey,
              title: finished.title,
              status: finished.status,
              attempts: finished.attempts,
              tokensUsed: finished.tokensUsed,
              costUsd: finished.costUsd,
              acceptance: finished.acceptance
                ? {
                    verdict: finished.acceptance.verdict,
                    reason: finished.acceptance.reason,
                    exitCode: finished.acceptance.evidence.exitCode,
                    stdoutTail: finished.acceptance.evidence.stdoutTail.slice(-400),
                  }
                : null,
              artifacts: finished.artifacts.map((artifact) => artifact.relPath),
              steps: finished.steps.map((step) => step.text).slice(-14),
            },
            null,
            2,
          )}\n`,
        );
        await work.dispose();
        app.exit(finished.status === 'accepted' ? 0 : 1);
      } catch (error) {
        console.error('RUN_TASK_FAILED', error);
        await work.dispose().catch(() => undefined);
        app.exit(1);
      }
      return;
    }

    if (isCompanySetup) {
      // 用真实服务建公司：与 UI 里点出来的是同一批行，只是可以重复执行。
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      const projects = new ProjectService(db);
      const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(org),
        upsertTaskCard: () => undefined,
        org,
        projects,
      });
      try {
        const spec = parseCompanySetup(readFileSync(companySetupPath!, 'utf8'));
        const report = applyCompanySetup({ db, org, projects, work }, spec);
        process.stdout.write(`${JSON.stringify({ probe: 'company-setup', ...report }, null, 2)}\n`);
        await work.dispose();
        app.exit(0);
      } catch (error) {
        console.error('COMPANY_SETUP_FAILED', error);
        await work.dispose().catch(() => undefined);
        app.exit(1);
      }
      return;
    }

    if (isConsolidationRunProbe) {
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-consol-run-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      ensureFirstCompany(org);
      const member = org.list().flatMap((department) => department.members)[0]!;
      const memory = new MemoryService(db);
      const runs = new ConsolidationRunStore(db);

      const slice = {
        conversationId: 'conv-run-probe',
        employeeId: member.id,
        messages: [
          { senderId: 'user', text: '交付先给最小可运行版本' },
          { senderId: member.id, text: '明白' },
        ],
      };

      const skipped = await consolidateConversation(memory, slice, undefined, { runs });
      const done = await consolidateConversation(
        memory,
        slice,
        async ({ messages }) =>
          messages
            .filter((message) => message.senderId === 'user')
            .map((message) => ({ kind: 'preference' as const, content: `老板要求：${message.text}` })),
        { runs },
      );
      const failed = await consolidateConversation(
        memory,
        slice,
        async () => {
          throw new Error('模型崩了');
        },
        { runs },
      ).catch((error) => ({ written: 0, skipped: String(error) }));

      const rows = runs.list(10);
      process.stdout.write(
        JSON.stringify({
          probe: 'consolidation-run',
          skipped,
          done,
          failedSkipped: 'skipped' in failed,
          statuses: rows.map((run) => `${run.status}:${run.memoriesCreated}`),
          total: rows.length,
        }) + '\n',
      );
      app.exit(
        rows.length === 3 &&
          rows.some((run) => run.status === 'skipped') &&
          rows.some((run) => run.status === 'done' && run.memoriesCreated === 1) &&
          rows.some((run) => run.status === 'failed')
          ? 0
          : 1,
      );
      return;
    }

    if (isBlockerProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok';
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-blocker-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      ensureFirstCompany(org);
      const member = org.list().flatMap((department) => department.members)[0]!;
      const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(org),
        upsertTaskCard: () => undefined,
        org,
      });

      const dispatch = (title: string) => {
        const created = work.createTask({
          title,
          brief: 'b',
          deliverableSpec: 'server.js 返回 200',
          assigneeId: member.id,
          estTokens: 1000,
          acceptanceCommand: [],
          acceptanceTemplate: 'http-ok',
        });
        if (!created.ok) throw new Error('创建失败');
        return created.task;
      };

      const blocker = dispatch('前置任务');
      const blocked = dispatch('被阻塞的任务');
      work.linkTasks(blocker.id, blocked.id, 'blocks');

      const linked = work.getTask(blocked.id)!;
      await work.runTaskAndWait(blocked.id);
      const refused = work.getTask(blocked.id)!;

      await work.runTaskAndWait(blocker.id);
      await work.runTaskAndWait(blocked.id);
      const afterBlockerDone = work.getTask(blocked.id)!;

      process.stdout.write(
        JSON.stringify({
          probe: 'blocker',
          blockedBy: linked.blockedBy.map((link) => `${link.issueKey}:${link.status}`),
          refusedStatus: refused.status,
          refusedError: refused.error,
          afterBlockerDone: afterBlockerDone.status,
        }) + '\n',
      );
      app.exit(
        refused.status === 'failed' && afterBlockerDone.status === 'accepted' ? 0 : 1,
      );
      return;
    }

    if (isIssueMetaProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok';
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-meta-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      ensureFirstCompany(org);
      const member = org.list().flatMap((department) => department.members)[0]!;
      const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(org),
        upsertTaskCard: () => undefined,
        org,
      });
      const created = work.createTask({
        title: '优先级探针',
        brief: 'b',
        deliverableSpec: 'server.js 返回 200',
        assigneeId: member.id,
        estTokens: 1000,
        acceptanceCommand: [],
        acceptanceTemplate: 'http-ok',
      });
      if (!created.ok) throw new Error('创建失败');
      const before = work.getTask(created.task.id)!;
      const updated = work.setIssueMeta(created.task.id, {
        priority: 'P0',
        labels: ['增长', '前端'],
        dueAt: Date.now() - 60_000,
      });
      const reread = work.getTask(created.task.id)!;

      process.stdout.write(
        JSON.stringify({
          probe: 'issue-meta',
          defaultPriority: before.priority,
          priority: updated.priority,
          labels: reread.labels,
          overdueInThePast: reread.dueAt !== undefined && reread.dueAt < Date.now(),
          issueKey: before.issueKey,
        }) + '\n',
      );
      app.exit(updated.priority === 'P0' && reread.labels.length === 2 && reread.dueAt !== undefined ? 0 : 1);
      return;
    }

    if (isPricingProbe) {
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-pricing-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const credentialStore = new FileCredentialStore(`${appPaths.userData}/credentials.json`);
      const modelConfig = new ModelConfigService(db, credentialStore, networkClient);

      modelConfig.saveProvider({
        id: 'probe-gateway',
        name: 'Probe Gateway',
        api: 'openai-completions',
        baseUrl: 'https://example.invalid/v1',
        models: [],
      } as never);
      const providerId = 'probe-gateway';
      for (const id of ['openai/gpt-4o-2024-08-06', 'claude-sonnet-4-5-20250929', 'brand-new-model']) {
        modelConfig.addModel(providerId, { id });
      }

      // A gateway with no usable /models must report that, not pretend.
      const refresh = await modelConfig.refreshModels(providerId);
      let builtinDeleteRefused = false;
      try {
        modelConfig.removeProvider('anthropic');
      } catch (error) {
        builtinDeleteRefused = String(error).includes('内置提供商不可删除');
      }
      const result = await modelConfig.applyBuiltinPricing(providerId);
      const priced = result.providers
        .find((provider) => provider.id === providerId)!
        .models.map((model) => `${model.id}=${model.inputUsdPerM}`);
      process.stdout.write(
        JSON.stringify({
          probe: 'pricing',
          refreshOk: refresh.ok,
          refreshMessage: refresh.message,
          builtinDeleteRefused,
          matched: result.matched,
          unmatched: result.unmatched,
          prices: priced,
        }) + '\n',
      );
      app.exit(result.matched >= 2 && result.unmatched.includes('brand-new-model') ? 0 : 1);
      return;
    }

    if (isProjectProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok';
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-project-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      ensureFirstCompany(org);
      const db2 = db;
      const facts = new OrgFactService(db2);
      const memory = new MemoryService(db2);
      const projects = new ProjectService(db2);
      const everyone = org.list().flatMap((department) => department.members);
      const alice = everyone[0]!;
      const bob = everyone[1]!;

      projects.create({ name: '春季留存战役', code: 'PR-01', description: '提升次月留存' });
      projects.create({ name: '内部工具', code: 'PR-02', description: '自动化脚本' });
      const [spring, tools] = projects.list();
      projects.assign(spring!.id, alice.id, '负责人');
      projects.assign(tools!.id, bob.id, '开发');

      facts.write({
        scopeType: 'project',
        scopeId: spring!.id,
        subject: '战役目标',
        object: '次月留存 +3pt',
        statement: '春季留存战役目标：次月留存提升 3pt',
      });
      facts.write({
        scopeType: 'project',
        scopeId: tools!.id,
        subject: '工具约束',
        object: '必须离线可跑',
        statement: '内部工具必须离线可跑（不该出现在 alice 的上下文）',
      });

      const work = new WorkService({
        db: db2,
        paths: appPaths,
        agents: agentsFromOrg(org),
        upsertTaskCard: () => undefined,
        org,
        memory,
        facts,
        projects,
      });
      const created = work.createTask({
        title: '写留存实验方案',
        brief: '按项目目标拆实验',
        deliverableSpec: 'server.js 在 3000 端口返回 200',
        assigneeId: alice.id,
        estTokens: 4000,
        acceptanceCommand: [],
        acceptanceTemplate: 'http-ok',
      });
      if (!created.ok) throw new Error('项目探针创建任务失败');
      const finished = await work.runTaskAndWait(created.task.id);

      const aliceПроjects = projects.activeProjectIdsOf(alice.id);
      const visibleFacts = [
        { type: 'org' as const },
        ...aliceПроjects.map((id) => ({ type: 'project' as const, id })),
      ];
      const aliceFacts = facts.current(visibleFacts).map((fact) => fact.statement);
      process.stdout.write(
        JSON.stringify({
          probe: 'project',
          aliceProjects: aliceПроjects.length,
          aliceFacts,
          leakedOtherProject: aliceFacts.some((statement) => statement.includes('不该出现')),
          assignmentListed: projects.list()[0]!.members.map((m) => m.name),
          injected: finished.steps.find((step) => step.text.startsWith('注入'))?.text ?? null,
          taskStatus: finished.status,
        }) + '\n',
      );
      app.exit(aliceПроjects.length === 1 ? 0 : 1);
      return;
    }

    if (isInboxProbe) {
      // One wake per person per day: the brake has to trip inside a probe, not after
      // five real ones. No model is configured on purpose — the run must still close
      // its items and leave a visible guard instead of inventing a reply.
      process.env.OPC_WAKE_QUOTA = '1';
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-inbox-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      ensureFirstCompany(org);
      const probeChat = new ChatService({
        db,
        agents: agentsFromOrg(org),
        departments: chatDepartmentsFromOrg(org),
        conversations: [],
      });
      const settings = commSettingsFrom(db);
      const repo = new CommRepository(db);
      const comm = new CommService({ repository: repo, org, transcript: probeChat, settings });

      const members = org.list().flatMap((department) => department.members);
      const manager = members.find((member) =>
        members.some((other) => other.reportsToEmployeeId === member.id),
      )!;
      const report = members.find((member) => member.reportsToEmployeeId === manager.id)!;
      const sameDepartment = members.filter((member) => member.departmentId === report.departmentId);
      const peerA = sameDepartment.find((member) => member.id !== report.id && member.id !== manager.id)!;
      // Deliberately from the whole company: a two-person department has no second peer.
      const peerB = members.find(
        (member) => member.id !== report.id && member.id !== manager.id && member.id !== peerA.id,
      )!;

      const now = Date.now();
      const first = comm.sendDirectMessage({
        fromEmployeeId: manager.id,
        toEmployeeId: report.id,
        text: '把昨天的接口测试结果发我一份',
        now,
      });
      const second = comm.sendDirectMessage({
        fromEmployeeId: manager.id,
        toEmployeeId: report.id,
        text: '顺便把用例也补上',
        now,
      });
      const third = comm.sendDirectMessage({
        fromEmployeeId: manager.id,
        toEmployeeId: report.id,
        text: '下午三点前给我',
        now,
      });

      const queued = comm.inbox(report.id);
      // A fresh ChatService proves the recipient's context comes from `message` rows,
      // not from this process's memory (§5.4).
      const reopened = new ChatService({
        db,
        agents: agentsFromOrg(org),
        departments: chatDepartmentsFromOrg(org),
        conversations: [],
      });
      const transcript = reopened.readTranscript(first.conversationId ?? '');
      const deliveredToBoss = reopened
        .getSnapshot()
        .conversations.find((conversation) => conversation.id === first.conversationId);

      const woken: string[] = [];
      const scheduler = new CommScheduler({
        comm,
        now: () => now,
        onWake: async (input) => {
          woken.push(`${input.employeeId}:${input.reason}:${input.items.length}`);
          // No model: the runner must close the items and record why it stayed silent.
          await createInboxRunner({
            comm,
            agentFor: (employeeId) => agentsFromOrg(org).find((agent) => agent.id === employeeId),
            appendAgentMessage: () => undefined,
          })(input);
        },
      });
      const firstTick = await scheduler.tick();
      const idleTick = await scheduler.tick();
      const guards = comm.guards(report.id);
      // Snapshot now: the turn-limit segment below queues new work on purpose.
      const inboxDrained = comm.inbox(report.id).length === 0;

      // Rate brake: the same pair may not exceed the hourly cap.
      for (let index = 0; index < settings.dmPerHour; index += 1) {
        comm.sendDirectMessage({
          fromEmployeeId: peerA.id,
          toEmployeeId: peerB.id,
          text: `第 ${index + 1} 条`,
          now,
        });
      }
      const overRate = comm.sendDirectMessage({
        fromEmployeeId: peerA.id,
        toEmployeeId: peerB.id,
        text: '这条应该被拦下',
        now,
      });
      const rateRefused = overRate.ok === false && overRate.code === 'DM_RATE_LIMIT';

      // §7.3 ②: the turn ceiling. A second instance with a budget of 2, so the brake
      // trips inside the probe instead of after ten real exchanges.
      const strict = new CommService({
        repository: repo,
        org,
        transcript: probeChat,
        settings: { ...settings, maxConversationTurns: 2 },
      });
      const turn1 = strict.sendDirectMessage({
        fromEmployeeId: peerA.id,
        toEmployeeId: report.id,
        text: '接口这个字段怎么定',
        now,
      });
      strict.sendDirectMessage({
        fromEmployeeId: peerA.id,
        toEmployeeId: report.id,
        text: '我倾向用 snake_case',
        now,
      });
      const turn3 = strict.sendDirectMessage({
        fromEmployeeId: peerA.id,
        toEmployeeId: report.id,
        text: '再确认一下',
        now,
      });
      const escalatedState = probeChat.turnState(turn1.conversationId ?? '');
      // The boss stepping in is the resolution the doc's lifecycle calls for.
      probeChat.sendMessage({ conversationId: turn1.conversationId ?? '', text: '这件事我来定' });
      const reopenedState = probeChat.turnState(turn1.conversationId ?? '');
      // Snapshot before the boss actions below: dismissing a guard hides it, which is
      // exactly what `dismissed_at` is for.
      const turnLimitGuards = strict.guards(peerA.id);

      // §7.5: idle → cooling, and writing to a cooled thread brings it back.
      const cooled = probeChat.coolIdleConversations(60_000, now + 10 * 60_000);
      const warmed = strict.sendDirectMessage({
        fromEmployeeId: manager.id,
        toEmployeeId: peerA.id,
        text: '在吗',
        now: now + 11 * 60_000,
      });
      const cooledPeer = probeChat.turnState(warmed.conversationId ?? '');

      const relationship = repo.relationship(manager.id, report.id);
      // §7.4: 群聊 @ 的路由 —— 没人 @ 只叫负责人，有人 @ 只叫被点名的人。
      const groupId = probeChat.ensureDepartmentGroup(org.list()[0]?.id ?? '');
      const routedOwner = comm.routeGroupMessage({
        conversationId: groupId,
        messageId: 'msg-group-owner',
        now,
      });
      const routedMentions = comm.routeGroupMessage({
        conversationId: groupId,
        messageId: 'msg-group-mentions',
        mentionIds: [report.id, peerA.id],
        now,
      });
      // 老板的两个动作：手动唤醒现在的待办，以及把护栏标记为已读。
      const manualWake = await scheduler.wakeNow(report.id);
      const openGuards = comm.guards().length;
      const dismissedGuards = comm.dismissGuards();
      const checks = {
        firstWokeRecipient: first.ok && first.delivery === 'now' && first.priority === 1,
        quotaDegradesToQueued:
          second.ok && second.delivery === 'queued' && second.priority === 3 && third.priority === 3,
        inboxOrdered: queued.length === 3 && queued[0]?.priority === 1 && queued[2]?.priority === 3,
        onlyFirstRequiresWake: queued.filter((item) => item.requiresWake).length === 1,
        transcriptFromDb: transcript.length === 3,
        visibleToBoss: Boolean(deliveredToBoss) && (deliveredToBoss?.messages.length ?? 0) === 3,
        wakeQuotaGuard: guards.some((guard) => guard.kind === 'wake_quota'),
        signalledWake: firstTick.woken.some((entry) => entry.reason === 'signal' && entry.items === 3),
        noModelGuard: guards.some((guard) => guard.kind === 'message_dropped'),
        inboxDrained,
        idleCostsNothing: idleTick.woken.length === 0,
        rateBrake: rateRefused,
        relationshipGrew: (relationship?.strength ?? 0) > 0.5 && relationship?.interactionCount === 3,
        turnLimitEscalates: escalatedState.status === 'escalated' && escalatedState.turns === 2,
        turnLimitRefuses: turn3.ok === false && turn3.code === 'CONVERSATION_ESCALATED',
        turnLimitGuard: turnLimitGuards.some(
          (guard) => guard.kind === 'turn_limit' && guard.detail.reason === 'limit_reached',
        ),
        bossReopensThread: reopenedState.status === 'open' && reopenedState.turns === 0,
        coolingReachable: cooled.length > 0,
        warmingReopens: cooledPeer.status === 'open',
        bossCanWake: manualWake.ok && manualWake.items > 0,
        guardsDismissable:
          openGuards > 0 && dismissedGuards === openGuards && comm.guards().length === 0,
        groupRoutesToOwner:
          routedOwner.delegatedToOwner &&
          routedOwner.targets.length === 1 &&
          routedOwner.targets[0]?.employeeId === manager.id,
        groupRoutesToMentions:
          routedMentions.targets.length === 2 &&
          routedMentions.targets.every((target) => target.priority === 2),
      };

      process.stdout.write(
        `${JSON.stringify(
          {
            probe: 'inbox',
            ...checks,
            firstDelivery: first.delivery,
            priorities: queued.map((item) => item.priority),
            guards: guards.map((guard) => guard.kind),
            woken,
            relationship: relationship
              ? { strength: relationship.strength, interactions: relationship.interactionCount }
              : null,
            lifecycle: { escalated: escalatedState, reopened: reopenedState, cooledThreads: cooled.length },
          },
          null,
          2,
        )}\n`,
      );
      scheduler.stop();
      db.close();
      app.exit(Object.values(checks).every(Boolean) ? 0 : 1);
      return;
    }

    if (isFactProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok';
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-fact-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      ensureFirstCompany(org);
      const facts = new OrgFactService(db);
      const memory = new MemoryService(db);
      const member = org.list().flatMap((department) => department.members)[0]!;
      const departmentId = member.departmentId;

      const first = facts.write({ scopeType: 'org', subject: 'Q4目标', object: '先做留存', statement: 'Q4 目标：先做留存，不做新功能' });
      const second = facts.write({ scopeType: 'org', subject: 'Q4目标', object: '先做留存与复购', statement: 'Q4 目标：先做留存与复购' });
      facts.write({
        scopeType: 'department',
        scopeId: departmentId,
        subject: '交付规范',
        object: '必须带 README',
        statement: '部门规定：每个交付必须带 README',
      });
      facts.write({
        scopeType: 'department',
        scopeId: org.list()[1]?.id ?? departmentId,
        subject: '交付规范',
        object: '另一部门的私有规定',
        statement: '另一个部门的规定（不应该出现在本员工上下文里）',
      });

      const current = facts.current([{ type: 'org' }, { type: 'department', id: departmentId }]);
      const history = facts.history('Q4目标');

      const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(org),
        upsertTaskCard: () => undefined,
        org,
        memory,
        facts,
      });
      const created = work.createTask({
        title: '写季度留存方案',
        brief: '按公司 Q4 目标写',
        deliverableSpec: 'server.js 在 3000 端口返回 200',
        assigneeId: member.id,
        estTokens: 4000,
        acceptanceCommand: [],
        acceptanceTemplate: 'http-ok',
      });
      if (!created.ok) throw new Error('事实探针创建任务失败');
      const finished = await work.runTaskAndWait(created.task.id);

      process.stdout.write(
        JSON.stringify({
          probe: 'facts',
          firstSuperseded: first.id !== second.id && history.length === 2,
          currentStatements: current.map((fact) => fact.statement),
          leakedOtherDepartment: current.some((fact) => fact.statement.includes('另一个部门')),
          injectedIntoPrompt: finished.steps.find((step) => step.text.startsWith('注入'))?.text ?? null,
          taskStatus: finished.status,
        }) + '\n',
      );
      app.exit(current.length === 2 && !current.some((fact) => fact.statement.includes('另一个部门')) ? 0 : 1);
      return;
    }

    if (isArchiveProbe) {
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-archive-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      ensureFirstCompany(org);
      const member = org.list().flatMap((department) => department.members)[0]!;
      const memory = new MemoryService(db);

      const chatProbe = new ChatService({
        db,
        agents: agentsFromOrg(org),
        departments: chatDepartmentsFromOrg(org),
        conversations: [],
      });
      // Deterministic summariser stand-in; the real one is models.complete.
      chatProbe.consolidate = async ({ conversationId, employeeId, messages: turns }) => {
        const bossLines = turns.filter((turn) => turn.senderId === 'user').map((turn) => turn.text);
        let written = 0;
        for (const line of bossLines.filter((entry) => entry.includes('README'))) {
          await memory.remember({
            employeeId,
            kind: 'preference',
            content: `老板要求：${line}`,
            scope: { type: 'personal' },
            sourceType: 'consolidation',
            sourceId: conversationId,
          });
          written += 1;
        }
        return { written };
      };

      const conversationId = chatProbe.openDirect(member.id);
      chatProbe.sendMessage({ conversationId, text: '文档以后放 README 里就够了，别单开 wiki' });
      await new Promise((resolve) => setTimeout(resolve, 1600));

      // Nothing is idle yet.
      const early = await chatProbe.sweepIdleConversations(60 * 60 * 1000);
      // Backdate the row, as if the boss walked away an hour ago.
      db.prepare('UPDATE conversation SET updated_at = ? WHERE id = ?').run(
        Date.now() - 2 * 60 * 60 * 1000,
        conversationId,
      );
      const swept = await chatProbe.sweepIdleConversations(60 * 60 * 1000);
      const again = await chatProbe.sweepIdleConversations(0);
      const row = db
        .prepare('SELECT archived_at, consolidated_at FROM conversation WHERE id = ?')
        .get(conversationId) as { archived_at: number | null; consolidated_at: number | null };

      process.stdout.write(
        JSON.stringify({
          probe: 'archive',
          earlySweep: early.length,
          swept,
          idempotentSecondSweep: again.length,
          archivedAt: row.archived_at !== null,
          consolidatedAt: row.consolidated_at !== null,
          memories: memory.listForEmployee(member.id).map((item) => item.content),
        }) + '\n',
      );
      app.exit(
        early.length === 0 && swept.length === 1 && again.length === 0 && row.consolidated_at !== null ? 0 : 1,
      );
      return;
    }

    if (isConsolidateProbe) {
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-consolidate-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      ensureFirstCompany(org);
      const member = org.list().flatMap((department) => department.members)[0]!;
      const memory = new MemoryService(db);

      const conversation = {
        conversationId: 'conv-probe',
        employeeId: member.id,
        messages: [
          { senderId: 'user', text: '以后交付都先给我最小可运行版本，别一次性堆功能' },
          { senderId: member.id, text: '明白，先跑通再扩展。' },
          { senderId: 'user', text: '文档放 README 里就够了' },
        ],
      };

      // 1) no summarizer → nothing invented
      const withoutModel = await consolidateConversation(memory, conversation, undefined);

      // 2) with a summarizer (a deterministic stand-in for the model in this probe)
      const withModel = await consolidateConversation(memory, conversation, async ({ messages: turns }) => {
        const bossLines = turns.filter((turn) => turn.senderId === 'user').map((turn) => turn.text);
        return bossLines
          .filter((line) => line.includes('最小可运行') || line.includes('README'))
          .map((line) => ({
            content: `老板要求：${line}`,
            kind: 'preference' as const,
          }));
      });

      const stored = memory.listForEmployee(member.id);
      const recalled = await memory.retrieve({
        employeeId: member.id,
        query: '这单怎么交付，文档放哪',
        scopes: [{ type: 'personal' }],
        limit: 2,
      });

      process.stdout.write(
        JSON.stringify({
          probe: 'consolidate',
          withoutModel,
          withModel,
          stored: stored.map((item) => item.content),
          topRecall: recalled[0]?.content ?? null,
        }) + '\n',
      );
      app.exit(withModel.written === 2 && withoutModel.written === 0 ? 0 : 1);
      return;
    }

    if (isMemoryProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok';
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-memory-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      ensureFirstCompany(org);
      const member = org.list().flatMap((department) => department.members)[0]!;
      const memory = new MemoryService(db);

      await memory.remember({
        employeeId: member.id,
        kind: 'experience',
        content: '健康检查服务必须监听 3000 端口，验收脚本会用 curl 打 /health',
        scope: { type: 'personal' },
        sourceType: 'manual',
      });
      await memory.remember({
        employeeId: member.id,
        kind: 'preference',
        content: '老板偏好先给最小可运行版本，再补文档',
        scope: { type: 'personal' },
        sourceType: 'manual',
      });
      await memory.remember({
        employeeId: member.id,
        kind: 'experience',
        content: '配色只用语义 token，不写死 hex',
        scope: { type: 'personal' },
        sourceType: 'manual',
      });

      const recalled = await memory.retrieve({
        employeeId: member.id,
        query: '写一个健康检查服务，要能被 curl 验收',
        scopes: [{ type: 'personal' }],
        limit: 2,
      });
      const afterRecall = memory.listForEmployee(member.id).find((item) => item.id === recalled[0]?.id);
      const totalBefore = memory.countForEmployee(member.id);

      const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(org),
        upsertTaskCard: () => undefined,
        org,
        memory,
      });
      const created = work.createTask({
        title: '写健康检查服务',
        brief: 'node:http，/health 返回 200',
        deliverableSpec: 'server.js 在 3000 端口返回 200',
        assigneeId: member.id,
        estTokens: 4000,
        acceptanceCommand: [],
        acceptanceTemplate: 'http-ok',
      });
      if (!created.ok) throw new Error('记忆探针创建任务失败');
      const finished = await work.runTaskAndWait(created.task.id);
      const injected = finished.steps.find((step) => step.text.startsWith('注入'));

      process.stdout.write(
        JSON.stringify({
          probe: 'memory',
          written: totalBefore,
          topRecall: recalled[0]?.content ?? null,
          recallCount: afterRecall ? 1 : 0,
          injectedIntoPrompt: injected?.text ?? null,
          taskStatus: finished.status,
          memoriesAfterTask: memory.countForEmployee(member.id),
        }) + '\n',
      );
      app.exit(injected ? 0 : 1);
      return;
    }

    if (isChatPersistProbe) {
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      ensureFirstCompany(org);
      const member = org.list().flatMap((department) => department.members)[0];
      if (!member) throw new Error('聊天持久化探针需要至少一名员工');

      const first = new ChatService({ db, agents: agentsFromOrg(org), departments: chatDepartmentsFromOrg(org), conversations: [] });
      const conversationId = first.openDirect(member.id);
      first.sendMessage({ conversationId, text: '最近有什么产品上线了么' });
      // The reply arrives on a timer (typing indicator first), so let it land.
      await new Promise((resolve) => setTimeout(resolve, 1600));
      const firstSnapshot = first.getSnapshot();
      const firstCount = firstSnapshot.conversations.find((item) => item.id === conversationId)?.messages.length ?? 0;
      first.dispose();

      // "Restart": a brand-new service reading the same SQLite file.
      const second = new ChatService({ db, agents: agentsFromOrg(org), departments: chatDepartmentsFromOrg(org), conversations: [] });
      const restored = second.getSnapshot().conversations.find((item) => item.id === conversationId);
      const restoredTexts = (restored?.messages ?? []).map((message) => message.text ?? message.kind);

      process.stdout.write(
        JSON.stringify({
          probe: 'chat-persist',
          conversationId,
          messagesBeforeRestart: firstCount,
          conversationsAfterRestart: second.getSnapshot().conversations.length,
          restoredMessages: restoredTexts,
          repliedHonestly: restoredTexts.some((text) => typeof text === 'string' && text.includes('还没配置可用模型')) ||
            restoredTexts.some((text) => typeof text === 'string' && text.includes('模型调用失败')),
          persists: firstCount > 0 && restoredTexts.length === firstCount,
        }) + '\n',
      );
      second.dispose();
      app.exit(firstCount > 0 && restoredTexts.length === firstCount ? 0 : 1);
      return;
    }

    if (isMarketSeed) {
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      ensureFirstCompany(org);
      const market = new MarketService(db, org);
      market.importJson(
        JSON.stringify({
          format: 'opc-agent-package@1',
          name: 'design-pack.json',
          agents: [
            {
              name: '苏晚',
              role: '视觉设计师',
              level: 'P6',
              model: '',
              skills: ['Figma', '信息图', '配色'],
              persona: '先给两级方案再展开细节。\n图纸必须能实现，配色只用语义 token。\n交付前自检对比度。',
            },
          ],
        }),
        'design-pack.json',
      );
      process.stdout.write(
        JSON.stringify({ probe: 'market-seed', candidates: market.list().map((item) => item.name) }) + '\n',
      );
      app.exit(0);
      return;
    }

    if (isResetCompany) {
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      const removed = resetCompany(db);
      const first = ensureFirstCompany(org);
      let duplicateRejected = false;
      try {
        org.createDepartment({ name: ' 产品部 ' });
      } catch (error) {
        duplicateRejected = error instanceof Error && error.message.includes('部门名称已存在');
      }
      let duplicateCodeRejected = false;
      try {
        org.createDepartment({ name: '产品二部', code: ' pd-01 ' });
      } catch (error) {
        duplicateCodeRejected = error instanceof Error && error.message.includes('部门代号已存在');
      }
      const movable = org
        .list()
        .flatMap((department) => department.members)
        .find((member) => !member.isHead);
      const withHead = org.createDepartment({
        name: '增长部',
        code: 'GR-01',
        description: '负责拉新与留存实验。',
        headEmployeeId: movable?.id,
      });
      const movedHead = withHead.members.find((member) => member.isHead);
      // Leave the company as the seed created it: drop the probe department again.
      db.prepare('DELETE FROM position WHERE department_id = ?').run(withHead.id);
      db.prepare('DELETE FROM department WHERE id = ?').run(withHead.id);

      const departments = org.list();
      process.stdout.write(
        JSON.stringify({
          probe: 'reset-company',
          headAppointed: movedHead ? `${movedHead.name}@${withHead.name}` : null,
          headDepartment: movedHead?.departmentId === withHead.id,
          removed,
          seeded: first,
          duplicateRejected,
          duplicateCodeRejected,
          departments: departments.map((department) => `${department.name}:${department.members.length}`),
          names: departments.map((department) => department.name),
          uniqueNames: new Set(departments.map((department) => department.name)).size,
        }) + '\n',
      );
      app.exit(0);
      return;
    }

    if (isFirstRunProbe) {
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-first-run-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      const first = ensureFirstCompany(org);
      const second = ensureFirstCompany(org);
      const departments = org.list();
      const employees = departments.flatMap((department) => department.members);
      const chat = new ChatService({
        agents: agentsFromOrg(org),
        departments: chatDepartmentsFromOrg(org),
        conversations: [],
      });
      const snapshot = chat.getSnapshot();
      process.stdout.write(
        JSON.stringify({
          probe: 'first-run',
          createdOnFirstCall: first.created,
          createdOnSecondCall: second.created,
          departments: departments.map((department) => `${department.name}:${department.members.length}`),
          employees: employees.map((member) => `${member.name}/${member.title}/${member.level}`),
          heads: employees.filter((member) => member.isHead).map((member) => member.name),
          reportingLines: employees.filter((member) => member.reportsToEmployeeId).length,
          seededConversations: snapshot.conversations.length,
          storedRows: (
            db.prepare('SELECT COUNT(*) AS n FROM employee WHERE status = ?').get('active') as { n: number }
          ).n,
        }) + '\n',
      );
      app.exit(0);
      return;
    }

    if (isChatProbe) {
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      const department = org.list().find((node) => node.members.length > 0);
      if (!department) throw new Error('聊天探针需要至少一个有成员的部门');
      const member = department.members[0]!;
      const service = new ChatService({
        agents: department.members.map((entry) => ({
          id: entry.id,
          name: entry.name,
          role: entry.role,
          level: entry.level,
          departmentId: department.id,
          model: entry.model,
          status: 'online' as const,
          skills: entry.skills,
          briefMd: entry.persona,
        })),
        departments: [
          {
            id: department.id,
            name: department.name,
            code: department.code,
            color: department.color,
            description: department.description,
            leadAgentId: department.headEmployeeId ?? '',
            groupConversationId: '',
          },
        ],
        conversations: [],
      });
      const directA = service.openDirect(member.id);
      const directB = service.openDirect(member.id);
      const groupA = service.ensureDepartmentGroup(department.id);
      const groupB = service.ensureDepartmentGroup(department.id);
      const snapshot = service.getSnapshot();
      const direct = snapshot.conversations.find((item) => item.id === directA);
      const group = snapshot.conversations.find((item) => item.id === groupA);
      process.stdout.write(
        JSON.stringify({
          probe: 'chat',
          conversations: snapshot.conversations.length,
          directReused: directA === directB,
          directTitle: direct?.title ?? null,
          directMembers: direct?.memberIds.length ?? 0,
          groupReused: groupA === groupB,
          groupTitle: group?.title ?? null,
          groupMembers: group?.memberIds.length ?? 0,
        }) + '\n',
      );
      app.exit(
        directA === directB && groupA === groupB && snapshot.conversations.length === 2 ? 0 : 1,
      );
      return;
    }

    if (isReviewProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok';
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      db.exec(
        'DELETE FROM acceptance; DELETE FROM artifact; DELETE FROM task_step; DELETE FROM task; DELETE FROM budget_reservation;',
      );
      org.createDepartment({ name: '验收部', code: 'RV-01' });
      const dept = org.list().find((node) => node.code === 'RV-01')!;
      const manager = org.hire({ name: '主管甲', role: '技术主管', departmentId: dept.id, isHead: true });
      const worker = org.hire({ name: '组员乙', role: '工程师', departmentId: dept.id, reportsToEmployeeId: manager.id });

      const work = new WorkService({
        db,
        paths: appPaths,
        agents: [manager, worker].map((member): Agent => ({
          id: member.id,
          name: member.name,
          role: member.role,
          level: member.level,
          model: '',
          departmentId: dept.id,
          status: 'online' as Agent['status'],
          skills: [] as string[],
          briefMd: '',
        })),
        upsertTaskCard: () => undefined,
        org,
      });
      const created = work.createTask({
        title: '写一个健康检查服务',
        brief: 'node:http，/health 返回 200',
        deliverableSpec: 'server.js 在 3000 端口返回 200',
        assigneeId: worker.id,
        estTokens: 5000,
        acceptanceCommand: [],
        acceptanceTemplate: 'http-ok',
      });
      if (!created.ok) {
        process.stdout.write(JSON.stringify({ probe: 'review', ok: false }) + '\n');
        app.exit(1);
        return;
      }
      void work.runTaskAndWait(created.task.id).then(async () => {
        // The review task runs on its own; wait for it to settle.
        for (let i = 0; i < 240; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const after = work.getTask(created.task.id);
          const review = work.listReviews(created.task.id)[0];
          const settled = review?.status === 'accepted' || review?.status === 'failed' || review?.status === 'rejected';
          if (after && settled && (after.status === 'accepted' || after.status === 'rejected')) break;
        }
        const final = work.getTask(created.task.id)!;
        const afterRevise = work.getTask(created.task.id)!;
        const delivered = afterRevise.status === 'accepted' ? work.bossDecision(created.task.id, 'approve') : null;
        const reviewList = work.listReviews(created.task.id);
        process.stdout.write(
          JSON.stringify({
            probe: 'review',
            finalStatus: final.status,
            acceptanceLevels: final.acceptance ? final.acceptance.reason : null,
            error: final.error ?? null,
            reviewTasks: reviewList.length,
            reviewStatus: reviewList[0]?.status ?? null,
            reworkRounds: reviewList.length,
            bossStatus: delivered?.status ?? null,
          }) + '\n',
        );
        app.exit(final.status === 'accepted' || final.status === 'delivered' ? 0 : 1);
      });
      return;
    }

    if (isMarketProbe) {
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      const market = new MarketService(db, org);
      db.exec('DELETE FROM agent_candidate;');
      const target = org.list()[0];
      if (!target) throw new Error('市场探针需要至少一个部门');
      const imported = market.importJson(
        JSON.stringify({
          format: 'opc-agent-package@1',
          name: 'probe-pack.json',
          agents: [
            { name: '包小满', role: '数据工程师', level: 'P6', model: 'gpt-5', skills: ['SQL', 'DuckDB'], persona: '你只交付可复现的数据查询。' },
            { name: '坏包', role: '' },
          ],
        }),
        'probe-pack.json',
      );
      market.hire(imported[0]!.id, { departmentId: target.id });
      const hired = org.list().flatMap((node) => node.members).find((member) => member.name === '包小满');
      process.stdout.write(
        JSON.stringify({
          probe: 'market',
          importedCount: imported.length,
          inferredFields: imported[0]?.skills,
          remainingCandidates: market.list().length,
          hiredInto: target.name,
          hiredSkills: hired?.skills,
          personaStored: hired?.persona,
          level: hired?.level,
        }) + '\n',
      );
      app.exit(0);
      return;
    }

    if (isDecomposeProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok';
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      db.exec("DELETE FROM position; DELETE FROM department;");
      org.createDepartment({ name: '交付部', code: 'QA-01' });
      const dept = org.list().find((node) => node.code === 'QA-01')!;

      const manager = org.hire({ name: '李雷', role: '交付总监', level: 'M2', departmentId: dept.id, isHead: true });
      const worker = org.hire({
        name: '韩梅梅',
        role: '前端工程师',
        level: 'P6',
        departmentId: dept.id,
        reportsToEmployeeId: manager.id,
      });
      const outsider = org.hire({ name: '外人', role: '别的部门', level: 'P6', departmentId: dept.id });

        const probeOrg = new OrgService(db);
        ensureFirstCompany(probeOrg);
        const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(probeOrg),
        upsertTaskCard: () => undefined,
        org,
      });
      db.exec('DELETE FROM budget_reservation; DELETE FROM budget;');

      const parent = work.createTask({ ...DEMO_TASK, assigneeId: manager.id, estTokens: 20000 });
      if (!parent.ok) {
        process.stdout.write(`${JSON.stringify({ parentRefused: parent.error })}\n`);
        app.exit(2);
        return;
      }

      const good: SubtaskDraft[] = [
        {
          title: '写页面',
          brief: '按交付物要求写前端页面',
          deliverableSpec: 'server.js：GET / 返回 ok',
          assigneeId: worker.id,
          estTokens: 6000,
          acceptanceTemplate: 'http-ok',
        },
      ];
      const created = work.decompose(parent.task.id, manager.id, good);
      const refusals = {
        subordinate: work.decompose(parent.task.id, manager.id, [
          { ...good[0]!, assigneeId: outsider.id },
        ]),
        fanout: work.decompose(parent.task.id, manager.id, Array.from({ length: 6 }, (_, index) => ({
          ...good[0]!,
          title: `子任务 ${index}`,
        }))),
        budget: work.decompose(parent.task.id, manager.id, [{ ...good[0]!, estTokens: 999999 }]),
        self: work.decompose(parent.task.id, manager.id, [{ ...good[0]!, assigneeId: manager.id }]),
        depth: (() => {
          // Put the parent at maxDepth-1 so the next level is refused.
          db.prepare('UPDATE task SET depth = 2 WHERE id = ?').run(parent.task.id);
          const result = work.decompose(parent.task.id, manager.id, good);
          db.prepare('UPDATE task SET depth = 0 WHERE id = ?').run(parent.task.id);
          return result;
        })(),
      };

      const childResults: string[] = [];
      if (created.ok) {
        for (const child of created.created) {
          const finished = await work.runTaskAndWait(child.id);
          childResults.push(`${finished.title}:${finished.status}`);
        }
      }

      process.stdout.write(
        `${JSON.stringify(
          {
            created: created.ok ? created.created.map((task) => `${task.assigneeName}:${task.title}@${task.depth}`) : created,
            refusals: Object.fromEntries(
              Object.entries(refusals).map(([key, value]) => [key, value.ok ? 'accepted?' : value.error.code]),
            ),
            childResults,
            subtree: work.listTasks().filter((task) => task.id === parent.task.id || task.parentTaskId === parent.task.id)
              .map((task) => ({ title: task.title, depth: task.depth, status: task.status })),
          },
          null,
          2,
        )}\n`,
      );
      await work.dispose();
      app.exit(created.ok && childResults.every((entry) => entry.endsWith('accepted')) ? 0 : 1);
      return;
    }

    if (isOrgProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok';
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
        const probeOrg = new OrgService(db);
        ensureFirstCompany(probeOrg);
        const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(probeOrg),
        upsertTaskCard: () => undefined,
      });
      const org = new OrgService(db);
      // Deterministic probe: reset the org projection, keep employees.
      db.exec("DELETE FROM position; UPDATE department SET deleted_at = NULL");
      ensureFirstCompany(org);
  org.ensureDistinctColors();
      db.exec('DELETE FROM budget_reservation; DELETE FROM budget;');

      const department = org.createDepartment({ name: '交付部', code: 'QA-01' });
      const hired = org.hire({ name: '林小舟', role: '前端工程师', level: 'P6', departmentId: department.id });

      const created = work.createTask({
        ...DEMO_TASK,
        assigneeId: hired.id,
      });
      const finished = created.ok ? await work.runTaskAndWait(created.task.id) : null;

      org.fire(hired.id);
      const afterFire = work.createTask({ ...DEMO_TASK, assigneeId: hired.id });

      const tree = org.list();
      process.stdout.write(
        `${JSON.stringify(
          {
            departments: tree.map((node) => `${node.name}(${node.members.length})`),
            hiredId: hired.id,
            dispatched: created.ok,
            taskStatus: finished?.status ?? null,
            afterFireRefused: afterFire.ok ? null : afterFire.error.code ?? 'refused',
            afterFireMessage: afterFire.ok ? null : afterFire.error.message,
          },
          null,
          2,
        )}\n`,
      );
      await work.dispose();
      app.exit(
        created.ok && finished?.status === 'accepted' && !afterFire.ok ? 0 : 1,
      );
      return;
    }

    if (isImageLoopProbe) {
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);

      // A local OpenAI-compatible image endpoint: proves the loop end to end
      // without a real provider key.
      const { createServer } = await import('node:http');
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      );
      const server = createServer((request, response) => {
        if (request.url?.includes('/images/generations')) {
          response.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }),
          );
          return;
        }
        response.writeHead(404).end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;

      const credentialStore = new FileCredentialStore(`${appPaths.userData}/credentials.json`);
      const modelConfig = new ModelConfigService(db, credentialStore, networkClient);
      modelConfig.importFromPi();
      modelConfig.saveProvider({
        id: 'mock-image',
        name: 'Mock Image',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: 'openai-completions',
        isCustom: true,
      });
      modelConfig.setKey('mock-image', 'test-key');
      modelConfig.setModels('mock-image', [
        { id: 'mock/png-1', name: 'Mock PNG', capability: 'image', api: 'openai-images' },
      ]);
      modelConfig.setDefault('image', { providerId: 'mock-image', modelId: 'mock/png-1' });

      const images = new ImageService(modelConfig);
        const probeOrg = new OrgService(db);
        ensureFirstCompany(probeOrg);
        const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(probeOrg),
        upsertTaskCard: () => undefined,
        modelConfig,
        images,
      });

      db.exec('DELETE FROM budget_reservation; DELETE FROM budget;');
      const created = work.createTask({
        title: '生成一张占位图片',
        brief:
          '必须调用 generate_image 工具生成一张图片，filename 用 icon.png。不要自己写 Base64，也不要只回复文字。',
        deliverableSpec: 'icon.png：一张 PNG 图片',
        assigneeId: 'agent-fe',
        estTokens: 6000,
        acceptanceCommand: ['node', '{checks}/verify.mjs'],
        acceptanceTemplate: 'image-200',
      });

      if (!created.ok) {
        process.stdout.write(`${JSON.stringify({ refused: created.error })}\n`);
        server.close();
        app.exit(2);
        return;
      }

      const finished = await work.runTaskAndWait(created.task.id);
      process.stdout.write(
        `${JSON.stringify(
          {
            status: finished.status,
            verdict: finished.acceptance?.verdict ?? null,
            template: finished.acceptanceTemplate,
            exitCode: finished.acceptance?.evidence.exitCode ?? null,
            artifacts: finished.artifacts.map((artifact) => `${artifact.relPath} (${artifact.bytes}B)`),
            steps: finished.steps.map((step) => step.text),
            error: finished.error ?? null,
          },
          null,
          2,
        )}\n`,
      );
      server.close();
      await work.dispose();
      app.exit(finished.status === 'accepted' ? 0 : 1);
      return;
    }

    if (crashProbe === 'start') {
      process.env.OPC_BRAIN_VARIANT ??= 'ok'; // probes are deterministic and must not spend tokens
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
        const probeOrg = new OrgService(db);
        ensureFirstCompany(probeOrg);
        const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(probeOrg),
        upsertTaskCard: () => undefined,
      });
      db.exec('DELETE FROM budget_reservation; DELETE FROM budget;');
      const created = work.createTask({ ...DEMO_TASK, assigneeId: 'agent-fe' });
      if (!created.ok) {
        process.stdout.write(`${JSON.stringify({ refused: created.error })}\n`);
        app.exit(2);
        return;
      }
      process.stdout.write(`${JSON.stringify({ started: created.task.id })}\n`);
      work.runTask(created.task.id);
      // Stay alive; the test harness kills this process mid-run.
      return;
    }

    if (crashProbe === 'resume') {
      process.env.OPC_BRAIN_VARIANT ??= 'ok'; // probes are deterministic and must not spend tokens
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
        const probeOrg = new OrgService(db);
        ensureFirstCompany(probeOrg);
        const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(probeOrg),
        upsertTaskCard: () => undefined,
      });
      const before = work.listTasks().filter((task) => task.status === 'running').length;

      // Orphan reservation: task id that no longer exists. The reaper must free it.
      const orphanId = `reservation-orphan-${Date.now()}`;
      db.prepare(
        `INSERT INTO budget_reservation (id, budget_id, task_id, employee_id, est_tokens, status, expires_at, created_at)
         VALUES (?, (SELECT id FROM budget WHERE scope='employee' LIMIT 1), 'task-gone', 'agent-fe', 1234, 'active', NULL, ?)`,
      ).run(orphanId, Date.now());
      db.prepare(`UPDATE budget SET reserved_tokens = reserved_tokens + 1234 WHERE scope='employee'`).run();

      await work.recover();
      const orphan = db
        .prepare('SELECT status FROM budget_reservation WHERE id = ?')
        .get(orphanId) as { status: string } | undefined;

      const deadline = Date.now() + 30_000;
      let latest = work.listTasks()[0];
      while (Date.now() < deadline) {
        latest = work.listTasks()[0];
        if (latest && latest.status !== 'running' && latest.status !== 'open') break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      process.stdout.write(
        `${JSON.stringify(
          {
            runningBeforeRecovery: before,
            status: latest?.status ?? null,
            attempts: latest?.attempts ?? null,
            exitCode: latest?.acceptance?.evidence.exitCode ?? null,
            resumedSteps:
              latest?.steps
                .map((step) => step.text)
                .filter((text) => text.includes('继续') || text.includes('启动恢复')) ?? [],
            orphanReservation: orphan?.status ?? null,
          },
          null,
          2,
        )}\n`,
      );
      await work.dispose();
      app.exit(latest?.status === 'accepted' ? 0 : 1);
      return;
    }

    if (isModelProbe) {
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const credentialStore = new FileCredentialStore(`${appPaths.userData}/credentials.json`);
      const modelConfig = new ModelConfigService(db, credentialStore, networkClient);
      const imported = modelConfig.importFromPi();
      const defaults = modelConfig.getDefaults();
      // Price the model so the ledger has a money column to verify.
      if (defaults.llm) {
        modelConfig.setModelPricing(defaults.llm.providerId, defaults.llm.modelId, {
          input: 0.14,
          output: 0.28,
          cacheRead: 0.014,
          cacheWrite: 0.14,
        });
      }

        const probeOrg = new OrgService(db);
        ensureFirstCompany(probeOrg);
        const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(probeOrg),
        upsertTaskCard: () => undefined,
        modelConfig,
      });

      db.exec('DELETE FROM budget_reservation; DELETE FROM budget;');
      const created = work.createTask({ ...DEMO_TASK, assigneeId: 'agent-fe' });
      if (!created.ok) {
        process.stdout.write(`${JSON.stringify({ refused: created.error }, null, 2)}\n`);
        app.exit(2);
        return;
      }

      const finished = await work.runTaskAndWait(created.task.id);
      process.stdout.write(
        `${JSON.stringify(
          {
            importedProviders: imported.imported,
            defaultLlm: defaults.llm,
            status: finished.status,
            verdict: finished.acceptance?.verdict ?? null,
            exitCode: finished.acceptance?.evidence.exitCode ?? null,
            steps: finished.steps.map((step) => step.text),
            error: finished.error ?? null,
            artifactChars: finished.artifacts[0]?.bytes ?? 0,
            tokensUsed: finished.tokensUsed,
            costUsd: finished.costUsd,
          },
          null,
          2,
        )}\n`,
      );
      await work.dispose();
      app.exit(finished.status === 'accepted' ? 0 : 1);
      return;
    }

    if (isBudgetProbe) {
      try {
      // Deterministic and non-destructive: its own temp company, and no model calls.
      // It charges through BudgetService directly — the sandbox refuses commands on
      // Windows, so running a full task here would hang until the durable timeout.
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-budget-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const org = new OrgService(db);
      ensureFirstCompany(org);
      const projects = new ProjectService(db);
      const budgets = new BudgetService(new BudgetRepository(db));
      const budgetCenter = new BudgetCenter({ budgets, org, projects });

      const assignee = org.list().flatMap((department) => department.members)[0]!;
      const departmentId = assignee.departmentId;
      const project = projects.create({ name: '预算探针项目', code: 'BUD', departmentId });
      projects.assign(project.id, assignee.id, '开发');
      const find = (scope: 'project' | 'department' | 'employee' | 'company', id: string) =>
        budgets.list().find((budget) => budget.scope === scope && budget.scopeId === id);

      // ① 单笔消耗同时扣四个维度
      budgets.reserve({
        employeeId: assignee.id,
        taskId: 'probe-multi-axis',
        estTokens: 1_000,
        projectGroupId: project.id,
        departmentId,
      });
      const stoppedOnFirst = budgets.settle('probe-multi-axis', 800, 0);

      const axes = {
        project: find('project', project.id)?.usedTokens ?? 0,
        department: find('department', departmentId)?.usedTokens ?? 0,
        employee: find('employee', assignee.id)?.usedTokens ?? 0,
        company: find('company', 'company-local')?.usedTokens ?? 0,
      };
      const chargedEveryAxis = Object.values(axes).every((used) => used === 800);
      const noStopYet = stoppedOnFirst.length === 0;

      // ② 任一维度没额度就整笔拒绝（不能只扣有钱的那条轴）
      budgets.setLimit('project', project.id, 500);
      let refusedWholeRun = false;
      try {
        budgets.reserve({
          employeeId: assignee.id,
          taskId: 'probe-refused',
          estTokens: 1_000,
          projectGroupId: project.id,
          departmentId,
        });
      } catch {
        refusedWholeRun = true;
      }
      const projectReserved = find('project', project.id)?.reservedTokens ?? 0;

      // ③ 冲过上限 → 硬停 + 告警；F8 停任职；提额度 → 解冻并恢复任职
      // 预估能过、实际花超 —— 生产里硬停几乎都是这么来的。
      budgets.setLimit('project', project.id, 2_000);
      budgets.reserve({
        employeeId: assignee.id,
        taskId: 'probe-trip',
        estTokens: 900,
        projectGroupId: project.id,
        departmentId,
      });
      const stoppedOnTrip = budgets.settle('probe-trip', 1_200, 0);
      const projectStopped = stoppedOnTrip.some((axis) => axis.scope === 'project');

      // WorkService 就是这么反应的（§5.6）：停任职，不停员工。
      const paused = projects.pauseAssignments({ projectId: project.id }, 'project_budget_exceeded');
      const pausedMembers = projects
        .list()
        .find((item) => item.id === project.id)!
        .members.filter((member) => member.status === 'paused').length;

      budgetCenter.setLimit({ scope: 'project', scopeId: project.id, limitTokens: 50_000 });
      const resumedMembers = projects
        .list()
        .find((item) => item.id === project.id)!
        .members.filter((member) => member.status === 'active').length;
      const projectAlert = budgets.alerts().some((alert) => alert.scope === 'project');
      const employerStillActive =
        org.everyone().find((member) => member.id === assignee.id)?.status === 'active';

      const checks = {
        chargedEveryAxis,
        noStopYet,
        refusedWholeRun,
        projectNotHalfReserved: projectReserved === 0,
        projectStopped,
        paused: paused === 1 && pausedMembers === 1,
        resumed: resumedMembers === 1,
        projectAlert,
        employerStillActive,
      };

      process.stdout.write(
        `${JSON.stringify(
          {
            probe: 'budget',
            ...checks,
            axes,
            projectBudget: find('project', project.id) && {
              used: find('project', project.id)!.usedTokens,
              limit: find('project', project.id)!.limitTokens,
              state: find('project', project.id)!.state,
            },
            alerts: budgets.alerts().map((alert) => `${alert.scope}:${alert.level}`),
          },
          null,
          2,
        )}\n`,
      );
      db.close();
      app.exit(Object.values(checks).every(Boolean) ? 0 : 1);
      } catch (error) {
        // A probe must fail loudly, never hang: an unhandled rejection keeps the
        // process alive and CI sees a timeout instead of a reason.
        console.error('BUDGET_PROBE_FAILED', error);
        app.exit(1);
      }
      return;
    }

    if (isWorkProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok'; // probes are deterministic and must not spend tokens
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
        const probeOrg = new OrgService(db);
        ensureFirstCompany(probeOrg);
        const work = new WorkService({
        db,
        paths: appPaths,
        agents: agentsFromOrg(probeOrg),
        upsertTaskCard: () => undefined,
      });
      // Probes must be deterministic: start from an empty ledger/reservation state.
      db.exec('DELETE FROM budget_reservation; DELETE FROM budget;');
      try {
        const created = work.createTask({ ...DEMO_TASK, assigneeId: 'agent-fe' });
        if (!created.ok) {
          process.stdout.write(`${JSON.stringify({ refused: created.error }, null, 2)}\n`);
          await work.dispose();
          app.exit(2);
          return;
        }
        const finished = await work.runTaskAndWait(created.task.id);
        process.stdout.write(
          `${JSON.stringify(
            {
              taskId: finished.id,
              status: finished.status,
              assignee: finished.assigneeName,
              artifacts: finished.artifacts,
              acceptance: finished.acceptance,
              steps: finished.steps.map((step) => step.text),
            },
            null,
            2,
          )}\n`,
        );
        await work.dispose();
        app.exit(finished.status === 'accepted' ? 0 : 1);
      } catch (error) {
        console.error('WORK_PROBE_FAILED', error);
        app.exit(1);
      }
      return;
    }

    if (isSelfTest) {
      initAppPaths();
      const { runDiagnostics } = await import('./diagnostics/report');
      const report = await runDiagnostics();
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      app.exit(report.errors.length > 0 ? 1 : 0);
      return;
    }

    await bootstrap();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Graceful shutdown: flush the service and close IPC before the process dies.
  app.on('before-quit', () => {
    disposeIpc?.();
    disposeIpc = null;
    chat?.dispose();
    chat = null;
    void ocrService?.dispose();
    ocrService = null;
    void work?.dispose();
    work = null;
  });
}
