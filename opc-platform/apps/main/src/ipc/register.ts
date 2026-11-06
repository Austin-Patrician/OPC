import {
  IPC,
  type SendMessageInput,
  type MemoryView,
  type OrphanMemoryGroup,
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
import { MODEL_ROLES, type ModelRole } from '@opc/shared/domain';
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
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
import { appPaths } from '../paths';
import { closeAllMcpConnections } from '../mcp/connection';
import { listServers, removeServer, saveServer, testServer } from '../mcp/settings';
import { readMcpConfig } from '../mcp/config';
import { McpAuthStore, authFile, isHttp, loginMcp } from '../mcp/auth';
import type { McpExposure, McpServerConfig } from '../mcp/contract';
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
  /** Watchdog 的只读入口与规则（W7）。 */
  watchdog: {
    incidents: { listRecent(limit?: number): unknown[] };
    actions: { listRecent(limit?: number): unknown[] };
    policy: {
      view(): unknown;
      save(patch: unknown): unknown;
      rollback(): unknown;
    };
    /** 它自己的模型；`null` = 跟随默认 LLM。 */
    model: { get(): unknown; set(ref: unknown): unknown };
    /**
     * 模型或钥匙变了：让 Watchdog 子进程重拿一份配置。
     * 它只在内存里拿着上次的 provider + 钥匙，不发这一下就要等重启才生效。
     */
    onModelChanged?: () => void;
    ask(question: string): Promise<unknown>;
  };
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
  /** 记忆：读写都在服务里，这里只转发。 */
  memories: {
    list: () => MemoryView[];
    update: (id: string, content: string) => boolean;
    forget: (id: string) => boolean;
    orphans: () => OrphanMemoryGroup[];
    claim: (ownerId: string) => number;
    discard: (ownerId: string) => number;
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
  memories,
  watchdog,
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
    const saved = models.saveProvider(draft);
    // Watchdog 手里有一份 provider 副本（含钥匙）：改了地址/接口就要重发。
    watchdog.onModelChanged?.();
    return saved;
  });
  ipcMain.handle(IPC.models.removeProvider, (_event, providerId: unknown) => {
    if (typeof providerId !== 'string') throw new Error('models:removeProvider 参数非法');
    const removed = models.removeProvider(providerId);
    watchdog.onModelChanged?.();
    return removed;
  });
  ipcMain.handle(IPC.models.setKey, (_event, providerId: unknown, apiKey: unknown) => {
    if (typeof providerId !== 'string' || typeof apiKey !== 'string') {
      throw new Error('models:setKey 参数非法');
    }
    const saved = models.setKey(providerId, apiKey);
    // 钥匙换了但子进程还拿着旧的：不发这一下，判断会一直用旧钥匙直到重启。
    watchdog.onModelChanged?.();
    return saved;
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
    // 名单只有一份（`MODEL_ROLES`）：手写这串判断漏一个角色，界面上就是
    // “改了但没保存”，而且不会报错。
    if (typeof role !== 'string' || !MODEL_ROLES.includes(role as ModelRole)) {
      throw new Error('models:setDefault role 非法');
    }
    if (ref !== null && !isModelRef(ref)) throw new Error('models:setDefault ref 非法');
    const saved = models.setDefault(role as ModelRole, ref);
    // 没配 `watchdog.model` 时，判断跟随默认 LLM——默认换了也要重发。
    if (role === 'llm') watchdog.onModelChanged?.();
    return saved;
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
  ipcMain.handle(IPC.memory.list, () => memories.list());
  ipcMain.handle(IPC.memory.update, (_event, id: unknown, content: unknown) => {
    if (typeof id !== 'string' || typeof content !== 'string') {
      throw new Error('memory:update 参数非法');
    }
    return memories.update(id, content);
  });
  ipcMain.handle(IPC.memory.orphans, () => memories.orphans());
  ipcMain.handle(IPC.memory.claim, (_event, ownerId: unknown) => {
    if (typeof ownerId !== 'string' || ownerId.trim().length === 0) {
      throw new Error('memory:claim 参数非法');
    }
    return memories.claim(ownerId);
  });
  ipcMain.handle(IPC.memory.discard, (_event, ownerId: unknown) => {
    if (typeof ownerId !== 'string' || ownerId.trim().length === 0) {
      throw new Error('memory:discard 参数非法');
    }
    return memories.discard(ownerId);
  });
  ipcMain.handle(IPC.memory.forget, (_event, id: unknown) => {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error('memory:forget 参数非法');
    }
    return memories.forget(id);
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

  // Watchdog（W7）：看 + 问 + 调规则。没有"修"——修复由它自己按白名单发起。
  ipcMain.handle(IPC.watchdog.incidents, () => watchdog.incidents.listRecent(50));
  ipcMain.handle(IPC.watchdog.actions, () => watchdog.actions.listRecent(20));
  ipcMain.handle(IPC.watchdog.ask, (_event, question: unknown) => {
    if (typeof question !== 'string') throw new Error('watchdog:ask 需要一个字符串');
    return watchdog.ask(question);
  });
  ipcMain.handle(IPC.watchdog.getPolicy, () => watchdog.policy.view());
  ipcMain.handle(IPC.watchdog.savePolicy, (_event, patch: unknown) => {
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new Error('watchdog:savePolicy 参数非法');
    }
    return watchdog.policy.save(patch);
  });
  ipcMain.handle(IPC.watchdog.rollbackPolicy, () => watchdog.policy.rollback());
  ipcMain.handle(IPC.watchdog.getModel, () => watchdog.model.get());
  ipcMain.handle(IPC.watchdog.setModel, (_event, ref: unknown) => {
    if (ref === null) {
      const next = watchdog.model.set(null);
      watchdog.onModelChanged?.();
      return next;
    }
    if (typeof ref !== 'object' || Array.isArray(ref)) throw new Error('watchdog:setModel 参数非法');
    const input = ref as { providerId?: unknown; modelId?: unknown };
    if (typeof input.providerId !== 'string' || typeof input.modelId !== 'string') {
      throw new Error('watchdog:setModel 需要 providerId 与 modelId');
    }
    const next = watchdog.model.set({ providerId: input.providerId, modelId: input.modelId });
    // 保存了就立刻生效：子进程手里那份配置是内存里的旧值。
    watchdog.onModelChanged?.();
    return next;
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
  /*
   * MCP 的那一页（M2）。配置存在 `<userData>/mcp.json`——那是 MCP 生态的公共格式，
   * 手写得、能进版本库；设置页只是它的编辑器，不是它的所有者。
   *
   * 改完之后必须做两件事：关掉旧连接（配置变了，那些进程已经没有意义），并把执行体的
   * 注册表作废（工具是在建注册表时装的）。不然界面上改了、活里还是旧的。
   */
  const mcpOptions = () => ({ userDataDir: appPaths.userData });
  const reloadMcp = async () => {
    await closeAllMcpConnections();
    await work.invalidateAllHarnesses();
  };

  ipcMain.handle(IPC.mcp.list, () => listServers(mcpOptions()));
  ipcMain.handle(IPC.mcp.save, async (_event, raw: unknown) => {
    const config = draftToMcpConfig(raw);
    const result = saveServer(mcpOptions(), config);
    await reloadMcp();
    return result;
  });
  ipcMain.handle(IPC.mcp.remove, async (_event, name: unknown) => {
    if (typeof name !== 'string' || !name.trim()) throw new Error('mcp:remove 需要服务器名');
    const result = removeServer(mcpOptions(), name.trim());
    await reloadMcp();
    return result;
  });
  const mcpConfigFor = (name: unknown): McpServerConfig => {
    if (typeof name !== 'string' || !name.trim()) throw new Error('mcp 需要服务器名');
    const config = readMcpConfig({ userDataDir: appPaths.userData }).servers.find(
      (server) => server.name === name.trim(),
    );
    if (!config) throw new Error(`没有这个服务器：${name}`);
    return config;
  };
  ipcMain.handle(IPC.mcp.test, async (_event, name: unknown) =>
    testServer(mcpConfigFor(name), undefined, appPaths.userData),
  );

  ipcMain.handle(IPC.mcp.login, async (_event, name: unknown) => {
    const config = mcpConfigFor(name);
    if (!isHttp(config)) throw new Error('只有 HTTP 服务器需要登录：stdio 的凭据在它自己的环境变量里');
    const store = new McpAuthStore(authFile(appPaths.userData), config.name);
    const result = await loginMcp(config, {
      store,
      // 只有这个进程知道"打开浏览器"是什么意思。
      openBrowser: (url) => shell.openExternal(url),
    });
    if (!result.ok) throw new Error(result.error);
    await reloadMcp();
    return listServers(mcpOptions());
  });
  ipcMain.handle(IPC.mcp.logout, async (_event, name: unknown) => {
    const config = mcpConfigFor(name);
    new McpAuthStore(authFile(appPaths.userData), config.name).clear();
    await reloadMcp();
    return listServers(mcpOptions());
  });

  ipcMain.handle(IPC.threads.answer, async (_event, raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) throw new Error('threads:answer 参数非法');
    const draft = raw as Record<string, unknown>;
    if (typeof draft.reportId !== 'string') throw new Error('threads:answer 需要 reportId');
    if (typeof draft.text !== 'string') throw new Error('threads:answer 需要 text');
    if (draft.allow !== undefined && typeof draft.allow !== 'boolean') {
      throw new Error('threads:answer 的 allow 只能是 true / false');
    }
    const result = await work.answerFor({
      reportId: draft.reportId,
      text: draft.text,
      ...(typeof draft.allow === 'boolean' ? { allow: draft.allow } : {}),
    });
    if (!result.ok) throw new Error(result.error);
    return result.delivered;
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
    if (level !== null && typeof level !== 'string') throw new Error('models:setThinking 参数非法');
    return models.setThinking(level);
  });

  ipcMain.handle(IPC.models.getRouterThinking, () => models.getRouterThinking());
  ipcMain.handle(IPC.models.setRouterThinking, (_event, level: unknown) => {
    if (level !== null && typeof level !== 'string') {
      throw new Error('models:setRouterThinking 参数非法');
    }
    return models.setRouterThinking(level);
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

  ipcMain.handle(IPC.work.trace, (_event, taskId: unknown, limit: unknown) => {
    if (typeof taskId !== 'string') throw new Error('work:trace 参数非法');
    return work.listTrace(taskId, typeof limit === 'number' ? limit : undefined);
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
    ipcMain.removeHandler(IPC.work.trace);
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

/**
 * 界面送来的一行 → 服务器配置。
 *
 * `target` 是给手打的：stdio 那行是 `npx -y server-fs`，按空白切开；带空格的路径走
 * `args`。名字只留字母数字、`_`、`-`——它会成为工具名的一部分。
 */
function draftToMcpConfig(raw: unknown): McpServerConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error('mcp:save 参数非法');
  const draft = raw as Record<string, unknown>;
  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error('服务器名只能用字母、数字、_ 和 -（它会成为工具名的一部分）');
  }
  const target = typeof draft.target === 'string' ? draft.target.trim() : '';
  if (!target) throw new Error('填一个命令或一个地址');

  const exposure: McpExposure | undefined =
    draft.exposure === 'deferred' || draft.exposure === 'direct' || draft.exposure === 'hidden'
      ? draft.exposure
      : undefined;
  const common = {
    name,
    ...(draft.enabled === false ? { enabled: false } : {}),
    ...(exposure ? { exposure } : {}),
    ...(typeof draft.description === 'string' && draft.description.trim()
      ? { description: draft.description.trim() }
      : {}),
  };

  if (draft.transport === 'http') {
    if (!/^https?:\/\//.test(target)) throw new Error('HTTP 服务器要一个 http(s) 地址');
    return { ...common, url: target };
  }

  const explicitArgs = Array.isArray(draft.args)
    ? draft.args.filter((item): item is string => typeof item === 'string')
    : null;
  const parts = explicitArgs ?? target.split(/\s+/);
  const [command, ...args] = parts;
  if (!command) throw new Error('填一个命令');
  return { ...common, command, ...(args.length > 0 ? { args } : {}) };
}
