import {
  IPC,
  type SendMessageInput,
  type StandingMemoryView,
  type TriggerPatch,
  type TriggerStatus,
} from '@opc/shared/ipc';
import type {
  BundledRuntime,
  CompactionSettings,
  CompanyProfilePatch,
  CreateTaskInput,
  DecisionClassifyInput,
  ModelOption,
  ModelRef,
  ProviderDraft,
  RuntimeProfileDraft,
  BillingSettingsPatch,
  TriagePolicyPatch,
  WorkThread,
} from '@opc/shared/domain';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getAppInfo } from '../appInfo';
import type { ChatService } from '../chat/chatService';
import { runDiagnostics } from '../diagnostics/report';
import type { OcrSettings } from '@opc/shared/ocr';
import type { FactService } from '../memory/factService';
import type { TriagePolicyStore } from '../router/triagePolicy';
import type { ThreadRepository } from '../data/threadRepository';
import type { ConsolidationRunStore } from '../memory/consolidationRun';
import type { AuthService } from '../models/authService';
import type { CompanyService } from '../company/companyService';
import { readImageArtifact } from '../work/artifacts';
import type { ModelConfigService } from '../models/modelConfigService';
import type { DecisionService } from '../models/decisionService';
import type { SpeechService } from '../models/speechService';
import type { NetworkProxyService } from '../network/proxyService';
import { probeProxy } from '../network/proxyRuntime';
import { isRuntimeKind } from '../runtime/profiles';
import type { RuntimeService } from '../runtime/service';
import type { PiExtensionHost } from '../extensions/host';
import type { PiSkillHost } from '../skills/host';
import type { WorkService } from '../work/workService';
import type { BillingSettingsService } from '../work/billingSettings';

interface RegisterOptions {
  chat: ChatService;
  work: WorkService;
  models: ModelConfigService;
  speech: SpeechService;
  decisions: DecisionService;
  auth: AuthService;
  company: CompanyService;
  /** 网络代理：保存即生效，失败会作为 IPC 错误抛回设置页。 */
  network: NetworkProxyService;
  /** 全局基础运行环境（Node / Python），所有执行体共用。 */
  runtime: RuntimeService;
  /** 随应用分发的引擎（OCR）：读的是磁盘，不是偏好。 */
  bundled: { inspect: () => Promise<BundledRuntime[]> };
  /** OCR 开关与输出粒度，和 Node/Python 一样是工作台级选择。 */
  ocrSettings: { get: () => OcrSettings; set: (next: OcrSettings) => OcrSettings };
  /** 计费口径：定价策略、展示币种、手工汇率（设置 → 通用 → 计费）。 */
  billingSettings: BillingSettingsService;
  /** Resolves artifact paths to the workspace root (injected by bootstrap). */
  workspaceRoot: string;
  /** v2 核心：工作线 / 执行体 / 事件 / 汇报。 */
  threads: ThreadRepository;
  /** 你丢一个目标：开线 + 入队事件 + 立刻推一次 Router（由 bootstrap 注入）。 */
  startGoal: (goal: string) => Promise<WorkThread>;
  facts: FactService;
  consolidationRuns: ConsolidationRunStore;
  /** 两层过滤的策略（设置 → 通用 → 调度）：写进 `app_setting`，调度每轮读。 */
  triage: TriagePolicyStore;
  /** 常驻约束：每轮都在生效的那几条（读写都在服务里，这里只转发）。 */
  standing: {
    list: () => StandingMemoryView[];
    forget: (id: string) => boolean;
  };
  /** 触发源：外部平台推进来的那扇门。 */
  triggers: {
    status: () => TriggerStatus;
    set: (patch: TriggerPatch) => TriggerStatus;
  };
  /** Pi 扩展的发现、加载与开关；扫描只读文件，加载才执行代码。 */
  piExtensions: PiExtensionHost;
  /** 本机技能（SKILL.md）的发现与开关；纯文本，不需要信任。 */
  piSkills: PiSkillHost;
}

/** Thin transport adapters: validate, delegate, broadcast. No business logic here. */
export function registerIpc({
  chat,
  work,
  models,
  speech,
  decisions,
  auth,
  workspaceRoot,
  threads,
  startGoal,
  facts,
  consolidationRuns,
  company,
  network,
  runtime,
  bundled,
  ocrSettings,
  billingSettings,
  piExtensions,
  piSkills,
  triage,
  triggers,
  standing,
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

  ipcMain.handle(IPC.billing.get, () => billingSettings.get());
  ipcMain.handle(IPC.billing.update, (_event, input: unknown) => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('billing:update 参数非法');
    }
    const draft = input as Record<string, unknown>;
    const allowed = new Set(['pricingMode', 'displayCurrency', 'usdCnyRate']);
    for (const key of Object.keys(draft)) {
      if (!allowed.has(key)) throw new Error(`billing:update 未知字段 ${key}`);
    }
    // The service validates values (mode/currency whitelists, rate range); this
    // layer only rejects shapes that are not a patch at all.
    const stored = billingSettings.update(draft as BillingSettingsPatch);
    broadcast(IPC.billing.changedEvent, stored);
    return stored;
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

  ipcMain.handle(IPC.chat.ensureAssistant, () => chat.ensureAssistant());
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
    if (role !== 'llm' && role !== 'image' && role !== 'asr' && role !== 'tts' && role !== 'decision') {
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

  ipcMain.handle(IPC.decisions.classify, (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('decisions:classify 参数非法');
    const raw = input as Record<string, unknown>;
    if (typeof raw.state !== 'string') throw new Error('decisions:classify 需要 state');
    if (typeof raw.questions !== 'object' || raw.questions === null || Array.isArray(raw.questions)) {
      throw new Error('decisions:classify 需要 questions');
    }
    if (raw.modelId !== undefined && typeof raw.modelId !== 'string') {
      throw new Error('decisions:classify modelId 非法');
    }

    return decisions.classify({
      state: raw.state,
      questions: raw.questions as DecisionClassifyInput['questions'],
      modelId: raw.modelId as string | undefined,
    });
  });

  ipcMain.handle(IPC.workers.list, () => threads.listAllWorkers());
  ipcMain.handle(IPC.capabilities.list, () => work.capabilities());
  ipcMain.handle(IPC.extensions.list, () => piExtensions.list());
  ipcMain.handle(
    IPC.extensions.setEnabled,
    async (_event, id: unknown, enabled: unknown, trusted: unknown) => {
      if (typeof id !== 'string' || !id) throw new Error('extensions:setEnabled 参数非法');
      if (typeof enabled !== 'boolean') throw new Error('extensions:setEnabled 参数非法');
      const catalog = await piExtensions.setEnabled(id, enabled, trusted === true);
      // Registries are fixed at harness open time; drop them so the next task
      // (or message) sees the new tool set instead of waiting for a restart.
      await work.invalidateAllHarnesses();
      return catalog;
    },
  );
  ipcMain.handle(IPC.skills.list, () => piSkills.list());
  ipcMain.handle(IPC.skills.setEnabled, async (_event, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || !id) throw new Error('skills:setEnabled 参数非法');
    if (typeof enabled !== 'boolean') throw new Error('skills:setEnabled 参数非法');
    const catalog = piSkills.setEnabled(id, enabled);
    // The prompt section is part of the registry, so cached harnesses are stale.
    await work.invalidateAllHarnesses();
    return catalog;
  });
  ipcMain.handle(IPC.memory.consolidationRuns, (_event, ownerId: unknown) =>
    consolidationRuns.list(20, typeof ownerId === 'string' ? ownerId : undefined),
  );

  // 两层过滤的策略：读一份、写一份。写的是部分更新，没提到的字段保持原值——
  // 表单只提交它改过的那几行，不整份覆盖。
  ipcMain.handle(IPC.memory.standing, () => standing.list());
  ipcMain.handle(IPC.memory.forget, (_event, id: unknown) => {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error('memory:forget 参数非法');
    }
    return standing.forget(id);
  });

  ipcMain.handle(IPC.trigger.status, () => triggers.status());
  ipcMain.handle(IPC.trigger.set, (_event, patch: unknown) => {
    if (typeof patch !== 'object' || patch === null) {
      throw new Error('trigger:set 参数非法');
    }
    return triggers.set(patch as TriggerPatch);
  });

  ipcMain.handle(IPC.router.getTriage, () => triage.get());
  ipcMain.handle(IPC.router.setTriage, (_event, patch: unknown) => {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new Error('router:setTriage 参数非法');
    }
    return triage.set(patch as TriagePolicyPatch);
  });

  ipcMain.handle(IPC.facts.list, (_event, filter: unknown) => {
    const parsed = (typeof filter === 'object' && filter !== null ? filter : {}) as {
      threadId?: unknown;
    };
    // 只有两层：这条线自己的规定，或者整个工作台的规定。中间那两层（部门/项目）
    // 在库里已经没有对应的表了，留着参数只会让人以为它们还有用。
    if (typeof parsed.threadId === 'string' && parsed.threadId) {
      return facts.current([{ type: 'thread' as const, id: parsed.threadId }], 50);
    }
    return facts.current([{ type: 'global' as const }], 50);
  });
  ipcMain.handle(IPC.facts.write, (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('facts:write 参数非法');
    const { scopeType, scopeId, subject, object, statement } = input as Record<string, unknown>;
    if (typeof subject !== 'string' || typeof object !== 'string' || typeof scopeType !== 'string') {
      throw new Error('facts:write 需要 scopeType / subject / object');
    }
    const written = facts.write({
      scopeType: scopeType === 'thread' ? 'thread' : 'global',
      scopeId: typeof scopeId === 'string' ? scopeId : undefined,
      subject,
      object,
      statement: typeof statement === 'string' ? statement : undefined,
    });
    return facts.current(
      written.scopeType === 'global'
        ? [{ type: 'global' as const }]
        : [{ type: written.scopeType, id: written.scopeId }],
      50,
    );
  });

  // ── v2: 注意力队列 ─────────────────────────────────────────────────────
  // 你打开应用看到的是"有什么事需要我"，不是会话列表。silent 的汇报永远不进
  // 队列——干完活不打扰是产品承诺，也是一条测试（router.test.ts）。
  ipcMain.handle(IPC.threads.start, (_event, goal: unknown) => {
    if (typeof goal !== 'string' || goal.trim().length === 0) {
      throw new Error('threads:start 需要一个目标');
    }
    return startGoal(goal.trim());
  });
  ipcMain.handle(IPC.threads.queue, () => threads.listQueueWithThread());
  ipcMain.handle(IPC.threads.list, (_event, limit: unknown) =>
    threads.listThreads({ limit: typeof limit === 'number' ? limit : 50 }),
  );
  ipcMain.handle(IPC.threads.markRead, (_event, reportId: unknown) => {
    if (typeof reportId !== 'string') throw new Error('threads:markRead 参数非法');
    threads.markReportRead(reportId);
  });
  ipcMain.handle(IPC.threads.decide, (_event, raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) throw new Error('threads:decide 参数非法');
    const draft = raw as Record<string, unknown>;
    if (typeof draft.reportId !== 'string') throw new Error('threads:decide 需要 reportId');
    if (typeof draft.threadId !== 'string') throw new Error('threads:decide 需要 threadId');
    if (draft.decision !== 'approve' && draft.decision !== 'rework') {
      throw new Error('threads:decide 需要 decision（approve / rework）');
    }
    const result = work.decideThread(
      draft.threadId,
      draft.decision,
      typeof draft.note === 'string' ? draft.note : undefined,
    );
    if (!result.ok) throw new Error(result.error);
    // You answered: the row leaves the queue either way. A rework will come
    // back with its own report when the second attempt lands.
    threads.markReportRead(draft.reportId);
    return result.thread;
  });
  ipcMain.handle(IPC.threads.close, (_event, threadId: unknown) => {
    if (typeof threadId !== 'string') throw new Error('threads:close 参数非法');
    return threads.setState(threadId, 'done');
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
  ipcMain.handle(IPC.work.userDecision, (_event, taskId: unknown, decision: unknown, reason: unknown) => {
    if (typeof taskId !== 'string' || (decision !== 'approve' && decision !== 'reject')) {
      throw new Error('work:userDecision 参数非法');
    }
    return work.userDecision(taskId, decision, typeof reason === 'string' ? reason : undefined);
  });
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
    unsubscribeWork();
    ipcMain.removeHandler(IPC.billing.get);
    ipcMain.removeHandler(IPC.billing.update);
    unsubscribe();
    ipcMain.removeHandler(IPC.work.listTasks);
    ipcMain.removeHandler(IPC.work.setIssueMeta);
    ipcMain.removeHandler(IPC.work.linkTasks);
    ipcMain.removeHandler(IPC.work.userDecision);
    ipcMain.removeHandler(IPC.work.createTask);
    ipcMain.removeHandler(IPC.work.runTask);
    ipcMain.removeHandler(IPC.app.getInfo);
    ipcMain.removeHandler(IPC.company.get);
    ipcMain.removeHandler(IPC.company.update);
    ipcMain.removeHandler(IPC.diagnostics.report);
    ipcMain.removeHandler(IPC.chat.getSnapshot);
    ipcMain.removeHandler(IPC.chat.sendMessage);
    ipcMain.removeHandler(IPC.chat.markRead);
    ipcMain.removeHandler(IPC.chat.ensureAssistant);
    ipcMain.removeHandler(IPC.chat.archive);
    ipcMain.removeHandler(IPC.chat.restore);
  };
}

function isCompanyPatch(value: unknown): value is CompanyProfilePatch {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const fields = ['name', 'domain', 'goal', 'colorId', 'userName', 'logo', 'userAvatar'] as const;
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
