import crypto from 'node:crypto';
import type { MemoryReflectionRunView } from '@opc/shared/ipc';
import {
  formatLocalDate,
  USER_PROFILE_SECTIONS,
  type MarkdownMemoryStore,
  type MemorySignalOrigin,
} from './markdownMemoryStore';

export interface TranscriptMessageForReflection {
  id: string;
  senderId: string;
  text: string;
  createdAt: number;
}

export interface MemoryReflectorDeps {
  store: MarkdownMemoryStore;
  complete: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
  readMessagesSince: (
    afterMessageId: string | null,
    limit?: number,
  ) => readonly TranscriptMessageForReflection[];
  /** Idle wait before reflecting incremental conversation turns (default 10 min). */
  idleMs?: number;
  /** Minimum unreflected messages required for an idle reflection (default 2). */
  idleMinMessages?: number;
  /** Reflect automatically once this many new user messages accumulate (default 8). */
  messageBatchThreshold?: number;
  /** Debounce window after a correction / failure signal (default 15s). */
  signalDebounceMs?: number;
  onChanged?: () => void;
}

interface ReflectionPatch {
  userSections?: Record<string, string[]>;
  rulesRemove?: string[];
  rulesReplace?: { old: string; next: string }[];
  rulesAdd?: string[];
  playbookUpserts?: { section: string; entry: string }[];
  topicUpdates?: { slug: string; title?: string; content: string; mode?: 'append' | 'replace' }[];
  dailyNote?: string | null;
}

const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_SIGNAL_DEBOUNCE_MS = 15_000;
const DEFAULT_BATCH_THRESHOLD = 8;
const DEFAULT_IDLE_MIN_MESSAGES = 2;

const ORIGIN_LABEL: Record<MemorySignalOrigin, string> = {
  rework: '用户退回返工',
  steering: '中途改方向（内部调度/路线微调，切勿当成系统权限或用户长期铁律）',
  pivot: '否定当前路线并转向',
  abort: '主动中止任务',
  task_recovery: '多次试错后修复成功（提炼避坑经验）',
  task_failure: '任务失败（提炼失败教训）',
  correction: '用户直接纠偏',
};

/**
 * Single-flight background memory consolidator & post-mortem reflector.
 *
 * Replaces the old archive-only conversation consolidator and disconnected 5-minute
 * signal loop with whole-document-aware incremental Markdown patches.
 */
export class MemoryReflector {
  private readonly idleMs: number;
  private readonly idleMinMessages: number;
  private readonly messageBatchThreshold: number;
  private readonly signalDebounceMs: number;

  private pendingUserMessageCount = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private signalTimer: ReturnType<typeof setTimeout> | null = null;
  private activeRun: Promise<MemoryReflectionRunView> | null = null;
  private disposed = false;

  constructor(private readonly deps: MemoryReflectorDeps) {
    this.idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
    this.idleMinMessages = deps.idleMinMessages ?? DEFAULT_IDLE_MIN_MESSAGES;
    this.messageBatchThreshold = deps.messageBatchThreshold ?? DEFAULT_BATCH_THRESHOLD;
    this.signalDebounceMs = deps.signalDebounceMs ?? DEFAULT_SIGNAL_DEBOUNCE_MS;
  }

  isReflecting(): boolean {
    return this.activeRun !== null;
  }

  noteUserMessage(): void {
    if (this.disposed) return;
    this.pendingUserMessageCount += 1;
    this.clearIdleTimer();

    if (this.pendingUserMessageCount >= this.messageBatchThreshold) {
      this.pendingUserMessageCount = 0;
      void this.trigger('conversation');
      return;
    }

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pendingUserMessageCount >= this.idleMinMessages) {
        this.pendingUserMessageCount = 0;
        void this.trigger('conversation');
      }
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  recordSignal(input: {
    origin: MemorySignalOrigin;
    text: string;
    threadId?: string;
    taskId?: string;
  }): void {
    if (this.disposed) return;
    const saved = this.deps.store.recordSignal(input);
    if (!saved) return;
    this.armSignalTimer();
  }

  async flushBeforeCompact(): Promise<void> {
    this.pendingUserMessageCount = 0;
    this.clearIdleTimer();
    try {
      await this.trigger('compact');
    } catch {
      // Compaction and reset must never fail because of background reflection.
    }
  }

  /**
   * Synchronizes reflection state when the user starts a new conversation.
   * Preserves all `memory/*.md` files on disk, flushes or discards pending signals,
   * and resets the message reflection cursor.
   */
  async resetAfterConversationClear(options: { flush: boolean }): Promise<void> {
    this.pendingUserMessageCount = 0;
    this.clearIdleTimer();
    this.clearSignalTimer();
    if (options.flush) {
      await this.flushBeforeCompact();
    } else {
      const pending = this.deps.store.readState().pendingSignals;
      if (pending.length > 0) {
        this.deps.store.consumeSignals(pending.map((signal) => signal.id));
      }
    }
    this.deps.store.resetReflectionCursor(Date.now());
  }

  reflectNow(): Promise<MemoryReflectionRunView> {
    this.pendingUserMessageCount = 0;
    this.clearIdleTimer();
    this.clearSignalTimer();
    return this.trigger('manual');
  }

  dispose(): void {
    this.disposed = true;
    this.clearIdleTimer();
    this.clearSignalTimer();
  }

  private armSignalTimer(): void {
    this.clearSignalTimer();
    this.signalTimer = setTimeout(() => {
      this.signalTimer = null;
      void this.trigger('signal');
    }, this.signalDebounceMs);
    this.signalTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearSignalTimer(): void {
    if (this.signalTimer) {
      clearTimeout(this.signalTimer);
      this.signalTimer = null;
    }
  }

  private trigger(
    trigger: MemoryReflectionRunView['trigger'],
  ): Promise<MemoryReflectionRunView> {
    if (this.activeRun) return this.activeRun;
    const run = this.execute(trigger).finally(() => {
      if (this.activeRun === run) this.activeRun = null;
      if (!this.disposed && this.deps.store.readState().pendingSignals.length > 0 && !this.signalTimer) {
        this.armSignalTimer();
      }
    });
    this.activeRun = run;
    return run;
  }

  private async execute(
    trigger: MemoryReflectionRunView['trigger'],
  ): Promise<MemoryReflectionRunView> {
    const startedAt = Date.now();
    const id = `reflect-${startedAt}-${crypto.randomUUID().slice(0, 6)}`;
    this.deps.store.ensureInitialized();
    const state = this.deps.store.readState();
    const signals = state.pendingSignals;
    const messages = this.deps
      .readMessagesSince(state.lastReflectedMessageId, 40)
      .filter((m) => m.text.trim().length > 0);

    if (messages.length === 0 && signals.length === 0) {
      const skipped: MemoryReflectionRunView = {
        id,
        trigger,
        startedAt,
        finishedAt: Date.now(),
        status: 'skipped',
        summary: '没有新增对话或待处理纠偏信号',
        changedFiles: [],
      };
      if (trigger === 'manual') this.deps.store.appendRun(skipped);
      return skipped;
    }

    const userDoc = this.deps.store.readDoc('USER.md').content;
    const rulesDoc = this.deps.store.readDoc('RULES.md').content;
    const playbookDoc = this.deps.store.readDoc('PLAYBOOK.md').content;
    const topicNames = this.deps.store
      .listDocs()
      .filter((doc) => doc.category === 'topic')
      .map((doc) => `${doc.relPath} (${doc.title})`);

    const userPrompt = buildReflectionUserPrompt({
      userDoc,
      rulesDoc,
      playbookDoc,
      topicNames,
      messages,
      signals,
      today: formatLocalDate(),
    });

    let rawOutput: string;
    try {
      rawOutput = await this.deps.complete({
        systemPrompt: REFLECTION_SYSTEM_PROMPT,
        userPrompt,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const run: MemoryReflectionRunView = {
        id,
        trigger,
        startedAt,
        finishedAt: Date.now(),
        status: reason.includes('未配置') ? 'skipped' : 'failed',
        summary: reason.includes('未配置') ? '未配置默认模型，已保留待处理记录' : '记忆整理调用失败',
        changedFiles: [],
        error: reason,
      };
      this.deps.store.appendRun(run);
      return run;
    }

    const patch = parseReflectionPatch(rawOutput);
    const changedSet = new Set<string>();
    const reason = `auto-reflect:${trigger}`;

    if (patch.userSections) {
      for (const [sec, items] of Object.entries(patch.userSections)) {
        if (!Array.isArray(items)) continue;
        const valid = items.filter((item): item is string => typeof item === 'string');
        if (this.deps.store.updateUserSection(sec, valid, { mode: 'replace', reason })) {
          changedSet.add('USER.md');
        }
      }
    }

    for (const target of patch.rulesRemove ?? []) {
      if (this.deps.store.removeRule(target, reason).ok) {
        changedSet.add('RULES.md');
      }
    }

    for (const rep of patch.rulesReplace ?? []) {
      const res = this.deps.store.addRule(rep.next, { replace: rep.old, reason });
      if (res.ok && res.changed) changedSet.add('RULES.md');
    }

    for (const rule of patch.rulesAdd ?? []) {
      const res = this.deps.store.addRule(rule, { reason });
      if (res.ok && res.changed) changedSet.add('RULES.md');
    }

    for (const item of patch.playbookUpserts ?? []) {
      const res = this.deps.store.upsertPlaybookEntry(item.section, item.entry, reason);
      if (res.ok && res.changed) changedSet.add('PLAYBOOK.md');
    }

    for (const topic of patch.topicUpdates ?? []) {
      const written = this.deps.store.upsertTopicDoc(
        topic.slug,
        topic.title || topic.slug,
        topic.content,
        { mode: topic.mode ?? 'append', reason },
      );
      changedSet.add(written.relPath);
    }

    if (patch.dailyNote && patch.dailyNote.trim()) {
      const daily = this.deps.store.appendDailyNote(patch.dailyNote, new Date(), reason);
      if (daily) changedSet.add(daily.relPath);
    }

    const latestMessageId = messages.at(-1)?.id ?? null;
    this.deps.store.consumeSignals(signals.map((s) => s.id));
    this.deps.store.updateReflectionCursor(latestMessageId, Date.now());

    const changedFiles = [...changedSet];
    const run: MemoryReflectionRunView = {
      id,
      trigger,
      startedAt,
      finishedAt: Date.now(),
      status: 'done',
      summary:
        changedFiles.length > 0
          ? `更新了 ${changedFiles.join('、')}`
          : '已检查增量上下文，无需改写现有记忆',
      changedFiles,
    };
    this.deps.store.appendRun(run);
    if (changedFiles.length > 0) this.deps.onChanged?.();
    return run;
  }
}

const REFLECTION_SYSTEM_PROMPT = [
  '你是用户的个人长期记忆整理器。你会看到：',
  '1) 当前已经存在于本地的四类记忆（USER.md、RULES.md、PLAYBOOK.md、topics/ 目录）',
  '2) 新增对话片段与用户纠偏/返工/任务复盘信号。',
  '',
  '请输出一个 **严格 JSON 对象**（可空字段直接省略），把真正长期有效或可复用避坑的知识合并更新到现有文件里，**严禁重复造近义词条目**：',
  '',
  '```json',
  '{',
  '  "userSections": {',
  `    "// 只包含需要更新的小节（可选值: ${USER_PROFILE_SECTIONS.join(' / ')}）；提供该小节整合去重后的完整列表": []`,
  '  },',
  '  "rulesRemove": ["确实过时或被用户推翻的旧铁律原文或子串"],',
  '  "rulesReplace": [{ "old": "旧铁律", "next": "替换后的更准确铁律" }],',
  '  "rulesAdd": ["仅限用户明确要求且跨任务必守的硬规则（总数<=20）"],',
  '  "playbookUpserts": [',
  '    { "section": "场景分类(如 Windows PowerShell / 前端UI / 网络代理)", "entry": "避免：具体错误或踩坑原因 → 正确做法：具体可执行解法" }',
  '  ],',
  '  "topicUpdates": [',
  '    { "slug": "英文或中文短名", "title": "专题标题", "content": "- 长期有效的项目架构/联系人/术语事实", "mode": "append" }',
  '  ],',
  '  "dailyNote": "仅用一句话概括今天完成的关键推进或重要决定；若无重要进展可省略"',
  '}',
  '```',
  '',
  '严禁写入的内容（违反会导致记忆污染）：',
  '- 不要把「助手刚执行了某次任务」「某条指令跑通了」当成铁律或避坑；一次性的寒暄、临时状态也不要进 USER.md/RULES.md。',
  '- 严禁把助手/Router 自己猜测的运行时/沙箱/权限/授权弹窗/附件路径结论（如“bash 被硬禁用”“用户端看不到授权弹窗”“附件只传 D 盘路径”）写入 RULES.md 或 USER.md。RULES.md 只记录用户亲口明确要求的跨任务行为/输出规范（称呼、语气、排版标准等），绝不记录内部 steer_line 改道话术或单次环境排查猜想。',
  '- 若现有 RULES.md 或 USER.md 中出现已被后续工具进展推翻的过时环境/权限限制条目，应主动通过 `rulesRemove` / `userSections` 清理。',
  '- 不要把泛泛而谈的空话（如"应当仔细检查需求"）写进 PLAYBOOK.md；避坑条必须指出**具体报错/环境/行为原因 + 明确替代做法**。',
  '- 若 USER.md 中某一小节需要补充信息，必须在 `userSections[sectionName]` 返回**合并旧条目+新信息并去重精简后的整节条目数组**。未变化的节不要输出。',
  '- 如果没有值得长期记住的变化，返回 `{}`。只输出 JSON，不要输出任何额外解释。',
].join('\n');

export const MEMORY_REFLECTION_SYSTEM_PROMPT = REFLECTION_SYSTEM_PROMPT;

function buildReflectionUserPrompt(input: {
  userDoc: string;
  rulesDoc: string;
  playbookDoc: string;
  topicNames: string[];
  messages: readonly TranscriptMessageForReflection[];
  signals: readonly { origin: MemorySignalOrigin; text: string; createdAt: number }[];
  today: string;
}): string {
  const parts: string[] = [
    `今天日期：${input.today}`,
    '',
    '### 现有 USER.md',
    input.userDoc.trim(),
    '',
    '### 现有 RULES.md',
    input.rulesDoc.trim(),
    '',
    '### 现有 PLAYBOOK.md',
    input.playbookDoc.trim(),
    '',
    `### 现有专题目录 (topics/)`,
    input.topicNames.length > 0 ? input.topicNames.join('、') : '（暂无）',
  ];

  if (input.signals.length > 0) {
    parts.push(
      '',
      '### 新增纠偏与复盘信号（高优先级，仔细提炼规则或避坑经验）',
      ...input.signals.map(
        (s) => `- [${ORIGIN_LABEL[s.origin] ?? s.origin}] ${s.text}`,
      ),
    );
  }

  if (input.messages.length > 0) {
    parts.push(
      '',
      '### 新增对话记录',
      ...input.messages.map((m) => `${m.senderId === 'user' ? '用户' : '助手'}：${m.text.slice(0, 800)}`),
    );
  }

  return parts.join('\n');
}

export function parseReflectionPatch(raw: string): ReflectionPatch {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1]!.trim() : extractFirstJsonObject(trimmed);
  if (!candidate) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const obj = parsed as Record<string, unknown>;
  const patch: ReflectionPatch = {};

  if (obj.userSections && typeof obj.userSections === 'object' && !Array.isArray(obj.userSections)) {
    const validSections: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(obj.userSections as Record<string, unknown>)) {
      if (k.startsWith('//')) continue;
      if (Array.isArray(v)) {
        validSections[k] = v.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
      }
    }
    if (Object.keys(validSections).length > 0) patch.userSections = validSections;
  }

  if (Array.isArray(obj.rulesRemove)) {
    patch.rulesRemove = obj.rulesRemove.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  }
  if (Array.isArray(obj.rulesReplace)) {
    patch.rulesReplace = obj.rulesReplace.filter(
      (v): v is { old: string; next: string } =>
        Boolean(v) &&
        typeof v === 'object' &&
        typeof (v as Record<string, unknown>).old === 'string' &&
        typeof (v as Record<string, unknown>).next === 'string',
    );
  }
  if (Array.isArray(obj.rulesAdd)) {
    patch.rulesAdd = obj.rulesAdd.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  }
  if (Array.isArray(obj.playbookUpserts)) {
    patch.playbookUpserts = obj.playbookUpserts.filter(
      (v): v is { section: string; entry: string } =>
        Boolean(v) &&
        typeof v === 'object' &&
        typeof (v as Record<string, unknown>).section === 'string' &&
        typeof (v as Record<string, unknown>).entry === 'string',
    );
  }
  if (Array.isArray(obj.topicUpdates)) {
    patch.topicUpdates = obj.topicUpdates.filter(
      (v): v is { slug: string; title?: string; content: string; mode?: 'append' | 'replace' } =>
        Boolean(v) &&
        typeof v === 'object' &&
        typeof (v as Record<string, unknown>).slug === 'string' &&
        typeof (v as Record<string, unknown>).content === 'string',
    );
  }
  if (typeof obj.dailyNote === 'string' && obj.dailyNote.trim()) {
    patch.dailyNote = obj.dailyNote.trim();
  }

  return patch;
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}
