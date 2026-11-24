import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  MemoryDocCategory,
  MemoryDocDetail,
  MemoryDocSummary,
  MemoryReflectionRunView,
  MemorySnapshotView,
  MemoryStatusView,
} from '@opc/shared/ipc';

export const MAX_RULES = 20;
export const MAX_USER_PROFILE_CHARS = 1200;
export const MAX_SNAPSHOTS = 30;
export const MAX_RECENT_RUNS = 30;
export const MAX_PENDING_SIGNALS = 50;

export const USER_PROFILE_SECTIONS = [
  '身份与角色',
  '工作与本地环境',
  '沟通与输出习惯',
  '近期关注',
] as const;

export type UserProfileSection = (typeof USER_PROFILE_SECTIONS)[number];

export type MemorySignalOrigin =
  | 'rework'
  | 'steering'
  | 'pivot'
  | 'abort'
  | 'task_recovery'
  | 'task_failure'
  | 'correction';

export interface PendingMemorySignal {
  id: string;
  origin: MemorySignalOrigin;
  text: string;
  threadId?: string;
  taskId?: string;
  createdAt: number;
}

export interface MemoryRuntimeState {
  lastReflectedMessageId: string | null;
  lastReflectedAt: number | null;
  pendingSignals: PendingMemorySignal[];
  recentRuns: MemoryReflectionRunView[];
}

const DEFAULT_USER_MD = [
  '# 个人画像（USER.md）',
  '',
  '## 身份与角色',
  '<!-- 例如：全栈开发工程师 / 独立开发者，主导 OPC 工作台桌面端 -->',
  '',
  '## 工作与本地环境',
  '<!-- 例如：Windows + PowerShell、仓库 E:\\code\\...、包管理器 pnpm -->',
  '',
  '## 沟通与输出习惯',
  '<!-- 例如：结论先行、中文回复、不要客套话 -->',
  '',
  '## 近期关注',
  '<!-- 例如：正在重构记忆系统、打磨桌面端体验 -->',
  '',
].join('\n');

const DEFAULT_RULES_MD = [
  '# 长期铁律（RULES.md）',
  '',
  '<!-- 每行一条铁律，以 "- " 开头；最多 20 条，每轮都会强注入给助手和执行体 -->',
  '',
].join('\n');

const DEFAULT_PLAYBOOK_MD = [
  '# 避坑与经验手册（PLAYBOOK.md）',
  '',
  '<!-- 按场景小标题组织：## 场景名，下方用 "- 避免：... → 正确做法：..." 记录可复用经验 -->',
  '',
].join('\n');

const DEFAULT_STATE: MemoryRuntimeState = {
  lastReflectedMessageId: null,
  lastReflectedAt: null,
  pendingSignals: [],
  recentRuns: [],
};

const CORE_FILES = new Set(['USER.md', 'RULES.md', 'PLAYBOOK.md']);

/**
 * Pure Markdown-First local memory store (`<userData>/memory/`).
 *
 * All durable user memory lives in human-editable `.md` files with automatic
 * `.snapshots/` rollback history and lightweight `.state.json` cursor/signals.
 */
export class MarkdownMemoryStore {
  private readonly snapshotsDir: string;
  private readonly topicsDir: string;
  private readonly dailyDir: string;
  private readonly statePath: string;
  private initialized = false;

  constructor(private readonly rootDir: string) {
    this.snapshotsDir = path.join(rootDir, '.snapshots');
    this.topicsDir = path.join(rootDir, 'topics');
    this.dailyDir = path.join(rootDir, 'daily');
    this.statePath = path.join(rootDir, '.state.json');
  }

  getRootDir(): string {
    return this.rootDir;
  }

  ensureInitialized(): void {
    if (this.initialized && fs.existsSync(this.rootDir)) return;
    fs.mkdirSync(this.rootDir, { recursive: true });
    fs.mkdirSync(this.topicsDir, { recursive: true });
    fs.mkdirSync(this.dailyDir, { recursive: true });
    fs.mkdirSync(this.snapshotsDir, { recursive: true });

    this.ensureFile('USER.md', DEFAULT_USER_MD);
    this.ensureFile('RULES.md', DEFAULT_RULES_MD);
    this.ensureFile('PLAYBOOK.md', DEFAULT_PLAYBOOK_MD);

    if (!fs.existsSync(this.statePath)) {
      this.atomicWriteAbsolute(this.statePath, JSON.stringify(DEFAULT_STATE, null, 2));
    }
    this.initialized = true;
  }

  normalizeRelPath(raw: string): string {
    const cleaned = raw
      .replace(/\\/g, '/')
      .replace(/^\.?\//, '')
      .trim();
    if (!cleaned) throw new Error('记忆文件路径不能为空');
    const segments = cleaned.split('/').filter(Boolean);
    if (segments.length === 0) throw new Error('记忆文件路径非法');
    for (const seg of segments) {
      if (seg === '.' || seg === '..' || seg.startsWith('.') || /[:*?"<>|]/.test(seg)) {
        throw new Error(`记忆文件路径非法：${raw}`);
      }
    }
    const normalized = segments.join('/');
    if (!normalized.toLowerCase().endsWith('.md')) {
      throw new Error('仅支持 .md 记忆文档');
    }
    if (segments.length === 1) {
      if (!CORE_FILES.has(normalized)) {
        throw new Error(`根目录仅允许 USER.md / RULES.md / PLAYBOOK.md：${normalized}`);
      }
      return normalized;
    }
    if (segments.length === 2 && (segments[0] === 'topics' || segments[0] === 'daily')) {
      return normalized;
    }
    throw new Error(`记忆路径必须位于根目录或 topics/、daily/ 下：${normalized}`);
  }

  categoryOf(relPath: string): MemoryDocCategory {
    if (relPath === 'USER.md') return 'user';
    if (relPath === 'RULES.md') return 'rules';
    if (relPath === 'PLAYBOOK.md') return 'playbook';
    if (relPath.startsWith('topics/')) return 'topic';
    return 'daily';
  }

  listDocs(): MemoryDocSummary[] {
    this.ensureInitialized();
    const candidates: string[] = ['USER.md', 'RULES.md', 'PLAYBOOK.md'];
    for (const dirName of ['topics', 'daily'] as const) {
      const dir = path.join(this.rootDir, dirName);
      if (!fs.existsSync(dir)) continue;
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        .map((entry) => `${dirName}/${entry.name}`)
        .sort((a, b) => (dirName === 'daily' ? b.localeCompare(a) : a.localeCompare(b)));
      candidates.push(...entries);
    }
    return candidates.map((relPath) => this.summarizeDoc(relPath));
  }

  readDoc(rawRelPath: string): MemoryDocDetail {
    this.ensureInitialized();
    const relPath = this.normalizeRelPath(rawRelPath);
    const fullPath = this.resolveWithinRoot(relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`记忆文档不存在：${relPath}`);
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    const summary = this.summarizeDoc(relPath, content);
    return { ...summary, content };
  }

  writeDoc(
    rawRelPath: string,
    content: string,
    options: { snapshot?: boolean; reason?: string } = {},
  ): MemoryDocDetail {
    this.ensureInitialized();
    const relPath = this.normalizeRelPath(rawRelPath);
    const fullPath = this.resolveWithinRoot(relPath);
    const normalizedContent = normalizeMarkdown(content);

    if (relPath === 'RULES.md') {
      const rules = extractRuleBullets(normalizedContent);
      if (rules.length > MAX_RULES) {
        throw new Error(`铁律数量达到上限（最多 ${MAX_RULES} 条，当前 ${rules.length} 条），请精简旧条目`);
      }
    }

    const previous = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : null;
    if (previous === normalizedContent) {
      return { ...this.summarizeDoc(relPath, normalizedContent), content: normalizedContent };
    }

    if (options.snapshot !== false && previous !== null) {
      this.createSnapshot(relPath, previous, options.reason ?? 'edit');
    }

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    this.atomicWriteAbsolute(fullPath, normalizedContent);
    return { ...this.summarizeDoc(relPath, normalizedContent), content: normalizedContent };
  }

  deleteDoc(rawRelPath: string, reason = 'manual-delete'): boolean {
    this.ensureInitialized();
    const relPath = this.normalizeRelPath(rawRelPath);
    if (CORE_FILES.has(relPath)) {
      throw new Error(`核心记忆文档不可删除：${relPath}`);
    }
    const fullPath = this.resolveWithinRoot(relPath);
    if (!fs.existsSync(fullPath)) return false;
    const previous = fs.readFileSync(fullPath, 'utf8');
    this.createSnapshot(relPath, previous, reason);
    fs.unlinkSync(fullPath);
    return true;
  }

  listSnapshots(): MemorySnapshotView[] {
    this.ensureInitialized();
    if (!fs.existsSync(this.snapshotsDir)) return [];
    const files = fs
      .readdirSync(this.snapshotsDir)
      .filter((name) => name.endsWith('.json'))
      .sort((a, b) => b.localeCompare(a));
    const views: MemorySnapshotView[] = [];
    for (const file of files) {
      try {
        const parsed = JSON.parse(
          fs.readFileSync(path.join(this.snapshotsDir, file), 'utf8'),
        ) as Partial<MemorySnapshotView & { content: string }>;
        if (
          typeof parsed.id === 'string' &&
          typeof parsed.relPath === 'string' &&
          typeof parsed.createdAt === 'number' &&
          typeof parsed.content === 'string'
        ) {
          views.push({
            id: parsed.id,
            relPath: parsed.relPath,
            createdAt: parsed.createdAt,
            reason: typeof parsed.reason === 'string' ? parsed.reason : 'snapshot',
            size: Buffer.byteLength(parsed.content, 'utf8'),
          });
        }
      } catch {
        // Ignore malformed snapshot entries cleanly.
      }
    }
    return views.sort((a, b) => b.createdAt - a.createdAt);
  }

  rollbackSnapshot(snapshotId: string): { ok: boolean; relPath?: string; reason?: string } {
    this.ensureInitialized();
    if (!/^[a-zA-Z0-9._-]+$/.test(snapshotId)) {
      return { ok: false, reason: '快照 ID 非法' };
    }
    const snapPath = path.join(this.snapshotsDir, `${snapshotId}.json`);
    if (!fs.existsSync(snapPath)) {
      return { ok: false, reason: `未找到快照：${snapshotId}` };
    }
    const parsed = JSON.parse(fs.readFileSync(snapPath, 'utf8')) as {
      relPath?: string;
      content?: string;
    };
    if (!parsed.relPath || typeof parsed.content !== 'string') {
      return { ok: false, reason: '快照内容损坏' };
    }
    const relPath = this.normalizeRelPath(parsed.relPath);
    this.writeDoc(relPath, parsed.content, {
      snapshot: true,
      reason: `rollback:${snapshotId}`,
    });
    return { ok: true, relPath };
  }

  // ── Structured Operations on Core Files ──────────────────────────────────

  listRules(): string[] {
    return extractRuleBullets(this.readDoc('RULES.md').content);
  }

  addRule(
    rawRule: string,
    options: { replace?: string; reason?: string } = {},
  ): { ok: true; index: number; rules: string[]; changed: boolean } | { ok: false; reason: string } {
    const clean = singleLine(rawRule);
    if (!clean) return { ok: false, reason: '铁律内容不能为空' };

    const current = this.readDoc('RULES.md').content;
    const { headerLines, bullets } = parseRulesMarkdown(current);
    const normNew = normalizeComparable(clean);

    let nextBullets = [...bullets];
    if (options.replace) {
      const normReplace = normalizeComparable(options.replace);
      const replaceIdx = nextBullets.findIndex(
        (item) => normalizeComparable(item) === normReplace || normalizeComparable(item).includes(normReplace),
      );
      if (replaceIdx >= 0) {
        nextBullets[replaceIdx] = clean;
        const rebuilt = buildRulesMarkdown(headerLines, dedupeComparable(nextBullets));
        this.writeDoc('RULES.md', rebuilt, { reason: options.reason ?? 'replace-rule' });
        const finalRules = extractRuleBullets(rebuilt);
        return { ok: true, index: finalRules.findIndex((r) => r === clean) + 1 || 1, rules: finalRules, changed: true };
      }
    }

    const existingIndex = nextBullets.findIndex((item) => normalizeComparable(item) === normNew);
    if (existingIndex >= 0) {
      return { ok: true, index: existingIndex + 1, rules: nextBullets, changed: false };
    }

    if (nextBullets.length >= MAX_RULES) {
      return {
        ok: false,
        reason: `长期铁律已满（${MAX_RULES} 条上限），请先用 forget_memory 撤掉旧规矩再记新的`,
      };
    }

    nextBullets = [...nextBullets, clean];
    const rebuilt = buildRulesMarkdown(headerLines, nextBullets);
    this.writeDoc('RULES.md', rebuilt, { reason: options.reason ?? 'add-rule' });
    return { ok: true, index: nextBullets.length, rules: nextBullets, changed: true };
  }

  removeRule(target: string, reason = 'remove-rule'): { ok: boolean; removed?: string } {
    const clean = target.trim();
    if (!clean) return { ok: false };
    const current = this.readDoc('RULES.md').content;
    const { headerLines, bullets } = parseRulesMarkdown(current);

    let idx = -1;
    const refMatch = /^(?:memory:)?RULES\.md#(\d+)$/i.exec(clean);
    if (refMatch) {
      const oneBased = Number(refMatch[1]);
      if (oneBased >= 1 && oneBased <= bullets.length) idx = oneBased - 1;
    } else {
      const norm = normalizeComparable(clean);
      idx = bullets.findIndex((item) => normalizeComparable(item) === norm);
      if (idx < 0 && norm.length >= 2) {
        idx = bullets.findIndex((item) => normalizeComparable(item).includes(norm));
      }
    }

    if (idx < 0 || idx >= bullets.length) return { ok: false };
    const [removed] = bullets.splice(idx, 1);
    const rebuilt = buildRulesMarkdown(headerLines, bullets);
    this.writeDoc('RULES.md', rebuilt, { reason });
    return { ok: true, removed };
  }

  updateUserSection(
    sectionTitle: string,
    nextItems: readonly string[],
    options: { mode?: 'replace' | 'append'; reason?: string } = {},
  ): boolean {
    const targetSection = matchUserSection(sectionTitle);
    if (!targetSection) return false;

    const cleanItems = dedupeComparable(nextItems.map(singleLine).filter(Boolean));
    const current = this.readDoc('USER.md').content;
    const parsed = parseH2Document(current, '# 个人画像（USER.md）');

    const map = new Map<string, string[]>();
    for (const sec of USER_PROFILE_SECTIONS) {
      map.set(sec, cleanSectionLines(parsed.sections.get(sec) ?? []));
    }

    const previous = map.get(targetSection) ?? [];
    const merged =
      options.mode === 'append'
        ? dedupeComparable([...previous, ...cleanItems])
        : cleanItems;

    if (
      previous.length === merged.length &&
      previous.every((line, i) => line === merged[i])
    ) {
      return false;
    }

    map.set(targetSection, merged);
    let rendered = renderUserMarkdown(map);
    if (rendered.length > MAX_USER_PROFILE_CHARS) {
      const recent = [...(map.get('近期关注') ?? [])];
      while (rendered.length > MAX_USER_PROFILE_CHARS && recent.length > 0) {
        recent.shift();
        map.set('近期关注', recent);
        rendered = renderUserMarkdown(map);
      }
      if (rendered.length > MAX_USER_PROFILE_CHARS) {
        for (const sec of ['近期关注', '工作与本地环境', '沟通与输出习惯', '身份与角色'] as const) {
          const arr = [...(map.get(sec) ?? [])];
          while (rendered.length > MAX_USER_PROFILE_CHARS && arr.length > 1) {
            arr.shift();
            map.set(sec, arr);
            rendered = renderUserMarkdown(map);
          }
        }
      }
    }

    this.writeDoc('USER.md', rendered, { reason: options.reason ?? 'update-user' });
    return true;
  }

  upsertPlaybookEntry(
    sectionTitle: string,
    entryText: string,
    reason = 'upsert-playbook',
  ): { ok: true; section: string; changed: boolean } | { ok: false; reason: string } {
    const section = sanitizeHeading(sectionTitle) || '通用经验';
    const entry = singleLine(entryText);
    if (!entry) return { ok: false, reason: '避坑条目不能为空' };

    const current = this.readDoc('PLAYBOOK.md').content;
    const parsed = parseH2Document(current, '# 避坑与经验手册（PLAYBOOK.md）');
    const existingLines = cleanSectionLines(parsed.sections.get(section) ?? []);
    const normNew = normalizeComparable(entry);

    if (existingLines.some((line) => normalizeComparable(line) === normNew)) {
      return { ok: true, section, changed: false };
    }

    existingLines.push(entry);
    parsed.sections.set(section, existingLines.map((line) => `- ${line}`));
    const rebuilt = renderH2Document(parsed.preamble, parsed.sections);
    this.writeDoc('PLAYBOOK.md', rebuilt, { reason });
    return { ok: true, section, changed: true };
  }

  upsertTopicDoc(
    rawSlug: string,
    title: string,
    bodyMarkdown: string,
    options: { mode?: 'replace' | 'append'; reason?: string } = {},
  ): MemoryDocDetail {
    this.ensureInitialized();
    const slug = sanitizeSlug(rawSlug || title);
    const relPath = `topics/${slug}.md`;
    const cleanTitle = sanitizeHeading(title) || slug;
    const body = bodyMarkdown.trim();
    const exists = fs.existsSync(this.resolveWithinRoot(relPath));

    if (exists && options.mode === 'append' && body) {
      const prev = this.readDoc(relPath).content.trimEnd();
      if (prev.includes(body)) return this.readDoc(relPath);
      return this.writeDoc(relPath, `${prev}\n${body.startsWith('-') || body.startsWith('#') ? body : `- ${body}`}\n`, {
        reason: options.reason ?? 'append-topic',
      });
    }

    const formatted = body.startsWith('# ')
      ? `${body}\n`
      : `# ${cleanTitle}\n\n${body}\n`;
    return this.writeDoc(relPath, formatted, { reason: options.reason ?? 'upsert-topic' });
  }

  appendDailyNote(line: string, date = new Date(), reason = 'daily-note'): MemoryDocDetail | null {
    this.ensureInitialized();
    const clean = singleLine(line);
    if (!clean) return null;
    const stamp = formatLocalDate(date);
    const relPath = `daily/${stamp}.md`;
    const fullPath = this.resolveWithinRoot(relPath);
    const existing = fs.existsSync(fullPath)
      ? fs.readFileSync(fullPath, 'utf8')
      : `# ${stamp} 日志与摘要\n\n`;
    const existingBullets = extractRuleBullets(existing);
    if (existingBullets.some((item) => normalizeComparable(item) === normalizeComparable(clean))) {
      return this.readDoc(relPath);
    }
    const next = `${existing.trimEnd()}\n- ${clean}\n`;
    return this.writeDoc(relPath, next, { snapshot: true, reason });
  }

  rememberFromRouter(
    text: string,
    options: { standing?: boolean; kind?: string; subject?: string } = {},
  ): { ok: true; id: string } | { ok: false; reason: string } {
    this.ensureInitialized();
    const clean = singleLine(text);
    if (!clean) return { ok: false, reason: '内容是空的' };

    const kind = options.kind ?? 'preference';
    if (options.standing === true || kind === 'constraint') {
      const added = this.addRule(clean, { reason: 'router:remember' });
      if (!added.ok) return added;
      return { ok: true, id: `memory:RULES.md#${added.index}` };
    }

    if (kind === 'workflow' || kind === 'format') {
      const section = options.subject?.trim() || (kind === 'format' ? '输出格式习惯' : '工作流与经验');
      const saved = this.upsertPlaybookEntry(section, clean, 'router:remember');
      if (!saved.ok) return saved;
      return { ok: true, id: `memory:PLAYBOOK.md#${saved.section}` };
    }

    if (options.subject && /^(topic|project):/i.test(options.subject.trim())) {
      const slug = options.subject.trim().replace(/^(topic|project):/i, '').trim() || 'general';
      const detail = this.upsertTopicDoc(slug, slug, `- ${clean}`, {
        mode: 'append',
        reason: 'router:remember',
      });
      return { ok: true, id: `memory:${detail.relPath}` };
    }

    const section = inferUserSection(clean, kind, options.subject);
    this.updateUserSection(section, [clean], { mode: 'append', reason: 'router:remember' });
    return { ok: true, id: `memory:USER.md#${section}` };
  }

  forgetByRef(rawRef: string, reason = 'router:forget'): { ok: boolean; detail?: string } {
    this.ensureInitialized();
    const ref = rawRef.trim();
    if (!ref) return { ok: false };

    const stripped = ref.startsWith('memory:') ? ref.slice('memory:'.length) : ref;
    const hashIdx = stripped.indexOf('#');
    const docPart = hashIdx >= 0 ? stripped.slice(0, hashIdx) : stripped;
    const anchor = hashIdx >= 0 ? stripped.slice(hashIdx + 1).trim() : '';

    if (/^RULES\.md$/i.test(docPart)) {
      const res = this.removeRule(ref, reason);
      return res.ok ? { ok: true, detail: res.removed } : { ok: false };
    }

    if (/^PLAYBOOK\.md$/i.test(docPart) && anchor) {
      const removed = this.removePlaybookMatch(anchor, reason);
      return removed ? { ok: true, detail: removed } : { ok: false };
    }

    if (/^USER\.md$/i.test(docPart) && anchor) {
      const removed = this.removeUserLineMatch(anchor, reason);
      return removed ? { ok: true, detail: removed } : { ok: false };
    }

    if (/^(topics|daily)\/.+\.md$/i.test(docPart) && !anchor) {
      try {
        const deleted = this.deleteDoc(docPart, reason);
        return deleted ? { ok: true, detail: docPart } : { ok: false };
      } catch {
        return { ok: false };
      }
    }

    // Fallback: search by text across RULES -> PLAYBOOK -> USER
    const fromRule = this.removeRule(ref, reason);
    if (fromRule.ok) return { ok: true, detail: fromRule.removed };

    const fromPlaybook = this.removePlaybookMatch(ref, reason);
    if (fromPlaybook) return { ok: true, detail: fromPlaybook };

    const fromUser = this.removeUserLineMatch(ref, reason);
    if (fromUser) return { ok: true, detail: fromUser };

    return { ok: false };
  }

  // ── Prompt Rendering ─────────────────────────────────────────────────────

  renderRouterStandingBlock(personalPreferences?: {
    tone: string;
    detail: string;
    instructions: string;
  }): string | undefined {
    this.ensureInitialized();
    const blocks: string[] = [];

    if (personalPreferences) {
      const toneMap: Record<string, string> = {
        friendly: '友好自然',
        balanced: '自然平衡',
        professional: '专业正式',
      };
      const detailMap: Record<string, string> = {
        concise: '优先简洁，先给结论',
        balanced: '详略适中',
        detailed: '尽量充分展开并解释依据',
      };
      const prefLines = [
        `回复偏好：语气${toneMap[personalPreferences.tone] ?? toneMap.balanced}；详略${detailMap[personalPreferences.detail] ?? detailMap.balanced}。`,
      ];
      if (personalPreferences.instructions.trim()) {
        prefLines.push(`补充回复要求：${personalPreferences.instructions.trim()}`);
      }
      blocks.push('## 回复偏好（设置）\n' + prefLines.map((l) => `- ${l}`).join('\n'));
    }

    const userSections = parseH2Document(this.readDoc('USER.md').content, '').sections;
    const populatedUser: string[] = [];
    for (const sec of USER_PROFILE_SECTIONS) {
      const items = cleanSectionLines(userSections.get(sec) ?? []);
      if (items.length > 0) {
        populatedUser.push(`### ${sec}\n${items.map((l) => `- ${l}`).join('\n')}`);
      }
    }
    if (populatedUser.length > 0) {
      blocks.push(`## 用户画像（USER.md）\n${populatedUser.join('\n')}`);
    }

    const rules = this.listRules();
    if (rules.length > 0) {
      blocks.push(
        `## 长期铁律（RULES.md，共 ${rules.length}/${MAX_RULES} 条，每轮必须遵守）\n` +
          rules.map((rule, idx) => `- [memory:RULES.md#${idx + 1}] ${rule}`).join('\n'),
      );
    }

    const topics = this.listDocs().filter((doc) => doc.category === 'topic');
    if (topics.length > 0) {
      const compactIndex = topics
        .slice(0, 12)
        .map((doc) => `${doc.title} (${doc.relPath})`)
        .join('、');
      blocks.push(
        `## 专题记忆目录（需要详情可用 recall_memory 或 recall memory:topics/<slug>.md）\n- ${compactIndex}`,
      );
    }

    return blocks.length > 0 ? blocks.join('\n\n') : undefined;
  }

  renderWorkerCoreBlock(): string | undefined {
    this.ensureInitialized();
    const parts: string[] = [];
    const userSections = parseH2Document(this.readDoc('USER.md').content, '').sections;
    for (const sec of ['工作与本地环境', '沟通与输出习惯'] as const) {
      const items = cleanSectionLines(userSections.get(sec) ?? []);
      if (items.length > 0) {
        parts.push(`[${sec}] ${items.join('；')}`);
      }
    }
    const rules = this.listRules();
    for (const rule of rules) {
      parts.push(`[铁律] ${rule}`);
    }
    return parts.length > 0 ? parts.map((line) => `- ${line}`).join('\n') : undefined;
  }

  // ── Runtime State, Reflection Cursor & Signals ───────────────────────────

  readState(): MemoryRuntimeState {
    this.ensureInitialized();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as Partial<MemoryRuntimeState>;
      return {
        lastReflectedMessageId:
          typeof parsed.lastReflectedMessageId === 'string' ? parsed.lastReflectedMessageId : null,
        lastReflectedAt:
          typeof parsed.lastReflectedAt === 'number' ? parsed.lastReflectedAt : null,
        pendingSignals: Array.isArray(parsed.pendingSignals) ? parsed.pendingSignals : [],
        recentRuns: Array.isArray(parsed.recentRuns) ? parsed.recentRuns : [],
      };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  writeState(next: MemoryRuntimeState): void {
    this.ensureInitialized();
    this.atomicWriteAbsolute(this.statePath, JSON.stringify(next, null, 2));
  }

  recordSignal(input: {
    origin: MemorySignalOrigin;
    text: string;
    threadId?: string;
    taskId?: string;
    createdAt?: number;
  }): PendingMemorySignal | null {
    const clean = input.text.trim();
    if (!clean) return null;
    const now = input.createdAt ?? Date.now();
    const state = this.readState();
    const norm = normalizeComparable(clean);
    const duplicate = state.pendingSignals.some(
      (existing) =>
        existing.origin === input.origin &&
        normalizeComparable(existing.text) === norm &&
        now - existing.createdAt < 10 * 60 * 1000,
    );
    if (duplicate) return null;

    const signal: PendingMemorySignal = {
      id: `sig-${now}-${crypto.randomUUID().slice(0, 6)}`,
      origin: input.origin,
      text: clean.slice(0, 600),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      createdAt: now,
    };

    const nextSignals = [...state.pendingSignals, signal].slice(-MAX_PENDING_SIGNALS);
    this.writeState({ ...state, pendingSignals: nextSignals });
    return signal;
  }

  consumeSignals(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    const state = this.readState();
    this.writeState({
      ...state,
      pendingSignals: state.pendingSignals.filter((s) => !drop.has(s.id)),
    });
  }

  updateReflectionCursor(messageId: string | null, at: number): void {
    const state = this.readState();
    this.writeState({
      ...state,
      lastReflectedMessageId: messageId ?? state.lastReflectedMessageId,
      lastReflectedAt: at,
    });
  }

  appendRun(run: MemoryReflectionRunView): void {
    const state = this.readState();
    this.writeState({
      ...state,
      recentRuns: [run, ...state.recentRuns].slice(0, MAX_RECENT_RUNS),
    });
  }

  status(reflecting = false): MemoryStatusView {
    const state = this.readState();
    const docs = this.listDocs();
    return {
      rootDir: this.rootDir,
      docCount: docs.length,
      ruleCount: this.listRules().length,
      maxRules: MAX_RULES,
      pendingSignals: state.pendingSignals.length,
      lastReflectedAt: state.lastReflectedAt,
      reflecting,
      recentRuns: state.recentRuns,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private ensureFile(relPath: string, defaultContent: string): void {
    const fullPath = this.resolveWithinRoot(relPath);
    if (!fs.existsSync(fullPath)) {
      this.atomicWriteAbsolute(fullPath, normalizeMarkdown(defaultContent));
    }
  }

  private resolveWithinRoot(relPath: string): string {
    const fullPath = path.resolve(this.rootDir, relPath);
    const rootResolved = path.resolve(this.rootDir);
    if (fullPath !== rootResolved && !fullPath.startsWith(`${rootResolved}${path.sep}`)) {
      throw new Error(`记忆文件路径越界：${relPath}`);
    }
    return fullPath;
  }

  private atomicWriteAbsolute(targetPath: string, content: string): void {
    const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, targetPath);
  }

  private createSnapshot(relPath: string, content: string, reason: string): void {
    fs.mkdirSync(this.snapshotsDir, { recursive: true });
    const now = Date.now();
    const id = `${now}-${crypto.randomUUID().slice(0, 6)}`;
    const payload = { id, relPath, createdAt: now, reason, content };
    this.atomicWriteAbsolute(path.join(this.snapshotsDir, `${id}.json`), JSON.stringify(payload, null, 2));

    const existing = fs
      .readdirSync(this.snapshotsDir)
      .filter((name) => name.endsWith('.json'))
      .sort((a, b) => b.localeCompare(a));
    for (const stale of existing.slice(MAX_SNAPSHOTS)) {
      fs.unlinkSync(path.join(this.snapshotsDir, stale));
    }
  }

  private summarizeDoc(relPath: string, preloaded?: string): MemoryDocSummary {
    const fullPath = this.resolveWithinRoot(relPath);
    const stat = fs.statSync(fullPath);
    const text = preloaded ?? fs.readFileSync(fullPath, 'utf8');
    const title = extractH1Title(text) ?? path.basename(relPath, '.md');
    const category = this.categoryOf(relPath);
    const itemCount =
      category === 'rules'
        ? extractRuleBullets(text).length
        : category === 'playbook' || category === 'user' || category === 'daily'
          ? extractRuleBullets(text).length
          : undefined;
    return {
      relPath,
      category,
      title,
      size: stat.size,
      updatedAt: stat.mtimeMs,
      ...(itemCount !== undefined ? { itemCount } : {}),
    };
  }

  private removePlaybookMatch(target: string, reason: string): string | null {
    const norm = normalizeComparable(target);
    if (!norm) return null;
    const current = this.readDoc('PLAYBOOK.md').content;
    const parsed = parseH2Document(current, '# 避坑与经验手册（PLAYBOOK.md）');
    let removed: string | null = null;
    for (const [sec, lines] of parsed.sections.entries()) {
      const cleaned = cleanSectionLines(lines);
      const next = cleaned.filter((line) => {
        if (removed) return true;
        const match =
          normalizeComparable(sec) === norm ||
          normalizeComparable(line) === norm ||
          (norm.length >= 3 && normalizeComparable(line).includes(norm));
        if (match) {
          removed = `${sec}: ${line}`;
          return false;
        }
        return true;
      });
      if (removed) {
        if (next.length === 0) parsed.sections.delete(sec);
        else parsed.sections.set(sec, next.map((line) => `- ${line}`));
        break;
      }
    }
    if (!removed) return null;
    this.writeDoc('PLAYBOOK.md', renderH2Document(parsed.preamble, parsed.sections), { reason });
    return removed;
  }

  private removeUserLineMatch(target: string, reason: string): string | null {
    const norm = normalizeComparable(target);
    if (!norm) return null;
    const current = this.readDoc('USER.md').content;
    const parsed = parseH2Document(current, '# 个人画像（USER.md）');
    const map = new Map<string, string[]>();
    for (const sec of USER_PROFILE_SECTIONS) {
      map.set(sec, cleanSectionLines(parsed.sections.get(sec) ?? []));
    }
    let removed: string | null = null;
    for (const sec of USER_PROFILE_SECTIONS) {
      const list = map.get(sec) ?? [];
      const next = list.filter((line) => {
        if (removed) return true;
        if (
          normalizeComparable(line) === norm ||
          (norm.length >= 3 && normalizeComparable(line).includes(norm))
        ) {
          removed = line;
          return false;
        }
        return true;
      });
      map.set(sec, next);
      if (removed) break;
    }
    if (!removed) return null;
    this.writeDoc('USER.md', renderUserMarkdown(map), { reason });
    return removed;
  }
}

// ── Markdown Parsing & Formatting Helpers ──────────────────────────────────

function normalizeMarkdown(raw: string): string {
  const unified = raw.replace(/\r\n/g, '\n').trimEnd();
  return unified ? `${unified}\n` : '\n';
}

function singleLine(raw: string): string {
  return raw.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').replace(/^[-*]\s+/, '').trim();
}

function normalizeComparable(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^[-*]\s+/, '')
    .replace(/[`*_~。，、！？!?,.:：；;（）()[\]【】\s]/g, '');
}

function dedupeComparable(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = normalizeComparable(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function sanitizeHeading(raw: string): string {
  return raw.replace(/^#+\s*/, '').replace(/\r?\n+/g, ' ').trim();
}

export function sanitizeSlug(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[\s/\\]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned.slice(0, 64) || `topic-${Date.now()}`;
}

export function formatLocalDate(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function extractH1Title(markdown: string): string | null {
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^#\s+(.+)$/.exec(line.trim());
    if (match) return match[1]!.trim();
  }
  return null;
}

export function extractRuleBullets(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('<!--')) continue;
    const match = /^[-*]\s+(.+)$/.exec(trimmed);
    if (match && match[1]!.trim()) out.push(match[1]!.trim());
  }
  return out;
}

function parseRulesMarkdown(markdown: string): { headerLines: string[]; bullets: string[] } {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const headerLines: string[] = [];
  const bullets: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bullet) {
      if (bullet[1]!.trim()) bullets.push(bullet[1]!.trim());
    } else if (bullets.length === 0) {
      headerLines.push(line);
    }
  }
  if (!headerLines.some((l) => l.trim().startsWith('# '))) {
    headerLines.unshift('# 长期铁律（RULES.md）', '');
  }
  return { headerLines, bullets };
}

function buildRulesMarkdown(headerLines: readonly string[], bullets: readonly string[]): string {
  const head = headerLines.join('\n').trimEnd();
  if (bullets.length === 0) return `${head}\n\n`;
  return `${head}\n\n${bullets.map((b) => `- ${b}`).join('\n')}\n`;
}

export function parseH2Document(
  markdown: string,
  fallbackTitle: string,
): { preamble: string[]; sections: Map<string, string[]> } {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const preamble: string[] = [];
  const sections = new Map<string, string[]>();
  let current: string | null = null;

  for (const line of lines) {
    const h2 = /^##\s+(.+)$/.exec(line.trim());
    if (h2) {
      current = h2[1]!.trim();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current === null) {
      preamble.push(line);
    } else {
      sections.get(current)!.push(line);
    }
  }

  if (preamble.every((l) => !l.trim()) && fallbackTitle) {
    preamble.splice(0, preamble.length, fallbackTitle);
  }
  return { preamble, sections };
}

function cleanSectionLines(lines: readonly string[]): string[] {
  const items: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('<!--')) continue;
    items.push(trimmed.replace(/^[-*]\s+/, '').trim());
  }
  return items.filter(Boolean);
}

function renderH2Document(
  preamble: readonly string[],
  sections: ReadonlyMap<string, readonly string[]>,
): string {
  const blocks: string[] = [preamble.join('\n').trim()];
  for (const [heading, lines] of sections.entries()) {
    const body = lines.join('\n').trim();
    blocks.push(body ? `## ${heading}\n${body}` : `## ${heading}`);
  }
  return `${blocks.filter(Boolean).join('\n\n')}\n`;
}

function renderUserMarkdown(sections: ReadonlyMap<string, readonly string[]>): string {
  const placeholders: Record<UserProfileSection, string> = {
    身份与角色: '<!-- 例如：全栈开发工程师 / 独立开发者，主导 OPC 工作台桌面端 -->',
    工作与本地环境: '<!-- 例如：Windows + PowerShell、仓库 E:\\code\\...、包管理器 pnpm -->',
    沟通与输出习惯: '<!-- 例如：结论先行、中文回复、不要客套话 -->',
    近期关注: '<!-- 例如：正在重构记忆系统、打磨桌面端体验 -->',
  };
  const blocks: string[] = ['# 个人画像（USER.md）'];
  for (const sec of USER_PROFILE_SECTIONS) {
    const items = sections.get(sec) ?? [];
    if (items.length > 0) {
      blocks.push(`## ${sec}\n${items.map((l) => `- ${l}`).join('\n')}`);
    } else {
      blocks.push(`## ${sec}\n${placeholders[sec]}`);
    }
  }
  return `${blocks.join('\n\n')}\n`;
}

function matchUserSection(raw: string): UserProfileSection | null {
  const clean = raw.replace(/^##\s*/, '').trim();
  for (const sec of USER_PROFILE_SECTIONS) {
    if (sec === clean || clean.includes(sec)) return sec;
  }
  if (/身份|角色|role|profile/i.test(clean)) return '身份与角色';
  if (/环境|电脑|工具|路径|env|workspace/i.test(clean)) return '工作与本地环境';
  if (/沟通|输出|风格|语气|偏好|style|format/i.test(clean)) return '沟通与输出习惯';
  if (/近期|关注|目标|focus|goal/i.test(clean)) return '近期关注';
  return null;
}

function inferUserSection(text: string, kind: string, subject?: string): UserProfileSection {
  if (kind === 'goal' || /最近|正在|本周|本月|项目推进/.test(text)) return '近期关注';
  if (kind === 'person' || /我是|职业|岗位|工程师|设计师|负责/.test(text)) return '身份与角色';
  if (/windows|mac|linux|powershell|bash|node|pnpm|python|端口|目录|path|repo|分支|git/i.test(text + (subject ?? ''))) {
    return '工作与本地环境';
  }
  return '沟通与输出习惯';
}
