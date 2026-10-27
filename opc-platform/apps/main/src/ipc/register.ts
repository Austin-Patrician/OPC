import { IPC, type SendMessageInput } from '@opc/shared/ipc';
import type {
  CompactionSettings,
  CreateTaskInput,
  ModelOption,
  ModelRef,
  ProviderDraft,
} from '@opc/shared/domain';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getAppInfo } from '../appInfo';
import type { ChatService } from '../chat/chatService';
import type { CommService } from '../comm/commService';
import type { ManualWakeResult } from '../comm/scheduler';
import { buildCommOverview } from '../comm/commOverview';
import { runDiagnostics } from '../diagnostics/report';
import type { PersonnelInput } from '@opc/shared/domain';
import type { MarketService } from '../market/marketService';
import type { OrgFactService } from '../memory/orgFactService';
import type { ConsolidationRunStore } from '../memory/consolidationRun';
import type { ProjectService } from '../org/projectService';
import type { AuthService } from '../models/authService';
import type { OrgService } from '../org/orgService';
import { readImageArtifact } from '../work/artifacts';
import type { ImageService } from '../models/imageService';
import type { ModelConfigService } from '../models/modelConfigService';
import type { WorkService } from '../work/workService';

interface RegisterOptions {
  chat: ChatService;
  work: WorkService;
  models: ModelConfigService;
  images: ImageService;
  auth: AuthService;
  /** Resolves artifact paths to the workspace root (injected by bootstrap). */
  workspaceRoot: string;
  org: OrgService;
  market: MarketService;
  facts: OrgFactService;
  projects: ProjectService;
  consolidationRuns: ConsolidationRunStore;
  comm: CommService;
  /** 老板手动唤醒：由 bootstrap 注入，因为它需要心跳调度器。 */
  wakeEmployee: (employeeId: string) => Promise<ManualWakeResult>;
}

/** Thin transport adapters: validate, delegate, broadcast. No business logic here. */
export function registerIpc({
  chat,
  work,
  models,
  images,
  auth,
  workspaceRoot,
  org,
  market,
  facts,
  projects,
  consolidationRuns,
  comm,
  wakeEmployee,
}: RegisterOptions): () => void {
  // Pending interactive prompts, keyed by prompt id; answered from the renderer.
  const pending = new Map<string, (value: string | null) => void>();

  const broadcast = (channel: string, payload: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  };

  const authBridge = {
    ask: (request: { id: string; kind: string; message: string }) =>
      new Promise<string | null>((resolve) => {
        pending.set(request.id, resolve);
        broadcast(IPC.auth.promptEvent, request);
      }),
    notify: (text: string, url?: string) => broadcast(IPC.auth.notifyEvent, { text, url }),
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
  ipcMain.handle(IPC.models.test, (_event, providerId: unknown) => {
    if (typeof providerId !== 'string') throw new Error('models:test 参数非法');
    return models.test(providerId);
  });
  ipcMain.handle(IPC.models.addModel, (_event, providerId: unknown, input: unknown) => {
    if (typeof providerId !== 'string' || typeof input !== 'object' || input === null) {
      throw new Error('models:addModel 参数非法');
    }
    const { id, name, contextWindow, api } = input as Record<string, unknown>;
    if (typeof id !== 'string') throw new Error('models:addModel 需要模型 id');
    return models.addModel(providerId, {
      id,
      name: typeof name === 'string' ? name : undefined,
      contextWindow: typeof contextWindow === 'number' ? contextWindow : undefined,
      api: typeof api === 'string' ? api : undefined,
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
    if (role !== 'llm' && role !== 'image') throw new Error('models:setDefault role 非法');
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

  ipcMain.handle(IPC.org.list, () => org.list());
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
    const { departmentId, reportsToEmployeeId, isHead } = input as {
      departmentId?: unknown;
      reportsToEmployeeId?: unknown;
      isHead?: unknown;
    };
    if (typeof departmentId !== 'string') throw new Error('market:hire 需要 departmentId');
    const { employeeId } = market.hire(candidateId, {
      departmentId,
      reportsToEmployeeId: typeof reportsToEmployeeId === 'string' ? reportsToEmployeeId : undefined,
      isHead: isHead === true,
    });
    return { candidates: market.list(), employeeId };
  });
  ipcMain.handle(IPC.org.place, (_event, employeeId: unknown, departmentId: unknown) => {
    if (typeof employeeId !== 'string' || typeof departmentId !== 'string') {
      throw new Error('org:place 参数非法');
    }
    org.place(employeeId, departmentId);
    return org.list();
  });

  ipcMain.handle(IPC.org.setAvatar, (_event, employeeId: unknown, dataUrl: unknown) => {
    if (typeof employeeId !== 'string' || typeof dataUrl !== 'string') {
      throw new Error('org:setAvatar 参数非法');
    }
    // A portrait is a resized data URL; anything larger is not what this channel is for.
    if (dataUrl.length > 700_000) throw new Error('头像过大（请使用 128px 图片）');
    org.setAvatar(employeeId, dataUrl);
    return org.list();
  });
  ipcMain.handle(IPC.org.personnel, (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('org:personnel 参数非法');
    org.personnel(input as PersonnelInput);
    return org.list();
  });

  ipcMain.handle(IPC.org.createDepartment, (_event, input: unknown) => {
    const draft = (input ?? {}) as { name?: unknown; code?: unknown; description?: unknown };
    if (typeof draft.name !== 'string' || draft.name.trim().length === 0) {
      throw new Error('org:createDepartment 参数非法');
    }
    org.createDepartment({
      name: draft.name.trim(),
      code: typeof draft.code === 'string' ? draft.code : undefined,
      description: typeof draft.description === 'string' ? draft.description : undefined,
    });
    return org.list();
  });
  ipcMain.handle(IPC.org.hire, (_event, input: unknown) => {
    const draft = (input ?? {}) as Record<string, unknown>;
    if (typeof draft.name !== 'string' || typeof draft.role !== 'string' || typeof draft.departmentId !== 'string') {
      throw new Error('org:hire 参数非法');
    }
    org.hire({
      name: draft.name,
      role: draft.role,
      level: typeof draft.level === 'string' ? draft.level : undefined,
      departmentId: draft.departmentId,
      title: typeof draft.title === 'string' ? draft.title : undefined,
      reportsToEmployeeId:
        typeof draft.reportsToEmployeeId === 'string' ? draft.reportsToEmployeeId : undefined,
      isHead: draft.isHead === true,
      model: typeof draft.model === 'string' ? draft.model : undefined,
    });
    return org.list();
  });
  ipcMain.handle(IPC.org.transfer, (_event, employeeId: unknown, departmentId: unknown, reportsTo: unknown) => {
    if (typeof employeeId !== 'string' || typeof departmentId !== 'string') {
      throw new Error('org:transfer 参数非法');
    }
    org.transfer(employeeId, departmentId, typeof reportsTo === 'string' ? reportsTo : undefined);
    return org.list();
  });
  ipcMain.handle(IPC.org.fire, (_event, employeeId: unknown) => {
    if (typeof employeeId !== 'string') throw new Error('org:fire 参数非法');
    org.fire(employeeId);
    return org.list();
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

  ipcMain.handle(IPC.images.generate, (_event, input: unknown) => {
    const draft = (input ?? {}) as { prompt?: unknown; modelId?: unknown };
    if (typeof draft.prompt !== 'string') throw new Error('images:generate 参数非法');
    return images.generate({
      prompt: draft.prompt,
      modelId: typeof draft.modelId === 'string' ? draft.modelId : undefined,
    });
  });

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
    ipcMain.removeHandler(IPC.images.generate);
    unsubscribeBudgets();
    unsubscribeWork();
    unsubscribeComm();
    if (commSignal) clearTimeout(commSignal);
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
    typeof candidate.isCustom === 'boolean'
  );
}

function isModelRef(value: unknown): value is ModelRef {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.providerId === 'string' && typeof candidate.modelId === 'string';
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
