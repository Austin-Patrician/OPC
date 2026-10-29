import { IPC, type EmployeeStackInput, type SendMessageInput } from '@opc/shared/ipc';
import type {
  BundledRuntime,
  CompactionSettings,
  CompanyProfilePatch,
  CreateTaskInput,
  ModelOption,
  ModelRef,
  ProviderDraft,
  RuntimeProfileDraft,
} from '@opc/shared/domain';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getAppInfo } from '../appInfo';
import type { ChatService } from '../chat/chatService';
import type { CommService } from '../comm/commService';
import type { BudgetCenter } from '../work/budgetCenter';
import type { PayrollService } from '../work/payroll';
import type { ManualWakeResult } from '../comm/scheduler';
import { buildCommOverview } from '../comm/commOverview';
import { runDiagnostics } from '../diagnostics/report';
import type { PersonnelInput } from '@opc/shared/domain';
import type { OcrSettings } from '@opc/shared/ocr';
import type { MarketService } from '../market/marketService';
import type { OrgFactService } from '../memory/orgFactService';
import type { ConsolidationRunStore } from '../memory/consolidationRun';
import type { ProjectService } from '../org/projectService';
import type { AuthService } from '../models/authService';
import type { CompanyService } from '../company/companyService';
import type { OrgService } from '../org/orgService';
import { agentsFromDepartments, chatDepartmentsFromDepartments } from '../seed/firstCompany';
import { readImageArtifact } from '../work/artifacts';
import type { ModelConfigService } from '../models/modelConfigService';
import type { SpeechService } from '../models/speechService';
import type { NetworkProxyService } from '../network/proxyService';
import { probeProxy } from '../network/proxyRuntime';
import { isRuntimeKind } from '../runtime/profiles';
import type { RuntimeService } from '../runtime/service';
import type { WorkService } from '../work/workService';

interface RegisterOptions {
  chat: ChatService;
  work: WorkService;
  models: ModelConfigService;
  speech: SpeechService;
  auth: AuthService;
  company: CompanyService;
  /** 网络代理：保存即生效，失败会作为 IPC 错误抛回设置页。 */
  network: NetworkProxyService;
  /** 全局基础运行环境（Node / Python），所有员工共用。 */
  runtime: RuntimeService;
  /** 随应用分发的引擎（OCR）：读的是磁盘，不是偏好。 */
  bundled: { inspect: () => Promise<BundledRuntime[]> };
  /** OCR 开关与输出粒度，和 Node/Python 一样是公司级选择。 */
  ocrSettings: { get: () => OcrSettings; set: (next: OcrSettings) => OcrSettings };
  /** Resolves artifact paths to the workspace root (injected by bootstrap). */
  workspaceRoot: string;
  org: OrgService;
  market: MarketService;
  facts: OrgFactService;
  projects: ProjectService;
  consolidationRuns: ConsolidationRunStore;
  comm: CommService;
  budget: BudgetCenter;
  /** 薪酬视图：预算账本 → 每个人的本月花费。 */
  payroll: PayrollService;
  /** 老板手动唤醒：由 bootstrap 注入，因为它需要心跳调度器。 */
  wakeEmployee: (employeeId: string) => Promise<ManualWakeResult>;
}

/** Thin transport adapters: validate, delegate, broadcast. No business logic here. */
export function registerIpc({
  chat,
  work,
  models,
  speech,
  auth,
  workspaceRoot,
  org,
  market,
  facts,
  projects,
  consolidationRuns,
  comm,
  budget: budgetCenter,
  payroll,
  company,
  network,
  runtime,
  bundled,
  ocrSettings,
  wakeEmployee,
}: RegisterOptions): () => void {
  // Pending interactive prompts, keyed by prompt id; answered from the renderer.
  const pending = new Map<string, (value: string | null) => void>();

  const broadcast = (channel: string, payload: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  };

  /** IPC may deliver a Uint8Array, an ArrayBuffer or another view. */
  const toBytes = (value: unknown): Uint8Array | undefined => {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength);
    }
    return undefined;
  };

  const authBridge = {
    ask: (request: { id: string; kind: string; message: string }) =>
      new Promise<string | null>((resolve) => {
        pending.set(request.id, resolve);
        broadcast(IPC.auth.promptEvent, request);
      }),
    notify: (text: string, url?: string) => broadcast(IPC.auth.notifyEvent, { text, url }),
  };

  /**
   * The one way out of an org mutation: read the org once, hand the same snapshot to
   * the chat service, and return it.
   *
   * Every org channel used to `return org.list()` on its own, which left the chat
   * snapshot holding the org as it was at launch — a newly hired employee never
   * joined their department group. Doing the sync here means a new mutation cannot
   * forget it.
   */
  const refreshOrg = () => {
    const departments = org.list();
    chat.syncOrg(agentsFromDepartments(departments), chatDepartmentsFromDepartments(departments));
    return departments;
  };
  const unsubscribeBudgets = work.subscribeBudgets((budgets) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.work.budgetsEvent, budgets);
    }
  });

  const unsubscribeWork = work.subscribe((task) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.work.taskEvent, task);
    }
  });

  const unsubscribe = chat.subscribe((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC.chat.snapshotEvent, snapshot);
      }
    }
  });

  // The notification view re-reads the overview itself; the event only says "it moved".
  // Coalesced, because one inbox run completes several items in a row.
  let commSignal: ReturnType<typeof setTimeout> | null = null;
  const unsubscribeComm = comm.subscribe(() => {
    if (commSignal) return;
    commSignal = setTimeout(() => {
      commSignal = null;
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(IPC.comm.overviewEvent, null);
      }
    }, 150);
    commSignal.unref?.();
  });

  ipcMain.handle(IPC.budget.overview, () => budgetCenter.overview());
  ipcMain.handle(IPC.budget.payroll, () => payroll.overview());
  ipcMain.handle(IPC.budget.costCenters, () => payroll.costCenters());

  ipcMain.handle(IPC.budget.setLimit, (_event, input: unknown) => {
    const draft = (input ?? {}) as { scope?: unknown; scopeId?: unknown; limitTokens?: unknown };
    const scopes = ['company', 'employee', 'department', 'project'];
    if (typeof draft.scope !== 'string' || !scopes.includes(draft.scope)) {
      throw new Error('budget:setLimit 参数非法（scope）');
    }
    if (typeof draft.scopeId !== 'string' || draft.scopeId.length === 0) {
      throw new Error('budget:setLimit 参数非法（scopeId）');
    }
    if (typeof draft.limitTokens !== 'number' || !Number.isFinite(draft.limitTokens) || draft.limitTokens <= 0) {
      throw new Error('budget:setLimit 参数非法（limitTokens）');
    }
    return budgetCenter.setLimit({
      scope: draft.scope as 'company' | 'employee' | 'department' | 'project',
      scopeId: draft.scopeId,
      limitTokens: draft.limitTokens,
    });
  });

  ipcMain.handle(IPC.comm.overview, () =>
    buildCommOverview({
      comm,
      org,
      readTranscript: (conversationId) => chat.readTranscript(conversationId),
    }),
  );

  ipcMain.handle(IPC.comm.wake, (_event, employeeId: unknown) => {
    if (typeof employeeId !== 'string') throw new Error('comm:wake 参数非法');
    return wakeEmployee(employeeId);
  });

  ipcMain.handle(IPC.comm.dismissGuards, (_event, ids: unknown) => {
    if (ids !== undefined && !(Array.isArray(ids) && ids.every((id) => typeof id === 'string'))) {
      throw new Error('comm:dismissGuards 参数非法');
    }
    return comm.dismissGuards(ids as string[] | undefined);
  });

  ipcMain.handle(IPC.app.getInfo, () => getAppInfo());

  ipcMain.handle(IPC.network.get, () => network.get());

  ipcMain.handle(IPC.network.update, async (_event, input: unknown) => {
    const config = await network.update(input);
    // Other windows show the same setting; they re-render from this payload.
    broadcast(IPC.network.changedEvent, config);
    return config;
  });

  ipcMain.handle(IPC.network.test, (_event, input: unknown) => probeProxy(network.candidate(input)));

  ipcMain.handle(IPC.runtime.snapshot, () => runtime.snapshot());

  // Re-detects every profile; the settings page calls this explicitly so a
  // version is never probed during a tool call.
  ipcMain.handle(IPC.runtime.probe, () => runtime.probe());

  ipcMain.handle(IPC.runtime.setActive, (_event, kind: unknown, profileId: unknown) => {
    if (!isRuntimeKind(kind)) throw new Error('runtime:setActive kind 非法');
    if (profileId !== null && typeof profileId !== 'string') {
      throw new Error('runtime:setActive profileId 非法');
    }
    return runtime.setActive(kind, profileId);
  });

  ipcMain.handle(IPC.runtime.chooseBinary, async (event, kind: unknown) => {
    if (!isRuntimeKind(kind)) throw new Error('runtime:chooseBinary kind 非法');
    const window = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0];
    const options = {
      title: kind === 'node' ? '选择 Node 解释器' : '选择 Python 解释器',
      // Interpreters have no stable extension; let the user pick any executable.
      properties: ['openFile' as const],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? '' : (result.filePaths[0] ?? '');
  });

  ipcMain.handle(IPC.runtime.inspect, (_event, kind: unknown, binary: unknown) => {
    if (!isRuntimeKind(kind)) throw new Error('runtime:inspect kind 非法');
    if (typeof binary !== 'string') throw new Error('runtime:inspect binary 非法');
    return runtime.inspect({ kind, binary });
  });

  ipcMain.handle(IPC.runtime.saveProfile, (_event, draft: unknown) => {
    if (!isRuntimeProfileDraft(draft)) throw new Error('runtime:saveProfile 参数非法');
    return runtime.saveProfile(draft);
  });

  ipcMain.handle(IPC.runtime.removeProfile, (_event, profileId: unknown) => {
    if (typeof profileId !== 'string') throw new Error('runtime:removeProfile 参数非法');
    return runtime.removeProfile(profileId);
  });

  ipcMain.handle(IPC.runtime.bundled, () => bundled.inspect());
  ipcMain.handle(IPC.runtime.ocr, () => ocrSettings.get());
  ipcMain.handle(IPC.runtime.setOcr, (_event, next: unknown) => {
    if (!next || typeof next !== 'object') throw new Error('runtime:setOcr 参数非法');
    const raw = next as { enabled?: unknown; detail?: unknown };
    return ocrSettings.set({
      enabled: raw.enabled !== false,
      detail: raw.detail === 'lines' ? 'lines' : 'text',
    });
  });

  ipcMain.handle(IPC.company.get, () => company.get());

  ipcMain.handle(IPC.company.update, (_event, patch: unknown) => {
    if (!isCompanyPatch(patch)) throw new Error('company:update 参数非法');
    const profile = company.update(patch);
    // Every window renders the title bar, so a rename has to reach all of them.
    broadcast(IPC.company.changedEvent, profile);
    return profile;
  });

  ipcMain.handle(IPC.diagnostics.report, () => runDiagnostics());

  ipcMain.handle(IPC.chat.getSnapshot, () => chat.getSnapshot());

  ipcMain.handle(IPC.chat.sendMessage, (_event, input: unknown) => {
    if (!isSendMessageInput(input)) throw new Error('chat:sendMessage 参数非法');
    chat.sendMessage(input);
  });

  ipcMain.handle(IPC.chat.openDirect, (_event, agentId: unknown) => {
    if (typeof agentId !== 'string') throw new Error('chat:openDirect 参数非法');
    const member = org.list().flatMap((department) => department.members).find((item) => item.id === agentId);
    return chat.openDirect(agentId, member?.name);
  });
  ipcMain.handle(IPC.chat.ensureDepartmentGroup, (_event, departmentId: unknown) => {
    if (typeof departmentId !== 'string') throw new Error('chat:ensureDepartmentGroup 参数非法');
    const department = org.list().find((item) => item.id === departmentId);
    return chat.ensureDepartmentGroup(departmentId, department?.name);
  });
  ipcMain.handle(IPC.chat.archive, (_event, conversationId: unknown) => {
    if (typeof conversationId !== 'string') throw new Error('chat:archive 参数非法');
    return chat.archiveConversation(conversationId);
  });
  ipcMain.handle(IPC.chat.restore, (_event, conversationId: unknown) => {
    if (typeof conversationId !== 'string') throw new Error('chat:restore 参数非法');
    chat.restoreConversation(conversationId);
  });
  ipcMain.handle(IPC.chat.markRead, (_event, conversationId: unknown) => {
    if (typeof conversationId !== 'string') throw new Error('chat:markRead 参数非法');
    chat.markRead(conversationId);
  });

  ipcMain.handle(
    IPC.chat.updateAgentBrief,
    (_event, agentId: unknown, briefMd: unknown) => {
      if (typeof agentId !== 'string' || typeof briefMd !== 'string') {
        throw new Error('chat:updateAgentBrief 参数非法');
      }
      chat.updateAgentBrief(agentId, briefMd);
    },
  );

  ipcMain.handle(IPC.models.list, () => models.listProviders());
  ipcMain.handle(IPC.models.getCatalog, async () => {
    const { getCatalog } = await import('../models/catalog');
    return getCatalog();
  });
  ipcMain.handle(IPC.models.saveProvider, (_event, draft: unknown) => {
    if (!isProviderDraft(draft)) throw new Error('models:saveProvider 参数非法');
    return models.saveProvider(draft);
  });
  ipcMain.handle(IPC.models.removeProvider, (_event, providerId: unknown) => {
    if (typeof providerId !== 'string') throw new Error('models:removeProvider 参数非法');
    return models.removeProvider(providerId);
  });
  ipcMain.handle(IPC.models.setKey, (_event, providerId: unknown, apiKey: unknown) => {
    if (typeof providerId !== 'string' || typeof apiKey !== 'string') {
      throw new Error('models:setKey 参数非法');
    }
    return models.setKey(providerId, apiKey);
  });
  ipcMain.handle(IPC.models.getKey, (_event, providerId: unknown) => {
    if (typeof providerId !== 'string') throw new Error('models:getKey 参数非法');
    return models.readKey(providerId) ?? '';
  });
  ipcMain.handle(IPC.models.test, (_event, providerId: unknown) => {
    if (typeof providerId !== 'string') throw new Error('models:test 参数非法');
    return models.test(providerId);
  });
  ipcMain.handle(IPC.models.addModel, (_event, providerId: unknown, input: unknown) => {
    if (typeof providerId !== 'string' || typeof input !== 'object' || input === null) {
      throw new Error('models:addModel 参数非法');
    }
    const { id, name, contextWindow, api, capability, inputUsdPerM, outputUsdPerM, cacheReadUsdPerM, cacheWriteUsdPerM } =
      input as Record<string, unknown>;
    if (typeof id !== 'string') throw new Error('models:addModel 需要模型 id');
    const price = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    return models.addModel(providerId, {
      id,
      name: typeof name === 'string' ? name : undefined,
      contextWindow: typeof contextWindow === 'number' ? contextWindow : undefined,
      api: typeof api === 'string' ? api : undefined,
      capability:
        capability === 'image' ||
        capability === 'classifier' ||
        capability === 'asr' ||
        capability === 'tts' ||
        capability === 'chat'
          ? capability
          : undefined,
      inputUsdPerM: price(inputUsdPerM),
      outputUsdPerM: price(outputUsdPerM),
      cacheReadUsdPerM: price(cacheReadUsdPerM),
      cacheWriteUsdPerM: price(cacheWriteUsdPerM),
    });
  });
  ipcMain.handle(IPC.models.supportsOauth, (_event, providerId: unknown) => {
    if (typeof providerId !== 'string') throw new Error('models:supportsOauth 参数非法');
    return models.supportsOauth(providerId);
  });
  ipcMain.handle(IPC.models.refreshModels, (_event, providerId: unknown) => {
    if (typeof providerId !== 'string') throw new Error('models:refreshModels 参数非法');
    return models.refreshModels(providerId);
  });
  ipcMain.handle(IPC.models.getDefaults, () => models.getDefaults());
  ipcMain.handle(IPC.models.setDefault, (_event, role: unknown, ref: unknown) => {
    if (role !== 'llm' && role !== 'image' && role !== 'asr' && role !== 'tts') {
      throw new Error('models:setDefault role 非法');
    }
    if (ref !== null && !isModelRef(ref)) throw new Error('models:setDefault ref 非法');
    return models.setDefault(role, ref);
  });
  ipcMain.handle(IPC.models.importFromPi, () => models.importFromPi());
  ipcMain.handle(IPC.models.getCompaction, () => models.getCompaction());
  ipcMain.handle(IPC.models.setModels, (_event, providerId: unknown, modelList: unknown) => {
    if (typeof providerId !== 'string' || !Array.isArray(modelList)) {
      throw new Error('models:setModels 参数非法');
    }
    return models.setModels(providerId, modelList as ModelOption[]);
  });

  ipcMain.handle(
    IPC.models.setModelPricing,
    (_event, providerId: unknown, modelId: unknown, price: unknown) => {
      const rates = (price ?? {}) as Record<string, unknown>;
      if (
        typeof providerId !== 'string' ||
        typeof modelId !== 'string' ||
        typeof rates.input !== 'number' ||
        typeof rates.output !== 'number' ||
        typeof rates.cacheRead !== 'number' ||
        typeof rates.cacheWrite !== 'number'
      ) {
        throw new Error('models:setModelPricing 参数非法');
      }
      return models.setModelPricing(providerId, modelId, {
        input: rates.input,
        output: rates.output,
        cacheRead: rates.cacheRead,
        cacheWrite: rates.cacheWrite,
      });
    },
  );

  ipcMain.handle(IPC.speech.transcribe, (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('speech:transcribe 参数非法');
    const raw = input as Record<string, unknown>;
    const audio = toBytes(raw.audio);
    if (!audio || audio.byteLength === 0) throw new Error('speech:transcribe 需要音频数据');
    if (typeof raw.mimeType !== 'string' || raw.mimeType.length === 0) {
      throw new Error('speech:transcribe 需要 mimeType');
    }
    if (raw.modelId !== undefined && typeof raw.modelId !== 'string') {
      throw new Error('speech:transcribe modelId 非法');
    }
    const language =
      raw.language === 'auto' || raw.language === 'zh' || raw.language === 'en' ? raw.language : undefined;

    return speech.transcribe({
      audio,
      mimeType: raw.mimeType,
      language,
      modelId: raw.modelId as string | undefined,
    });
  });

  ipcMain.handle(IPC.speech.synthesize, (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('speech:synthesize 参数非法');
    const raw = input as Record<string, unknown>;
    if (typeof raw.text !== 'string' || raw.text.trim().length === 0) {
      throw new Error('speech:synthesize 需要文本');
    }
    if (raw.voice !== undefined && typeof raw.voice !== 'string') {
      throw new Error('speech:synthesize voice 非法');
    }
    if (raw.modelId !== undefined && typeof raw.modelId !== 'string') {
      throw new Error('speech:synthesize modelId 非法');
    }
    const format = raw.format === 'wav' || raw.format === 'mp3' ? raw.format : undefined;

    return speech.synthesize({
      text: raw.text,
      voice: raw.voice as string | undefined,
      format,
      modelId: raw.modelId as string | undefined,
    });
  });

  ipcMain.handle(IPC.org.list, () => org.list());
  ipcMain.handle(IPC.org.stack, (_event, employeeId: unknown) => {
    if (typeof employeeId !== 'string' || !employeeId) throw new Error('org:stack 参数非法');
    return work.stack(employeeId);
  });
  ipcMain.handle(IPC.org.setStack, async (_event, employeeId: unknown, input: unknown) => {
    if (typeof employeeId !== 'string' || !employeeId) throw new Error('org:setStack 参数非法');
    if (typeof input !== 'object' || input === null) throw new Error('org:setStack 参数非法');
    const view = await work.setStack(employeeId, input as EmployeeStackInput);
    refreshOrg();
    return view;
  });
  ipcMain.handle(IPC.org.setPersona, (_event, employeeId: unknown, persona: unknown) => {
    if (typeof employeeId !== 'string' || !employeeId) throw new Error('org:setPersona 参数非法');
    if (typeof persona !== 'string') throw new Error('org:setPersona 参数非法');
    if (persona.length > 8000) throw new Error('岗位职责过长（最多 8000 字）');
    org.setPersona(employeeId, persona);
    return refreshOrg();
  });
  ipcMain.handle(IPC.capabilities.list, () => work.capabilities());
  ipcMain.handle(IPC.memory.consolidationRuns, (_event, employeeId: unknown) =>
    consolidationRuns.list(20, typeof employeeId === 'string' ? employeeId : undefined),
  );
  ipcMain.handle(IPC.projects.list, () => projects.list());
  ipcMain.handle(IPC.projects.create, (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('projects:create 参数非法');
    const { name, code, description, departmentId } = input as Record<string, unknown>;
    if (typeof name !== 'string') throw new Error('projects:create 需要 name');
    projects.create({
      name,
      code: typeof code === 'string' ? code : undefined,
      description: typeof description === 'string' ? description : undefined,
      departmentId: typeof departmentId === 'string' ? departmentId : undefined,
    });
    return projects.list();
  });
  ipcMain.handle(IPC.projects.assign, (_event, projectId: unknown, employeeId: unknown, role: unknown) => {
    if (typeof projectId !== 'string' || typeof employeeId !== 'string') {
      throw new Error('projects:assign 参数非法');
    }
    projects.assign(projectId, employeeId, typeof role === 'string' ? role : '');
    return projects.list();
  });
  ipcMain.handle(IPC.projects.removeMember, (_event, projectId: unknown, employeeId: unknown) => {
    if (typeof projectId !== 'string' || typeof employeeId !== 'string') {
      throw new Error('projects:removeMember 参数非法');
    }
    projects.removeMember(projectId, employeeId);
    return projects.list();
  });
  ipcMain.handle(IPC.projects.setReportsTo, (_event, projectId: unknown, employeeId: unknown, managerId: unknown) => {
    if (typeof projectId !== 'string' || typeof employeeId !== 'string') {
      throw new Error('projects:setReportsTo 参数非法');
    }
    if (managerId !== null && typeof managerId !== 'string') {
      throw new Error('projects:setReportsTo 参数非法');
    }
    projects.setReportsTo(projectId, employeeId, managerId);
    return projects.list();
  });
  ipcMain.handle(IPC.projects.archive, (_event, projectId: unknown) => {
    if (typeof projectId !== 'string') throw new Error('projects:archive 参数非法');
    projects.archive(projectId);
    return projects.list();
  });

  ipcMain.handle(IPC.facts.list, (_event, filter: unknown) => {
    const parsed = (typeof filter === 'object' && filter !== null ? filter : {}) as {
      employeeId?: unknown;
      departmentId?: unknown;
      projectId?: unknown;
    };
    if (typeof parsed.departmentId === 'string' && parsed.departmentId) {
      return facts.current([{ type: 'department' as const, id: parsed.departmentId }], 50);
    }
    if (typeof parsed.projectId === 'string' && parsed.projectId) {
      return facts.current([{ type: 'project' as const, id: parsed.projectId }], 50);
    }
    const member =
      typeof parsed.employeeId === 'string'
        ? org.list().flatMap((department) => department.members).find((entry) => entry.id === parsed.employeeId)
        : undefined;
    const scopes = [
      { type: 'org' as const },
      ...(member?.departmentId ? [{ type: 'department' as const, id: member.departmentId }] : []),
    ];
    return facts.current(scopes, 50);
  });
  ipcMain.handle(IPC.facts.write, (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('facts:write 参数非法');
    const { scopeType, scopeId, subject, object, statement } = input as Record<string, unknown>;
    if (typeof subject !== 'string' || typeof object !== 'string' || typeof scopeType !== 'string') {
      throw new Error('facts:write 需要 scopeType / subject / object');
    }
    const written = facts.write({
      scopeType: scopeType as 'org' | 'department' | 'project',
      scopeId: typeof scopeId === 'string' ? scopeId : undefined,
      subject,
      object,
      statement: typeof statement === 'string' ? statement : undefined,
    });
    return facts.current(
      written.scopeType === 'org'
        ? [{ type: 'org' as const }]
        : [{ type: written.scopeType, id: written.scopeId }],
      50,
    );
  });

  ipcMain.handle(IPC.org.unplaced, () => org.unplaced());
  ipcMain.handle(IPC.market.candidates, () => market.list());
  ipcMain.handle(IPC.market.importPackage, async () => {
    const picked = await dialog.showOpenDialog({
      title: '导入本地 Agent 包',
      filters: [{ name: 'Agent 包', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || picked.filePaths.length === 0) return market.list();
    return market.importFile(picked.filePaths[0]!);
  });
  ipcMain.handle(IPC.market.removeCandidate, (_event, candidateId: unknown) => {
    if (typeof candidateId !== 'string') throw new Error('market:remove 参数非法');
    market.remove(candidateId);
    return market.list();
  });
  ipcMain.handle(IPC.market.hireCandidate, (_event, candidateId: unknown, input: unknown) => {
    if (typeof candidateId !== 'string' || typeof input !== 'object' || input === null) {
      throw new Error('market:hire 参数非法');
    }
    const { departmentId, reportsToEmployeeId, isHead, jobId } = input as {
      departmentId?: unknown;
      reportsToEmployeeId?: unknown;
      isHead?: unknown;
      jobId?: unknown;
    };
    if (typeof departmentId !== 'string') throw new Error('market:hire 需要 departmentId');
    const { employeeId } = market.hire(candidateId, {
      departmentId,
      reportsToEmployeeId: typeof reportsToEmployeeId === 'string' ? reportsToEmployeeId : undefined,
      isHead: isHead === true,
      jobId: typeof jobId === 'string' && jobId ? jobId : undefined,
    });
    // The new employee must appear in the IM side too, not only in the org chart.
    refreshOrg();
    return { candidates: market.list(), employeeId };
  });

  ipcMain.handle(IPC.market.interviews, (_event, candidateId: unknown) =>
    market.interviews(typeof candidateId === 'string' && candidateId ? candidateId : undefined),
  );
  ipcMain.handle(IPC.market.createInterview, (_event, candidateId: unknown, taskPrompt: unknown) => {
    if (typeof candidateId !== 'string' || typeof taskPrompt !== 'string') {
      throw new Error('market:createInterview 参数非法');
    }
    market.createInterview(candidateId, taskPrompt);
    return market.interviews(candidateId);
  });
  ipcMain.handle(IPC.market.runInterview, async (_event, interviewId: unknown) => {
    if (typeof interviewId !== 'string') throw new Error('market:runInterview 参数非法');
    const interview = await market.runInterview(interviewId);
    return market.interviews(interview.candidateId);
  });
  ipcMain.handle(IPC.market.decideInterview, (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('market:decideInterview 参数非法');
    const draft = input as Record<string, unknown>;
    if (typeof draft.interviewId !== 'string') throw new Error('market:decideInterview 需要 interviewId');
    if (draft.decision !== 'hire' && draft.decision !== 'reject') {
      throw new Error('market:decideInterview 需要 decision（hire / reject）');
    }
    const result = market.decideInterview({
      interviewId: draft.interviewId,
      decision: draft.decision,
      departmentId: typeof draft.departmentId === 'string' ? draft.departmentId : undefined,
      reportsToEmployeeId:
        typeof draft.reportsToEmployeeId === 'string' ? draft.reportsToEmployeeId : undefined,
      jobId: typeof draft.jobId === 'string' && draft.jobId ? draft.jobId : undefined,
    });
    if (result.employeeId) refreshOrg();
    return {
      interviews: market.interviews(result.interview.candidateId),
      candidates: market.list(),
      ...(result.employeeId ? { employeeId: result.employeeId } : {}),
    };
  });

  ipcMain.handle(IPC.market.packages, () => market.packages());
  ipcMain.handle(IPC.market.exportPackage, async (event, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('market:exportPackage 参数非法');
    const draft = input as Record<string, unknown>;
    const kind = draft.kind;
    if (kind !== 'employee' && kind !== 'team' && kind !== 'company') {
      throw new Error('market:exportPackage 需要 kind（employee / team / company）');
    }
    if (typeof draft.name !== 'string' || !draft.name.trim()) {
      throw new Error('market:exportPackage 需要 name');
    }
    const employeeIds = Array.isArray(draft.employeeIds)
      ? draft.employeeIds.filter((id): id is string => typeof id === 'string')
      : undefined;

    const window = BrowserWindow.fromWebContents(event.sender);
    const picked = await dialog.showSaveDialog(window ?? undefined!, {
      title: '导出员工包',
      defaultPath: `${draft.name.trim().replace(/[\\/:*?"<>|]/g, '-')}.json`,
      filters: [{ name: 'Agent 包', extensions: ['json'] }],
    });
    if (picked.canceled || !picked.filePath) {
      return { packages: market.packages(), cancelled: true };
    }

    await market.exportPackage({
      kind,
      name: draft.name.trim(),
      description: typeof draft.description === 'string' ? draft.description : undefined,
      license: typeof draft.license === 'string' ? draft.license : undefined,
      employeeIds,
      filePath: picked.filePath,
    });
    return { packages: market.packages(), path: picked.filePath };
  });
  ipcMain.handle(IPC.market.verifyPackage, (_event, packageId: unknown) => {
    if (typeof packageId !== 'string') throw new Error('market:verifyPackage 参数非法');
    return market.verifyPackage(packageId);
  });
  ipcMain.handle(IPC.org.place, (_event, employeeId: unknown, departmentId: unknown) => {
    if (typeof employeeId !== 'string' || typeof departmentId !== 'string') {
      throw new Error('org:place 参数非法');
    }
    org.place(employeeId, departmentId);
    return refreshOrg();
  });

  ipcMain.handle(IPC.org.setAvatar, (_event, employeeId: unknown, dataUrl: unknown) => {
    if (typeof employeeId !== 'string' || typeof dataUrl !== 'string') {
      throw new Error('org:setAvatar 参数非法');
    }
    // A portrait is a resized data URL; anything larger is not what this channel is for.
    if (dataUrl.length > 700_000) throw new Error('头像过大（请使用 128px 图片）');
    org.setAvatar(employeeId, dataUrl);
    return refreshOrg();
  });
  ipcMain.handle(IPC.org.personnel, (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('org:personnel 参数非法');
    org.personnel(input as PersonnelInput);
    return refreshOrg();
  });

  ipcMain.handle(IPC.org.createDepartment, (_event, input: unknown) => {
    const draft = (input ?? {}) as {
      name?: unknown;
      code?: unknown;
      description?: unknown;
      parentId?: unknown;
      headEmployeeId?: unknown;
    };
    if (typeof draft.name !== 'string' || draft.name.trim().length === 0) {
      throw new Error('org:createDepartment 参数非法');
    }
    org.createDepartment({
      name: draft.name.trim(),
      code: typeof draft.code === 'string' ? draft.code : undefined,
      description: typeof draft.description === 'string' ? draft.description : undefined,
      parentId: typeof draft.parentId === 'string' && draft.parentId ? draft.parentId : undefined,
      headEmployeeId:
        typeof draft.headEmployeeId === 'string' && draft.headEmployeeId ? draft.headEmployeeId : undefined,
    });
    return refreshOrg();
  });
  ipcMain.handle(IPC.org.updateDepartment, (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('org:updateDepartment 参数非法');
    const draft = input as Record<string, unknown>;
    if (typeof draft.id !== 'string' || !draft.id) throw new Error('org:updateDepartment 需要 id');
    org.updateDepartment({
      id: draft.id,
      name: typeof draft.name === 'string' ? draft.name : undefined,
      code: typeof draft.code === 'string' ? draft.code : undefined,
      description: typeof draft.description === 'string' ? draft.description : undefined,
      // `null` is meaningful here (move to the top level), so it is not folded into
      // `undefined` the way an absent field is.
      parentId:
        draft.parentId === null
          ? null
          : typeof draft.parentId === 'string'
            ? draft.parentId
            : undefined,
      sortOrder: typeof draft.sortOrder === 'number' ? draft.sortOrder : undefined,
    });
    return refreshOrg();
  });
  ipcMain.handle(IPC.org.archiveDepartment, (_event, departmentId: unknown) => {
    if (typeof departmentId !== 'string') throw new Error('org:archiveDepartment 参数非法');
    org.archiveDepartment(departmentId);
    return refreshOrg();
  });
  ipcMain.handle(IPC.org.appointHead, (_event, departmentId: unknown, employeeId: unknown) => {
    if (typeof departmentId !== 'string') throw new Error('org:appointHead 参数非法');
    if (employeeId !== null && typeof employeeId !== 'string') throw new Error('org:appointHead 参数非法');
    org.appointHead(departmentId, employeeId);
    return refreshOrg();
  });
  ipcMain.handle(IPC.org.appointActingHead, (_event, departmentId: unknown, employeeId: unknown) => {
    if (typeof departmentId !== 'string') throw new Error('org:appointActingHead 参数非法');
    if (employeeId !== null && typeof employeeId !== 'string') throw new Error('org:appointActingHead 参数非法');
    org.appointActingHead(departmentId, employeeId);
    return refreshOrg();
  });
  ipcMain.handle(IPC.org.evaluations, (_event, employeeId: unknown, limit: unknown) => {
    if (typeof employeeId !== 'string') throw new Error('org:evaluations 参数非法');
    return org.evaluations(employeeId, typeof limit === 'number' ? limit : undefined);
  });
  ipcMain.handle(IPC.org.addEvaluation, (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('org:addEvaluation 参数非法');
    const draft = input as Record<string, unknown>;
    if (typeof draft.employeeId !== 'string' || typeof draft.scoreOverall !== 'number') {
      throw new Error('org:addEvaluation 需要 employeeId / scoreOverall');
    }
    const kind = draft.kind;
    org.addEvaluation({
      employeeId: draft.employeeId,
      kind:
        kind === 'probation' || kind === 'periodic' || kind === 'project' || kind === 'exit'
          ? kind
          : undefined,
      periodKey: typeof draft.periodKey === 'string' ? draft.periodKey : undefined,
      scoreOverall: draft.scoreOverall,
      scoreQuality: typeof draft.scoreQuality === 'number' ? draft.scoreQuality : undefined,
      scoreSpeed: typeof draft.scoreSpeed === 'number' ? draft.scoreSpeed : undefined,
      scoreCost: typeof draft.scoreCost === 'number' ? draft.scoreCost : undefined,
      summary: typeof draft.summary === 'string' ? draft.summary : undefined,
      reviewer: typeof draft.reviewer === 'string' ? draft.reviewer : undefined,
    });
    return org.evaluations(draft.employeeId);
  });
  ipcMain.handle(IPC.org.jobs, (_event, departmentId: unknown) =>
    org.jobs(typeof departmentId === 'string' && departmentId ? departmentId : undefined),
  );
  ipcMain.handle(IPC.org.createJob, (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('org:createJob 参数非法');
    const draft = input as Record<string, unknown>;
    if (typeof draft.title !== 'string') throw new Error('org:createJob 需要 title');
    org.createJob({
      title: draft.title,
      level: typeof draft.level === 'string' ? draft.level : undefined,
      description: typeof draft.description === 'string' ? draft.description : undefined,
      skills: readSkills(draft.skills),
      model: typeof draft.model === 'string' ? draft.model : undefined,
      modelRef: readModelRef(draft.modelRef) ?? null,
    });
    return org.jobs();
  });
  ipcMain.handle(IPC.org.updateJob, (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('org:updateJob 参数非法');
    const draft = input as Record<string, unknown>;
    if (typeof draft.id !== 'string' || !draft.id) throw new Error('org:updateJob 需要 id');
    org.updateJob({
      id: draft.id,
      title: typeof draft.title === 'string' ? draft.title : undefined,
      level: typeof draft.level === 'string' ? draft.level : undefined,
      description: typeof draft.description === 'string' ? draft.description : undefined,
      skills: readSkills(draft.skills),
      model: typeof draft.model === 'string' ? draft.model : undefined,
      // Tri-state: absent keeps the current default, `null` clears it.
      modelRef: draft.modelRef === undefined ? undefined : (readModelRef(draft.modelRef) ?? null),
    });
    return org.jobs();
  });
  ipcMain.handle(IPC.org.archiveJob, (_event, jobId: unknown) => {
    if (typeof jobId !== 'string') throw new Error('org:archiveJob 参数非法');
    org.archiveJob(jobId);
    return org.jobs();
  });
  ipcMain.handle(IPC.org.setJobSeat, (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('org:setJobSeat 参数非法');
    const draft = input as Record<string, unknown>;
    if (
      typeof draft.jobId !== 'string' ||
      typeof draft.departmentId !== 'string' ||
      typeof draft.headcount !== 'number'
    ) {
      throw new Error('org:setJobSeat 需要 jobId / departmentId / headcount');
    }
    org.setJobSeat({
      jobId: draft.jobId,
      departmentId: draft.departmentId,
      headcount: draft.headcount,
    });
    return org.jobs();
  });
  ipcMain.handle(IPC.org.syncJob, (_event, jobId: unknown) => {
    if (typeof jobId !== 'string') throw new Error('org:syncJob 参数非法');
    return org.syncJob(jobId);
  });
  ipcMain.handle(IPC.org.events, (_event, employeeId: unknown, limit: unknown) => {
    if (typeof employeeId !== 'string') throw new Error('org:events 参数非法');
    return org.events(employeeId, typeof limit === 'number' ? limit : undefined);
  });
  ipcMain.handle(IPC.org.hire, (_event, input: unknown) => {
    const draft = (input ?? {}) as Record<string, unknown>;
    if (typeof draft.name !== 'string' || typeof draft.departmentId !== 'string') {
      throw new Error('org:hire 参数非法');
    }
    org.hire({
      name: draft.name,
      // A job's title is the role now; the renderer only sends one when it hired
      // into a department with no job catalogue.
      role: typeof draft.role === 'string' ? draft.role : '',
      level: typeof draft.level === 'string' ? draft.level : undefined,
      departmentId: draft.departmentId,
      title: typeof draft.title === 'string' ? draft.title : undefined,
      reportsToEmployeeId:
        typeof draft.reportsToEmployeeId === 'string' ? draft.reportsToEmployeeId : undefined,
      isHead: draft.isHead === true,
      model: typeof draft.model === 'string' ? draft.model : undefined,
      modelRef: readModelRef(draft.modelRef),
      skills: Array.isArray(draft.skills) ? draft.skills.filter((s): s is string => typeof s === 'string') : undefined,
      persona: typeof draft.persona === 'string' ? draft.persona : undefined,
      jobId: typeof draft.jobId === 'string' && draft.jobId ? draft.jobId : undefined,
      probationDays: typeof draft.probationDays === 'number' ? draft.probationDays : undefined,
    });
    return refreshOrg();
  });
  ipcMain.handle(IPC.org.transfer, (_event, employeeId: unknown, departmentId: unknown, reportsTo: unknown, jobId: unknown) => {
    if (typeof employeeId !== 'string' || typeof departmentId !== 'string') {
      throw new Error('org:transfer 参数非法');
    }
    org.transfer(
      employeeId,
      departmentId,
      typeof reportsTo === 'string' ? reportsTo : undefined,
      typeof jobId === 'string' ? jobId : undefined,
    );
    return refreshOrg();
  });
  ipcMain.handle(IPC.org.fire, (_event, employeeId: unknown) => {
    if (typeof employeeId !== 'string') throw new Error('org:fire 参数非法');
    org.fire(employeeId);
    return refreshOrg();
  });

  ipcMain.handle(IPC.artifacts.read, (_event, taskId: unknown, relPath: unknown) => {
    if (typeof taskId !== 'string' || typeof relPath !== 'string') {
      throw new Error('artifacts:read 参数非法');
    }
    const task = work.getTask(taskId);
    if (!task) return { ok: false, error: '未知任务' };
    return readImageArtifact(workspaceRoot, task.workspaceRelPath, relPath);
  });

  ipcMain.handle(IPC.artifacts.saveAs, async (event, taskId: unknown, relPath: unknown) => {
    if (typeof taskId !== 'string' || typeof relPath !== 'string') {
      throw new Error('artifacts:saveAs 参数非法');
    }
    const task = work.getTask(taskId);
    if (!task) return { ok: false, error: '未知任务' };

    const read = readImageArtifact(workspaceRoot, task.workspaceRelPath, relPath);
    if (!read.ok) return { ok: false, error: read.error };

    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(window ?? undefined!, {
      defaultPath: path.basename(relPath),
    });
    if (result.canceled || !result.filePath) return { ok: false, error: '已取消' };

    const source = path.resolve(workspaceRoot, task.workspaceRelPath, relPath);
    fs.copyFileSync(source, result.filePath);
    return { ok: true, path: result.filePath };
  });

  ipcMain.handle(IPC.auth.answer, (_event, promptId: unknown, value: unknown) => {
    if (typeof promptId !== 'string') throw new Error('auth:answer 参数非法');
    const resolve = pending.get(promptId);
    if (!resolve) return;
    pending.delete(promptId);
    resolve(typeof value === 'string' ? value : null);
  });

  ipcMain.handle(IPC.auth.login, (_event, providerId: unknown, type: unknown) => {
    if (typeof providerId !== 'string' || (type !== 'oauth' && type !== 'apiKey')) {
      throw new Error('auth:login 参数非法');
    }
    return auth.login(providerId, type === 'oauth' ? 'oauth' : 'api_key', authBridge);
  });

  ipcMain.handle(IPC.auth.logout, (_event, providerId: unknown) => {
    if (typeof providerId !== 'string') throw new Error('auth:logout 参数非法');
    return auth.logout(providerId);
  });

  ipcMain.handle(IPC.auth.status, () => auth.status());

  ipcMain.handle(IPC.models.getThinking, () => models.getThinking());
  ipcMain.handle(IPC.models.applyBuiltinPricing, (_event, providerId: unknown) => {
    if (typeof providerId !== 'string') throw new Error('models:applyBuiltinPricing 参数非法');
    return models.applyBuiltinPricing(providerId);
  });

  ipcMain.handle(IPC.models.setThinking, (_event, level: unknown) => {
    if (typeof level !== 'string') throw new Error('models:setThinking 参数非法');
    return models.setThinking(level);
  });

  ipcMain.handle(IPC.models.setCompaction, (_event, next: unknown) => {
    if (!isCompaction(next)) throw new Error('models:setCompaction 参数非法');
    return models.setCompaction(next);
  });
  ipcMain.handle(
    IPC.models.setModelContext,
    (_event, providerId: unknown, modelId: unknown, contextWindow: unknown) => {
      if (typeof providerId !== 'string' || typeof modelId !== 'string' || typeof contextWindow !== 'number') {
        throw new Error('models:setModelContext 参数非法');
      }
      return models.setModelContext(providerId, modelId, contextWindow);
    },
  );

  ipcMain.handle(IPC.work.setIssueMeta, (_event, taskId: unknown, patch: unknown) => {
    if (typeof taskId !== 'string' || typeof patch !== 'object' || patch === null) {
      throw new Error('work:setIssueMeta 参数非法');
    }
    const { priority, labels, dueAt } = patch as Record<string, unknown>;
    return work.setIssueMeta(taskId, {
      priority:
        typeof priority === 'string' && ['P0', 'P1', 'P2', 'P3'].includes(priority)
          ? (priority as 'P0' | 'P1' | 'P2' | 'P3')
          : undefined,
      labels: Array.isArray(labels) ? labels.filter((label): label is string => typeof label === 'string') : undefined,
      dueAt: dueAt === null ? null : typeof dueAt === 'number' ? dueAt : undefined,
    });
  });
  ipcMain.handle(IPC.work.linkTasks, (_event, fromId: unknown, toId: unknown, type: unknown) => {
    if (typeof fromId !== 'string' || typeof toId !== 'string') {
      throw new Error('work:linkTasks 参数非法');
    }
    const kind = type === 'duplicates' || type === 'relates' ? type : 'blocks';
    // An empty fromId unlinks — one channel, no separate delete verb to get wrong.
    return fromId === ''
      ? work.unlinkTasks('', toId, kind)
      : work.linkTasks(fromId, toId, kind);
  });
  ipcMain.handle(IPC.work.listTasks, (_event, limit: unknown) =>
    work.listTasks(typeof limit === 'number' ? limit : undefined),
  );
  ipcMain.handle(IPC.work.bossDecision, (_event, taskId: unknown, decision: unknown, reason: unknown) => {
    if (typeof taskId !== 'string' || (decision !== 'approve' && decision !== 'reject')) {
      throw new Error('work:bossDecision 参数非法');
    }
    return work.bossDecision(taskId, decision, typeof reason === 'string' ? reason : undefined);
  });
  ipcMain.handle(IPC.work.listBudgets, () => work.listBudgets());
  ipcMain.handle(IPC.work.subtasks, (_event, taskId: unknown) => {
    if (typeof taskId !== 'string') throw new Error('work:subtasks 参数非法');
    return work.listSubtasks(taskId);
  });

  ipcMain.handle(IPC.work.createTask, (_event, input: unknown) => {
    if (!isCreateTaskInput(input)) throw new Error('work:createTask 参数非法');
    return work.createTask(input);
  });

  ipcMain.handle(IPC.work.runTask, (_event, taskId: unknown) => {
    if (typeof taskId !== 'string') throw new Error('work:runTask 参数非法');
    work.runTask(taskId);
  });

  return () => {
    for (const channel of Object.values(IPC.models)) ipcMain.removeHandler(channel);
    for (const channel of Object.values(IPC.runtime)) ipcMain.removeHandler(channel);
    unsubscribeBudgets();
    unsubscribeWork();
    unsubscribeComm();
    if (commSignal) clearTimeout(commSignal);
    ipcMain.removeHandler(IPC.budget.overview);
    ipcMain.removeHandler(IPC.budget.setLimit);
    ipcMain.removeHandler(IPC.comm.overview);
    ipcMain.removeHandler(IPC.comm.wake);
    ipcMain.removeHandler(IPC.comm.dismissGuards);
    ipcMain.removeHandler(IPC.work.listBudgets);
    unsubscribe();
    ipcMain.removeHandler(IPC.work.listTasks);
    ipcMain.removeHandler(IPC.work.setIssueMeta);
    ipcMain.removeHandler(IPC.work.linkTasks);
    ipcMain.removeHandler(IPC.work.bossDecision);
    ipcMain.removeHandler(IPC.work.createTask);
    ipcMain.removeHandler(IPC.work.runTask);
    ipcMain.removeHandler(IPC.app.getInfo);
    ipcMain.removeHandler(IPC.company.get);
    ipcMain.removeHandler(IPC.company.update);
    ipcMain.removeHandler(IPC.diagnostics.report);
    ipcMain.removeHandler(IPC.chat.getSnapshot);
    ipcMain.removeHandler(IPC.chat.sendMessage);
    ipcMain.removeHandler(IPC.chat.markRead);
    ipcMain.removeHandler(IPC.chat.openDirect);
    ipcMain.removeHandler(IPC.chat.archive);
    ipcMain.removeHandler(IPC.chat.restore);
    ipcMain.removeHandler(IPC.chat.ensureDepartmentGroup);
    ipcMain.removeHandler(IPC.chat.updateAgentBrief);
  };
}

function isCompanyPatch(value: unknown): value is CompanyProfilePatch {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const fields = ['name', 'industry', 'vision', 'colorId', 'bossName', 'logo', 'bossAvatar'] as const;
  // Every present field must be a string; `undefined` means "leave as is".
  return fields.every((field) => candidate[field] === undefined || typeof candidate[field] === 'string');
}

function isCompaction(value: unknown): value is CompactionSettings {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.enabled === 'boolean' &&
    typeof candidate.reserveTokens === 'number' &&
    typeof candidate.keepRecentTokens === 'number' &&
    typeof candidate.backgroundTokens === 'number'
  );
}

function isProviderDraft(value: unknown): value is ProviderDraft {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.baseUrl === 'string' &&
    typeof candidate.api === 'string' &&
    typeof candidate.isCustom === 'boolean' &&
    (candidate.icon === undefined || typeof candidate.icon === 'string') &&
    (candidate.apiKey === undefined || typeof candidate.apiKey === 'string')
  );
}

function isModelRef(value: unknown): value is ModelRef {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.providerId === 'string' && typeof candidate.modelId === 'string';
}

/** Optional ref from the renderer: absent/invalid means "inherit the default". */
function readModelRef(value: unknown): ModelRef | undefined {
  return isModelRef(value) && value.providerId && value.modelId ? value : undefined;
}

/** Skill tags from the renderer: strings only, trimmed, empties dropped. */
function readSkills(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isCreateTaskInput(value: unknown): value is CreateTaskInput {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.title === 'string' &&
    typeof candidate.brief === 'string' &&
    typeof candidate.deliverableSpec === 'string' &&
    typeof candidate.assigneeId === 'string' &&
    typeof candidate.estTokens === 'number' &&
    Array.isArray(candidate.acceptanceCommand) &&
    candidate.acceptanceCommand.every((part) => typeof part === 'string') &&
    (candidate.acceptanceTemplate === undefined ||
      candidate.acceptanceTemplate === 'http-ok' ||
      candidate.acceptanceTemplate === 'image-200')
  );
}

function isSendMessageInput(value: unknown): value is SendMessageInput {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.conversationId === 'string' &&
    typeof candidate.text === 'string' &&
    (candidate.mentionIds === undefined ||
      (Array.isArray(candidate.mentionIds) &&
        candidate.mentionIds.every((id) => typeof id === 'string')))
  );
}

function isRuntimeProfileDraft(value: unknown): value is RuntimeProfileDraft {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isRuntimeKind(candidate.kind) &&
    typeof candidate.name === 'string' &&
    typeof candidate.binary === 'string'
  );
}
