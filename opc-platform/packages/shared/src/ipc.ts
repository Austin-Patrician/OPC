import type {
  Agent,
  BillingSettings,
  BillingSettingsPatch,
  Conversation,
  CreateTaskInput,
  CreateTaskResult,
  CatalogProvider,
  CompactionSettings,
  CompanyProfile,
  CompanyProfilePatch,
  DecisionClassifyInput,
  DecisionClassifyResult,
  WorkThread,
  Worker,
  WorkerStatus,
  WorkerTemplate,
  ToolPolicy,
  TriagePolicy,
  TriagePolicyPatch,
  ModelDefaults,
  ModelOption,
  ModelRef,
  ModelRole,
  ProviderConfig,
  ProviderDraft,
  ProviderTestResult,
  ProxyConfig,
  ProxyConfigInput,
  ProxyTestResult,
  BundledRuntime,
  RuntimeInspection,
  RuntimeKind,
  RuntimeProfileDraft,
  RuntimeSnapshot,
  RuntimeState,
  SpeechSynthesizeInput,
  SpeechSynthesizeResult,
  SpeechTranscribeInput,
  SpeechTranscribeResult,
  TaskTrace,
  WorkTask,
} from './domain';
import type { OcrSettings } from './ocr';

/**
 * The typed surface between Electron main and renderer.
 *
 * Renderer never touches Node, SQLite or the filesystem: it only sees these
 * promises and one snapshot event stream.
 */

export const IPC = {
  chat: {
    getSnapshot: 'chat:getSnapshot',
    sendMessage: 'chat:sendMessage',
    markRead: 'chat:markRead',
    ensureAssistant: 'chat:ensureAssistant',
    archive: 'chat:archive',
    restore: 'chat:restore',
    snapshotEvent: 'chat:snapshot',
  },
  diagnostics: {
    report: 'diagnostics:report',
  },
  models: {
    list: 'models:list',
    getCatalog: 'models:getCatalog',
    saveProvider: 'models:saveProvider',
    removeProvider: 'models:removeProvider',
    setKey: 'models:setKey',
    getKey: 'models:getKey',
    test: 'models:test',
    refreshModels: 'models:refreshModels',
    addModel: 'models:addModel',
    supportsOauth: 'models:supportsOauth',
    getDefaults: 'models:getDefaults',
    setDefault: 'models:setDefault',
    importFromPi: 'models:importFromPi',
    getCompaction: 'models:getCompaction',
    setCompaction: 'models:setCompaction',
    setModelContext: 'models:setModelContext',
    setModels: 'models:setModels',
    setModelPricing: 'models:setModelPricing',
    applyBuiltinPricing: 'models:applyBuiltinPricing',
    getThinking: 'models:getThinking',
    setThinking: 'models:setThinking',
    getRouterThinking: 'models:getRouterThinking',
    setRouterThinking: 'models:setRouterThinking',
  },
  speech: {
    transcribe: 'speech:transcribe',
    synthesize: 'speech:synthesize',
  },
  decisions: {
    classify: 'decisions:classify',
  },
  facts: {
    list: 'facts:list',
    write: 'facts:write',
  },
  memory: {
    consolidationRuns: 'memory:consolidationRuns',
    list: 'memory:list',
    update: 'memory:update',
    forget: 'memory:forget',
    orphans: 'memory:orphans',
    claim: 'memory:claim',
    discard: 'memory:discard',
  },
  router: {
    getTriage: 'router:getTriage',
    setTriage: 'router:setTriage',
  },
  trigger: {
    status: 'trigger:status',
    set: 'trigger:set',
  },
  threads: {
    start: 'threads:start',
    list: 'threads:list',
    queue: 'threads:queue',
    markRead: 'threads:markRead',
    decide: 'threads:decide',
    /** 回答执行体的请示（`ReportKind = 'question'` 的那一类）。 */
    answer: 'threads:answer',
    close: 'threads:close',
  },
  mcp: {
    list: 'mcp:list',
    save: 'mcp:save',
    remove: 'mcp:remove',
    test: 'mcp:test',
    login: 'mcp:login',
    logout: 'mcp:logout',
  },
  watchdog: {
    incidents: 'watchdog:incidents',
    actions: 'watchdog:actions',
    ask: 'watchdog:ask',
    getPolicy: 'watchdog:getPolicy',
    savePolicy: 'watchdog:savePolicy',
    rollbackPolicy: 'watchdog:rollbackPolicy',
    getModel: 'watchdog:getModel',
    setModel: 'watchdog:setModel',
  },
  workers: {
    list: 'workers:list',
  },
  artifacts: {
    read: 'artifacts:read',
    saveAs: 'artifacts:saveAs',
  },
  auth: {
    login: 'auth:login',
    logout: 'auth:logout',
    status: 'auth:status',
    answer: 'auth:answer',
    promptEvent: 'auth:prompt',
    notifyEvent: 'auth:notify',
  },
  work: {
    listTasks: 'work:listTasks',
    userDecision: 'work:userDecision',
    setIssueMeta: 'work:setIssueMeta',
    linkTasks: 'work:linkTasks',
    subtasks: 'work:subtasks',
    trace: 'work:trace',
    createTask: 'work:createTask',
    runTask: 'work:runTask',
    taskEvent: 'work:taskChanged',
  },
  billing: {
    get: 'billing:get',
    update: 'billing:update',
    changedEvent: 'billing:changed',
  },
  app: {
    getInfo: 'app:getInfo',
  },
  network: {
    get: 'network:get',
    update: 'network:update',
    test: 'network:test',
    changedEvent: 'network:changed',
  },
  runtime: {
    snapshot: 'runtime:snapshot',
    probe: 'runtime:probe',
    setActive: 'runtime:setActive',
    chooseBinary: 'runtime:chooseBinary',
    inspect: 'runtime:inspect',
    saveProfile: 'runtime:saveProfile',
    removeProfile: 'runtime:removeProfile',
    bundled: 'runtime:bundled',
    ocr: 'runtime:ocr',
    setOcr: 'runtime:setOcr',
  },
  company: {
    get: 'company:get',
    update: 'company:update',
    changedEvent: 'company:changed',
  },
  capabilities: {
    list: 'capabilities:list',
  },
  extensions: {
    list: 'extensions:list',
    setEnabled: 'extensions:setEnabled',
  },
  skills: {
    list: 'skills:list',
    setEnabled: 'skills:setEnabled',
  },
} as const;

export interface ChatSnapshot {
  agents: Agent[];
  conversations: Conversation[];
  /** conversationId → display names currently working. */
  typingByConversation: Readonly<Record<string, readonly string[]>>;
}

export interface SendMessageInput {
  conversationId: string;
  text: string;
  mentionIds?: string[];
}

/** Node/Electron platform strings, minus the dependency on @types/node. */
export type DesktopPlatform = 'darwin' | 'win32' | 'linux';

export interface AppInfo {
  name: string;
  version: string;
  platform: DesktopPlatform;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  userDataPath: string;
}

export type ProbeStatus = 'ok' | 'failed' | 'skipped';

export interface ProbeResult {
  id: string;
  title: string;
  status: ProbeStatus;
  /** Human readable detail, shown in Settings → 自检. */
  detail: string;
  /** Measured duration in ms, when meaningful. */
  durationMs?: number;
}

/** G0 acceptance evidence: native modules + durable runtime + isolation. */
export interface DiagnosticsReport {
  generatedAt: string;
  app: AppInfo;
  probes: ProbeResult[];
  errors: string[];
}

export interface ChatBridge {
  getSnapshot(): Promise<ChatSnapshot>;
  onSnapshot(listener: (snapshot: ChatSnapshot) => void): () => void;
  sendMessage(input: SendMessageInput): Promise<void>;
  markRead(conversationId: string): Promise<void>;
  /** 1v1 with an employee; creates the conversation on first use. */
  /** 唯一的那条会话：没有就建一条。没有执行体时返回 null。 */
  ensureAssistant(): Promise<string>;
  /** Archives a conversation and consolidates it once (idempotent). */
  archive(conversationId: string): Promise<{ archived: boolean; written: number }>;
  /** Moves an archived conversation back into the active list. */
  restore(conversationId: string): Promise<void>;
}

export interface WorkBridge {
  listTasks(limit?: number): Promise<WorkTask[]>;
  /** Direct subtasks of one task (the decomposition tree). */
  subtasks(taskId: string): Promise<WorkTask[]>;
  /**
   * 执行体的动作流（`09-worker-spec.md` W6）：它到底调了什么工具、成没成。
   *
   * 和 `steps` 分两档：`steps` 是写给人读的叙述，这里是真的动作。裁剪之后序号会
   * 留空洞，界面据此显示「略去 N 步」。
   */
  trace(taskId: string, limit?: number): Promise<TaskTrace[]>;
  createTask(input: CreateTaskInput): Promise<CreateTaskResult>;
  /** Fire-and-forget: progress arrives through `onTaskChanged`. */
  runTask(taskId: string): Promise<void>;
  /** You sign-off: approve → delivered, reject → parked with a reason. */
  userDecision(taskId: string, decision: 'approve' | 'reject', reason?: string): Promise<WorkTask>;
  setIssueMeta(
    taskId: string,
    patch: { priority?: 'P0' | 'P1' | 'P2' | 'P3'; labels?: string[]; dueAt?: number | null },
  ): Promise<WorkTask>;
  /** `fromId blocks toId`; pass an empty `fromId` to remove the link. */
  linkTasks(fromId: string, toId: string, type?: 'blocks' | 'duplicates' | 'relates'): Promise<WorkTask>;
  onTaskChanged(listener: (task: WorkTask) => void): () => void;
}

export interface ModelsBridge {
  list(): Promise<ProviderConfig[]>;
  /** pi's whole built-in catalog (providers, models, prices, API kinds). */
  getCatalog(): Promise<CatalogProvider[]>;
  saveProvider(draft: ProviderDraft): Promise<ProviderConfig[]>;
  removeProvider(providerId: string): Promise<ProviderConfig[]>;
  /** Replace (or clear with an empty string) the stored API key. */
  setKey(providerId: string, apiKey: string): Promise<ProviderConfig[]>;
  /** The decrypted key, only so the settings page can show it masked with a reveal toggle. */
  getKey(providerId: string): Promise<string>;
  test(providerId: string): Promise<ProviderTestResult>;
  refreshModels(providerId: string): Promise<{
    providers: ProviderConfig[];
    ok: boolean;
    message: string;
    added: string[];
    total: number;
  }>;
  addModel(
    providerId: string,
    input: {
      id: string;
      name?: string;
      contextWindow?: number;
      api?: string;
      /** Defaults to `chat`; the Image/Voice pages add their models explicitly. */
      capability?: 'chat' | 'image' | 'classifier' | 'asr' | 'tts';
      /** USD per 1M tokens; omitted/0 means "unknown". */
      inputUsdPerM?: number;
      outputUsdPerM?: number;
      cacheReadUsdPerM?: number;
      cacheWriteUsdPerM?: number;
    },
  ): Promise<ProviderConfig[]>;
  /** True only for providers pi can log into with OAuth; the rest use an API key. */
  supportsOauth(providerId: string): Promise<boolean>;
  getDefaults(): Promise<ModelDefaults>;
  setDefault(role: ModelRole, ref: ModelRef | null): Promise<ModelDefaults>;
  /** Imports an existing pi config as providers (explicit user action). */
  importFromPi(): Promise<{ imported: number; providers: ProviderConfig[] }>;
  getCompaction(): Promise<CompactionSettings>;
  setCompaction(next: CompactionSettings): Promise<CompactionSettings>;
  /** Context window of one model, used by the compaction thresholds. */
  setModelContext(providerId: string, modelId: string, contextWindow: number): Promise<ProviderConfig[]>;
  /** Replaces a provider's model list (used when importing the pi catalog). */
  setModels(providerId: string, models: ModelOption[]): Promise<ProviderConfig[]>;
  /** Copies pi's built-in cost (cache + context tiers) onto every model. */
  applyBuiltinPricing(providerId: string): Promise<{
    providers: ProviderConfig[];
    matched: number;
    unmatched: string[];
  }>;
  /** USD per 1M tokens; drives the ledger's money column. */
  setModelPricing(
    providerId: string,
    modelId: string,
    price: { input: number; output: number; cacheRead: number; cacheWrite: number },
  ): Promise<ProviderConfig[]>;
  getThinking(): Promise<string>;
  /** `null` clears the explicit choice and falls back to the system default. */
  setThinking(level: string | null): Promise<string>;
  /** Router 的思考档位；没单独配时返回全局那一档。 */
  getRouterThinking(): Promise<string>;
  /** `null` clears it and follows the global level again. */
  setRouterThinking(level: string | null): Promise<string>;
}

export interface AuthPromptRequest {
  id: string;
  kind: 'text' | 'secret' | 'select' | 'manual_code';
  message: string;
  placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[];
}

export interface AuthMenuItem {
  providerId: string;
  type: string;
}

export interface AuthBridge {
  login(providerId: string, type: 'oauth' | 'apiKey'): Promise<{ ok: boolean; message: string }>;
  logout(providerId: string): Promise<{ ok: boolean; message: string }>;
  status(): Promise<AuthMenuItem[]>;
  /** Answer a pending prompt; `null` cancels the flow. */
  answer(promptId: string, value: string | null): Promise<void>;
  onPrompt(listener: (request: AuthPromptRequest) => void): () => void;
  onNotify(listener: (event: { text: string; url?: string }) => void): () => void;
}

export interface ArtifactReadResult {
  ok: boolean;
  dataUrl?: string;
  bytes?: number;
  error?: string;
}

export interface FactView {
  id: string;
  scopeType: 'global' | 'thread';
  scopeId: string;
  subject: string;
  predicate: string;
  object: string;
  statement: string;
  confidence: number;
  validFrom: number;
}


export interface ConsolidationRunView {
  id: string;
  ownerId: string;
  conversationIds: string[];
  episodeCount: number;
  memoriesCreated: number;
  status: 'running' | 'done' | 'failed' | 'skipped';
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/** One tool exactly as the runtime installed it for an agent. */
export interface CapabilityTool {
  name: string;
  description: string;
  /** Extension that registered it. */
  extension: string;
  /** Offered only through `tool_search` instead of every request. */
  deferred: boolean;
}

/**
 * One installed extension. Hooks / tasks / sections are counted because some
 * extensions (`opc.sandbox`, `opc.limits`, `opc.work`) add no tools at all.
 */
export interface CapabilityExtension {
  name: string;
  tools: string[];
  hooks: number;
  tasks: number;
  sections: number;
}

export interface AgentCapability {
  workerId: string;
  name: string;
  template: WorkerTemplate;
  status: WorkerStatus;
  /** Label of the model this execution body actually runs on. */
  model: string;
  /** Skills carried by the worker record; never injected into the prompt. */
  skills: string[];
  extensions: CapabilityExtension[];
  tools: CapabilityTool[];
}

export interface CapabilityCatalog {
  generatedAt: number;
  agents: AgentCapability[];
}

export interface CapabilitiesBridge {
  /** Installed extensions and tools per live execution body, read from the live registry. */
  list(): Promise<CapabilityCatalog>;
}

/** Where a Pi extension was discovered: the user's home or this project. */
export type PiExtensionScope = 'global' | 'project';

/** One Pi extension found on disk, whether or not it is loaded. */
export interface PiExtensionView {
  /** Stable handle: the absolute path of what was discovered (entry file or directory). */
  id: string;
  name: string;
  description: string;
  version: string;
  scope: PiExtensionScope;
  /** Absolute path of the module the main process imports. */
  entry: string;
  enabled: boolean;
  /** The user explicitly accepted that this code runs with full main-process rights. */
  trusted: boolean;
  /** True once the module was imported successfully. */
  loaded: boolean;
  /**
   * Tools the extension registered. Empty while disabled: importing it would
   * already run its code, so the list stays empty until the user opts in.
   */
  tools: string[];
  /** Pi lifecycle events it subscribes to. Only `tool_call` is wired today. */
  events: string[];
  commands: string[];
  /** Pi APIs it used that OPC has no equivalent for. */
  unsupported: string[];
  /** Import error, shown verbatim so a broken extension is diagnosable. */
  error?: string;
}

export interface PiExtensionCatalog {
  generatedAt: number;
  /** Directories that were scanned, so the empty state can name them. */
  roots: string[];
  entries: PiExtensionView[];
}

export interface ExtensionsBridge {
  /** Everything Pi would auto-discover, plus what OPC actually loaded. */
  list(): Promise<PiExtensionCatalog>;
  /**
   * Enables or disables one extension company-wide. Enabling runs the module in
   * the main process, so the first enable must pass `trusted: true`.
   */
  setEnabled(id: string, enabled: boolean, trusted?: boolean): Promise<PiExtensionCatalog>;
}

/** One `SKILL.md` folder found on disk. */
export interface PiSkillView {
  /** Absolute path of the SKILL.md, POSIX-normalized. */
  id: string;
  name: string;
  description: string;
  scope: PiExtensionScope;
  /** Folder holding the skill; its scripts and references live here. */
  dir: string;
  file: string;
  /** How many files ship with the skill (scripts, references, schemas). */
  files: number;
  enabled: boolean;
  /** Rough prompt cost of advertising it, so the page can be honest about tokens. */
  promptTokens: number;
}

export interface PiSkillCatalog {
  generatedAt: number;
  roots: string[];
  entries: PiSkillView[];
}

export interface SkillsBridge {
  /** Every skill found under `~/.agents/skills` and `.agents/skills`. */
  list(): Promise<PiSkillCatalog>;
  /** Turns one skill on or off for every agent; no trust gate, a skill is text. */
  setEnabled(id: string, enabled: boolean): Promise<PiSkillCatalog>;
}

/**
 * 一条记忆，给「它记得什么」这一页看。
 *
 * 界面必须能回答三个问题：**记住了什么**、**记错了怎么改**、**它是从哪知道的**。
 * 第三条尤其重要——能追到来源的记忆才是可信的记忆。
 */
export interface MemoryView {
  id: string;
  /** `standing` 每轮都生效；`long` 命中相关度才出现。 */
  tier: 'long' | 'standing';
  kind: string;
  /** 主题键：同一条规矩改过几次都只留一条，靠它认出来。 */
  subject: string | null;
  content: string;
  createdAt: number;
  sourceType: string;
  /** 被观察到几次。到 3 次会自己升进常驻层。 */
  observations: number;
  scopeType: string;
}

/**
 * 一组没有归属的记忆。
 *
 * 真实存在过的坑：早期版本把记忆挂在执行体名下，那些执行体早就不在了，于是有一批记忆
 * 谁也读不到。V33 明确决定不在迁移里猜归属——代价就是这个。出口不是再猜一次，
 * 是问用户一句：这些是以前记的，还要吗。
 */
export interface OrphanMemoryGroup {
  ownerId: string;
  count: number;
  samples: string[];
}

export interface MemoryBridge {
  /** Recent consolidation runs — the audit trail of "下班反思". */
  consolidationRuns(ownerId?: string): Promise<ConsolidationRunView[]>;
  /** 当前有效的全部记忆。常驻的排在最前。 */
  list(): Promise<MemoryView[]>;
  /** 改一条的说法。改的是内容，不是归属。 */
  update(id: string, content: string): Promise<boolean>;
  /** 撤掉一条。归档，不是销毁。 */
  forget(id: string): Promise<boolean>;
  /** 挂在已经不存在的归属上的那些，按归属分组。 */
  orphans(): Promise<OrphanMemoryGroup[]>;
  /** 收下：归到「关于你」名下。返回搬过去的条数。 */
  claim(ownerId: string): Promise<number>;
  /** 丢掉：归档整组。返回条数。 */
  discard(ownerId: string): Promise<number>;
}

/**
 * 调度的两层过滤怎么配（§3.1）。
 *
 * 设置页只读这一份：改完立刻生效，不需要重启——Router 每一轮都重新读。
 */
export interface RouterBridge {
  getTriage(): Promise<TriagePolicy>;
  setTriage(patch: TriagePolicyPatch): Promise<TriagePolicy>;
}

/**
 * 触发源：外部平台把事件推进来的那扇门。
 *
 * 界面需要知道的只有三件事：门开着没有、地址是什么、这一家配了密钥没有。密钥本身
 * 不回传给渲染进程——它没有用到的场合，还多一个能泄露它的地方。
 */
export interface TriggerEntryStatus {
  id: string;
  source: string;
  /** 要填到平台里的那个 URL。门没开时也给（它是"应该在哪"）。 */
  url: string;
  configured: boolean;
}

export interface TriggerStatus {
  running: boolean;
  port: number;
  entries: TriggerEntryStatus[];
}

export interface TriggerPatch {
  port?: number;
  secrets?: Partial<Record<'github' | 'feishu' | 'dingtalk', string>>;
}

export interface TriggerBridge {
  status(): Promise<TriggerStatus>;
  set(patch: TriggerPatch): Promise<TriggerStatus>;
}

export interface FactsBridge {
  /** 当前生效的事实：整条工作线的（给 threadId），或者整个工作台的。 */
  list(filter?: { threadId?: string }): Promise<FactView[]>;
  write(input: {
    scopeType: 'global' | 'thread';
    scopeId?: string;
    subject: string;
    object: string;
    statement?: string;
  }): Promise<FactView[]>;
}

/** One tool as the employee's stack page sees it. */
export interface ToolView {
  name: string;
  /** Short label key suffix under `capabilities.tools.*`; falls back to `name`. */
  label: string;
  /** Whether the runtime can install it for this employee at all. */
  available: boolean;
  /** Effective state: available, extension enabled, tool not explicitly disabled. */
  enabled: boolean;
}

/** One extension group in the employee's stack. */
export interface ToolExtensionView {
  name: string;
  /** Core extensions cannot be switched off, only their tools can be trimmed. */
  essential: boolean;
  available: boolean;
  /** When unavailable: `no-image-provider`, `no-speech-model`, `no-subordinates`, ... */
  reason?: string;
  enabled: boolean;
  tools: ToolView[];
}

/**
 * 一个执行体实际跑在什么上面。
 *
 * 与注册表装的是同一份目录，所以界面不可能描述一个模型拿不到的工具。
 * `model: null` 表示这个执行体跟随工作台默认。
 */
export interface WorkerStackView {
  workerId: string;
  name: string;
  model: ModelRef | null;
  modelLabel: string;
  defaultModel: ModelRef | null;
  policy: ToolPolicy;
  extensions: ToolExtensionView[];
}

export interface WorkerStackInput {
  /** Omit to leave unchanged; `null` clears the override and inherits the default. */
  model?: ModelRef | null;
  /** Omit to leave unchanged; the whole policy is replaced when present. */
  policy?: ToolPolicy;
}

/**
 * 执行体名单：onboarding 仍然要回答"现在有几个执行体"，组织树已经被界面删掉了
 * （docs/v2/00-audit.md §4），所以这里只返回 worker 行本身。
 */
export interface WorkersBridge {
  list(): Promise<Worker[]>;
}

export interface ArtifactsBridge {
  /** Reads an image artifact as a data URL (used for card thumbnails). */
  read(taskId: string, relPath: string): Promise<ArtifactReadResult>;
  /** "Download": native save dialog + copy, so it works under file:// too. */
  saveAs(taskId: string, relPath: string): Promise<{ ok: boolean; path?: string; error?: string }>;
}


/**
 * The company row + its profile preferences (§1.3: one company per install).
 *
 * The name lives in `company.name`, the industry in `company.domain`; the rest
 * (vision / brand colour / how you is addressed) has no column and lives in
 * `app_setting`. The renderer treats this as the single source of truth — it keeps
 * no copy in localStorage.
 */
export interface CompanyBridge {
  get(): Promise<CompanyProfile>;
  /** Partial write; returns the stored profile so the UI can render the truth. */
  update(patch: CompanyProfilePatch): Promise<CompanyProfile>;
  /** Fires after any write, so every window stays in sync. */
  onChanged(listener: (profile: CompanyProfile) => void): () => void;
}

/**
 * Settings → 通用 → 计费: pricing policy + how money is shown.
 *
 * The ledger is USD-only. `usdCnyRate` is a manual planning rate applied at render
 * time, so changing it never rewrites history.
 */
export interface BillingBridge {
  get(): Promise<BillingSettings>;
  update(patch: BillingSettingsPatch): Promise<BillingSettings>;
  onChanged(listener: (settings: BillingSettings) => void): () => void;
}

/**
 * Outgoing network configuration. Saving applies immediately: main-process
 * `fetch`, Chromium's network stack and spawned child processes all switch at
 * once, and the stored config is re-applied on the next launch.
 */
export interface NetworkBridge {
  get(): Promise<ProxyConfig>;
  update(input: ProxyConfigInput): Promise<ProxyConfig>;
  /** Probes the draft without saving it (TCP dial + one egress request). */
  test(input: ProxyConfigInput): Promise<ProxyTestResult>;
  onChanged(listener: (config: ProxyConfig) => void): () => void;
}

/**
 * The company-wide base environment (Settings → 运行时).
 *
 * There is deliberately no per-employee surface: one selection applies to every
 * agent's tool calls and to acceptance commands.
 */
export interface RuntimeBridge {
  /** Stored profiles plus the last known availability, without spawning. */
  snapshot(): Promise<RuntimeSnapshot>;
  /** Re-detects every profile (spawns `--version` with a timeout). */
  probe(): Promise<RuntimeSnapshot>;
  setActive(kind: RuntimeKind, profileId: string | null): Promise<RuntimeState>;
  /** Native picker; returns '' when the user cancels. */
  chooseBinary(kind: RuntimeKind): Promise<string>;
  /** Version + derived venv/conda variables, before saving. */
  inspect(kind: RuntimeKind, binary: string): Promise<RuntimeInspection>;
  /** Adds a custom profile and makes it current for its language. */
  saveProfile(draft: RuntimeProfileDraft): Promise<RuntimeState>;
  removeProfile(profileId: string): Promise<RuntimeState>;
  /**
   * Engines that ship with the app (no choice to make, nothing to install).
   * Sizes first, then a hash pass, so a same-size corrupted model is caught.
   */
  bundled(): Promise<BundledRuntime[]>;
  /** On/off and output shape for `ocr_image`; applies to the next call. */
  ocr(): Promise<OcrSettings>;
  setOcr(next: OcrSettings): Promise<OcrSettings>;
}

/**
 * Speech runs in the main process because the API key never leaves it. The
 * renderer records WAV and plays back the returned bytes; it never sees the key.
 */
export interface SpeechBridge {
  transcribe(input: SpeechTranscribeInput): Promise<SpeechTranscribeResult>;
  synthesize(input: SpeechSynthesizeInput): Promise<SpeechSynthesizeResult>;
}

/**
 * Structured decisions (Jev / System One). Same rule as speech: the provider key
 * stays in the main process, the renderer only sends state + questions.
 */
export interface DecisionsBridge {
  classify(input: DecisionClassifyInput): Promise<DecisionClassifyResult>;
}

/**
 * Watchdog（`docs/v2/11-watchdog-spec.md` W7）。
 *
 * 这一组只有两件事：**看**（incident / 动作账本 / 问一句）与**调规则**。
 * 没有"修"——修复是 W6 的白名单，由 Watchdog 自己发起，不由界面代劳。
 */
export interface WatchdogIncidentView {
  id: string;
  kind: string;
  state: 'active' | 'rechecking' | 'escalated' | 'resolved';
  subjectType: string;
  subjectId: string;
  summary: string;
  detail?: string;
  firstAt: number;
  lastSeenAt: number;
  reopenCount: number;
  resolvedAt?: number;
}

export interface WatchdogActionView {
  incidentId: string;
  action: string;
  status: 'pending' | 'done' | 'failed' | 'refused';
  at: number;
  result: string;
}

export interface WatchdogAskResult {
  ok: boolean;
  answer?: string;
  /** 喂给模型的证据编号（回答里的 `[i:…]` 应当落在这里面）。 */
  evidence?: string[];
  /** 模型实际引用、且确实存在的编号。 */
  citations?: string[];
  /** 被剔除的伪造引用条数。 */
  invalidCitations?: number;
  model?: string;
  error?: string;
}

/** 规则的可编辑面。时间单位都是毫秒。 */
export interface WatchdogPolicyView {
  enabled: boolean;
  idleTaskMs: number;
  repeatFailure: number;
  staleMainMs: number;
  recheckAfterMs: number;
  escalateAfterMs: number;
  judgeCooldownMs: number;
  actionCooldownMs: number;
  updatedAt: number | null;
  hasPrevious: boolean;
}

export interface WatchdogBridge {
  incidents(): Promise<WatchdogIncidentView[]>;
  actions(): Promise<WatchdogActionView[]>;
  /** 问一句「为什么」。只读，带证据编号。 */
  ask(question: string): Promise<WatchdogAskResult>;
  getPolicy(): Promise<WatchdogPolicyView>;
  savePolicy(patch: Partial<WatchdogPolicyView>): Promise<WatchdogPolicyView>;
  rollbackPolicy(): Promise<WatchdogPolicyView>;
  /** 它自己的模型；`null` = 跟随默认 LLM。 */
  getModel(): Promise<{ providerId: string; modelId: string } | null>;
  setModel(ref: { providerId: string; modelId: string } | null): Promise<{ providerId: string; modelId: string } | null>;
}

export interface OpcBridge {
  readonly platform: string;
  readonly isElectron: true;
  app: {
    getInfo(): Promise<AppInfo>;
  };
  network: NetworkBridge;
  runtime: RuntimeBridge;
  company: CompanyBridge;
  chat: ChatBridge;
  work: WorkBridge;
  models: ModelsBridge;
  speech: SpeechBridge;
  decisions: DecisionsBridge;
  auth: AuthBridge;
  artifacts: ArtifactsBridge;
  workers: WorkersBridge;
  capabilities: CapabilitiesBridge;
  extensions: ExtensionsBridge;
  skills: SkillsBridge;
  facts: FactsBridge;
  memory: MemoryBridge;
  router: RouterBridge;
  trigger: TriggerBridge;
  billing: BillingBridge;
  threads: ThreadsBridge;
  mcp: McpBridge;
  watchdog: WatchdogBridge;
  diagnostics: {
    report(): Promise<DiagnosticsReport>;
  };
}

/**
 * v2 注意力队列（docs/v2/01-core.md）。
 *
 * 你打开应用看到的不是会话列表，而是"有什么事需要我"。一个 report 的级别
 * 决定它出现在这里还是只留在记录里：silent 永远不进来。
 */
export interface AttentionEntry {
  id: string;
  threadId: string;
  /** 这条汇报是哪件活说的；空 = 这条线本身。 */
  taskId: string | null;
  /**
   * `question` 是执行体卡住了在问你，收件动词是「回答」；
   * `report` 是结果给你看，收件动词是「认可 / 重做」。
   */
  kind: 'report' | 'question' | 'approval';
  /** 「整理 Q3 财报」——你认的是这件事，不是 id。 */
  threadTitle: string;
  level: 'decide' | 'notify' | 'silent';
  title: string;
  body: string;
  createdAt: number;
}

/**
 * 一个 MCP 服务器在界面上的一行。
 *
 * 形状和主进程的 `McpServerView` 一致，但**故意分开声明**：IPC 是两台机器之间的合同，
 * 让它跟内部类型自动同步，等于让内部改名变成一次静默的协议变更。
 */
export interface McpServerView {
  name: string;
  transport: 'stdio' | 'http';
  target: string;
  enabled: boolean;
  exposure: 'deferred' | 'direct' | 'hidden';
  description?: string;
  tools?: number;
  resources?: number;
  error?: string;
  /** HTTP 服务器才有：登录了没有。 */
  auth?: 'signed-in' | 'signed-out';
}

/** 一份可写回的服务器配置（界面里能编辑的那几个字段）。 */
export interface McpServerDraft {
  name: string;
  transport: 'stdio' | 'http';
  /** stdio：`npx -y server-fs`；http：URL。按空白切分，所以带空格的路径要写成数组形式。 */
  target: string;
  args?: string[];
  enabled?: boolean;
  exposure?: 'deferred' | 'direct' | 'hidden';
  description?: string;
}

export interface McpBridge {  /** 当前生效的服务器清单，以及它读自哪几个文件。 */
  list(): Promise<{ servers: McpServerView[]; sources: string[] }>;
  /** 写入或改一台。返回写入后的清单。 */
  save(draft: McpServerDraft): Promise<{ servers: McpServerView[]; sources: string[] }>;
  remove(name: string): Promise<{ servers: McpServerView[]; sources: string[] }>;
  /** 连一次、报工具数。不改配置。 */
  test(name: string): Promise<McpServerView>;
  /**
   * 走一遍 OAuth 登录（会打开浏览器）。
   *
   * 只有 HTTP 服务器需要：stdio 的凭据是它自己的环境变量。登录成功之后连接会重建，
   * 所以下一次干活就带上了——不用重启。
   */
  login(name: string): Promise<{ servers: McpServerView[]; sources: string[] }>;
  logout(name: string): Promise<{ servers: McpServerView[]; sources: string[] }>;
}

export interface ThreadsBridge {
  /**
   * 你丢一个目标进来：开一条工作线 + 一条 manual 事件，立刻推一次 Router。
   * 不直接建任务——"这件事值不值得做、该给谁做"仍然是 Router 的决定。
   */
  start(goal: string): Promise<WorkThread>;
  /** 未读、且级别不是 silent 的汇报，decide 永远排在前面。 */
  queue(): Promise<AttentionEntry[]>;
  /** 最近的工作线；静默完成的活也在这里，否则你没法确认它真的在干。 */
  list(limit?: number): Promise<WorkThread[]>;
  markRead(reportId: string): Promise<void>;
  /**
   * 你在队列上做的那两个动作：认可（`approve`）或带着意见重做（`rework`）。
   * 这是唯一一处「人判定对不对」的入口——系统自己不宣称验收。
   */
  decide(input: {
    reportId: string;
    threadId: string;
    decision: 'approve' | 'rework';
    note?: string;
  }): Promise<WorkThread>;
  /**
   * 回答执行体的请示。
   *
   * 返回它去哪了：`live` 插进了正在跑的会话，`next-attempt` 记在那件活上等下一次尝试，
   * `new-task` 是那件活已经收尾、于是开了一件新活带上这个回答。界面上要说清是哪一种
   * ——"我答了，但它没收到"是最糟的一种沉默。
   */
  answer(input: {
    reportId: string;
    text: string;
    /** 审批行才有意义：允不允许。请示行不看它。 */
    allow?: boolean;
  }): Promise<'live' | 'next-attempt' | 'new-task'>;
  /** 关掉一条工作线（你手动收尾）。 */
  close(threadId: string): Promise<WorkThread>;
}
