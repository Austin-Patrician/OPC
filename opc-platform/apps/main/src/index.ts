import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, session, shell } from 'electron';
import type { Context } from '@earendil-works/chord/context';
import { ChatService } from './chat/chatService';
import { referencedConversationArtifacts } from './chat/conversationArtifacts';
import { readMcpConfig } from './mcp/config';
import { closeAllMcpConnections, configureMcpAuth } from './mcp/connection';
import { USER_MEMORY_OWNER } from './memory/owners';
import { loadSmokeScript } from './smoke';
import { consolidateConversation } from './memory/consolidation';
import { ConsolidationRunStore } from './memory/consolidationRun';
import { createMemoryExtraction, type MemoryExtractor } from './memory/extraction';
import { MemoryService } from './memory/memoryService';
import { SignalStore } from './memory/signals';
import { FactService } from './memory/factService';
import { resetCompany } from './seed/resetCompany';
import { openCompanyDatabase, type CompanyDatabase } from './data/companyDatabase';
import { registerIpc } from './ipc/register';
import { AuthService } from './models/authService';
import { FileCredentialStore } from './models/credentialStore';
import { ImageService } from './models/imageService';
import { ModelConfigService } from './models/modelConfigService';
import { DecisionService } from './models/decisionService';
import { SpeechService } from './models/speechService';
import type { SubtaskDraft, Worker, WorkThread } from '@opc/shared/domain';
import type { RouterToolDeps } from './router/routerTools';
import { CompanyService } from './company/companyService';
import { NetworkProxyService } from './network/proxyService';
import { applyProxy, connectProxyRuntime, networkClient } from './network/proxyRuntime';
import { RuntimeService } from './runtime/service';
import { inspectOcrRuntime, resolveOcrAssetsDir } from './ocr/assets';
import { OcrSettingsStore } from './ocr/settings';
import { registerOcrScheme } from './ocr/protocol';
import { handleChatMediaProtocol, registerChatMediaScheme } from './chat/mediaProtocol';
import { OcrService } from './ocr/service';
import { decryptSecret, encryptSecret } from './models/keyCipher';
import { initAppPaths, appPaths } from './paths';
import { WorkService } from './work/workService';
import { shouldPromoteManualCompletion } from './work/reportPolicy';
import { PiExtensionHost } from './extensions/host';
import { PiSkillHost } from './skills/host';
import { BillingSettingsService } from './work/billingSettings';
import { TaskRepository } from './data/taskRepository';
import { SystemEventRepository } from './data/systemEventRepository';
import { WatchdogIncidentRepository } from './data/watchdogIncidentRepository';
import { WatchdogActionRepository } from './data/watchdogActionRepository';
import { ThreadRepository } from './data/threadRepository';
import { FolderWatcher } from './router/folderWatcher';
import { createDingTalkAdapter } from './trigger/dingtalk';
import { createFeishuAdapter } from './trigger/feishu';
import { createGitHubAdapter } from './trigger/github';
import { ingestTrigger } from './trigger/ingest';
import { TriggerRegistry } from './trigger/registry';
import { startTriggerServer, type TriggerServer } from './trigger/server';
import { TriggerSettingsStore } from './trigger/settings';
import { WatchdogHost } from './watchdog/host';
import { createWatchdogJudge } from './watchdog/judge';
import { WatchdogModelStore } from './watchdog/model';
import { createWatchdogAnswerer } from './watchdog/ask';
import { WatchdogPolicyStore } from './watchdog/policy';
import { createRouterHost } from './router/routerHost';
import { SqliteContextGraphStore } from './ontology/contextGraphStore';
import { OntologyCommandService } from './ontology/commandService';
import { OntologyOutboxDispatcher } from './ontology/outboxDispatcher';
import { TriagePolicyStore } from './router/triagePolicy';
import { createLineOpener } from './router/workDispatch';
import type { TickReport } from './router/router';
import { Router } from './router/router';
import { createFastPath } from './router/triage';
import { createDecisionGate } from './router/semanticGate';
import type { SemanticScreener } from './router/semanticGate';
import { pickWorker } from './work/workerPool';
import { DEMO_TASK } from './work/acceptanceTemplate';
import { BrowserInstallService } from './browser/install';
import { BrowserBroker } from './browser/broker';
import { DesktopInstallService } from './desktop/install';
import { DesktopBroker } from './desktop/broker';
import { AssistantToolsService } from './assistant/assistantTools';
import { UsageRepository } from './data/usageRepository';

/** §7.5: idle → cooling (no auto replies); much older → archived + consolidated. */
const IDLE_COOLING_MS = 60 * 60 * 1000;
const IDLE_ARCHIVE_MS = 24 * 60 * 60 * 1000;

const isDev = !app.isPackaged;

// Must happen before `app.whenReady()`: the OCR window loads over `opc-ocr://`.
registerOcrScheme();
registerChatMediaScheme();

/** Compile-time constant injected by electron-vite: `out/main`. */
const mainDir = __dirname;

const isSelfTest = process.argv.includes("--self-test");
/** `OPC_OCR_PROBE=<image>`: recognise one image end-to-end (hidden window, WebGPU/WASM), print JSON, exit. */
const isOcrProbe = process.env.OPC_OCR_PROBE;
/** `OPC_SMOKE=1`: boot the real window, exercise preload + IPC, print a report, exit. */
const isSmoke = process.env.OPC_SMOKE === "1";
/** `OPC_WORK_PROBE=1`: run the Phase 0 loop headlessly and print evidence. */
const isWorkProbe = process.env.OPC_WORK_PROBE === "1";
/** `OPC_MCP_PROBE=1`: 真的起一个 stdio MCP 子进程，连上、列工具、调一次。 */
const isMcpProbe = process.env.OPC_MCP_PROBE === '1';
/** `OPC_SUBAGENT_PROBE=1`: can a tool wait for another conversation in the same harness? (真模型) */
const isSubagentProbe = process.env.OPC_SUBAGENT_PROBE === '1';
/** `OPC_MODEL_PROBE=1`: import the local pi provider config and run one task with the model brain. */
const isModelProbe = process.env.OPC_MODEL_PROBE === "1";
/** `OPC_WATCHDOG_PROBE=1`: 起一个真正的 Watchdog 子进程，证明主进程堵住时它还在转。 */
const isWatchdogProbe = process.env.OPC_WATCHDOG_PROBE === '1';
/** `OPC_WATCHDOG_JUDGE_PROBE=1`: 用默认模型判一次合成证据，验证语义层通路。 */
const isWatchdogJudgeProbe = process.env.OPC_WATCHDOG_JUDGE_PROBE === '1';
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
/** `OPC_RUN_TASK=<issue key | task id>`: 用真实模型把一条任务跑到终态，然后退出。 */
const runTaskRef = process.env.OPC_RUN_TASK;
const isRunTask = Boolean(runTaskRef);
/** `OPC_FACT_PROBE=1`: company facts are versioned and reach the executor's prompt. */
const isFactProbe = process.env.OPC_FACT_PROBE === '1';
/** `OPC_ARCHIVE_PROBE=1`: idle conversation → archived → consolidated once. */
const isArchiveProbe = process.env.OPC_ARCHIVE_PROBE === '1';
/** `OPC_CONSOLIDATE_PROBE=1`: a settled conversation becomes long-term memory. */
const isConsolidateProbe = process.env.OPC_CONSOLIDATE_PROBE === '1';
/** `OPC_MEMORY_PROBE=1`: write → recall into the prompt → recall strengthens it. */
const isMemoryProbe = process.env.OPC_MEMORY_PROBE === '1';
/** `OPC_CHAT_PERSIST_PROBE=1`: messages survive a ChatService restart. */
const isChatPersistProbe = process.env.OPC_CHAT_PERSIST_PROBE === '1';
/** `OPC_RESET_COMPANY=1`: wipe business rows, re-seed the one default executor. */
const isResetCompany = process.env.OPC_RESET_COMPANY === '1';
/** `OPC_FIRST_RUN_PROBE=1`: a temp userData dir → prove what a fresh install contains. */
const isFirstRunProbe = process.env.OPC_FIRST_RUN_PROBE === '1';
/** `OPC_CHAT_PROBE=1`: a 1v1 conversation is created once and reused. */
const isChatProbe = process.env.OPC_CHAT_PROBE === "1";
/** `OPC_TRIAGE_PROBE=1`: 两层过滤各自可配，而且两层都不丢活。 */
const isTriageProbe = process.env.OPC_TRIAGE_PROBE === '1';
/** `OPC_REVIEW_PROBE=1`: system pass → manager verdict.json → original accepted. */
const isReviewProbe = process.env.OPC_REVIEW_PROBE === "1";
/** `OPC_IMAGE_LOOP_PROBE=1`: mock image endpoint → agent tool → image-200 acceptance. */
const isImageLoopProbe = process.env.OPC_IMAGE_LOOP_PROBE === "1";
/** `OPC_CRASH_PROBE=start|resume`: kill the app mid-run, then prove it resumes. */
const crashProbe = process.env.OPC_CRASH_PROBE;
let mainWindow: BrowserWindow | null = null;
let chat: ChatService | null = null;
let work: WorkService | null = null;
let ocrService: OcrService | null = null;
let browserBroker: BrowserBroker | null = null;
let desktopBroker: DesktopBroker | null = null;
/** Kept at module scope so IPC can trigger a manual wake (§7.2 P0). */
let disposeIpc: (() => void) | null = null;
function createMainWindow() {
	const window = new BrowserWindow({
		width: 1260,
		height: 800,
		minWidth: 980,
		minHeight: 650,
		roundedCorners: true,
		show: false,
		backgroundColor: "#dcdce0",
		title: "OPC Agent 工作台",
		...process.platform === "darwin" ? {
			titleBarStyle: "hiddenInset",
			trafficLightPosition: {
				x: 14,
				y: 6
			}
		} : { titleBarStyle: "hidden" },
		webPreferences: {
			preload: path.join(mainDir, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
			spellcheck: false
		}
	});
	if (process.platform === "darwin") {
		// The renderer owns the right-side window controls; avoid duplicating the
		// native traffic lights on the left side of the title bar.
		window.setWindowButtonVisibility(false);
	}
	window.center();
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
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: opc-media:; media-src 'self' blob: opc-media:; font-src 'self' data:; connect-src 'self'",
        ],
      },
    });
  });
}

/** Loaded once: pi-durable is ESM-only, the main bundle is CJS. */
let routerContextPromise: Promise<Context> | null = null;
function getBackgroundContext() {
  routerContextPromise ??= import('@earendil-works/chord/context').then(
    (module) => module.BACKGROUND_CONTEXT,
  );
  return routerContextPromise;
}

/** 只有真到达你的东西才值得一行日志；安静是预期结果。 */
function logTick(report: TickReport): void {
  if (
    report.routed === 0 &&
    report.passthrough === 0 &&
    report.reports === 0 &&
    report.gated === 0 &&
    report.dropped === 0
  ) {
    return;
  }
  console.warn('[router]', report);
}

/**
 * 全新安装时唯一需要的那个执行体。
 *
 * 界面上已经没有招聘、部门和组织架构了，但派活仍然需要一个执行体：模型、工具
 * 策略、技能都挂在 `worker` 行上。所以首次运行只建**一个**，而不是塞一个演示公司。
 *
 * 幂等：已经有执行体就返回第一个，重复调用不会多出第二个。
 */
const DEFAULT_EXECUTOR = {
  name: '小助手',
  template: 'research',
  // 三个模板都要能落在它身上：pickWorker 命中不了别人时也必须有人能干。
  skills: ['TypeScript', 'Node.js', 'Python', '调研', '写作', '分析', '部署', '运维'],
} as const;

function seedExecutor(db: CompanyDatabase): Worker {
  const threads = new ThreadRepository(db);
  const existing = threads.listAllWorkers()[0];
  if (existing) return existing;
  return threads.createWorker({
    name: DEFAULT_EXECUTOR.name,
    template: DEFAULT_EXECUTOR.template,
    skills: [...DEFAULT_EXECUTOR.skills],
  });
}

async function bootstrap(): Promise<void> {
  initAppPaths();

  const db = openCompanyDatabase(appPaths.database);
  // 系统故障的去处。Watchdog（`11-watchdog-spec.md`）读的就是这张表；
  // 在这之前，这些事只存在于控制台，而读库的东西看不见控制台。
  const systemEvents = new SystemEventRepository(db);
  // Watchdog 的 incident 镜像（事实源在它自己的库里）。给 Router 与界面读。
  const watchdogIncidents = new WatchdogIncidentRepository(db);
  // 动作账本：认领 → 执行 → 回写。幂等键是 (incident, action)。
  const watchdogActions = new WatchdogActionRepository(db);
  // 规则（W7）：阈值、冷却、总开关。设置页写、子进程每轮读。
  const watchdogPolicy = new WatchdogPolicyStore(db);
  // 它自己的模型（W5）：没配就退回默认 LLM。
  const watchdogModel = new WatchdogModelStore(db);
  /**
   * 子进程的宿主。注册 IPC 时它还没建出来（下面要拿 `work` 等装配），
   * 所以用一个晚绑定的引用：设置页改了模型要能立刻通知到它。
   */
  let watchdogHost: WatchdogHost | null = null;
  const instanceId = randomUUID();
  const previousRun = systemEvents.uncleanExit(instanceId);
  if (previousRun) {
    systemEvents.recordSafely({
      kind: 'process.unclean_exit',
      severity: 'warning',
      subjectType: 'process',
      summary: '上一次运行时没有正常退出：有可能有任务停在中途。',
      detail: {
        lastSeenAt: new Date(previousRun.at).toISOString(),
        previousInstance: previousRun.instanceId,
        pid: previousRun.pid,
        state: previousRun.state,
      },
    });
  }
  systemEvents.beat({ instanceId, pid: process.pid });
  const heartbeat = setInterval(() => {
    try {
      systemEvents.beat({ instanceId, pid: process.pid });
    } catch (error) {
      // 心跳写不进去说明库有问题；它不该把整个应用带下去。
      console.warn('[heartbeat] 写不进去', error);
    }
  }, 15_000);
  heartbeat.unref?.();
  app.on('before-quit', () => {
    clearInterval(heartbeat);
    try {
      systemEvents.beat({ instanceId, pid: process.pid, state: 'stopping' });
    } catch {
      // 退出路径上没什么可做的：下一次启动会把它当成异常退出，那也不算错。
    }
  });
  // `app.exit()`（探针全走这条路）不会触发 `before-quit`。没有这一条，每跑一次
  // 探针都会留下一条"上次没正常退出"，把真正的异常淹掉。
  process.on('exit', () => {
    try {
      systemEvents.beat({ instanceId, pid: process.pid, state: 'stopping' });
    } catch {
      // 同步写都失败，说明库已经不可用了；记录退出状态不是这时该做的事。
    }
  });
  const credentialStore = new FileCredentialStore(`${appPaths.userData}/credentials.json`);
  const modelConfig = new ModelConfigService(db, credentialStore, networkClient);
  const network = new NetworkProxyService(db, {
    cipher: { encrypt: encryptSecret, decrypt: decryptSecret },
    apply: applyProxy,
  });
  const assistantTools = new AssistantToolsService(db, networkClient);
  // One instance for the process: the router writes threads here, IPC reads them.
  const threads = new ThreadRepository(db);
  // 全新安装要有一个人能干活：界面上已经没有招聘和组织架构了，
  // 所以这里自动建**一个**执行体（不是以前那个六个人的演示公司）。
  // 用 `OPC_COMPANY_SETUP=<file>` 导入模板仍然有效，它会先于这一步发生。
  try {
    const before = threads.listAllWorkers().length;
    seedExecutor(db);
    if (before === 0) console.warn('[OPC] 已创建默认执行体「小助手」：可以直接丢目标给它了。');
  } catch (error) {
    console.error('[OPC] 创建默认执行体失败', error);
  }

  chat = new ChatService({
    db,
    conversations: [],
  });
  threads.onReportCreated = (report) => {
    const conversationId = chat?.ensureAssistant();
    const activity = conversationId ? chat?.getActivity(conversationId) : undefined;
    // Normal chat-dispatched work may finish with a silent durable report.
    // While this conversation is active, promote that result into the Router
    // queue so completion can be summarized back to the user. Background or
    // speculative work stays silent when the assistant is idle.
    const reportThread = report.threadId ? threads.getThread(report.threadId) : null;
    // A normal user-dispatched line may finish after the short "working"
    // activity indicator has returned to idle. In that case gating promotion on
    // the current activity loses the completion forever: the durable report stays
    // silent and Router is never given a chance to summarize it. Manual lines are
    // the chat/goal path; folder/webhook and explicitly speculative lines keep
    // their background semantics.
    const reportTask = report.taskId ? work?.getTask(report.taskId) : undefined;
    if (conversationId && shouldPromoteManualCompletion(report, reportThread, reportTask)) {
      const promoted = threads.promoteReport(report.id);
      if (promoted) report = promoted;
    }
    if (conversationId && activity && activity.phase !== 'idle') {
      chat?.setActivity(conversationId, 'organizing');
    }
    // A completed worker writes its result through this callback. Updating the
    // activity indicator alone is not enough: the Router must be scheduled to
    // consume the new report, otherwise the conversation remains in thinking
    // forever until another user message happens to wake it.
    wakeRouter();
    // Worker reports are input to the Router's final response. Only a direct
    // question remains an interactive chat card; approvals have their own card
    // callback below. This keeps the user-facing transcript free of duplicate
    // report cards and intermediate execution details.
    if (!conversationId || report.kind !== 'question') return;
    chat?.appendWorkflowCard(conversationId, {
      type: 'workflow',
      reportId: report.id,
      threadId: report.threadId,
      ...(report.taskId ? { taskId: report.taskId } : {}),
      kind: report.kind === 'question' ? 'question' : 'report',
      title: report.title,
      body: report.body,
      state: 'pending',
    });
  };
  threads.onReportRead = (reportId) => {
    chat?.updateWorkflowCard(reportId, 'resolved');
    const conversationId = chat?.ensureAssistant();
    if (conversationId && chat?.getActivity(conversationId)?.phase === 'waiting_user') {
      chat?.setActivity(conversationId, 'thinking');
    }
  };
  // A previous process may have marked a report handled without persisting the
  // corresponding chat snapshot update (or the app may have been closed between
  // those two writes). Remove those stale action cards before restoring any new
  // ones; otherwise the UI shows a pending card whose IPC action is already a
  // no-op.
  const persistedActionCards = chat.readActionCards().flatMap(({ block }) =>
    block.type === 'approval' || block.type === 'workflow'
      ? [{ reportId: block.reportId, type: block.type }]
      : [],
  );
  for (const card of persistedActionCards) {
    const report = threads.getReport(card.reportId);
    if (!report || report.readAt !== null || (card.type === 'workflow' && report.kind !== 'question')) {
      if (card.type === 'approval') chat.updateApprovalCard(card.reportId, 'allowed');
      else chat.updateWorkflowCard(card.reportId, 'resolved');
    }
  }
  // Backfill actionable reports created before the chat-first UI existed. This
  // is idempotent because persisted report ids are used as the card key.
  const existingWorkflowCards = new Set(
    chat.readActionCards()
      .flatMap(({ block }) => block.type === 'workflow' ? [block.reportId] : []),
  );
  const routerConversation = chat.ensureAssistant();
  for (const report of threads.listPendingConversationReports(200).filter((item) => item.kind === 'question')) {
    if (existingWorkflowCards.has(report.id)) continue;
    chat.appendWorkflowCard(routerConversation, {
      type: 'workflow',
      reportId: report.id,
      threadId: report.threadId,
      ...(report.taskId ? { taskId: report.taskId } : {}),
      kind: report.kind === 'question' ? 'question' : 'report',
      title: report.title,
      body: report.body,
      state: 'pending',
    });
  }

  // Consolidation summariser: the same provider the agents answer with, so nothing
  // is invented when no model is configured (consolidation then writes nothing).
  const summarize = async ({ messages: turns }: { messages: { senderId: string; text: string }[] }) => {
    const defaults = modelConfig.getDefaults().llm;
    if (!defaults) throw new Error('未配置默认 LLM 模型');
    const models = await modelConfig.runtime.createModels();
    const model = await modelConfig.runtime.resolveModel(defaults.providerId, defaults.modelId);
    if (!model) throw new Error('找不到模型');
    const transcript = turns.map((turn) => `${turn.senderId === 'user' ? '你' : '助手'}：${turn.text}`).join('\n');
    const answer = await models.complete(model, {
      systemPrompt: [
        '下面是一段助手和用户的对话。只提炼**会改变下次行为**的东西：',
        '- 他明确要求过的做法、他偏好什么、他讨厌什么',
        '- 关于他本人或他的工作的稳定事实',
        '',
        '**不要记**这几类。它们是这份数据变脏的全部原因：',
        '- 这段对话里发生了什么：进度、结论、失败、谁说了什么、工具报了什么错',
        '- 方法论与通用原则（"应当先确认验收标准"这种话对谁都成立，等于没说）',
        '- 同一个意思的第二种说法',
        '',
        '每条一行，格式为「类型|内容」，类型只能是 preference / fact。',
        '一条都提炼不出来就输出空——这是正常结果，不是失败。',
      ].join('\n'),
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
        // 只收这两类：`experience` 是情景记录，属于对话历史，不属于记忆。
        const kind = (['fact', 'preference'] as const).includes(
          rawKind!.trim() as 'fact' | 'preference',
        )
          ? (rawKind!.trim() as 'fact' | 'preference')
          : 'fact';
        return { kind, content: rest.join('|').trim() };
      })
      .filter((lesson) => lesson.content.length > 0);
  };
  chat.consolidate = async ({ conversationId, ownerId, messages: turns }) =>
    consolidateConversation(memory, { conversationId, ownerId, messages: turns }, summarize, {
      runs: consolidationRuns,
    });

  // 这里本来有 `chat.replyWithModel`：一个执行体用「你是「X」，岗位是 Y」的人设直接
  // 回答你。v2 的双层架构里没有这条路——Worker 只向 Router 汇报，由 Router 统一
  // 对外说话（§2.2）。留着它就等于留了第二个能回答你的人。
  const memory = new MemoryService(db, {
    /**
     * 一条偏好被升进常驻层时告诉你。
     *
     * 升级之后它每一轮都在生效——**不可见的自动升级是赌博**。所以要说一句，并且给出
     * 两条后路：当场否决，或者去设置页改。
     */
    onPromoted: ({ content, observations }) => {
      // 通知是加分项：聊天服务还没起来时，记忆本身已经升级好了，不该因此回滚。
      const conversationId = chat?.ensureAssistant();
      if (!conversationId) return;
      try {
        chat?.appendRouterMessage(
          conversationId,
          `你提过 ${observations} 次的这件事，我记成长期规矩了：「${content}」。` +
            '不对的话跟我说一声，或者去 设置 → 它记得什么 里改。',
        );
      } catch (error) {
        console.warn('[memory] 晋级没通知出去（不影响记忆本身）', error);
      }
    },
  });
  const facts = new FactService(db);
  const consolidationRuns = new ConsolidationRunStore(db);
  const billingSettings = new BillingSettingsService(db);
  billingSettings.ensureDefaults();
  const usage = new UsageRepository(db);
  const imageService = new ImageService(modelConfig, networkClient, usage);
  const speechService = new SpeechService(modelConfig, networkClient, usage);
  const decisionService = new DecisionService(modelConfig, usage, () => billingSettings.get().pricingMode);

  /**
   * 偏好抽取：把「返工理由」和「改方向」变成记忆。
   *
   * 后置、批量、可失败。它看的是用户**明确说出来的**要求，不是他说话的语气——
   * 「图表要标上单位」是判定，「嗯……还行吧」不是。
   *
   * 格式是五行一段的朴素文本，和归档巩固用的是同一套办法（`models.complete` 而不是
   * 另造一个结构化协议）：这里要的是"模型把话讲清楚"，不是"把 JSON 解析对"。
   * 解析失败的一行就丢掉，不要为了填满结构去猜。
   */
  const extractPreferences: MemoryExtractor = async (signals) => {
    const defaults = modelConfig.getDefaults().llm;
    if (!defaults) throw new Error('未配置默认 LLM 模型');
    const models = await modelConfig.runtime.createModels();
    const model = await modelConfig.runtime.resolveModel(defaults.providerId, defaults.modelId);
    if (!model) throw new Error('找不到模型');

    const transcript = signals
      .map((signal) => `[${signal.origin === 'rework' ? '让我重做' : '中途改方向'}] ${signal.text}`)
      .join('\n');
    const answer = await models.complete(model, {
      systemPrompt: [
        '下面是一个人让助手重做、或中途改变方向时说的话。',
        '把里面**明确表达出来、以后仍然成立**的要求提炼成条目。每条一行，五段用 | 分隔：',
        '类型|主题|时效|范围|内容',
        '- 类型：preference / constraint / format / workflow / person / term / fact',
        '- 主题：这条讲的是哪件事，用一个稳定的短英文名（如 reply.length、chart.units）；说不清就写 -',
        '- 时效：stable（一直有效）/ slow（多数偏好）/ session（只这阵子有效）',
        '- 范围：person（关于这个人）/ thread（只关于这一单）',
        '- 内容：一句可执行的话，不要写"他好像""可能"。',
        '只提炼他明确说过的，不要推测。一次性的意见（"这版先这样"）不算。没有值得记的就一行都不输出。',
      ].join('\n'),
      messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
    } as never);

    const text = ((answer as { content?: { type: string; text?: string }[] }).content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    return parseExtracted(text);
  };

  const contextGraph = new SqliteContextGraphStore(db);
  // Created after WorkService, but Router's harness is lazy. This late-bound
  // reference lets the Router expose the same command boundary without a
  // second implementation or a bootstrap cycle.
  let ontologyCommands: OntologyCommandService | null = null;
  const preferenceExtraction = createMemoryExtraction({
    signals: new SignalStore(db),
    memory,
    extract: extractPreferences,
    onWritten: ({ candidate, memoryId, signals }) => {
      const content = candidate.content.trim();
      if (!content) return;
      const episode = contextGraph.appendEpisode({
        sourceType: 'memory.extraction',
        sourceId: memoryId,
        actor: 'model',
        content,
        metadata: { confidence: 0.65, candidate: true, sourceSignals: signals.map((signal) => signal.id) },
      });
      const user = contextGraph.resolveEntity('user')!;
      // Extracted memories remain candidate evidence (confidence < 1). They
      // never become standing constraints automatically.
      contextGraph.assertFact({
        subjectEntityId: user.id,
        predicate: candidate.kind === 'fact' ? 'describes' : 'prefers',
        objectValue: content,
        valueType: 'text',
        sourceEpisodeId: episode.id,
        confidence: 0.65,
      });
    },
  });
  // Ontology graph semantics live beside existing business data; task/worker/
  // approval tables remain authoritative and are never shadow-copied.
  const ontologyOutbox = new OntologyOutboxDispatcher(contextGraph);
  ontologyOutbox.subscribe((event) => {
    systemEvents.recordSafely({
      kind: 'ontology.changed',
      severity: 'info',
      subjectType: 'router',
      subjectId: event.aggregateId,
      summary: `Ontology 事件：${event.eventType}`,
      detail: { eventType: event.eventType, aggregateType: event.aggregateType, aggregateId: event.aggregateId, payload: event.payload },
    });
  });
  ontologyOutbox.start();
  app.on('before-quit', () => ontologyOutbox.stop());
  // One runtime service for the whole process: employees, acceptance scripts and
  // the settings page must see exactly the same interpreters. The app-owned
  // `<userData>/runtimes` directory is where the PATH shims live.
  const runtimeService = new RuntimeService(db, {
    userDataDir: appPaths.userData,
    network: networkClient,
  });
  const browserInstall = new BrowserInstallService(db, appPaths.userData);
  browserBroker = new BrowserBroker(browserInstall, appPaths.artifactsDir);
  const desktopInstall = new DesktopInstallService(db, appPaths.userData);
  desktopBroker = new DesktopBroker(desktopInstall);
  await desktopBroker.initialize();

  const ocrSettings = new OcrSettingsStore(db);
  const ocr = ensureOcr(ocrSettings);
  // 计费口径：定价策略 + 展示币种 + 手工汇率。汇率只影响渲染，不写进账本。
  // Pi extensions on this machine (`~/.pi/agent/extensions`). Scanning is free;
  // only the ones you turned on are imported.
  const piExtensions = new PiExtensionHost({ userDataDir: appPaths.userData });
  // Skills are Markdown, so there is nothing to trust: they are discovered and
  // available unless you switches them off.
  const piSkills = new PiSkillHost({ userDataDir: appPaths.userData });
  // 外部能力（MCP）：读 `<userData>/mcp.json`，再读 pi 的 `~/.pi/agent/mcp.json`。
  // 一个服务器连不上只会让它的工具不在，不影响别的、也不影响这个应用能不能开。
  // OAuth 的 token 存在 userData 下（加密）：和模型的凭据分开放，两件事生命周期不一样。
  configureMcpAuth(appPaths.userData);
  const readMcp = () => readMcpConfig({ userDataDir: appPaths.userData }).servers;
  const mcpConfigured = readMcp();
  if (mcpConfigured.length > 0) {
    console.warn(`[mcp] 读到 ${mcpConfigured.length} 个服务器：${mcpConfigured.map((s) => s.name).join('、')}`);
  }
  let wakeRouter: () => void = () => undefined;
  work = new WorkService({
    db,
    threads,
    faults: systemEvents,
    paths: appPaths,
    upsertTaskCard: () => undefined,
    onApprovalCard: ({ report, task, tool, browser, desktop }) => {
      const conversationId = chat?.ensureAssistant();
      if (!conversationId) return;
      chat?.appendApprovalCard(conversationId, {
        type: 'approval',
        reportId: report.id,
        threadId: report.threadId,
        taskId: task.id,
        tool,
        ...(browser ? { browser } : {}),
        ...(desktop ? { desktop } : {}),
        title: report.title,
        body: report.body,
        state: 'pending',
      });
    },
    onApprovalResolved: (reportId, state) => {
      chat?.updateApprovalCard(reportId, state);
      const conversationId = chat?.ensureAssistant();
      if (conversationId) chat?.setActivity(conversationId, 'thinking');
    },
    mcp: readMcp,
    modelConfig,
    assistantTools,
    usageRepository: usage,
    pricingMode: () => billingSettings.get().pricingMode,
    images: imageService,
    speech: speechService,
    decisions: decisionService,
    memory,
    facts,
    contextGraph,
    network: networkClient,
    runtime: runtimeService,
    ocr,
    piExtensions,
    piSkills,
    wakeRouter: () => wakeRouter(),
    browser: browserBroker,
    desktop: desktopBroker,
  });
  // Development phase: discard approval prompts created before chat cards were
  // introduced, otherwise old queue state can leave threads permanently waiting.
  const persistedApprovalCards = new Set(
    chat.readActionCards()
      .flatMap(({ block }) => block.type === 'approval' ? [block.reportId] : []),
  );
  for (const threadId of threads.clearPendingApprovals(persistedApprovalCards)) {
    const thread = threads.getThread(threadId);
    const stillWaiting = threads.listReportsOf(threadId, 50).some(
      (report) => report.readAt === null && report.kind !== 'approval',
    );
    if (thread?.state === 'waiting' && !stillWaiting) threads.setState(threadId, 'open');
  }

  // v2 路由：在 IPC 之前建好，聊天输入可以直接创建工作线。
  // 定时器在下面按「非无头」条件启动——这里只创建，不驱动。
  /**
   * 两层过滤的配置（§3.1）。存在 `app_setting` 里，设置页写、调度循环每一轮读。
   */
  const triage = new TriagePolicyStore(db);

  /**
   * 触发源（§3 事件驱动）：GitHub、飞书、钉钉。
   *
   * 三家各自一个适配器，只管自己那套方言；`TriggerRegistry` 按 `/hook/<id>` 认人，
   * 认出来之后验身、归一，再交给 `ingestTrigger` 落事件。**加一个新的触发源不改
   * 调度循环一行**——这就是这一层存在的理由。
   *
   * 密钥每次请求重新读（`secret()` 是个闭包），所以在设置里改完立刻生效；端口不行，
   * 端口要重启才换，界面上说清楚。
   */
  const triggerSettings = new TriggerSettingsStore(db);
  const triggerRegistry = new TriggerRegistry([
    createGitHubAdapter(() => triggerSettings.get().secrets.github),
    createFeishuAdapter(() => triggerSettings.get().secrets.feishu),
    createDingTalkAdapter(() => triggerSettings.get().secrets.dingtalk),
  ]);
  let triggerServer: TriggerServer | null = null;
  const triggerStatus = () => {
    const settings = triggerSettings.get();
    return {
      running: triggerServer !== null,
      port: triggerServer?.port ?? settings.port,
      entries: triggerRegistry.entries.map((entry) => {
        const url = triggerServer?.urls.find((candidate) => candidate.id === entry.id)?.url;
        return {
          id: entry.id,
          source: entry.source,
          url: url ?? `http://127.0.0.1:${settings.port}/hook/${entry.id}`,
          configured: Boolean(settings.secrets[entry.id as keyof typeof settings.secrets]?.trim()),
        };
      }),
    };
  };

  /**
   * Router：一个真的会话。
   *
   * 从这一版起，`router` 不是"一个会调模型的循环"，而是**一个常驻的 LLM 会话**
   * （自己的 sqlite、自己的上下文、自己的工具），外面套一层确定性的调度循环：
   * 程序层过滤 → 直通判定 → 攒批交给会话。语义判断全在会话里，不在这个循环里。
   */
  const activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const routerHost = createRouterHost({
    db,
    threads,
    faults: systemEvents,
    agentsDir: appPaths.agentsDir,
    workspaceDir: appPaths.workspaceDir,
    modelConfig,
    assistantTools,
    usageRepository: usage,
    pricingMode: () => billingSettings.get().pricingMode,
    envFor: () => runtimeService.envFor() as Record<string, string>,
    context: () => getBackgroundContext(),
    /** 两层过滤怎么配：设置页写、每一轮读（改完立刻生效）。 */
    policy: () => triage.get(),
    /** 语义门用的分类器；没配模型时这一层自动关掉，不是错误。 */
    decisions: decisionService,
    /**
     * Router 的记忆。
     *
     * 归属是**用户**（`'user'`），不是 `'router'`：一条「以后结论放前面」是关于他的，
     * 执行体也得能读到。归档巩固写的是同一个归属，所以写的人和读的人终于是同一个。
     */
    memory,
    /** 工作台的规矩：执行体的提示词里有，Router 也得有。 */
    facts,
    personalPreferences: () => {
      const profile = new CompanyService(db).get();
      return { tone: profile.replyTone, detail: profile.replyDetail, instructions: profile.replyInstructions };
    },
    contextGraph,
    workerCapabilities: () => work?.routerCapabilities() ?? [],
    ontologyCommand: (input: Parameters<NonNullable<RouterToolDeps['ontologyCommand']>>[0]) => ontologyCommands
      ? ontologyCommands.execute({ actor: 'router', ...input })
      : Promise.resolve({ ok: false, command: { commandId: '', status: 'failed', approvalId: null, error: '本体命令服务尚未就绪' }, error: '本体命令服务尚未就绪' }),
    openLine: createLineOpener({
      threads,
      createTask: work!.createTask,
      // 启动但不等待：派活是异步的，Router 拿到 id 就结束这一轮（§4.1）。
      startTask: (taskId) => work!.runTask(taskId),
      // 谁来干：按模板匹配技能，而不是"名单里的第一个"。
      resolveWorker: ({ threadId, template, hint }) => {
        const people = threads.listAllWorkers().map((worker) => ({
          ownerId: worker.id,
          name: worker.name,
          skills: worker.skills,
        }));
        const picked = pickWorker(people, template, hint);
        if (!picked) return null;
        const worker = threads.ensureWorker({
          threadId,
          ownerId: picked.ownerId,
          name: picked.name,
          template,
        });
        return { ownerId: picked.ownerId, workerId: worker.id };
      },
    }),
    // Router 对你说话：走聊天这条唯一的外观信道（§2.2）。
    reply: (response) => chat!.appendRouterMessage(
      chat!.ensureAssistant(),
      response.blocks.filter((block) => block.type === 'markdown').map((block) => block.text).join('\n\n'),
      response.blocks,
    ),
    onActivity: (phase) => {
      const conversationId = chat?.ensureAssistant();
      if (!conversationId) return;
      // `openLine` reports delegating and working back-to-back. Keep the
      // hand-off visible long enough for the renderer to paint it; otherwise
      // the two snapshots are coalesced and the user only ever sees thinking.
      const activityWindow = activityTimers.get(conversationId);
      if (phase !== 'working' && activityWindow) {
        clearTimeout(activityWindow);
        activityTimers.delete(conversationId);
      }
      if (phase === 'working' && chat?.getActivity(conversationId)?.phase === 'delegating') {
        if (!activityWindow) {
          const timer = setTimeout(() => {
            activityTimers.delete(conversationId);
            if (chat?.getActivity(conversationId)?.phase === 'delegating') {
              chat.setActivity(conversationId, 'working');
            }
          }, 420);
          activityTimers.set(conversationId, timer);
        }
        return;
      }
      if (phase === 'completed') {
        chat?.completeActivity(conversationId);
      } else if (phase === 'error') {
        chat?.showActivityError(conversationId);
      } else {
        chat?.setActivity(conversationId, phase);
      }
    },
    /**
     * 你中途改方向（§8.2）。
     *
     * 没有这一行，`steer_line` 就是一个空插座：模型会调它、会失败，而"改主意"
     * 在双层架构里没有第二条路可走——你只能看着一条跑错方向的活跑完。
     */
    steer: (threadId, note) => work!.steerThread(threadId, note),
  });
  const goalRouter = routerHost;

  /**
   * 推一轮调度，不等它跑完。
   *
   * `tick` 是 `async` 的（语义门和 Router 会话都可能等待），调用方不 await 它，所以
   * 你打完字仍会立刻看到自己的消息；同一时间的后续触发由 Router 单飞并在当前轮结束
   * 后自动补跑。失败只记日志，事件会回到队列等待重试。
   */
  const pushTick = (): void => {
    const activity = chat?.getActivity(routerConversation);
    if (activity?.phase === 'delivered') chat?.setActivity(routerConversation, 'thinking');
    void goalRouter.tick().then(logTick, (error: unknown) => {
      console.error('[router] 一轮调度失败', error);
      chat?.showActivityError(routerConversation);
    });
  };
  wakeRouter = pushTick;

  /**
   * 你在聊天里说话 = 一条 Trigger（§3「事件驱动」）。
   *
   * 注意这里**不带 `threadKey`**：聊天是人对 Router 说话的信道，不是某条工作线的
   * 事件流。带上键的话，一旦 Router 为这个话题开过线，后面每句话都会被直通给那个
   * 执行体，Router 就再也听不到你说话了——那是把信道和执行流混成一件事。
   */
  chat.onUserMessage = ({ conversationId, text, attachments }) => {
    try {
      contextGraph.appendEpisode({ sourceType: 'conversation', sourceId: conversationId, actor: 'user', content: text });
    } catch (error) {
      console.warn('[ontology] 保存对话 Episode 失败', error);
    }
    const priorArtifacts = referencedConversationArtifacts({
      text,
      messages: chat!.readTranscript(conversationId),
      workspaceRoot: appPaths.workspaceDir,
      getTask: (taskId) => work?.getTask(taskId),
    });
    const files = [...(attachments ?? []), ...priorArtifacts].filter(
      (attachment, index, all) => all.findIndex((candidate) => candidate.path === attachment.path) === index,
    );
    threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text, ...(files.length ? { attachments: files } : {}) } });
    pushTick();
  };

  /**
   * 你在对话里丢一个目标。
   *
   * 只开线 + 写入事件，**不直接建任务**：这件事值不值得做、该给谁做，仍然是
   * Router 的决定。开线在这里做，是为了让 UI 立刻能显示它，而不是等下一轮 tick。
   */
  const startGoal = async (goal: string): Promise<WorkThread> => {
    const title = goal.split('\n')[0]?.slice(0, 60).trim() || '未命名目标';
    const thread = threads.createThread({ title, goal });
    threads.enqueueEvent({ source: 'manual', kind: 'goal', payload: { goal }, threadId: thread.id });
    // 你刚打的字不该等 20 秒：立刻推一次，剩下的交给定时器。
    pushTick();
    return thread;
  };

  // Rows created before issue keys existed get one now; new tasks allocate at insert.
  // Runs in headless mode too, so probes and the issue list see the same data.
  try {
    const filled = work.backfillIssueKeys();
    if (filled > 0) console.warn(`backfilled ${filled} issue keys`);
  } catch (error) {
    console.warn('issue key backfill failed', error);
  }

  ontologyCommands = new OntologyCommandService({
    db,
    graph: contextGraph,
    work,
    company: new CompanyService(db),
    requestApproval: ({ command, reason }) => {
      const conversationId = chat!.ensureAssistant();
      chat!.appendOntologyApprovalCard(conversationId, {
        type: 'ontologyApproval',
        commandId: command.commandId,
        action: command.action,
        objectType: command.objectType,
        title: '助手请求执行一项操作',
        body: `${reason}\n\n动作：${command.action}\n对象：${command.objectId}`,
        state: 'pending',
      });
      // The command id is the durable approval handle. There is no synthetic
      // task/report involved, so approval stays attached to this command's
      // original execution thread.
      return command.commandId;
    },
    onApprovalResolved: (command, state) => {
      chat!.updateOntologyApprovalCard(command.commandId, state === 'failed' ? 'rejected' : state);
      const message = state === 'approved'
        ? `已完成：${command.action}（${command.objectId}）`
        : state === 'failed'
          ? `执行失败：${command.action}（${command.objectId}）${command.error ? `：${command.error}` : ''}`
          : `已拒绝：${command.action}（${command.objectId}）`;
      chat!.appendRouterMessage(chat!.ensureAssistant(), message);
    },
  });

  // Remove cards whose command was already completed while the app was closed.
  for (const card of chat.readActionCards().flatMap(({ block }) =>
    block.type === 'ontologyApproval' ? [block] : [],
  )) {
    const command = contextGraph.getCommand(card.commandId);
    if (!command || ['succeeded', 'failed', 'rejected'].includes(command.status)) {
      chat!.updateOntologyApprovalCard(card.commandId, command?.status === 'succeeded' ? 'approved' : 'rejected');
    }
  }
  // Recover a pending command card if the process stopped between the durable
  // command write and the chat snapshot write. The command itself remains the
  // source of truth, so recovery never creates a second execution.
  const existingOntologyCards = new Set(chat.readActionCards().flatMap(({ block }) =>
    block.type === 'ontologyApproval' ? [block.commandId] : [],
  ));
  const recoveryConversation = chat.ensureAssistant();
  for (const command of contextGraph.listCommands('pending')) {
    if (!command.approvalId || existingOntologyCards.has(command.commandId)) continue;
    chat.appendOntologyApprovalCard(recoveryConversation, {
      type: 'ontologyApproval',
      commandId: command.commandId,
      action: command.action,
      objectType: command.objectType,
      title: '助手请求执行一项操作',
      body: `命令 ${command.action} 需要用户确认\n\n动作：${command.action}\n对象：${command.objectId}`,
      state: 'pending',
    });
  }

  disposeIpc = registerIpc({
    chat,
    work,
    models: modelConfig,
    speech: speechService,
    decisions: decisionService,
    facts,
    ontology: contextGraph,
    ontologyCommands,
    browser: browserBroker,
    desktop: desktopBroker,
    consolidationRuns,
    events: systemEvents,
    triage,
    watchdog: {
      incidents: watchdogIncidents,
      actions: watchdogActions,
      policy: watchdogPolicy,
      model: watchdogModel,
      ask: createWatchdogAnswerer({
        models: modelConfig,
        incidents: watchdogIncidents,
        actions: watchdogActions,
        events: systemEvents,
      }),
      // 模型/钥匙在别的页面改的：这里把子进程手里的那份刷新掉。
      onModelChanged: () => watchdogHost?.refreshModel(),
    },
    memories: {
      list: () =>
        memory.list(USER_MEMORY_OWNER).map((item) => ({
          id: item.id,
          tier: item.tier,
          kind: item.kind,
          subject: item.subject,
          content: item.content,
          createdAt: item.createdAt,
          sourceType: item.sourceType,
          observations: item.observations,
          scopeType: item.scopeType,
        })),
      update: (id: string, content: string) => memory.update(id, content),
      forget: (id: string) => memory.forget(id),
      // 谁知道自己的记忆归谁：活的执行体、活的线、再加上这个人。
      // `'router'` 不在里面——那是 P0 之前的旧归属，也该被问一句。
      orphans: () =>
        memory.orphanOwners(
          new Set([
            USER_MEMORY_OWNER,
            ...threads.listAllWorkers().map((worker) => worker.id),
            ...threads.listActiveThreads(200).map((thread) => thread.id),
          ]),
        ),
      claim: (ownerId: string) => memory.claim(ownerId),
      discard: (ownerId: string) => memory.discardOwner(ownerId),
    },
    triggers: {
      status: triggerStatus,
      set: (patch: unknown) => {
        triggerSettings.set(patch as never);
        // 端口改了要重启才生效，所以这里回的是**当前**状态而不是愿望：界面照着
        // 它显示"重启后生效"，比让用户以为已经换过去要诚实。
        return triggerStatus();
      },
    },
    company: new CompanyService(db),
    network,
    assistantTools,
    runtime: runtimeService,
    // 设置 → 运行时: engines we ship are read-only, so the page reads the disk
    // rather than a stored preference.
    bundled: { inspect: async () => [await inspectOcrRuntime(ocrAssetsDir())] },
    ocrSettings,
    billingSettings,
    usage,
    auth: new AuthService(() => modelConfig.runtime.createModels(), credentialStore),
    workspaceRoot: appPaths.workspaceDir,
    threads,
    startGoal,
    piExtensions,
    piSkills,
  });

  // MCP 服务器是子进程（stdio）：退出时要真的收掉，否则它们会活过这个应用。
  app.on('before-quit', () => {
    void closeAllMcpConnections();
  });

  // Watchdog 是**另一个进程**（`docs/v2/11-watchdog-spec.md` W2）：它读同一个业务库
  // （只读连接），写自己的库；主进程卡住或崩掉时它还在。
  // 探针不加它：几十次短命进程各 fork 一个观测者，只会把探针本身拖慢。
  const watchdog = new WatchdogHost({
    // 探针可以指向一个临时业务库：它要验证"子进程真的去问了模型并落了结论"，
    // 那不该往真实的库里塞假任务。生产路径永远是 `appPaths.database`。
    businessDb:
      (isWatchdogProbe && process.env.OPC_WATCHDOG_PROBE_BUSINESS_DB) || appPaths.database,
    sessionDb: path.join(appPaths.userData, 'watchdog', 'watchdog.sqlite'),
    faults: systemEvents,
    incidents: watchdogIncidents,
    judge: createWatchdogJudge(modelConfig, () => watchdogModel.get()),
    /**
     * 判断模型的钥匙：主进程解密，只通过这条专用通道交给子进程（不进环境变量、
     * 不写盘）。拿不到静态 key（OAuth-only）时返回 null，判断退回主进程。
     */
    modelWire: () => {
      const target = watchdogModel.get() ?? modelConfig.getDefaults().llm;
      if (!target) return null;
      const provider = modelConfig.listProviders().find((entry) => entry.id === target.providerId);
      const model = provider?.models.find((entry) => entry.id === target.modelId);
      const apiKey = modelConfig.readKey(target.providerId);
      if (!provider || !model || !apiKey) return null;
      return {
        providerId: provider.id,
        providerName: provider.name,
        baseUrl: provider.baseUrl,
        api: model.api ?? provider.api,
        modelId: model.id,
        modelName: model.name ?? model.id,
        apiKey,
      };
    },
    /**
     * 白名单动作（W6）。三件事按顺序做，缺一步都不算"修过"：
     *
     * 1. **认领**：`(incident, action)` 唯一键，重复请求直接返回"已执行过"；
     * 2. **执行**：只有 `mcp.reconnect`。断开共享连接并让 harness 失效，
     *    下一个任务会重新挂着试——幂等，最坏结果是"还是连不上"；
     * 3. **回写**：成功写 `done`，失败写 `failed` + 原因。**失败不改 incident 状态**。
     */
    performAction: async (payload) => {
      const claim = watchdogActions.claim({
        incidentId: payload.incidentId,
        action: payload.action,
        reason: payload.reason,
        evidence: payload.evidence,
      });
      // "没认领到"有四种原因，每一种的下一步都不同。旧实现把它们都说成
      // "已经执行过"——一次认领后崩溃会被永久当成修好了。
      if (claim === 'done') return { ok: true, message: '这条动作已经执行过（幂等跳过）' };
      // "正在执行"不是"已经执行"：另一次请求还没回，这一条**没有**被执行。
      // 回 ok 会让子进程把它记成修过了——与动作账本的本意相反。
      if (claim === 'in_flight') {
        return { ok: false, message: '这条动作正在别处执行，本次没有重复执行' };
      }
      if (claim === 'refused') return { ok: false, message: '这条动作之前被拒绝过，不再重试' };
      if (claim === 'exhausted') return { ok: false, message: '这条动作已经试满次数，不再重试' };

      try {
        if (payload.action === 'mcp.reconnect') {
          await closeAllMcpConnections();
          await work?.invalidateAllHarnesses();
          watchdogActions.finish(
            payload.incidentId,
            payload.action,
            'done',
            '已断开共享连接并让执行体缓存失效，下一个任务会重新挂载',
          );
          return { ok: true, message: '已重连' };
        }
        watchdogActions.finish(payload.incidentId, payload.action, 'refused', '不在白名单里');
        return { ok: false, message: `不在白名单里：${payload.action}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        watchdogActions.finish(payload.incidentId, payload.action, 'failed', message);
        return { ok: false, message };
      }
    },
    /**
     * 唯一的人可见出口：一条 incident 升级成 escalated 时，在这件活所属的线上
     * 放一条 `decide`。旧的主进程 Watchdog 退休之后，这句话就靠这里说。
     *
     * 只处理挂在任务上的：进程级的事（主进程不响应）没有"线"可以说话，
     * 它在库里、在镜像里，等 W7 的入口。
     */
    onEscalated: (incident) => {
      // 只有挂在任务上的升级才有"线"可以说话。进程级的事没有线，这句现在
      // 发不出去——返回 false，让镜像保持"未通知"，而不是假装已经通知过。
      if (incident.subjectType !== 'task') return false;
      const row = db
        .prepare(`SELECT thread_id, title FROM task WHERE id = ?`)
        .get(incident.subjectId) as { thread_id: string | null; title: string } | undefined;
      if (!row?.thread_id) return false;
      threads.addReport({
        threadId: row.thread_id,
        level: 'decide',
        title: row.title,
        body: [
          incident.summary,
          incident.verdict
            ? `Watchdog 判断：${incident.verdict}（置信度 ${Math.round((incident.verdictConfidence ?? 0) * 100)}%）${incident.verdictReason ? `；${incident.verdictReason}` : ''}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
        taskId: incident.subjectId,
      });
      return true;
    },
    ...(isWatchdogProbe ? { intervalMs: 1_000 } : {}),
  });
  watchdogHost = watchdog;
  if (!isHeadlessMode) watchdog.start();
  app.on('before-quit', () => {
    void watchdog.stop();
  });

  if (isWatchdogJudgeProbe) {
    // 一条合成证据：同一个命令失败三次、中间夹着别的动作——正是 W4 抓到的形状。
    const verdict = await createWatchdogJudge(modelConfig)({
      taskId: 'probe',
      title: '修构建',
      goal: 'server.js 能通过 node --check，并且 README 说明用法',
      candidate: {
        kind: 'repeat_failure',
        summary: '同一个动作失败了 3 次（bash node --check server.js）',
        detail: '{"attempts":3,"seqs":[2,4,6]}',
      },
      trace: [
        { seq: 1, at: Date.now() - 5000, name: 'read', argsDigest: 'src/app.ts', ok: true },
        { seq: 2, at: Date.now() - 4000, name: 'bash', argsDigest: 'node --check server.js', ok: false },
        { seq: 3, at: Date.now() - 3000, name: 'write', argsDigest: 'server.js', ok: true },
        { seq: 4, at: Date.now() - 2000, name: 'bash', argsDigest: 'node --check server.js', ok: false },
        { seq: 5, at: Date.now() - 1000, name: 'read', argsDigest: 'src/app.ts', ok: true },
        { seq: 6, at: Date.now(), name: 'bash', argsDigest: 'node --check server.js', ok: false },
      ],
    });
    process.stdout.write(`WATCHDOG_JUDGE ${JSON.stringify(verdict)}\n`);
    app.exit(verdict.ok ? 0 : 1);
  }

  if (isWatchdogProbe) {
    watchdog.start();
    const ready = await watchdog.whenReady(8_000);
    const firstPid = watchdog.pidForProbe();
    // W8：模拟一次崩溃，看它会不会按退避策略自己回来。
    watchdog.crashForProbe();
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const restarted = await watchdog.ping();
    const secondPid = watchdog.pidForProbe();
    const before = await watchdog.ping();
    // 主进程**故意堵住自己**：一段同步忙等。同一进程里的定时器这时会停，
    // 子进程不该停——这是 W2 唯一真正要证明的事。
    const until = Date.now() + 3_000;
    while (Date.now() < until) {
      // busy wait on purpose
    }
    const after = await watchdog.ping();
    const advanced = (after?.lastTickAt ?? 0) > (before?.lastTickAt ?? 0);
    // 等这次判断落地：基线是 ready 时的计数，等到它变大或超时。
    const judgeDeadline = Date.now() + 60_000;
    const baseline = before?.judged ?? 0;
    let judged = after?.judged ?? 0;
    while (judged <= baseline && Date.now() < judgeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      judged = (await watchdog.ping())?.judged ?? 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    process.stdout.write(
      `WATCHDOG_PROBE ${JSON.stringify({
        ready,
        before,
        after,
        tickAdvancedWhileBlocked: advanced,
        restarted: Boolean(restarted) && secondPid !== null && secondPid !== firstPid,
        pids: [firstPid, secondPid],
        sessionDbExists: existsSync(path.join(appPaths.userData, 'watchdog', 'watchdog.sqlite')),
        judged,
        mirror: watchdogIncidents.listOpen(5).map((row) => ({ kind: row.kind, state: row.state })),
        actions: watchdogActions.listRecent(3),
      })}\n`,
    );
    await watchdog.stop();
    app.exit(ready && advanced && restarted ? 0 : 1);
  }

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

  // The v2 loop: a folder you drops files into becomes lines of work.
  //
  // This is the whole point of the重构 — nothing is typed into a chat window. A file
  // lands, the router decides it is worth doing, a thread opens, a task runs, and the
  // result either closes quietly or asks for a decision. Headless probes drive the
  // router themselves instead of waiting for a timer.
  if (!isHeadlessMode && work) {
    const inboxDir = path.join(appPaths.userData, 'inbox');
    try {
      mkdirSync(inboxDir, { recursive: true });
    } catch (error) {
      console.warn('[OPC] 无法创建收件目录，文件夹触发源本次不启用', error);
    }

    /**
     * 触发入口。只监听本机：GitHub / 飞书 / 钉钉都在公网上，要接起来还得在中间放一条
     * 隧道——这一步由用户决定，我们只把门装好。起不来（端口被占）不影响应用打开，
     * 设置页会显示"没在运行"和原因。
     */
    const triggerTasks = new TaskRepository(db);
    void startTriggerServer({
      registry: triggerRegistry,
      port: triggerSettings.get().port,
      onAccepted: (trigger, meta) => {
        const result = ingestTrigger({ threads, tasks: triggerTasks }, trigger, meta);
        if (!result.inserted) return;
        // 一条外部事件到了就推一轮：GitHub 的评论不该等 20 秒的定时器。
        pushTick();
      },
      onOutcome: (outcome) => {
        if (outcome.reason) console.warn('[trigger]', outcome.reason);
      },
    })
      .then((server) => {
        triggerServer = server;
        console.warn('[trigger] 触发入口已就绪', server.urls.map((entry) => entry.url).join(' '));
      })
      .catch((error: unknown) => {
        console.warn('[trigger] 触发入口没能启动（端口可能被占用）', error);
      });

    app.on('before-quit', () => {
      void triggerServer?.close().catch(() => undefined);
    });

    const watcher = new FolderWatcher({
      dir: inboxDir,
      onFile: (file) => {
        threads.enqueueEvent({
          source: 'folder',
          kind: 'folder.added',
          payload: {
            file: file.relPath,
            goal: `处理新到的文件 ${file.relPath}，把结果留在工作区并附一个可运行的验收脚本`,
          },
        });
      },
    });
    watcher.start();

    const tick = setInterval(() => pushTick(), 20_000);
    tick.unref?.();

    app.on('before-quit', () => {
      clearInterval(tick);
      watcher.stop();
    });

    /**
     * 偏好抽取排在后台：用户点完「重做」要立刻看到活重新跑起来，不能等一次模型调用。
     * 五分钟一次，顺带把"上次没配模型时积下的"一起处理掉。
     */
    const runExtraction = (): void => {
      void preferenceExtraction.run().then(
        (result) => {
          if (result.written > 0) console.warn('[memory] 从返工/改方向里抽出', result.written, '条偏好');
          else if (result.skipped) console.warn('[memory] 本轮没抽：', result.skipped);
        },
        (error: unknown) => console.error('[memory] 抽取失败，信号留着下一轮再试', error),
      );
    };
    runExtraction();
    const extractionTimer = setInterval(runExtraction, 5 * 60_000);
    extractionTimer.unref?.();
    app.on('before-quit', () => clearInterval(extractionTimer));

    // 旧的程序层 Watchdog 已经退休（W4）：判据从 `task.steps` 搬到了 `task_trace`，
    // 跑在子进程里（`watchdog/child.ts`）。它唯一的用户可见出口——
    // 「这条线可能卡住了」——由 `onEscalated` 接着发，判据是 incident 升级。
  }

  // Outgoing traffic must already follow the your choice when the first window
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
  handleChatMediaProtocol(session.defaultSession, appPaths.workspaceDir);
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
  isWatchdogProbe ||
  isWatchdogJudgeProbe ||
  Boolean(isOcrProbe) ||
  isWorkProbe ||
  isMcpProbe ||
  isSubagentProbe ||
  isModelProbe ||
  isConsolidationRunProbe ||
  isBlockerProbe ||
  isIssueMetaProbe ||
  isPricingProbe ||
  isFactProbe ||
  isArchiveProbe ||
  isConsolidateProbe ||
  isMemoryProbe ||
  isChatPersistProbe ||
  isResetCompany ||
  isFirstRunProbe ||
  isChatProbe ||
  isTriageProbe ||
  isReviewProbe ||
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
      // 单条任务跑到底：给"真实工作台 + 真实模型"一个非交互的入口，也方便回归。
      // 用真库（就是你正在用的那份），不改任何别的任务。
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const credentialStore = new FileCredentialStore(`${appPaths.userData}/credentials.json`);
      const modelConfig = new ModelConfigService(db, credentialStore, networkClient);
      seedExecutor(db);
      const work = new WorkService({
        db,
        paths: appPaths,
        upsertTaskCard: () => undefined,
        modelConfig,
        memory: new MemoryService(db),
        facts: new FactService(db),
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


    if (isConsolidationRunProbe) {
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-consol-run-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const executor = seedExecutor(db);
      const memory = new MemoryService(db);
      const runs = new ConsolidationRunStore(db);

      const slice = {
        conversationId: 'conv-run-probe',
        ownerId: executor.id,
        messages: [
          { senderId: 'user', text: '交付先给最小可运行版本' },
          { senderId: executor.id, text: '明白' },
        ],
      };

      const skipped = await consolidateConversation(memory, slice, undefined, { runs });
      const done = await consolidateConversation(
        memory,
        slice,
        async ({ messages }) =>
          messages
            .filter((message) => message.senderId === 'user')
            .map((message) => ({ kind: 'preference' as const, content: `你的要求：${message.text}` })),
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
      const executor = seedExecutor(db);
      const work = new WorkService({
        db,
        paths: appPaths,
        upsertTaskCard: () => undefined,
      });

      const dispatch = (title: string) => {
        const created = work.createTask({
          title,
          brief: 'b',
          deliverableSpec: 'server.js 返回 200',
          assigneeId: executor.id,
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
      const executor = seedExecutor(db);
      const work = new WorkService({
        db,
        paths: appPaths,
        upsertTaskCard: () => undefined,
      });
      const created = work.createTask({
        title: '优先级探针',
        brief: 'b',
        deliverableSpec: 'server.js 返回 200',
        assigneeId: executor.id,
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


    if (isFactProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok';
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-fact-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const executor = seedExecutor(db);
      const facts = new FactService(db);
      const memory = new MemoryService(db);
      const threads = new ThreadRepository(db);
      // 作用域只剩两层：整个工作台的规定，和某条工作线自己的规定。
      const line = threads.createThread({ title: '写季度留存方案' });
      const otherLine = threads.createThread({ title: '另一条线' });

      const first = facts.write({ scopeType: 'global', subject: 'Q4目标', object: '先做留存', statement: 'Q4 目标：先做留存，不做新功能' });
      const second = facts.write({ scopeType: 'global', subject: 'Q4目标', object: '先做留存与复购', statement: 'Q4 目标：先做留存与复购' });
      facts.write({
        scopeType: 'thread',
        scopeId: line.id,
        subject: '交付规范',
        object: '必须带 README',
        statement: '这条线的规定：每个交付必须带 README',
      });
      facts.write({
        scopeType: 'thread',
        scopeId: otherLine.id,
        subject: '交付规范',
        object: '另一条线的私有规定',
        statement: '另一条线的规定（不应该出现在这条线的上下文里）',
      });

      const current = facts.current([{ type: 'global' }, { type: 'thread', id: line.id }]);
      const history = facts.history('Q4目标');

      const work = new WorkService({
        db,
        paths: appPaths,
        upsertTaskCard: () => undefined,
        memory,
        facts,
      });
      const created = work.createTask({
        title: '写季度留存方案',
        brief: '按工作台 Q4 目标写',
        deliverableSpec: 'server.js 在 3000 端口返回 200',
        assigneeId: executor.id,
        estTokens: 4000,
        acceptanceCommand: [],
        acceptanceTemplate: 'http-ok',
        threadId: line.id,
      });
      if (!created.ok) throw new Error('事实探针创建任务失败');
      const finished = await work.runTaskAndWait(created.task.id);

      process.stdout.write(
        JSON.stringify({
          probe: 'facts',
          firstSuperseded: first.id !== second.id && history.length === 2,
          currentStatements: current.map((fact) => fact.statement),
          leakedOtherLine: current.some((fact) => fact.statement.includes('另一条线')),
          injectedIntoPrompt: finished.steps.find((step) => step.text.startsWith('注入'))?.text ?? null,
          taskStatus: finished.status,
        }) + '\n',
      );
      app.exit(current.length === 2 && !current.some((fact) => fact.statement.includes('另一条线')) ? 0 : 1);
      return;
    }

    if (isArchiveProbe) {
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-archive-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const memory = new MemoryService(db);

      const chatProbe = new ChatService({
        db,
        conversations: [],
      });
      // Deterministic summariser stand-in; the real one is models.complete.
      chatProbe.consolidate = async ({ conversationId, ownerId, messages: turns }) => {
        const userLines = turns.filter((turn) => turn.senderId === 'user').map((turn) => turn.text);
        let written = 0;
        for (const line of userLines.filter((entry) => entry.includes('README'))) {
          await memory.remember({
            ownerId,
            kind: 'preference',
            content: `你的要求：${line}`,
            scope: { type: 'personal' },
            sourceType: 'consolidation',
            sourceId: conversationId,
          });
          written += 1;
        }
        return { written };
      };

      const conversationId = chatProbe.ensureAssistant();
      // 两句而不是一句：巩固的下限是"会话太短就不值得"，而这里没有执行体替它回话，
      // 只有你自己说的话。
      chatProbe.sendMessage({ conversationId, text: '文档以后放 README 里就够了，别单开 wiki' });
      chatProbe.sendMessage({ conversationId, text: '交付都先给我最小可运行版本' });
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Nothing is idle yet.
      const early = await chatProbe.sweepIdleConversations(60 * 60 * 1000);
      // Backdate the row, as if you walked away an hour ago.
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
          // 巩固出来的是**关于这个人**的记忆，所以它挂在用户身上，不挂在 Router 身上
          // （`memory/owners.ts`）。这条断言以前是 `ROUTER_ID`——那正是被修掉的那个归属。
          memories: memory.listForOwner(USER_MEMORY_OWNER).map((item) => item.content),
        }) + '\n',
      );
      app.exit(
        early.length === 0 &&
          swept.length === 1 &&
          again.length === 0 &&
          row.consolidated_at !== null &&
          // 归档只是机械动作；这条链的意义是"归档之后真的变成了记忆"。
          memory.countForOwner(USER_MEMORY_OWNER) > 0
          ? 0
          : 1,
      );
      return;
    }

    if (isConsolidateProbe) {
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-consolidate-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const executor = seedExecutor(db);
      const memory = new MemoryService(db);

      const conversation = {
        conversationId: 'conv-probe',
        ownerId: executor.id,
        messages: [
          { senderId: 'user', text: '以后交付都先给我最小可运行版本，别一次性堆功能' },
          { senderId: executor.id, text: '明白，先跑通再扩展。' },
          { senderId: 'user', text: '文档放 README 里就够了' },
        ],
      };

      // 1) no summarizer → nothing invented
      const withoutModel = await consolidateConversation(memory, conversation, undefined);

      // 2) with a summarizer (a deterministic stand-in for the model in this probe)
      const withModel = await consolidateConversation(memory, conversation, async ({ messages: turns }) => {
        const userLines = turns.filter((turn) => turn.senderId === 'user').map((turn) => turn.text);
        return userLines
          .filter((line) => line.includes('最小可运行') || line.includes('README'))
          .map((line) => ({
            content: `你的要求：${line}`,
            kind: 'preference' as const,
          }));
      });

      const stored = memory.listForOwner(executor.id);
      const recalled = await memory.retrieve({
        owners: [executor.id],
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
      const executor = seedExecutor(db);
      const memory = new MemoryService(db);

      await memory.remember({
        ownerId: executor.id,
        kind: 'experience',
        content: '健康检查服务必须监听 3000 端口，验收脚本会用 curl 打 /health',
        scope: { type: 'personal' },
        sourceType: 'manual',
      });
      await memory.remember({
        ownerId: executor.id,
        kind: 'preference',
        content: '你偏好先给最小可运行版本，再补文档',
        scope: { type: 'personal' },
        sourceType: 'manual',
      });
      await memory.remember({
        ownerId: executor.id,
        kind: 'experience',
        content: '配色只用语义 token，不写死 hex',
        scope: { type: 'personal' },
        sourceType: 'manual',
      });

      const recalled = await memory.retrieve({
        owners: [executor.id],
        query: '写一个健康检查服务，要能被 curl 验收',
        scopes: [{ type: 'personal' }],
        limit: 2,
      });
      const afterRecall = memory.listForOwner(executor.id).find((item) => item.id === recalled[0]?.id);
      const totalBefore = memory.countForOwner(executor.id);

      const work = new WorkService({
        db,
        paths: appPaths,
        upsertTaskCard: () => undefined,
        memory,
      });
      const created = work.createTask({
        title: '写健康检查服务',
        brief: 'node:http，/health 返回 200',
        deliverableSpec: 'server.js 在 3000 端口返回 200',
        assigneeId: executor.id,
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
          memoriesAfterTask: memory.countForOwner(executor.id),
        }) + '\n',
      );
      app.exit(injected ? 0 : 1);
      return;
    }

    if (isChatPersistProbe) {
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      // 装一个执行体在库里，正是为了证明**它不会**开口：聊天里说话的人只有你和
      // Router（§2.2）。这条断言取代了原来那句"回复是否老实"，因为现在根本不该
      // 有回复——回复要等 Router 决定。
      const executor = seedExecutor(db);

      const first = new ChatService({ db, conversations: [] });
      const conversationId = first.ensureAssistant();
      first.sendMessage({ conversationId, text: '最近有什么产品上线了么' });
      const firstCount = first.readTranscript(conversationId).length;
      first.dispose();

      // "Restart": a brand-new service reading the same SQLite file.
      const second = new ChatService({ db, conversations: [] });
      const restoredMessages = second.readTranscript(conversationId);
      const restoredTexts = restoredMessages.map((message) => message.text ?? message.kind);
      const speakers = [...new Set(restoredMessages.map((message) => message.senderId))];

      process.stdout.write(
        JSON.stringify({
          probe: 'chat-persist',
          conversationId,
          messagesBeforeRestart: firstCount,
          conversationsAfterRestart: second.getSnapshot().conversations.length,
          restoredMessages: restoredTexts,
          speakers,
          workerSilent: !speakers.includes(executor.id),
          persists: firstCount > 0 && restoredTexts.length === firstCount,
        }) + '\n',
      );
      second.dispose();
      app.exit(firstCount > 0 && restoredTexts.length === firstCount && !speakers.includes(executor.id) ? 0 : 1);
      return;
    }

    if (isResetCompany) {
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const removed = resetCompany(db);
      const threads = new ThreadRepository(db);
      const first = seedExecutor(db);
      const second = seedExecutor(db);
      const workers = threads.listAllWorkers();
      process.stdout.write(
        JSON.stringify({
          probe: 'reset-company',
          removed,
          seeded: `${first.name}/${first.template}`,
          idempotent: first.id === second.id,
          workers: workers.map((worker) => `${worker.name}:${worker.status}`),
          storedRows: (db.prepare('SELECT COUNT(*) AS n FROM worker').get() as { n: number }).n,
        }) + '\n',
      );
      app.exit(0);
      return;
    }

    if (isFirstRunProbe) {
      app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'opc-first-run-')));
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const threads = new ThreadRepository(db);
      const before = threads.listAllWorkers().length;
      const first = seedExecutor(db);
      const second = seedExecutor(db);
      const workers = threads.listAllWorkers();
      const chat = new ChatService({
        conversations: [],
      });
      const snapshot = chat.getSnapshot();
      process.stdout.write(
        JSON.stringify({
          probe: 'first-run',
          createdOnFirstCall: before === 0 && workers.length === 1,
          createdOnSecondCall: first.id !== second.id,
          workers: workers.map((worker) => `${worker.name}/${worker.template}`),
          skills: first.skills,
          seededConversations: snapshot.conversations.length,
          storedRows: (
            db.prepare('SELECT COUNT(*) AS n FROM worker WHERE status != ?').get('retired') as { n: number }
          ).n,
        }) + '\n',
      );
      app.exit(0);
      return;
    }

    if (isChatProbe) {
      // v2：聊天只有一条会话，对面是 Router。探针查三件事——重复调用不出第二条、
      // 你的话变成一条 Trigger、Router 说话走唯一出口。
      initAppPaths();
      const service = new ChatService({ agents: [], conversations: [] });
      const first = service.ensureAssistant();
      const second = service.ensureAssistant();

      const triggers: string[] = [];
      service.onUserMessage = (input) => triggers.push(input.text);
      service.sendMessage({ conversationId: first, text: '在吗' });
      service.appendRouterMessage(first, '在。');

      const conversation = service.getSnapshot().conversations.find((item) => item.id === first);
      const last = conversation?.messages.at(-1);
      process.stdout.write(
        JSON.stringify({
          probe: 'chat',
          conversations: service.getSnapshot().conversations.length,
          reused: first === second,
          members: conversation?.memberIds.length ?? 0,
          triggers,
          lastSender: last?.senderId ?? null,
        }) + '\n',
      );
      app.exit(
        first === second &&
          service.getSnapshot().conversations.length === 1 &&
          triggers.length === 1 &&
          last?.senderId === 'router'
          ? 0
          : 1,
      );
      return;
    }

    if (isTriageProbe) {
      // 两层过滤（§3.1）在真实装配下走一遍。这里不碰 harness：要验的是
      // 「策略 → 程序层 / 语义门 → 调度循环」这条链，而不是模型说得好不好。
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      db.exec('DELETE FROM event; DELETE FROM report; DELETE FROM subscription; DELETE FROM worker; DELETE FROM thread;');
      const threads = new ThreadRepository(db);
      const store = new TriagePolicyStore(db);

      const makeRouter = (screen?: SemanticScreener) => {
        const delivered: string[] = [];
        const router = new Router({
          threads,
          prefilter: createFastPath({ policy: () => store.get() }),
          ...(screen ? { semantic: screen } : {}),
          deliver: (text) => delivered.push(text),
        });
        return { router, delivered };
      };

      const run = async () => {
        // ① 名单模式：没登记的来源进不来，登记了的照常进。
        store.set({ fastPath: 'allowlist', sources: ['folder'] });
        threads.enqueueEvent({ source: 'github', kind: 'pr.opened', payload: { text: 'PR #12' } });
        threads.enqueueEvent({ source: 'folder', kind: 'folder.added', payload: { path: 'inbox/a.md' } });
        const allowlist = await makeRouter().router.tick();

        // ② 噪声模式：回环与重复挡掉，人说的话一条不少。
        store.set({ fastPath: 'noise', semantic: 'router' });
        db.exec('DELETE FROM event;');
        threads.enqueueEvent({ source: 'folder', kind: 'folder.added', payload: { path: 'out/x.md', origin: 'self' } });
        threads.enqueueEvent({ source: 'folder', kind: 'folder.added', payload: { path: 'inbox/b.md' } });
        threads.enqueueEvent({ source: 'folder', kind: 'folder.added', payload: { path: 'inbox/b.md' } });
        threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '在吗' } });
        threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '在吗' } });
        const noise = await makeRouter().router.tick();

        // ③ 语义门：分类器判掉的那条既不进 Router，也在库里记成 dropped。
        store.set({ fastPath: 'noise', semantic: 'decision', noiseThreshold: 0.7 });
        db.exec('DELETE FROM event;');
        threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '心跳' } });
        threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '把周报写出来' } });
        const decisions = {
          classify: async (input: { questions: Record<string, unknown> }) => {
            const answers: Record<string, unknown> = {};
            let index = 0;
            for (const key of Object.keys(input.questions)) {
              answers[key] = { type: 'bool', probability: index === 0 ? 0.95 : 0.05 };
              index += 1;
            }
            return { ok: true, answers };
          },
        } as unknown as DecisionService;
        const gated = await makeRouter(
          createDecisionGate({ decisions, threshold: () => store.get().noiseThreshold }),
        ).router.tick();

        // ④ 分类器挂了：一条都不能丢。
        db.exec('DELETE FROM event;');
        threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '在吗' } });
        const broken = {
          classify: async () => {
            throw new Error('没有决策模型');
          },
        } as unknown as DecisionService;
        const fallback = await makeRouter(
          createDecisionGate({ decisions: broken, threshold: () => 0.7 }),
        ).router.tick();

        const droppedRows = (
          db.prepare("SELECT COUNT(*) AS n FROM event WHERE triage = 'dropped'").get() as { n: number }
        ).n;

        // ⑤ 工作台的规矩进 Router 的上下文：执行体的提示词里有，调度的人也得有。
        db.exec('DELETE FROM event;');
        const facts = new FactService(db);
        facts.write({ scopeType: 'global', subject: '交付', object: '每个交付必须带 README' });
        threads.enqueueEvent({ source: 'im', kind: 'user_message', payload: { text: '在吗' } });
        const withRules: string[] = [];
        const rulesRouter = new Router({
          threads,
          prefilter: createFastPath({ policy: () => store.get() }),
          rules: () => facts.current([{ type: 'global' }], 12).map((fact) => fact.statement),
          deliver: (text) => withRules.push(text),
        });
        await rulesRouter.tick();

        process.stdout.write(
          JSON.stringify({
            probe: 'triage',
            allowlist: { dropped: allowlist.dropped, routed: allowlist.routed },
            // ② 五条事件：回环 + 重复各挡一条，剩下的三条（两份人的话 + 一份文件）都往上交。
            noise: { dropped: noise.dropped, routed: noise.routed },
            gated: { gated: gated.gated, routed: gated.routed },
            fallback: { gated: fallback.gated, routed: fallback.routed },
            droppedRowsAfterFallback: droppedRows,
            rulesInPrompt: withRules[0]?.includes('每个交付必须带 README') ?? false,
          }) + '\n',
        );

        app.exit(
          allowlist.dropped === 1 &&
            allowlist.routed === 1 &&
            noise.dropped === 2 &&
            noise.routed === 3 &&
            gated.gated === 1 &&
            gated.routed === 1 &&
            fallback.gated === 0 &&
            fallback.routed === 1 &&
            droppedRows === 0 &&
            withRules[0]?.includes('每个交付必须带 README') === true
            ? 0
            : 1,
        );
      };

      void run().catch((error: unknown) => {
        console.error('[triage probe]', error);
        app.exit(1);
      });
      return;
    }

    if (isReviewProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok';
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      db.exec('DELETE FROM acceptance; DELETE FROM artifact; DELETE FROM task_step; DELETE FROM task;');
      const executor = seedExecutor(db);

      const work = new WorkService({
        db,
        paths: appPaths,
        upsertTaskCard: () => undefined,
      });
      const created = work.createTask({
        title: '写一个健康检查服务',
        brief: 'node:http，/health 返回 200',
        deliverableSpec: 'server.js 在 3000 端口返回 200',
        assigneeId: executor.id,
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
        const final = work.getTask(created.task.id)!;
        const delivered = final.status === 'accepted' ? work.userDecision(created.task.id, 'approve') : null;
        const reviewList = work.listReviews(created.task.id);
        process.stdout.write(
          JSON.stringify({
            probe: 'review',
            finalStatus: final.status,
            acceptanceLevels: final.acceptance ? final.acceptance.reason : null,
            error: final.error ?? null,
            reviewTasks: reviewList.length,
            reviewStatus: reviewList[0]?.status ?? null,
            deliveredStatus: delivered?.status ?? null,
          }) + '\n',
        );
        app.exit(final.status === 'accepted' || final.status === 'delivered' ? 0 : 1);
      });
      return;
    }

    if (isDecomposeProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok';
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const threads = new ThreadRepository(db);
      const manager = threads.createWorker({
        name: '李雷',
        template: 'research',
        skills: ['交付', '管理', '验收'],
      });
      const worker = threads.createWorker({
        name: '韩梅梅',
        template: 'code',
        skills: ['TypeScript', 'Node.js', '前端'],
      });
      const outsider = threads.createWorker({
        name: '外人',
        template: 'research',
        skills: ['调研'],
      });

      const work = new WorkService({
        db,
        paths: appPaths,
        upsertTaskCard: () => undefined,
      });

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
        { id: 'mock/png-1', name: 'Mock PNG', capability: 'image', api: 'openai-images', imageEnabled: true },
      ]);
      modelConfig.setDefault('image', { providerId: 'mock-image', modelId: 'mock/png-1' });

      const images = new ImageService(modelConfig);
      const executor = seedExecutor(db);
      const work = new WorkService({
        db,
        paths: appPaths,
        upsertTaskCard: () => undefined,
        modelConfig,
        images,
      });

      const created = work.createTask({
        title: '生成一张占位图片',
        brief:
          '必须调用 generate_image 工具生成一张图片，filename 用 icon.png。不要自己写 Base64，也不要只回复文字。',
        deliverableSpec: 'icon.png：一张 PNG 图片',
        assigneeId: executor.id,
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
      const executor = seedExecutor(db);
      const work = new WorkService({
        db,
        paths: appPaths,
        upsertTaskCard: () => undefined,
      });
      const created = work.createTask({ ...DEMO_TASK, assigneeId: executor.id });
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
      seedExecutor(db);
      const work = new WorkService({
        db,
        paths: appPaths,
        upsertTaskCard: () => undefined,
      });
      const before = work.listTasks().filter((task) => task.status === 'running').length;

      await work.recover();

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
          },
          null,
          2,
        )}\n`,
      );
      await work.dispose();
      app.exit(latest?.status === 'accepted' ? 0 : 1);
      return;
    }

    if (isMcpProbe) {
      // 外部能力（MCP）的端到端验证：真子进程、真握手、真调用、真收尸。
      try {
        const { probeMcp } = await import('./mcp/probe');
        const outcome = await probeMcp();
        process.stdout.write(`${JSON.stringify({ probe: 'mcp', ...outcome }, null, 2)}\n`);
        app.exit(outcome.ok ? 0 : 1);
      } catch (error) {
        console.error('MCP_PROBE_FAILED', error);
        app.exit(1);
      }
      return;
    }

    if (isSubagentProbe) {
      // 迁移子代理之前的一次前置验证（09-team.md §8）：工具里等另一轮 generation
      // 在同一个 harness 里成不成立。用真库的模型配置 + 临时存储，不碰任何真会话。
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const credentialStore = new FileCredentialStore(`${appPaths.userData}/credentials.json`);
      const modelConfig = new ModelConfigService(db, credentialStore, networkClient);
      const llm = modelConfig.getDefaults().llm;
      if (!llm) {
        process.stdout.write(`${JSON.stringify({ probe: 'subagent', ok: false, error: '没有配置默认模型' }, null, 2)}\n`);
        app.exit(2);
        return;
      }

      try {
        const { mkdtempSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { probeWorkSubagent } = await import('./work/subagentProbe');
        const outcome = await probeWorkSubagent({
          modelConfig,
          root: mkdtempSync(path.join(tmpdir(), 'opc-subagent-probe-')),
        });
        process.stdout.write(`${JSON.stringify({ probe: 'subagent', ...outcome }, null, 2)}\n`);
        app.exit(outcome.ok ? 0 : 1);
      } catch (error) {
        console.error('SUBAGENT_PROBE_FAILED', error);
        app.exit(1);
      } finally {
        db.close();
      }
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

      const executor = seedExecutor(db);
      const work = new WorkService({
        db,
        paths: appPaths,
        upsertTaskCard: () => undefined,
        modelConfig,
      });

      const created = work.createTask({ ...DEMO_TASK, assigneeId: executor.id });
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

    if (isWorkProbe) {
      process.env.OPC_BRAIN_VARIANT ??= 'ok'; // probes are deterministic and must not spend tokens
      initAppPaths();
      const db = openCompanyDatabase(appPaths.database);
      const executor = seedExecutor(db);
      const work = new WorkService({
        db,
        paths: appPaths,
        upsertTaskCard: () => undefined,
      });
      try {
        const created = work.createTask({ ...DEMO_TASK, assigneeId: executor.id });
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
    void browserBroker?.dispose();
    browserBroker = null;
    void desktopBroker?.dispose();
    desktopBroker = null;
  });
}

/**
 * 解析抽取结果。
 *
 * 解析失败的一行直接丢——宁可少记一条，也不要把半句话猜成一条偏好。
 */
function parseExtracted(text: string): {
  kind: 'preference' | 'constraint' | 'format' | 'workflow' | 'person' | 'term' | 'fact';
  subject: string | null;
  volatility: 'stable' | 'slow' | 'session';
  scope: 'person' | 'thread';
  content: string;
}[] {
  const kinds = ['preference', 'constraint', 'format', 'workflow', 'person', 'term', 'fact'] as const;
  const volatilities = ['stable', 'slow', 'session'] as const;

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('|'))
    .map((line) => {
      const [rawKind, rawSubject, rawVolatility, rawScope, ...rest] = line.split('|');
      const content = rest.join('|').trim();
      if (content.length === 0) return null;
      const kind = kinds.find((value) => value === rawKind?.trim().toLowerCase()) ?? 'preference';
      const volatility =
        volatilities.find((value) => value === rawVolatility?.trim().toLowerCase()) ?? 'slow';
      const subject = rawSubject?.trim();
      return {
        kind,
        subject: !subject || subject === '-' ? null : subject,
        volatility,
        scope: rawScope?.trim().toLowerCase() === 'thread' ? ('thread' as const) : ('person' as const),
        content,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}
