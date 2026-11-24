import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  FilePlus2,
  FolderOpen,
  History,
  Plus,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  MemoryDocSummary,
  MemorySearchHit,
  MemorySnapshotView,
  MemoryStatusView,
} from '@opc/shared/ipc';
import { formatAppDate } from '@/shared/lib/appTime';
import { cn } from '@/shared/lib/cn';
import { buttonClass, PageHeader, Section } from '../kit';

type MemoryTab = 'user' | 'rules' | 'playbook' | 'topics';

function parseRuleLines(markdown: string): string[] {
  const out: string[] = [];
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('<!--')) continue;
    const match = /^[-*]\s+(.+)$/.exec(trimmed);
    if (match?.[1]?.trim()) out.push(match[1].trim());
  }
  return out;
}

function buildRulesMarkdown(rules: readonly string[]): string {
  const header = [
    '# 长期铁律（RULES.md）',
    '',
    '<!-- 每行一条铁律，以 "- " 开头；最多 20 条，每轮都会强注入给助手和执行体 -->',
    '',
  ];
  if (rules.length === 0) return header.join('\n');
  return `${header.join('\n')}\n${rules.map((r) => `- ${r}`).join('\n')}\n`;
}

function parsePlaybookHeadings(markdown: string): string[] {
  const headings: string[] = [];
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^##\s+(.+)$/.exec(line.trim());
    if (match?.[1]?.trim()) headings.push(match[1].trim());
  }
  return headings;
}

export function MemoryPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<MemoryTab>('user');
  const [status, setStatus] = useState<MemoryStatusView | null>(null);
  const [docs, setDocs] = useState<MemoryDocSummary[]>([]);
  const [activeRelPath, setActiveRelPath] = useState<string>('USER.md');
  const [content, setContent] = useState<string>('');
  const [savedContent, setSavedContent] = useState<string>('');
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reflecting, setReflecting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  // Rules structured mode vs raw markdown
  const [rulesRawMode, setRulesRawMode] = useState(false);
  const [newRule, setNewRule] = useState('');

  // Topic creation
  const [newTopicName, setNewTopicName] = useState('');
  const [creatingTopic, setCreatingTopic] = useState(false);

  // Instant search
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<MemorySearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Snapshots rollback popover
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [snapshots, setSnapshots] = useState<MemorySnapshotView[]>([]);

  const dirty = content !== savedContent;

  const loadMeta = useCallback(async () => {
    const bridge = window.opc;
    if (!bridge) return;
    const [nextStatus, nextDocs] = await Promise.all([
      bridge.memory.status().catch(() => null),
      bridge.memory.listDocs().catch(() => []),
    ]);
    if (nextStatus) setStatus(nextStatus);
    setDocs(nextDocs);
  }, []);

  const openDocument = useCallback(async (relPath: string) => {
    const bridge = window.opc;
    if (!bridge) return;
    setLoadingDoc(true);
    setActiveRelPath(relPath);
    try {
      const detail = await bridge.memory.readDoc(relPath);
      setContent(detail.content);
      setSavedContent(detail.content);
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoadingDoc(false);
    }
  }, []);

  useEffect(() => {
    void loadMeta();
    void openDocument('USER.md');
  }, [loadMeta, openDocument]);

  const topicAndDailyDocs = useMemo(
    () => docs.filter((d) => d.category === 'topic' || d.category === 'daily'),
    [docs],
  );

  const switchTab = (next: MemoryTab) => {
    setTab(next);
    setNotice(null);
    if (next === 'user') {
      void openDocument('USER.md');
    } else if (next === 'rules') {
      void openDocument('RULES.md');
    } else if (next === 'playbook') {
      void openDocument('PLAYBOOK.md');
    } else {
      const firstTopic = topicAndDailyDocs[0];
      if (firstTopic) {
        void openDocument(firstTopic.relPath);
      } else {
        setActiveRelPath('');
        setContent('');
        setSavedContent('');
      }
    }
  };

  const handleSave = async (nextText = content, targetPath = activeRelPath) => {
    const bridge = window.opc;
    if (!bridge || !targetPath) return;
    setSaving(true);
    setNotice(null);
    try {
      const saved = await bridge.memory.writeDoc(targetPath, nextText);
      setContent(saved.content);
      setSavedContent(saved.content);
      await loadMeta();
      setNotice({ kind: 'ok', text: `${t('settings.memory.saved')} · ${targetPath}` });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  const handleReflectNow = async () => {
    const bridge = window.opc;
    if (!bridge || reflecting) return;
    setReflecting(true);
    setNotice(null);
    try {
      const run = await bridge.memory.reflectNow();
      await loadMeta();
      if (activeRelPath) await openDocument(activeRelPath);
      setNotice({
        kind: run.status === 'failed' ? 'error' : 'ok',
        text: run.error ? `${run.summary}：${run.error}` : run.summary,
      });
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setReflecting(false);
    }
  };

  const handleSearch = async (text: string) => {
    setQuery(text);
    const trimmed = text.trim();
    if (!trimmed) {
      setHits(null);
      return;
    }
    const bridge = window.opc;
    if (!bridge) return;
    setSearching(true);
    try {
      const results = await bridge.memory.search(trimmed, 10);
      setHits(results);
    } finally {
      setSearching(false);
    }
  };

  const jumpToHit = (hit: MemorySearchHit) => {
    setHits(null);
    setQuery('');
    const targetTab: MemoryTab =
      hit.category === 'user'
        ? 'user'
        : hit.category === 'rules'
          ? 'rules'
          : hit.category === 'playbook'
            ? 'playbook'
            : 'topics';
    setTab(targetTab);
    void openDocument(hit.relPath);
  };

  const toggleSnapshots = async () => {
    const next = !showSnapshots;
    setShowSnapshots(next);
    if (next && window.opc) {
      const rows = await window.opc.memory.listSnapshots().catch(() => []);
      setSnapshots(rows);
    }
  };

  const handleRollback = async (snapshotId: string) => {
    const bridge = window.opc;
    if (!bridge) return;
    const res = await bridge.memory.rollbackSnapshot(snapshotId);
    setShowSnapshots(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.reason ?? '回退失败' });
      return;
    }
    await loadMeta();
    if (res.relPath) {
      const nextTab: MemoryTab =
        res.relPath === 'USER.md'
          ? 'user'
          : res.relPath === 'RULES.md'
            ? 'rules'
            : res.relPath === 'PLAYBOOK.md'
              ? 'playbook'
              : 'topics';
      setTab(nextTab);
      await openDocument(res.relPath);
    }
    setNotice({ kind: 'ok', text: `已回退 ${res.relPath ?? ''}` });
  };

  const ruleItems = useMemo(
    () => (activeRelPath === 'RULES.md' ? parseRuleLines(content) : []),
    [activeRelPath, content],
  );

  const playbookHeadings = useMemo(
    () => (activeRelPath === 'PLAYBOOK.md' ? parsePlaybookHeadings(content) : []),
    [activeRelPath, content],
  );

  const addRuleItem = () => {
    const trimmed = newRule.trim();
    if (!trimmed) return;
    if (ruleItems.length >= (status?.maxRules ?? 20)) {
      setNotice({ kind: 'error', text: `铁律最多 ${status?.maxRules ?? 20} 条` });
      return;
    }
    const nextMd = buildRulesMarkdown([...ruleItems, trimmed]);
    setNewRule('');
    void handleSave(nextMd, 'RULES.md');
  };

  const removeRuleItem = (index: number) => {
    const next = ruleItems.filter((_, idx) => idx !== index);
    void handleSave(buildRulesMarkdown(next), 'RULES.md');
  };

  const createTopic = async () => {
    const name = newTopicName.trim();
    const bridge = window.opc;
    if (!name || !bridge) return;
    const slug = name
      .toLowerCase()
      .replace(/[\s/\\]+/g, '-')
      .replace(/[^a-z0-9\u4e00-\u9fa5_-]/g, '')
      .slice(0, 48) || `topic-${Date.now()}`;
    const relPath = `topics/${slug}.md`;
    setCreatingTopic(false);
    setNewTopicName('');
    await handleSave(`# ${name}\n\n- \n`, relPath);
    setTab('topics');
    await openDocument(relPath);
  };

  const deleteTopicOrDaily = async (relPath: string) => {
    const bridge = window.opc;
    if (!bridge) return;
    await bridge.memory.deleteDoc(relPath);
    await loadMeta();
    const remaining = docs.filter((d) => (d.category === 'topic' || d.category === 'daily') && d.relPath !== relPath);
    if (remaining[0]) {
      await openDocument(remaining[0].relPath);
    } else {
      setActiveRelPath('');
      setContent('');
      setSavedContent('');
    }
    setNotice({ kind: 'ok', text: `已删除 ${relPath}（可在快照中撤销）` });
  };

  const activeDocMeta = docs.find((d) => d.relPath === activeRelPath);

  return (
    <>
      <PageHeader
        crumbs={[t('settings.title'), t('settings.group.behavior')]}
        title={t('settings.memory.title')}
        description={t('settings.memory.desc')}
        actions={
          <div className="relative flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={reflecting}
              onClick={() => void handleReflectNow()}
              className={buttonClass.primary}
            >
              <Sparkles className="size-3.5" />
              {reflecting ? t('settings.memory.reflecting') : t('settings.memory.reflectNow')}
            </button>
            <button
              type="button"
              onClick={() => void window.opc?.memory.openFolder()}
              className={buttonClass.secondary}
            >
              <FolderOpen className="size-3.5" />
              {t('settings.memory.openFolder')}
            </button>
            <button
              type="button"
              onClick={() => void toggleSnapshots()}
              className={buttonClass.secondary}
            >
              <History className="size-3.5" />
              {t('settings.memory.snapshots')}
            </button>

            {showSnapshots ? (
              <div className="absolute top-10 right-0 z-30 w-80 overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
                <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5 text-xs font-medium text-ink">
                  <span>{t('settings.memory.snapshots')}</span>
                  <button
                    type="button"
                    onClick={() => setShowSnapshots(false)}
                    className="rounded p-0.5 text-ink-tertiary hover:text-ink"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {snapshots.length === 0 ? (
                    <p className="px-3.5 py-4 text-xs text-ink-tertiary">
                      {t('settings.memory.noSnapshots')}
                    </p>
                  ) : (
                    snapshots.map((snap) => (
                      <div
                        key={snap.id}
                        className="flex items-center justify-between gap-2 border-t border-line/60 px-3.5 py-2 text-xs first:border-t-0"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-mono text-ink">{snap.relPath}</div>
                          <div className="truncate text-[11px] text-ink-tertiary">
                            {formatAppDate(snap.createdAt)} · {snap.reason}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleRollback(snap.id)}
                          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-secondary hover:bg-surface-hover hover:text-ink"
                        >
                          <RotateCcw className="size-3" />
                          回退
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : null}
          </div>
        }
      />

      {/* Search + live status strip */}
      <div className="mb-4 space-y-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-ink-quaternary" />
          <input
            type="search"
            value={query}
            onChange={(e) => void handleSearch(e.target.value)}
            placeholder={t('settings.memory.searchPlaceholder')}
            className="w-full rounded-xl border border-line bg-surface py-2 pr-3 pl-9 text-sm text-ink placeholder:text-ink-quaternary focus:border-accent focus:outline-none"
          />
          {hits !== null ? (
            <div className="mt-1.5 overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
              {searching ? (
                <p className="px-4 py-3 text-xs text-ink-tertiary">搜索中…</p>
              ) : hits.length === 0 ? (
                <p className="px-4 py-3 text-xs text-ink-tertiary">未找到匹配的记忆片段</p>
              ) : (
                <ul className="divide-y divide-line">
                  {hits.map((hit) => (
                    <li key={hit.id}>
                      <button
                        type="button"
                        onClick={() => jumpToHit(hit)}
                        className="block w-full px-4 py-2.5 text-left transition-colors hover:bg-surface-hover"
                      >
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-medium text-ink">
                            {hit.docTitle} · {hit.sectionTitle}
                          </span>
                          <span className="font-mono text-[11px] text-ink-quaternary">
                            {hit.relPath} · score {hit.score.toFixed(2)}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-ink-secondary">{hit.snippet}</p>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-ink-tertiary">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              铁律配额：<strong className="font-mono text-ink">{status?.ruleCount ?? 0}</strong> /{' '}
              {status?.maxRules ?? 20}
            </span>
            <span>文档数：{status?.docCount ?? docs.length}</span>
            <span>待整理信号：{status?.pendingSignals ?? 0}</span>
            {status?.lastReflectedAt ? (
              <span>上次整理：{formatAppDate(status.lastReflectedAt)}</span>
            ) : null}
          </div>
          {notice ? (
            <span
              className={cn(
                'text-xs font-medium',
                notice.kind === 'error' ? 'text-danger' : 'text-success',
              )}
            >
              {notice.text}
            </span>
          ) : null}
        </div>
      </div>

      {/* 4 Editorial Tabs */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5 border-b border-line pb-2.5">
        {(
          [
            { id: 'user', label: t('settings.memory.tabs.user') },
            { id: 'rules', label: `${t('settings.memory.tabs.rules')} (${status?.ruleCount ?? 0}/20)` },
            { id: 'playbook', label: t('settings.memory.tabs.playbook') },
            { id: 'topics', label: `${t('settings.memory.tabs.topics')} (${topicAndDailyDocs.length})` },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => switchTab(item.id)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
              tab === item.id
                ? 'bg-ink text-surface'
                : 'text-ink-secondary hover:bg-surface-hover hover:text-ink',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {tab === 'rules' && !rulesRawMode ? (
        <Section
          title="长期铁律（RULES.md）"
          description="用户明令禁止或长期要求的行为准则，上限 20 条，永不衰减，每轮注入给助手与执行体。"
          action={
            <button
              type="button"
              onClick={() => setRulesRawMode(true)}
              className={buttonClass.secondary}
            >
              源码编辑
            </button>
          }
        >
          <div className="p-4">
            <div className="mb-3 flex gap-2">
              <input
                type="text"
                value={newRule}
                onChange={(e) => setNewRule(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addRuleItem();
                }}
                placeholder="新增一条长期铁律（例如：所有接口错误必须返回明确中文提示）"
                className="min-w-0 flex-1 rounded-lg border border-line bg-surface-secondary px-3 py-1.5 text-sm text-ink placeholder:text-ink-quaternary focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                disabled={!newRule.trim() || saving}
                onClick={addRuleItem}
                className={buttonClass.primary}
              >
                <Plus className="size-3.5" />
                添加
              </button>
            </div>

            {ruleItems.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-tertiary">
                暂无铁律。当你在对话中说「以后都这样」或手动添加时，会记录在这里。
              </p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {ruleItems.map((rule, index) => (
                  <li
                    key={`${index}-${rule}`}
                    className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm"
                  >
                    <div className="flex min-w-0 items-baseline gap-2.5">
                      <span className="shrink-0 font-mono text-xs text-ink-quaternary">
                        #{index + 1}
                      </span>
                      <span className="break-words text-ink">{rule}</span>
                    </div>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => removeRuleItem(index)}
                      aria-label="删除铁律"
                      className="shrink-0 rounded-md p-1.5 text-ink-tertiary transition-colors hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>
      ) : tab === 'topics' ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[240px_1fr]">
          <Section
            title="文档列表"
            action={
              <button
                type="button"
                onClick={() => setCreatingTopic((v) => !v)}
                className="rounded-md p-1 text-ink-secondary hover:bg-surface-hover hover:text-ink"
                title="新建专题"
              >
                <FilePlus2 className="size-4" />
              </button>
            }
          >
            <div className="p-2">
              {creatingTopic ? (
                <div className="mb-2 flex gap-1.5 p-1">
                  <input
                    type="text"
                    value={newTopicName}
                    onChange={(e) => setNewTopicName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void createTopic();
                    }}
                    placeholder="专题名，如 opc-架构"
                    className="min-w-0 flex-1 rounded-md border border-line bg-surface-secondary px-2 py-1 text-xs text-ink focus:border-accent focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void createTopic()}
                    className="rounded-md bg-ink px-2 py-1 text-xs font-medium text-surface"
                  >
                    创建
                  </button>
                </div>
              ) : null}

              {topicAndDailyDocs.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-ink-tertiary">
                  还没有专题笔记或每日摘要
                </p>
              ) : (
                <ul className="space-y-1">
                  {topicAndDailyDocs.map((doc) => (
                    <li key={doc.relPath} className="group flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void openDocument(doc.relPath)}
                        className={cn(
                          'flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors',
                          activeRelPath === doc.relPath
                            ? 'bg-surface-active font-medium text-ink'
                            : 'text-ink-secondary hover:bg-surface-hover hover:text-ink',
                        )}
                      >
                        <BookOpen className="size-3.5 shrink-0 text-ink-quaternary" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{doc.title}</div>
                          <div className="truncate font-mono text-[10px] text-ink-quaternary">
                            {doc.relPath}
                          </div>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteTopicOrDaily(doc.relPath)}
                        className="hidden rounded p-1 text-ink-quaternary group-hover:block hover:text-danger"
                        title="删除文档"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Section>

          <MarkdownEditorCard
            relPath={activeRelPath}
            updatedAt={activeDocMeta?.updatedAt}
            content={content}
            dirty={dirty}
            loading={loadingDoc}
            saving={saving}
            onChange={setContent}
            onSave={() => void handleSave()}
            saveLabel={t('settings.memory.save')}
          />
        </div>
      ) : (
        <MarkdownEditorCard
          relPath={activeRelPath}
          updatedAt={activeDocMeta?.updatedAt}
          description={
            tab === 'user'
              ? '记录身份背景、Windows/软件环境、沟通偏好与近期关注，精简保持在 1200 字以内。'
              : tab === 'playbook'
                ? '按「## 场景」沉淀具体避坑经验（避免：... → 正确做法：...），执行体遇同类任务时自动注入。'
                : '直接编辑 RULES.md 源码，支持返回结构化列表模式。'
          }
          chips={tab === 'playbook' ? playbookHeadings : undefined}
          headerExtra={
            tab === 'rules' ? (
              <button
                type="button"
                onClick={() => setRulesRawMode(false)}
                className={buttonClass.secondary}
              >
                列表视图
              </button>
            ) : undefined
          }
          content={content}
          dirty={dirty}
          loading={loadingDoc}
          saving={saving}
          onChange={setContent}
          onSave={() => void handleSave()}
          saveLabel={t('settings.memory.save')}
        />
      )}
    </>
  );
}

function MarkdownEditorCard({
  relPath,
  updatedAt,
  description,
  chips,
  headerExtra,
  content,
  dirty,
  loading,
  saving,
  onChange,
  onSave,
  saveLabel,
}: {
  relPath: string;
  updatedAt?: number;
  description?: string;
  chips?: string[];
  headerExtra?: React.ReactNode;
  content: string;
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  saveLabel: string;
}) {
  if (!relPath) {
    return (
      <Section title="选择或新建一篇文档">
        <p className="px-4 py-10 text-center text-sm text-ink-tertiary">
          从左侧选择专题/日志，或点击右上角图标新建一篇专题笔记。
        </p>
      </Section>
    );
  }

  return (
    <Section
      title={relPath}
      description={
        description ??
        (updatedAt ? `最近更新：${formatAppDate(updatedAt)}` : undefined)
      }
      action={
        <div className="flex items-center gap-2">
          {headerExtra}
          <button
            type="button"
            disabled={!dirty || saving || loading}
            onClick={onSave}
            className={dirty ? buttonClass.primary : buttonClass.secondary}
          >
            <Save className="size-3.5" />
            {saving ? '保存中…' : saveLabel}
          </button>
        </div>
      }
    >
      <div className="space-y-3 p-4">
        {chips && chips.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {chips.map((heading) => (
              <span
                key={heading}
                className="rounded-md border border-line bg-surface-secondary px-2 py-0.5 text-[11px] text-ink-secondary"
              >
                ## {heading}
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          value={content}
          disabled={loading}
          onChange={(e) => onChange(e.target.value)}
          rows={18}
          spellCheck={false}
          className="w-full resize-y rounded-xl border border-line bg-surface-secondary p-3.5 font-mono text-[13px] leading-relaxed text-ink focus:border-accent focus:outline-none"
        />
      </div>
    </Section>
  );
}
