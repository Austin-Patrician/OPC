import {
  IPC,
  type AuthPromptRequest,
  type BudgetOverview,
  type CommOverview,
  type CommWakeResult,
  type ChatSnapshot,
  type EmployeeStackInput,
  type OpcBridge,
  type SendMessageInput,
} from '@opc/shared/ipc';
import type { OcrSettings } from '@opc/shared/ocr';
import type {
  BundledRuntime,
  Budget,
  HireInput,
  DepartmentEditInput,
  EvaluationInput,
  JobEditInput,
  JobInput,
  CatalogProvider,
  CompanyProfile,
  CompanyProfilePatch,
  ModelOption,
  CompactionSettings,
  CreateTaskInput,
  ModelDefaults,
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
  SpeechSynthesizeInput,
  SpeechSynthesizeResult,
  SpeechTranscribeInput,
  SpeechTranscribeResult,
  DecisionClassifyInput,
  DecisionClassifyResult,
  WorkTask,
} from '@opc/shared/domain';
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/**
 * The only surface the renderer may touch. No Node, no filesystem, no SQLite.
 * Runs in a sandboxed preload, so it must stay CommonJS-compatible.
 */
const bridge: OpcBridge = {
  isElectron: true,
  platform: process.platform,
  app: {
    getInfo: () => ipcRenderer.invoke(IPC.app.getInfo),
  },
  network: {
    get: () => ipcRenderer.invoke(IPC.network.get) as Promise<ProxyConfig>,
    update: (input: ProxyConfigInput) =>
      ipcRenderer.invoke(IPC.network.update, input) as Promise<ProxyConfig>,
    test: (input: ProxyConfigInput) =>
      ipcRenderer.invoke(IPC.network.test, input) as Promise<ProxyTestResult>,
    onChanged: (listener: (config: ProxyConfig) => void) => {
      const handler = (_event: IpcRendererEvent, config: ProxyConfig) => listener(config);
      ipcRenderer.on(IPC.network.changedEvent, handler);
      return () => {
        ipcRenderer.off(IPC.network.changedEvent, handler);
      };
    },
  },
  runtime: {
    snapshot: () => ipcRenderer.invoke(IPC.runtime.snapshot) as Promise<RuntimeSnapshot>,
    probe: () => ipcRenderer.invoke(IPC.runtime.probe) as Promise<RuntimeSnapshot>,
    setActive: (kind: RuntimeKind, profileId: string | null) =>
      ipcRenderer.invoke(IPC.runtime.setActive, kind, profileId) as Promise<RuntimeState>,
    chooseBinary: (kind: RuntimeKind) =>
      ipcRenderer.invoke(IPC.runtime.chooseBinary, kind) as Promise<string>,
    inspect: (kind: RuntimeKind, binary: string) =>
      ipcRenderer.invoke(IPC.runtime.inspect, kind, binary) as Promise<RuntimeInspection>,
    saveProfile: (draft: RuntimeProfileDraft) =>
      ipcRenderer.invoke(IPC.runtime.saveProfile, draft) as Promise<RuntimeState>,
    removeProfile: (profileId: string) =>
      ipcRenderer.invoke(IPC.runtime.removeProfile, profileId) as Promise<RuntimeState>,
    bundled: () => ipcRenderer.invoke(IPC.runtime.bundled) as Promise<BundledRuntime[]>,
    ocr: () => ipcRenderer.invoke(IPC.runtime.ocr) as Promise<OcrSettings>,
    setOcr: (next: OcrSettings) =>
      ipcRenderer.invoke(IPC.runtime.setOcr, next) as Promise<OcrSettings>,
  },
  company: {
    get: () => ipcRenderer.invoke(IPC.company.get) as Promise<CompanyProfile>,
    update: (patch: CompanyProfilePatch) =>
      ipcRenderer.invoke(IPC.company.update, patch) as Promise<CompanyProfile>,
    onChanged: (listener: (profile: CompanyProfile) => void) => {
      const handler = (_event: IpcRendererEvent, profile: CompanyProfile) => listener(profile);
      ipcRenderer.on(IPC.company.changedEvent, handler);
      return () => {
        ipcRenderer.off(IPC.company.changedEvent, handler);
      };
    },
  },
  chat: {
    getSnapshot: () => ipcRenderer.invoke(IPC.chat.getSnapshot) as Promise<ChatSnapshot>,
    sendMessage: (input: SendMessageInput) => ipcRenderer.invoke(IPC.chat.sendMessage, input),
    markRead: (conversationId: string) => ipcRenderer.invoke(IPC.chat.markRead, conversationId),
    openDirect: (agentId: string) => ipcRenderer.invoke(IPC.chat.openDirect, agentId) as Promise<string>,
    ensureDepartmentGroup: (departmentId: string) =>
      ipcRenderer.invoke(IPC.chat.ensureDepartmentGroup, departmentId) as Promise<string>,
    archive: (conversationId: string) =>
      ipcRenderer.invoke(IPC.chat.archive, conversationId) as Promise<{ archived: boolean; written: number }>,
    restore: (conversationId: string) =>
      ipcRenderer.invoke(IPC.chat.restore, conversationId) as Promise<void>,
    updateAgentBrief: (agentId: string, briefMd: string) =>
      ipcRenderer.invoke(IPC.chat.updateAgentBrief, agentId, briefMd),
    onSnapshot: (listener: (snapshot: ChatSnapshot) => void) => {
      const handler = (_event: IpcRendererEvent, snapshot: ChatSnapshot) => listener(snapshot);
      ipcRenderer.on(IPC.chat.snapshotEvent, handler);
      return () => {
        ipcRenderer.off(IPC.chat.snapshotEvent, handler);
      };
    },
  },
  market: {
    candidates: () => ipcRenderer.invoke(IPC.market.candidates),
    importPackage: () => ipcRenderer.invoke(IPC.market.importPackage),
    removeCandidate: (candidateId: string) => ipcRenderer.invoke(IPC.market.removeCandidate, candidateId),
    hireCandidate: (
      candidateId: string,
      input: { departmentId: string; reportsToEmployeeId?: string; isHead?: boolean; jobId?: string },
    ) => ipcRenderer.invoke(IPC.market.hireCandidate, candidateId, input),
    interviews: (candidateId?: string) => ipcRenderer.invoke(IPC.market.interviews, candidateId),
    createInterview: (candidateId: string, taskPrompt: string) =>
      ipcRenderer.invoke(IPC.market.createInterview, candidateId, taskPrompt),
    runInterview: (interviewId: string) => ipcRenderer.invoke(IPC.market.runInterview, interviewId),
    decideInterview: (input: unknown) => ipcRenderer.invoke(IPC.market.decideInterview, input),
    packages: () => ipcRenderer.invoke(IPC.market.packages),
    exportPackage: (input: unknown) => ipcRenderer.invoke(IPC.market.exportPackage, input),
    verifyPackage: (packageId: string) => ipcRenderer.invoke(IPC.market.verifyPackage, packageId),
  },
  budget: {
    overview: () => ipcRenderer.invoke(IPC.budget.overview) as Promise<BudgetOverview>,
    setLimit: (input: {
      scope: 'company' | 'employee' | 'department' | 'project';
      scopeId: string;
      limitTokens: number;
    }) => ipcRenderer.invoke(IPC.budget.setLimit, input) as Promise<BudgetOverview>,
    payroll: () => ipcRenderer.invoke(IPC.budget.payroll),
    costCenters: () => ipcRenderer.invoke(IPC.budget.costCenters),
  },
  comm: {
    overview: () => ipcRenderer.invoke(IPC.comm.overview) as Promise<CommOverview>,
    wake: (employeeId: string) =>
      ipcRenderer.invoke(IPC.comm.wake, employeeId) as Promise<CommWakeResult>,
    dismissGuards: (ids?: string[]) =>
      ipcRenderer.invoke(IPC.comm.dismissGuards, ids) as Promise<number>,
    onOverviewChanged: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on(IPC.comm.overviewEvent, handler);
      return () => {
        ipcRenderer.off(IPC.comm.overviewEvent, handler);
      };
    },
  },
  memory: {
    consolidationRuns: (employeeId?: string) =>
      ipcRenderer.invoke(IPC.memory.consolidationRuns, employeeId),
  },
  projects: {
    list: () => ipcRenderer.invoke(IPC.projects.list),
    create: (input: unknown) => ipcRenderer.invoke(IPC.projects.create, input),
    assign: (projectId: string, employeeId: string, role?: string) =>
      ipcRenderer.invoke(IPC.projects.assign, projectId, employeeId, role),
    archive: (projectId: string) => ipcRenderer.invoke(IPC.projects.archive, projectId),
    removeMember: (projectId: string, employeeId: string) =>
      ipcRenderer.invoke(IPC.projects.removeMember, projectId, employeeId),
    setReportsTo: (projectId: string, employeeId: string, managerId: string | null) =>
      ipcRenderer.invoke(IPC.projects.setReportsTo, projectId, employeeId, managerId),
  },
  facts: {
    list: (filter?: { employeeId?: string; departmentId?: string; projectId?: string }) =>
      ipcRenderer.invoke(IPC.facts.list, filter),
    write: (input: unknown) => ipcRenderer.invoke(IPC.facts.write, input),
  },
  org: {
    list: () => ipcRenderer.invoke(IPC.org.list),
    unplaced: () => ipcRenderer.invoke(IPC.org.unplaced),
    place: (employeeId: string, departmentId: string) =>
      ipcRenderer.invoke(IPC.org.place, employeeId, departmentId),
    setAvatar: (employeeId: string, dataUrl: string) =>
      ipcRenderer.invoke(IPC.org.setAvatar, employeeId, dataUrl),
    setPersona: (employeeId: string, persona: string) =>
      ipcRenderer.invoke(IPC.org.setPersona, employeeId, persona),
    personnel: (input: unknown) => ipcRenderer.invoke(IPC.org.personnel, input),
    createDepartment: (input: { name: string; code?: string; description?: string; parentId?: string }) =>
      ipcRenderer.invoke(IPC.org.createDepartment, input),
    updateDepartment: (input: DepartmentEditInput) =>
      ipcRenderer.invoke(IPC.org.updateDepartment, input),
    archiveDepartment: (departmentId: string) =>
      ipcRenderer.invoke(IPC.org.archiveDepartment, departmentId),
    appointHead: (departmentId: string, employeeId: string | null) =>
      ipcRenderer.invoke(IPC.org.appointHead, departmentId, employeeId),
    appointActingHead: (departmentId: string, employeeId: string | null) =>
      ipcRenderer.invoke(IPC.org.appointActingHead, departmentId, employeeId),
    evaluations: (employeeId: string, limit?: number) =>
      ipcRenderer.invoke(IPC.org.evaluations, employeeId, limit),
    addEvaluation: (input: EvaluationInput) => ipcRenderer.invoke(IPC.org.addEvaluation, input),
    jobs: (departmentId?: string) => ipcRenderer.invoke(IPC.org.jobs, departmentId),
    createJob: (input: JobInput) => ipcRenderer.invoke(IPC.org.createJob, input),
    updateJob: (input: JobEditInput) => ipcRenderer.invoke(IPC.org.updateJob, input),
    archiveJob: (jobId: string) => ipcRenderer.invoke(IPC.org.archiveJob, jobId),
    setJobSeat: (input) => ipcRenderer.invoke(IPC.org.setJobSeat, input),
    syncJob: (jobId: string) => ipcRenderer.invoke(IPC.org.syncJob, jobId) as Promise<number>,
    events: (employeeId: string, limit?: number) =>
      ipcRenderer.invoke(IPC.org.events, employeeId, limit),
    hire: (input: HireInput) => ipcRenderer.invoke(IPC.org.hire, input),
    transfer: (employeeId: string, departmentId: string, reportsToEmployeeId?: string, jobId?: string) =>
      ipcRenderer.invoke(IPC.org.transfer, employeeId, departmentId, reportsToEmployeeId, jobId),
    fire: (employeeId: string) => ipcRenderer.invoke(IPC.org.fire, employeeId),
    stack: (employeeId: string) => ipcRenderer.invoke(IPC.org.stack, employeeId),
    setStack: (employeeId: string, input: EmployeeStackInput) =>
      ipcRenderer.invoke(IPC.org.setStack, employeeId, input),
  },
  artifacts: {
    read: (taskId: string, relPath: string) => ipcRenderer.invoke(IPC.artifacts.read, taskId, relPath),
    saveAs: (taskId: string, relPath: string) =>
      ipcRenderer.invoke(IPC.artifacts.saveAs, taskId, relPath),
  },
  auth: {
    login: (providerId: string, type: 'oauth' | 'apiKey') =>
      ipcRenderer.invoke(IPC.auth.login, providerId, type),
    logout: (providerId: string) => ipcRenderer.invoke(IPC.auth.logout, providerId),
    status: () => ipcRenderer.invoke(IPC.auth.status),
    answer: (promptId: string, value: string | null) =>
      ipcRenderer.invoke(IPC.auth.answer, promptId, value),
    onPrompt: (listener: (request: AuthPromptRequest) => void) => {
      const handler = (_event: IpcRendererEvent, request: AuthPromptRequest) => listener(request);
      ipcRenderer.on(IPC.auth.promptEvent, handler);
      return () => {
        ipcRenderer.off(IPC.auth.promptEvent, handler);
      };
    },
    onNotify: (listener: (event: { text: string; url?: string }) => void) => {
      const handler = (_event: IpcRendererEvent, payload: { text: string; url?: string }) => listener(payload);
      ipcRenderer.on(IPC.auth.notifyEvent, handler);
      return () => {
        ipcRenderer.off(IPC.auth.notifyEvent, handler);
      };
    },
  },
  models: {
    list: () => ipcRenderer.invoke(IPC.models.list) as Promise<ProviderConfig[]>,
    getCatalog: () => ipcRenderer.invoke(IPC.models.getCatalog) as Promise<CatalogProvider[]>,
    saveProvider: (draft: ProviderDraft) => ipcRenderer.invoke(IPC.models.saveProvider, draft),
    removeProvider: (providerId: string) => ipcRenderer.invoke(IPC.models.removeProvider, providerId),
    setKey: (providerId: string, apiKey: string) =>
      ipcRenderer.invoke(IPC.models.setKey, providerId, apiKey),
    getKey: (providerId: string) => ipcRenderer.invoke(IPC.models.getKey, providerId),
    test: (providerId: string) =>
      ipcRenderer.invoke(IPC.models.test, providerId) as Promise<ProviderTestResult>,
    refreshModels: (providerId: string) => ipcRenderer.invoke(IPC.models.refreshModels, providerId),
    addModel: (providerId: string, input: unknown) => ipcRenderer.invoke(IPC.models.addModel, providerId, input),
    supportsOauth: (providerId: string) =>
      ipcRenderer.invoke(IPC.models.supportsOauth, providerId) as Promise<boolean>,
    getDefaults: () => ipcRenderer.invoke(IPC.models.getDefaults) as Promise<ModelDefaults>,
    setDefault: (role: 'llm' | 'image' | 'asr' | 'tts' | 'decision', ref: ModelRef | null) =>
      ipcRenderer.invoke(IPC.models.setDefault, role, ref),
    importFromPi: () => ipcRenderer.invoke(IPC.models.importFromPi),
    getCompaction: () => ipcRenderer.invoke(IPC.models.getCompaction) as Promise<CompactionSettings>,
    setCompaction: (next: CompactionSettings) => ipcRenderer.invoke(IPC.models.setCompaction, next),
    setModelContext: (providerId: string, modelId: string, contextWindow: number) =>
      ipcRenderer.invoke(IPC.models.setModelContext, providerId, modelId, contextWindow),
    setModels: (providerId: string, models: ModelOption[]) =>
      ipcRenderer.invoke(IPC.models.setModels, providerId, models),
    setModelPricing: (
      providerId: string,
      modelId: string,
      price: { input: number; output: number; cacheRead: number; cacheWrite: number },
    ) => ipcRenderer.invoke(IPC.models.setModelPricing, providerId, modelId, price),
    applyBuiltinPricing: (providerId: string) =>
      ipcRenderer.invoke(IPC.models.applyBuiltinPricing, providerId),
    getThinking: () => ipcRenderer.invoke(IPC.models.getThinking) as Promise<string>,
    setThinking: (level: string) => ipcRenderer.invoke(IPC.models.setThinking, level),
  },
  speech: {
    transcribe: (input: SpeechTranscribeInput) =>
      ipcRenderer.invoke(IPC.speech.transcribe, input) as Promise<SpeechTranscribeResult>,
    synthesize: (input: SpeechSynthesizeInput) =>
      ipcRenderer.invoke(IPC.speech.synthesize, input) as Promise<SpeechSynthesizeResult>,
  },
  decisions: {
    classify: (input: DecisionClassifyInput) =>
      ipcRenderer.invoke(IPC.decisions.classify, input) as Promise<DecisionClassifyResult>,
  },
  work: {
    listTasks: (limit?: number) => ipcRenderer.invoke(IPC.work.listTasks, limit) as Promise<WorkTask[]>,
    createTask: (input: CreateTaskInput) => ipcRenderer.invoke(IPC.work.createTask, input),
    runTask: (taskId: string) => ipcRenderer.invoke(IPC.work.runTask, taskId),
    bossDecision: (taskId: string, decision: 'approve' | 'reject', reason?: string) =>
      ipcRenderer.invoke(IPC.work.bossDecision, taskId, decision, reason) as Promise<WorkTask>,
    setIssueMeta: (taskId: string, patch: unknown) =>
      ipcRenderer.invoke(IPC.work.setIssueMeta, taskId, patch) as Promise<WorkTask>,
    linkTasks: (fromId: string, toId: string, type?: 'blocks' | 'duplicates' | 'relates') =>
      ipcRenderer.invoke(IPC.work.linkTasks, fromId, toId, type) as Promise<WorkTask>,
    listBudgets: () => ipcRenderer.invoke(IPC.work.listBudgets) as Promise<Budget[]>,
    subtasks: (taskId: string) => ipcRenderer.invoke(IPC.work.subtasks, taskId) as Promise<WorkTask[]>,
    onBudgetsChanged: (listener: (budgets: Budget[]) => void) => {
      const handler = (_event: IpcRendererEvent, budgets: Budget[]) => listener(budgets);
      ipcRenderer.on(IPC.work.budgetsEvent, handler);
      return () => {
        ipcRenderer.off(IPC.work.budgetsEvent, handler);
      };
    },
    onTaskChanged: (listener: (task: WorkTask) => void) => {
      const handler = (_event: IpcRendererEvent, task: WorkTask) => listener(task);
      ipcRenderer.on(IPC.work.taskEvent, handler);
      return () => {
        ipcRenderer.off(IPC.work.taskEvent, handler);
      };
    },
  },
  capabilities: {
    list: () => ipcRenderer.invoke(IPC.capabilities.list),
  },
  extensions: {
    list: () => ipcRenderer.invoke(IPC.extensions.list),
    setEnabled: (id: string, enabled: boolean, trusted?: boolean) =>
      ipcRenderer.invoke(IPC.extensions.setEnabled, id, enabled, trusted),
  },
  skills: {
    list: () => ipcRenderer.invoke(IPC.skills.list),
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke(IPC.skills.setEnabled, id, enabled),
  },
  diagnostics: {
    report: () => ipcRenderer.invoke(IPC.diagnostics.report),
  },
};

contextBridge.exposeInMainWorld('opc', bridge);
