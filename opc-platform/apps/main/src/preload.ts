import {
  IPC,
  type AuthPromptRequest,
  type CommOverview,
  type CommWakeResult,
  type ChatSnapshot,
  type OpcBridge,
  type SendMessageInput,
} from '@opc/shared/ipc';
import type {
  Budget,
  HireInput,
  CatalogProvider,
  ModelOption,
  CompactionSettings,
  CreateTaskInput,
  ModelDefaults,
  ModelRef,
  ProviderConfig,
  ProviderDraft,
  ProviderTestResult,
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
      input: { departmentId: string; reportsToEmployeeId?: string; isHead?: boolean },
    ) => ipcRenderer.invoke(IPC.market.hireCandidate, candidateId, input),
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
  },
  facts: {
    list: (filter?: { employeeId?: string; departmentId?: string }) =>
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
    personnel: (input: unknown) => ipcRenderer.invoke(IPC.org.personnel, input),
    createDepartment: (input: { name: string; code?: string; description?: string }) =>
      ipcRenderer.invoke(IPC.org.createDepartment, input),
    hire: (input: HireInput) => ipcRenderer.invoke(IPC.org.hire, input),
    transfer: (employeeId: string, departmentId: string, reportsToEmployeeId?: string) =>
      ipcRenderer.invoke(IPC.org.transfer, employeeId, departmentId, reportsToEmployeeId),
    fire: (employeeId: string) => ipcRenderer.invoke(IPC.org.fire, employeeId),
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
  images: {
    generate: (input: { prompt: string; modelId?: string }) =>
      ipcRenderer.invoke(IPC.images.generate, input),
  },
  models: {
    list: () => ipcRenderer.invoke(IPC.models.list) as Promise<ProviderConfig[]>,
    getCatalog: () => ipcRenderer.invoke(IPC.models.getCatalog) as Promise<CatalogProvider[]>,
    saveProvider: (draft: ProviderDraft) => ipcRenderer.invoke(IPC.models.saveProvider, draft),
    removeProvider: (providerId: string) => ipcRenderer.invoke(IPC.models.removeProvider, providerId),
    setKey: (providerId: string, apiKey: string) =>
      ipcRenderer.invoke(IPC.models.setKey, providerId, apiKey),
    test: (providerId: string) =>
      ipcRenderer.invoke(IPC.models.test, providerId) as Promise<ProviderTestResult>,
    refreshModels: (providerId: string) => ipcRenderer.invoke(IPC.models.refreshModels, providerId),
    addModel: (providerId: string, input: unknown) => ipcRenderer.invoke(IPC.models.addModel, providerId, input),
    supportsOauth: (providerId: string) =>
      ipcRenderer.invoke(IPC.models.supportsOauth, providerId) as Promise<boolean>,
    getDefaults: () => ipcRenderer.invoke(IPC.models.getDefaults) as Promise<ModelDefaults>,
    setDefault: (role: 'llm' | 'image', ref: ModelRef | null) =>
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
  diagnostics: {
    report: () => ipcRenderer.invoke(IPC.diagnostics.report),
  },
};

contextBridge.exposeInMainWorld('opc', bridge);
