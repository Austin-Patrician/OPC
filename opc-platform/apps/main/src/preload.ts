import {
  IPC,
  type AuthPromptRequest,
  type ChatSnapshot,
  type OpcBridge,
  type RuntimeObservatorySnapshot,
  type RuntimeObservatoryRequest,
  type RuntimeEventView,
  type SendMessageInput,
  type BrowserStatus,
  type BrowserInstallProgress,
  type DesktopStatus,
  type DesktopInstallProgress,
  type AssistantToolsSettings,
  type AssistantSearchProvider,
  type UsageFilter,
  type UsageReport,
} from "@opc/shared/ipc";
import type { OcrSettings } from "@opc/shared/ocr";
import type {
  BundledRuntime,
  CatalogProvider,
  CompanyProfile,
  CompanyProfilePatch,
  BillingSettings,
  BillingSettingsPatch,
  ModelOption,
  CompactionSettings,
  CreateTaskInput,
  ModelDefaults,
  ModelRef,
  ModelRole,
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
  TaskTrace,
  WorkTask,
} from "@opc/shared/domain";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

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
  window: {
    minimize: () => ipcRenderer.invoke(IPC.window.minimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.window.toggleMaximize),
    close: () => ipcRenderer.invoke(IPC.window.close),
  },
  network: {
    get: () => ipcRenderer.invoke(IPC.network.get) as Promise<ProxyConfig>,
    update: (input: ProxyConfigInput) =>
      ipcRenderer.invoke(IPC.network.update, input) as Promise<ProxyConfig>,
    test: (input: ProxyConfigInput) =>
      ipcRenderer.invoke(IPC.network.test, input) as Promise<ProxyTestResult>,
    onChanged: (listener: (config: ProxyConfig) => void) => {
      const handler = (_event: IpcRendererEvent, config: ProxyConfig) =>
        listener(config);
      ipcRenderer.on(IPC.network.changedEvent, handler);
      return () => {
        ipcRenderer.off(IPC.network.changedEvent, handler);
      };
    },
  },
  assistantTools: {
    getSettings: () => ipcRenderer.invoke(IPC.assistantTools.getSettings) as Promise<AssistantToolsSettings>,
    updateSettings: (patch: { timezone?: string | null; weatherCity?: string; defaultSearch?: AssistantSearchProvider; enabled?: Partial<Record<AssistantSearchProvider, boolean>>; keys?: Partial<Record<AssistantSearchProvider, string | null>> }) =>
      ipcRenderer.invoke(IPC.assistantTools.updateSettings, patch) as Promise<AssistantToolsSettings>,
  },
  runtime: {
    snapshot: () =>
      ipcRenderer.invoke(IPC.runtime.snapshot) as Promise<RuntimeSnapshot>,
    observatory: (request?: RuntimeObservatoryRequest) =>
      ipcRenderer.invoke(IPC.runtime.observatory, request) as Promise<RuntimeObservatorySnapshot>,
    onChanged: (listener: (event: RuntimeEventView) => void) => {
      const handler = (_event: IpcRendererEvent, payload: RuntimeEventView) => listener(payload);
      ipcRenderer.on(IPC.runtime.changedEvent, handler);
      return () => ipcRenderer.off(IPC.runtime.changedEvent, handler);
    },
    probe: () =>
      ipcRenderer.invoke(IPC.runtime.probe) as Promise<RuntimeSnapshot>,
    setActive: (kind: RuntimeKind, profileId: string | null) =>
      ipcRenderer.invoke(
        IPC.runtime.setActive,
        kind,
        profileId,
      ) as Promise<RuntimeState>,
    chooseBinary: (kind: RuntimeKind) =>
      ipcRenderer.invoke(IPC.runtime.chooseBinary, kind) as Promise<string>,
    inspect: (kind: RuntimeKind, binary: string) =>
      ipcRenderer.invoke(
        IPC.runtime.inspect,
        kind,
        binary,
      ) as Promise<RuntimeInspection>,
    saveProfile: (draft: RuntimeProfileDraft) =>
      ipcRenderer.invoke(
        IPC.runtime.saveProfile,
        draft,
      ) as Promise<RuntimeState>,
    removeProfile: (profileId: string) =>
      ipcRenderer.invoke(
        IPC.runtime.removeProfile,
        profileId,
      ) as Promise<RuntimeState>,
    bundled: () =>
      ipcRenderer.invoke(IPC.runtime.bundled) as Promise<BundledRuntime[]>,
    ocr: () => ipcRenderer.invoke(IPC.runtime.ocr) as Promise<OcrSettings>,
    setOcr: (next: OcrSettings) =>
      ipcRenderer.invoke(IPC.runtime.setOcr, next) as Promise<OcrSettings>,
  },
  company: {
    get: () => ipcRenderer.invoke(IPC.company.get) as Promise<CompanyProfile>,
    update: (patch: CompanyProfilePatch) =>
      ipcRenderer.invoke(IPC.company.update, patch) as Promise<CompanyProfile>,
    onChanged: (listener: (profile: CompanyProfile) => void) => {
      const handler = (_event: IpcRendererEvent, profile: CompanyProfile) =>
        listener(profile);
      ipcRenderer.on(IPC.company.changedEvent, handler);
      return () => {
        ipcRenderer.off(IPC.company.changedEvent, handler);
      };
    },
  },
  chat: {
    getSnapshot: () =>
      ipcRenderer.invoke(IPC.chat.getSnapshot) as Promise<ChatSnapshot>,
    loadOlderMessages: (conversationId: string, beforeMessageId: string) =>
      ipcRenderer.invoke(IPC.chat.loadOlderMessages, conversationId, beforeMessageId),
    searchMessages: (input) => ipcRenderer.invoke(IPC.chat.searchMessages, input),
    sendMessage: (input: SendMessageInput) =>
      ipcRenderer.invoke(IPC.chat.sendMessage, input),
    chooseAttachments: () => ipcRenderer.invoke(IPC.chat.chooseAttachments),
    materializeClipboardAttachment: (input: { name: string; mimeType?: string; bytes: ArrayBuffer }) =>
      ipcRenderer.invoke(IPC.chat.materializeClipboardAttachment, input),
    markRead: (conversationId: string) =>
      ipcRenderer.invoke(IPC.chat.markRead, conversationId),
    ensureAssistant: () =>
      ipcRenderer.invoke(IPC.chat.ensureAssistant) as Promise<string>,
    archive: (conversationId: string) =>
      ipcRenderer.invoke(IPC.chat.archive, conversationId) as Promise<{
        archived: boolean;
        written: number;
      }>,
    restore: (conversationId: string) =>
      ipcRenderer.invoke(IPC.chat.restore, conversationId) as Promise<void>,
    onSnapshot: (listener: (snapshot: ChatSnapshot) => void) => {
      const handler = (_event: IpcRendererEvent, snapshot: ChatSnapshot) =>
        listener(snapshot);
      ipcRenderer.on(IPC.chat.snapshotEvent, handler);
      return () => {
        ipcRenderer.off(IPC.chat.snapshotEvent, handler);
      };
    },
  },
  mcp: {
    list: () => ipcRenderer.invoke(IPC.mcp.list),
    save: (draft: unknown) => ipcRenderer.invoke(IPC.mcp.save, draft),
    setAutoApprove: (name: string, enabled: boolean) =>
      ipcRenderer.invoke(IPC.mcp.setAutoApprove, { name, enabled }),
    listTools: (name: string) => ipcRenderer.invoke(IPC.mcp.listTools, name),
    setToolAutoApprove: (server: string, tool: string, enabled: boolean | null) =>
      ipcRenderer.invoke(IPC.mcp.setToolAutoApprove, { server, tool, enabled }),
    resetToolApprovals: (server: string, enabled: boolean) =>
      ipcRenderer.invoke(IPC.mcp.resetToolApprovals, { server, enabled }),
    remove: (name: string) => ipcRenderer.invoke(IPC.mcp.remove, name),
    test: (name: string) => ipcRenderer.invoke(IPC.mcp.test, name),
    login: (name: string) => ipcRenderer.invoke(IPC.mcp.login, name),
    logout: (name: string) => ipcRenderer.invoke(IPC.mcp.logout, name),
  },
  browser: {
    status: () => ipcRenderer.invoke(IPC.browser.status),
    install: () => ipcRenderer.invoke(IPC.browser.install),
    uninstall: (deleteProfile?: boolean, deleteBrowserCache?: boolean) => ipcRenderer.invoke(IPC.browser.uninstall, { deleteProfile: deleteProfile === true, deleteBrowserCache: deleteBrowserCache === true }),
    doctor: () => ipcRenderer.invoke(IPC.browser.doctor),
    getSettings: () => ipcRenderer.invoke(IPC.browser.getSettings),
    setSettings: (patch: unknown) => ipcRenderer.invoke(IPC.browser.setSettings, patch),
    show: (taskId: string) => ipcRenderer.invoke(IPC.browser.show, taskId),
    hide: (taskId?: string) => ipcRenderer.invoke(IPC.browser.hide, taskId),
    resetProfile: (userId?: string) => ipcRenderer.invoke(IPC.browser.resetProfile, userId),
    onChanged: (listener: (status: BrowserStatus) => void) => {
      const handler = (_event: IpcRendererEvent, status: BrowserStatus) => listener(status);
      ipcRenderer.on(IPC.browser.changedEvent, handler);
      return () => ipcRenderer.off(IPC.browser.changedEvent, handler);
    },
    onInstallProgress: (listener: (progress: BrowserInstallProgress | null) => void) => {
      const handler = (_event: IpcRendererEvent, progress: BrowserInstallProgress | null) => listener(progress);
      ipcRenderer.on(IPC.browser.installProgressEvent, handler);
      return () => ipcRenderer.off(IPC.browser.installProgressEvent, handler);
    },
  },
  desktop: {
    status: () => ipcRenderer.invoke(IPC.desktop.status) as Promise<DesktopStatus>,
    install: () => ipcRenderer.invoke(IPC.desktop.install) as Promise<DesktopStatus>,
    uninstall: (deleteRuntime?: boolean) => ipcRenderer.invoke(IPC.desktop.uninstall, deleteRuntime !== false) as Promise<DesktopStatus>,
    doctor: () => ipcRenderer.invoke(IPC.desktop.doctor) as Promise<DesktopStatus>,
    permissions: () => ipcRenderer.invoke(IPC.desktop.permissions) as Promise<DesktopStatus>,
    permissionsGuide: () => ipcRenderer.invoke(IPC.desktop.permissionsGuide) as Promise<DesktopStatus>,
    getSettings: () => ipcRenderer.invoke(IPC.desktop.getSettings),
    setSettings: (patch: unknown) => ipcRenderer.invoke(IPC.desktop.setSettings, patch),
    listApps: () => ipcRenderer.invoke(IPC.desktop.listApps),
    listWindows: () => ipcRenderer.invoke(IPC.desktop.listWindows),
    inspect: (taskId: string) => ipcRenderer.invoke(IPC.desktop.inspect, taskId),
    show: (taskId: string) => ipcRenderer.invoke(IPC.desktop.show, taskId),
    hide: (taskId?: string) => ipcRenderer.invoke(IPC.desktop.hide, taskId),
    onChanged: (listener: (status: DesktopStatus) => void) => {
      const handler = (_event: IpcRendererEvent, status: DesktopStatus) => listener(status);
      ipcRenderer.on(IPC.desktop.changedEvent, handler);
      return () => ipcRenderer.off(IPC.desktop.changedEvent, handler);
    },
    onInstallProgress: (listener: (progress: DesktopInstallProgress | null) => void) => {
      const handler = (_event: IpcRendererEvent, progress: DesktopInstallProgress | null) => listener(progress);
      ipcRenderer.on(IPC.desktop.installProgressEvent, handler);
      return () => ipcRenderer.off(IPC.desktop.installProgressEvent, handler);
    },
  },
  threads: {
    start: (goal: string) => ipcRenderer.invoke(IPC.threads.start, goal),
    list: (limit?: number) => ipcRenderer.invoke(IPC.threads.list, limit),
    markRead: (reportId: string) =>
      ipcRenderer.invoke(IPC.threads.markRead, reportId),
    decide: (input: unknown) => ipcRenderer.invoke(IPC.threads.decide, input),
    answer: (input: unknown) => ipcRenderer.invoke(IPC.threads.answer, input),
    close: (threadId: string) =>
      ipcRenderer.invoke(IPC.threads.close, threadId),
  },
  billing: {
    get: () => ipcRenderer.invoke(IPC.billing.get) as Promise<BillingSettings>,
    update: (patch: BillingSettingsPatch) =>
      ipcRenderer.invoke(IPC.billing.update, patch) as Promise<BillingSettings>,
    onChanged: (listener: (settings: BillingSettings) => void) => {
      const handler = (_event: IpcRendererEvent, settings: BillingSettings) =>
        listener(settings);
      ipcRenderer.on(IPC.billing.changedEvent, handler);
      return () => {
        ipcRenderer.off(IPC.billing.changedEvent, handler);
      };
    },
  },
  usage: {
    report: (filter: UsageFilter) => ipcRenderer.invoke(IPC.usage.report, filter) as Promise<UsageReport>,
    exportCsv: (filter: UsageFilter) => ipcRenderer.invoke(IPC.usage.exportCsv, filter) as Promise<boolean>,
    onChanged: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on(IPC.usage.changedEvent, handler);
      return () => ipcRenderer.off(IPC.usage.changedEvent, handler);
    },
  },
  memory: {
    consolidationRuns: (ownerId?: string) =>
      ipcRenderer.invoke(IPC.memory.consolidationRuns, ownerId),
    list: () => ipcRenderer.invoke(IPC.memory.list),
    update: (id: string, content: string) =>
      ipcRenderer.invoke(IPC.memory.update, id, content),
    forget: (id: string) => ipcRenderer.invoke(IPC.memory.forget, id),
    orphans: () => ipcRenderer.invoke(IPC.memory.orphans),
    claim: (ownerId: string) => ipcRenderer.invoke(IPC.memory.claim, ownerId),
    discard: (ownerId: string) =>
      ipcRenderer.invoke(IPC.memory.discard, ownerId),
  },
  facts: {
    list: (filter?: { threadId?: string }) =>
      ipcRenderer.invoke(IPC.facts.list, filter),
    write: (input: unknown) => ipcRenderer.invoke(IPC.facts.write, input),
  },
  ontology: {
    context: (input?: unknown) => ipcRenderer.invoke(IPC.ontology.context, input),
    history: (input: unknown) => ipcRenderer.invoke(IPC.ontology.history, input),
    command: (input: unknown) => ipcRenderer.invoke(IPC.ontology.command, input),
    commandStatus: (commandId: string, status: 'approved' | 'rejected', result?: unknown, error?: string) =>
      ipcRenderer.invoke(IPC.ontology.commandStatus, { commandId, status, result, error }),
    outbox: (limit?: number) => ipcRenderer.invoke(IPC.ontology.outbox, limit),
  },
  router: {
    getTriage: () => ipcRenderer.invoke(IPC.router.getTriage),
    setTriage: (patch: unknown) =>
      ipcRenderer.invoke(IPC.router.setTriage, patch),
    listSchedules: () => ipcRenderer.invoke(IPC.router.listSchedules),
    createSchedule: (draft: unknown) => ipcRenderer.invoke(IPC.router.createSchedule, draft),
    updateSchedule: (id: string, patch: unknown) => ipcRenderer.invoke(IPC.router.updateSchedule, id, patch),
    cancelSchedule: (id: string) => ipcRenderer.invoke(IPC.router.cancelSchedule, id),
    listScheduleOccurrences: (id: string) => ipcRenderer.invoke(IPC.router.listScheduleOccurrences, id),
    onScheduleChanged: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on(IPC.router.scheduleChangedEvent, handler);
      return () => ipcRenderer.removeListener(IPC.router.scheduleChangedEvent, handler);
    },
  },
  watchdog: {
    incidents: () => ipcRenderer.invoke(IPC.watchdog.incidents),
    actions: () => ipcRenderer.invoke(IPC.watchdog.actions),
    ask: (question: string) => ipcRenderer.invoke(IPC.watchdog.ask, question),
    getPolicy: () => ipcRenderer.invoke(IPC.watchdog.getPolicy),
    savePolicy: (patch: unknown) =>
      ipcRenderer.invoke(IPC.watchdog.savePolicy, patch),
    getModel: () => ipcRenderer.invoke(IPC.watchdog.getModel),
    setModel: (ref: unknown) => ipcRenderer.invoke(IPC.watchdog.setModel, ref),
  },
  trigger: {
    status: () => ipcRenderer.invoke(IPC.trigger.status),
    set: (patch: unknown) => ipcRenderer.invoke(IPC.trigger.set, patch),
  },
  workers: {
    list: () => ipcRenderer.invoke(IPC.workers.list),
  },
  artifacts: {
    read: (taskId: string, relPath: string) =>
      ipcRenderer.invoke(IPC.artifacts.read, taskId, relPath),
    saveAs: (taskId: string, relPath: string) =>
      ipcRenderer.invoke(IPC.artifacts.saveAs, taskId, relPath),
  },
  chatMedia: {
    register: (input: unknown) => ipcRenderer.invoke(IPC.chatMedia.register, input),
  },
  auth: {
    login: (providerId: string, type: "oauth" | "apiKey") =>
      ipcRenderer.invoke(IPC.auth.login, providerId, type),
    logout: (providerId: string) =>
      ipcRenderer.invoke(IPC.auth.logout, providerId),
    status: () => ipcRenderer.invoke(IPC.auth.status),
    answer: (promptId: string, value: string | null) =>
      ipcRenderer.invoke(IPC.auth.answer, promptId, value),
    onPrompt: (listener: (request: AuthPromptRequest) => void) => {
      const handler = (_event: IpcRendererEvent, request: AuthPromptRequest) =>
        listener(request);
      ipcRenderer.on(IPC.auth.promptEvent, handler);
      return () => {
        ipcRenderer.off(IPC.auth.promptEvent, handler);
      };
    },
    onNotify: (listener: (event: { text: string; url?: string }) => void) => {
      const handler = (
        _event: IpcRendererEvent,
        payload: { text: string; url?: string },
      ) => listener(payload);
      ipcRenderer.on(IPC.auth.notifyEvent, handler);
      return () => {
        ipcRenderer.off(IPC.auth.notifyEvent, handler);
      };
    },
  },
  models: {
    list: () =>
      ipcRenderer.invoke(IPC.models.list) as Promise<ProviderConfig[]>,
    getCatalog: () =>
      ipcRenderer.invoke(IPC.models.getCatalog) as Promise<CatalogProvider[]>,
    saveProvider: (draft: ProviderDraft) =>
      ipcRenderer.invoke(IPC.models.saveProvider, draft),
    removeProvider: (providerId: string) =>
      ipcRenderer.invoke(IPC.models.removeProvider, providerId),
    setKey: (providerId: string, apiKey: string) =>
      ipcRenderer.invoke(IPC.models.setKey, providerId, apiKey),
    getKey: (providerId: string) =>
      ipcRenderer.invoke(IPC.models.getKey, providerId),
    test: (providerId: string) =>
      ipcRenderer.invoke(
        IPC.models.test,
        providerId,
      ) as Promise<ProviderTestResult>,
    refreshModels: (providerId: string) =>
      ipcRenderer.invoke(IPC.models.refreshModels, providerId),
    addModel: (providerId: string, input: unknown) =>
      ipcRenderer.invoke(IPC.models.addModel, providerId, input),
    supportsOauth: (providerId: string) =>
      ipcRenderer.invoke(
        IPC.models.supportsOauth,
        providerId,
      ) as Promise<boolean>,
    getDefaults: () =>
      ipcRenderer.invoke(IPC.models.getDefaults) as Promise<ModelDefaults>,
    setDefault: (role: ModelRole, ref: ModelRef | null) =>
      ipcRenderer.invoke(IPC.models.setDefault, role, ref),
    importFromPi: () => ipcRenderer.invoke(IPC.models.importFromPi),
    getCompaction: () =>
      ipcRenderer.invoke(
        IPC.models.getCompaction,
      ) as Promise<CompactionSettings>,
    setCompaction: (next: CompactionSettings) =>
      ipcRenderer.invoke(IPC.models.setCompaction, next),
    setModelContext: (
      providerId: string,
      modelId: string,
      contextWindow: number,
    ) =>
      ipcRenderer.invoke(
        IPC.models.setModelContext,
        providerId,
        modelId,
        contextWindow,
      ),
    setModels: (providerId: string, models: ModelOption[]) =>
      ipcRenderer.invoke(IPC.models.setModels, providerId, models),
    setModelPricing: (
      providerId: string,
      modelId: string,
      price: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
      },
    ) =>
      ipcRenderer.invoke(
        IPC.models.setModelPricing,
        providerId,
        modelId,
        price,
      ),
    applyBuiltinPricing: (providerId: string) =>
      ipcRenderer.invoke(IPC.models.applyBuiltinPricing, providerId),
    getThinking: () =>
      ipcRenderer.invoke(IPC.models.getThinking) as Promise<string>,
    setThinking: (level: string | null) =>
      ipcRenderer.invoke(IPC.models.setThinking, level),
    getRouterThinking: () =>
      ipcRenderer.invoke(IPC.models.getRouterThinking) as Promise<string>,
    setRouterThinking: (level: string | null) =>
      ipcRenderer.invoke(
        IPC.models.setRouterThinking,
        level,
      ) as Promise<string>,
  },
  speech: {
    transcribe: (input: SpeechTranscribeInput) =>
      ipcRenderer.invoke(
        IPC.speech.transcribe,
        input,
      ) as Promise<SpeechTranscribeResult>,
    synthesize: (input: SpeechSynthesizeInput) =>
      ipcRenderer.invoke(
        IPC.speech.synthesize,
        input,
      ) as Promise<SpeechSynthesizeResult>,
  },
  decisions: {
    classify: (input: DecisionClassifyInput) =>
      ipcRenderer.invoke(
        IPC.decisions.classify,
        input,
      ) as Promise<DecisionClassifyResult>,
  },
  work: {
    listTasks: (limit?: number) =>
      ipcRenderer.invoke(IPC.work.listTasks, limit) as Promise<WorkTask[]>,
    createTask: (input: CreateTaskInput) =>
      ipcRenderer.invoke(IPC.work.createTask, input),
    runTask: (taskId: string) => ipcRenderer.invoke(IPC.work.runTask, taskId),
    userDecision: (
      taskId: string,
      decision: "approve" | "reject",
      reason?: string,
    ) =>
      ipcRenderer.invoke(
        IPC.work.userDecision,
        taskId,
        decision,
        reason,
      ) as Promise<WorkTask>,
    setIssueMeta: (taskId: string, patch: unknown) =>
      ipcRenderer.invoke(
        IPC.work.setIssueMeta,
        taskId,
        patch,
      ) as Promise<WorkTask>,
    linkTasks: (
      fromId: string,
      toId: string,
      type?: "blocks" | "duplicates" | "relates",
    ) =>
      ipcRenderer.invoke(
        IPC.work.linkTasks,
        fromId,
        toId,
        type,
      ) as Promise<WorkTask>,
    subtasks: (taskId: string) =>
      ipcRenderer.invoke(IPC.work.subtasks, taskId) as Promise<WorkTask[]>,
    trace: (taskId: string, limit?: number) =>
      ipcRenderer.invoke(IPC.work.trace, taskId, limit) as Promise<TaskTrace[]>,
    onTaskChanged: (listener: (task: WorkTask) => void) => {
      const handler = (_event: IpcRendererEvent, task: WorkTask) =>
        listener(task);
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

contextBridge.exposeInMainWorld("opc", bridge);
