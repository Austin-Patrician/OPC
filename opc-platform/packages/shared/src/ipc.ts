import type {
  Agent,
  Budget,
  BudgetScope,
  BudgetState,
  Conversation,
  Department,
  CreateTaskInput,
  CreateTaskResult,
  CatalogProvider,
  CompactionSettings,
  CompanyProfile,
  CompanyProfilePatch,
  DepartmentNode,
  AgentCandidate,
  HireInput,
  PersonnelInput,
  ModelDefaults,
  OrgMember,
  ModelOption,
  ModelRef,
  ProviderConfig,
  ProviderDraft,
  ProviderTestResult,
  ProxyConfig,
  ProxyConfigInput,
  ProxyTestResult,
  RuntimeInspection,
  RuntimeKind,
  RuntimeProfileDraft,
  RuntimeSnapshot,
  RuntimeState,
  WorkTask,
} from './domain';

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
    openDirect: 'chat:openDirect',
    archive: 'chat:archive',
    restore: 'chat:restore',
    ensureDepartmentGroup: 'chat:ensureDepartmentGroup',
    updateAgentBrief: 'chat:updateAgentBrief',
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
  },
  images: {
    generate: 'images:generate',
  },
  market: {
    candidates: 'market:candidates',
    importPackage: 'market:import',
    removeCandidate: 'market:remove',
    hireCandidate: 'market:hire',
  },
  facts: {
    list: 'facts:list',
    write: 'facts:write',
  },
  memory: {
    consolidationRuns: 'memory:consolidationRuns',
  },
  projects: {
    list: 'projects:list',
    create: 'projects:create',
    assign: 'projects:assign',
    archive: 'projects:archive',
    removeMember: 'projects:removeMember',
  },
  org: {
    list: 'org:list',
    unplaced: 'org:unplaced',
    place: 'org:place',
    setAvatar: 'org:setAvatar',
    personnel: 'org:personnel',
    createDepartment: 'org:createDepartment',
    hire: 'org:hire',
    transfer: 'org:transfer',
    fire: 'org:fire',
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
    bossDecision: 'work:bossDecision',
    setIssueMeta: 'work:setIssueMeta',
    linkTasks: 'work:linkTasks',
    subtasks: 'work:subtasks',
    createTask: 'work:createTask',
    runTask: 'work:runTask',
    taskEvent: 'work:taskChanged',
    listBudgets: 'work:listBudgets',
    budgetsEvent: 'work:budgetsChanged',
  },
  budget: {
    overview: 'budget:overview',
    setLimit: 'budget:setLimit',
  },
  comm: {
    overview: 'comm:overview',
    overviewEvent: 'comm:overviewChanged',
    wake: 'comm:wake',
    dismissGuards: 'comm:dismissGuards',
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
  },
  company: {
    get: 'company:get',
    update: 'company:update',
    changedEvent: 'company:changed',
  },
} as const;

export interface ChatSnapshot {
  agents: Agent[];
  departments: Department[];
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
  updateAgentBrief(agentId: string, briefMd: string): Promise<void>;
  /** 1v1 with an employee; creates the conversation on first use. */
  openDirect(agentId: string): Promise<string>;
  /** Department group chat; creates it with the current roster on first use. */
  ensureDepartmentGroup(departmentId: string): Promise<string>;
  /** Archives a conversation and consolidates it once (idempotent). */
  archive(conversationId: string): Promise<{ archived: boolean; written: number }>;
  /** Moves an archived conversation back into the active list. */
  restore(conversationId: string): Promise<void>;
}

export interface WorkBridge {
  listTasks(limit?: number): Promise<WorkTask[]>;
  /** Direct subtasks of one task (the decomposition tree). */
  subtasks(taskId: string): Promise<WorkTask[]>;
  listBudgets(): Promise<Budget[]>;
  createTask(input: CreateTaskInput): Promise<CreateTaskResult>;
  /** Fire-and-forget: progress arrives through `onTaskChanged`. */
  runTask(taskId: string): Promise<void>;
  /** Boss sign-off: approve → delivered, reject → parked with a reason. */
  bossDecision(taskId: string, decision: 'approve' | 'reject', reason?: string): Promise<WorkTask>;
  setIssueMeta(
    taskId: string,
    patch: { priority?: 'P0' | 'P1' | 'P2' | 'P3'; labels?: string[]; dueAt?: number | null },
  ): Promise<WorkTask>;
  /** `fromId blocks toId`; pass an empty `fromId` to remove the link. */
  linkTasks(fromId: string, toId: string, type?: 'blocks' | 'duplicates' | 'relates'): Promise<WorkTask>;
  onTaskChanged(listener: (task: WorkTask) => void): () => void;
  onBudgetsChanged(listener: (budgets: Budget[]) => void): () => void;
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
  setDefault(role: 'llm' | 'image', ref: ModelRef | null): Promise<ModelDefaults>;
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
  setThinking(level: string): Promise<string>;
}

export interface GeneratedImageResult {
  ok: boolean;
  /** File name inside the user's images directory. */
  fileName?: string;
  /** data: URL for immediate preview. */
  dataUrl?: string;
  bytes?: number;
  model?: string;
  error?: string;
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

export interface MarketBridge {
  candidates(): Promise<AgentCandidate[]>;
  /** Opens a file picker and imports an .json agent package. */
  importPackage(): Promise<AgentCandidate[]>;
  removeCandidate(candidateId: string): Promise<AgentCandidate[]>;
  hireCandidate(
    candidateId: string,
    input: { departmentId: string; reportsToEmployeeId?: string; isHead?: boolean },
  ): Promise<{ candidates: AgentCandidate[]; employeeId: string }>;
}

export interface OrgFactView {
  id: string;
  scopeType: 'org' | 'department' | 'project';
  scopeId: string;
  subject: string;
  predicate: string;
  object: string;
  statement: string;
  confidence: number;
  validFrom: number;
}

export interface ProjectView {
  id: string;
  name: string;
  code: string;
  description: string;
  departmentId: string;
  status: 'active' | 'archived';
  members: { employeeId: string; name: string; role: string }[];
}

export interface ConsolidationRunView {
  id: string;
  employeeId: string;
  conversationIds: string[];
  episodeCount: number;
  memoriesCreated: number;
  status: 'running' | 'done' | 'failed' | 'skipped';
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface MemoryBridge {
  /** Recent consolidation runs — the audit trail of "下班反思". */
  consolidationRuns(employeeId?: string): Promise<ConsolidationRunView[]>;
}

export interface ProjectsBridge {
  list(): Promise<ProjectView[]>;
  create(input: { name: string; code?: string; description?: string; departmentId?: string }): Promise<ProjectView[]>;
  assign(projectId: string, employeeId: string, role?: string): Promise<ProjectView[]>;
  archive(projectId: string): Promise<ProjectView[]>;
  removeMember(projectId: string, employeeId: string): Promise<ProjectView[]>;
}

export interface FactsBridge {
  /** Current facts: by employee (org + their department) or by department. */
  list(filter?: { employeeId?: string; departmentId?: string; projectId?: string }): Promise<OrgFactView[]>;
  write(input: {
    scopeType: 'org' | 'department' | 'project';
    scopeId?: string;
    subject: string;
    object: string;
    statement?: string;
  }): Promise<OrgFactView[]>;
}

export interface OrgBridge {
  list(): Promise<DepartmentNode[]>;
  /** Employees without an active position (terminated / newly unplaced). */
  unplaced(): Promise<OrgMember[]>;
  /** Places (or re-hires) an employee into a department. */
  place(employeeId: string, departmentId: string): Promise<DepartmentNode[]>;
  setAvatar(employeeId: string, dataUrl: string): Promise<DepartmentNode[]>;
  /** Transfer / terminate / reinstate / re-assign manager, in one entry point. */
  personnel(input: PersonnelInput): Promise<DepartmentNode[]>;
  createDepartment(input: {
    name: string;
    code?: string;
    description?: string;
    headEmployeeId?: string;
  }): Promise<DepartmentNode[]>;
  hire(input: HireInput): Promise<DepartmentNode[]>;
  transfer(employeeId: string, departmentId: string, reportsToEmployeeId?: string): Promise<DepartmentNode[]>;
  fire(employeeId: string): Promise<DepartmentNode[]>;
}

export interface ArtifactsBridge {
  /** Reads an image artifact as a data URL (used for card thumbnails). */
  read(taskId: string, relPath: string): Promise<ArtifactReadResult>;
  /** "Download": native save dialog + copy, so it works under file:// too. */
  saveAs(taskId: string, relPath: string): Promise<{ ok: boolean; path?: string; error?: string }>;
}

export interface ImagesBridge {
  generate(input: { prompt: string; modelId?: string }): Promise<GeneratedImageResult>;
}

/**
 * What the boss can see about employee-to-employee communication.
 *
 * Suppression is deliberately visible (决定② C): who is waiting, who was refused a
 * wake, who has been talking to whom. Nothing here is a filter over a private
 * transcript — the inbox, the guards and the relationship edges are their own rows.
 */
export type CommPriority = 0 | 1 | 2 | 3;
export type CommGuardKind = 'wake_quota' | 'turn_limit' | 'dm_rate' | 'message_dropped';
export type CommRelationshipKind = 'colleague' | 'manager' | 'report' | 'collaborator';

export interface CommInboxView {
  id: string;
  employeeId: string;
  employeeName: string;
  sourceType: 'message' | 'task' | 'approval' | 'system';
  priority: CommPriority;
  /** True when the recipient is woken now instead of at its heartbeat. */
  requiresWake: boolean;
  conversationId?: string;
  /** Who caused it, when the source is a message. */
  fromName?: string;
  /** First line of the message, for the list. */
  preview?: string;
  createdAt: number;
}

export interface CommGuardView {
  id: string;
  employeeId: string;
  employeeName: string;
  kind: CommGuardKind;
  /** Already-flattened detail: names resolved, nothing to look up in the UI. */
  detail: Readonly<Record<string, string | number | boolean>>;
  conversationId?: string;
  createdAt: number;
}

export interface CommRelationshipView {
  id: string;
  fromEmployeeId: string;
  fromName: string;
  toEmployeeId: string;
  toName: string;
  kind: CommRelationshipKind;
  strength: number;
  interactionCount: number;
  lastInteractionAt?: number;
}

export interface CommQuotaView {
  employeeId: string;
  employeeName: string;
  limit: number;
  used: number;
  remaining: number;
}

export interface CommOverview {
  generatedAt: number;
  inbox: CommInboxView[];
  guards: CommGuardView[];
  relationships: CommRelationshipView[];
  quotas: CommQuotaView[];
}

/** ── 预算中心 (§8) ───────────────────────────────────────────────────────── */

export interface BudgetView {
  scope: BudgetScope;
  scopeId: string;
  /** Resolved name (公司 / 员工 / 部门 / 项目) — never a raw id. */
  label: string;
  periodKey: string;
  limitTokens: number;
  usedTokens: number;
  reservedTokens: number;
  availableTokens: number;
  state: BudgetState;
  warnAt: number;
  hardStopAt: number;
  /** §8.3 straight-line projection to the end of the month. */
  projectedTokens: number;
  willExceed: boolean;
}

export interface BudgetAlertView {
  id: string;
  scope: BudgetScope;
  scopeId: string;
  label: string;
  level: 'warn' | 'stop';
  usedTokens: number;
  limitTokens: number;
  ratio: number;
  periodKey: string;
  createdAt: number;
}

/** A person taken off a project by a budget stop (§5.6: 停任职不停员工). */
export interface PausedAssignmentView {
  projectId: string;
  projectName: string;
  employeeId: string;
  employeeName: string;
  reason: string;
  pausedAt?: number;
}

export interface BudgetOverview {
  generatedAt: number;
  periodKey: string;
  budgets: BudgetView[];
  alerts: BudgetAlertView[];
  paused: PausedAssignmentView[];
}

export interface BudgetBridge {
  overview(): Promise<BudgetOverview>;
  /** 老板改额度；把额度提回阈值以下会解除硬停并恢复被暂停的任职。 */
  setLimit(input: { scope: BudgetScope; scopeId: string; limitTokens: number }): Promise<BudgetOverview>;
}

export interface CommWakeResult {  ok: boolean;
  message: string;
  /** How many inbox items the run actually handled. */
  items: number;
}

export interface CommBridge {
  overview(): Promise<CommOverview>;
  /** Fires when the inbox, a guard, a quota or a relationship changed. */
  onOverviewChanged(listener: () => void): () => void;
  /** 老板手动唤醒一个人：绕过心跳与配额（P0 特权），跑一次收件箱。 */
  wake(employeeId: string): Promise<CommWakeResult>;
  /** 标记护栏为已读；不传 ids 表示全部。记录不会被删除。 */
  dismissGuards(ids?: string[]): Promise<number>;
}

/**
 * The company row + its profile preferences (§1.3: one company per install).
 *
 * The name lives in `company.name`, the industry in `company.industry`; the rest
 * (vision / brand colour / how the boss is addressed) has no column and lives in
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
  images: ImagesBridge;
  auth: AuthBridge;
  artifacts: ArtifactsBridge;
  org: OrgBridge;
  facts: FactsBridge;
  projects: ProjectsBridge;
  memory: MemoryBridge;
  market: MarketBridge;
  budget: BudgetBridge;
  comm: CommBridge;
  diagnostics: {
    report(): Promise<DiagnosticsReport>;
  };
}
