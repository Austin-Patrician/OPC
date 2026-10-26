import type {
  Agent,
  Budget,
  Conversation,
  Department,
  CreateTaskInput,
  CreateTaskResult,
  CatalogProvider,
  CompactionSettings,
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
    test: 'models:test',
    refreshModels: 'models:refreshModels',
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
  projects: {
    list: 'projects:list',
    create: 'projects:create',
    assign: 'projects:assign',
    archive: 'projects:archive',
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
    subtasks: 'work:subtasks',
    createTask: 'work:createTask',
    runTask: 'work:runTask',
    taskEvent: 'work:taskChanged',
    listBudgets: 'work:listBudgets',
    budgetsEvent: 'work:budgetsChanged',
  },
  app: {
    getInfo: 'app:getInfo',
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
  listTasks(): Promise<WorkTask[]>;
  /** Direct subtasks of one task (the decomposition tree). */
  subtasks(taskId: string): Promise<WorkTask[]>;
  listBudgets(): Promise<Budget[]>;
  createTask(input: CreateTaskInput): Promise<CreateTaskResult>;
  /** Fire-and-forget: progress arrives through `onTaskChanged`. */
  runTask(taskId: string): Promise<void>;
  /** Boss sign-off: approve → delivered, reject → parked with a reason. */
  bossDecision(taskId: string, decision: 'approve' | 'reject', reason?: string): Promise<WorkTask>;
  onTaskChanged(listener: (task: WorkTask) => void): () => void;
  onBudgetsChanged(listener: (budgets: Budget[]) => void): () => void;
}

export interface ModelsBridge {
  list(): Promise<ProviderConfig[]>;
  /** pi's whole built-in catalog (providers, models, prices, API kinds). */
  getCatalog(): Promise<CatalogProvider[]>;
  saveProvider(draft: ProviderDraft): Promise<ProviderConfig[]>;
  removeProvider(providerId: string): Promise<ProviderConfig[]>;
  /** Write-only: the key never travels back to the renderer. */
  setKey(providerId: string, apiKey: string): Promise<ProviderConfig[]>;
  test(providerId: string): Promise<ProviderTestResult>;
  refreshModels(providerId: string): Promise<ProviderConfig[]>;
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
  applyBuiltinPricing(providerId: string): Promise<ProviderConfig[]>;
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

export interface ProjectsBridge {
  list(): Promise<ProjectView[]>;
  create(input: { name: string; code?: string; description?: string; departmentId?: string }): Promise<ProjectView[]>;
  assign(projectId: string, employeeId: string, role?: string): Promise<ProjectView[]>;
  archive(projectId: string): Promise<ProjectView[]>;
}

export interface FactsBridge {
  /** Current facts: by employee (org + their department) or by department. */
  list(filter?: { employeeId?: string; departmentId?: string }): Promise<OrgFactView[]>;
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

export interface OpcBridge {
  readonly platform: string;
  readonly isElectron: true;
  app: {
    getInfo(): Promise<AppInfo>;
  };
  chat: ChatBridge;
  work: WorkBridge;
  models: ModelsBridge;
  images: ImagesBridge;
  auth: AuthBridge;
  artifacts: ArtifactsBridge;
  org: OrgBridge;
  facts: FactsBridge;
  projects: ProjectsBridge;
  market: MarketBridge;
  diagnostics: {
    report(): Promise<DiagnosticsReport>;
  };
}
