import { useCallback, useEffect, useState } from 'react';
import { ArrowUp, Check, Inbox, Loader2, RefreshCw, RotateCcw, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AttentionEntry } from '@opc/shared/ipc';
import type { WorkThread } from '@opc/shared/domain';
import { buttonClass, PageHeader, Section, StatusBadge } from '@/features/settings/ui/kit';
import { cn } from '@/shared/lib/cn';

/**
 * 注意力队列 —— 你打开应用看到的第一个页面。
 *
 * 这一页是 v2 的全部主张：**跟进单位是工作线，不是会话**。上面是"需要我处理的
 * 事"（decide 永远排在 notify 之前），下面是"机器在干什么"——静默完成的活必须
 * 在这里可见，否则"干完不打扰"就会退化成"看不见"。
 *
 * 所有数字都来自 `report` / `thread` 两行数据，渲染层不做任何估算。
 */
const LEVEL_ORDER = ['decide', 'notify'] as const;

const STATE_TONE: Record<WorkThread['state'], 'green' | 'blue' | 'amber' | 'red' | 'gray'> = {
  open: 'blue',
  running: 'blue',
  waiting: 'amber',
  done: 'green',
  failed: 'red',
  archived: 'gray',
};

export function AttentionPage() {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<AttentionEntry[]>([]);
  const [threads, setThreads] = useState<WorkThread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [starting, setStarting] = useState(false);
  /** Which row is asking for a rework note, and what you typed. */
  const [reworkId, setReworkId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  /** Which row is asking for an answer, and what you typed. */
  const [answerId, setAnswerId] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  /** 上一步做完之后的一句确认（"回答已经插进它正在跑的活里"）。 */
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!window.opc?.threads) return;
    try {
      const [nextQueue, nextThreads] = await Promise.all([
        window.opc.threads.queue(),
        window.opc.threads.list(20),
      ]);
      setQueue(nextQueue);
      setThreads(nextThreads);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Cheap and honest: the router ticks on its own schedule, so re-read on focus
    // and on a slow timer rather than inventing a push channel for two rows.
    const timer = window.setInterval(() => void load(), 15_000);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  const markRead = async (id: string) => {
    setBusyId(id);
    try {
      await window.opc?.threads.markRead(id);
      setQueue((previous) => previous.filter((entry) => entry.id !== id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(null);
    }
  };

  const closeThread = async (id: string) => {
    setBusyId(id);
    try {
      const updated = await window.opc?.threads.close(id);
      if (updated) {
        setThreads((previous) => previous.map((thread) => (thread.id === id ? updated : thread)));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * 你的判定。这是系统唯一一处「人说了算」的入口——`decide` 的活系统自己
   * 判不了，所以才在这里。
   */
  const decide = async (entry: AttentionEntry, decision: 'approve' | 'rework', text?: string) => {
    setPendingId(entry.id);
    try {
      const updated = await window.opc!.threads.decide({
        reportId: entry.id,
        threadId: entry.threadId,
        decision,
        ...(text ? { note: text } : {}),
      });
      setQueue((previous) => previous.filter((row) => row.id !== entry.id));
      setThreads((previous) => previous.map((thread) => (thread.id === updated.id ? updated : thread)));
      setReworkId(null);
      setNote('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPendingId(null);
    }
  };

  /**
   * 回答执行体的请示。
   *
   * 它不是"认可/重做"的第三种说法：那两个是对**结果**表态，这个是对**问题**作答。
   * 送出去之后要如实说它去了哪——插进了正在跑的会话，还是记在那件活上等下一次尝试。
   */
  const sendAnswer = async (entry: AttentionEntry) => {
    const text = reply.trim();
    if (!text) return;
    setPendingId(entry.id);
    try {
      const delivered = await window.opc!.threads.answer({ reportId: entry.id, text });
      setQueue((previous) => previous.filter((row) => row.id !== entry.id));
      setAnswerId(null);
      setReply('');
      const message =
        delivered === 'live'
          ? t('attention.answerLive')
          : delivered === 'new-task'
            ? t('attention.answerNewTask')
            : t('attention.answerNextAttempt');
      setError(null);
      window.setTimeout(() => void load(), 400);
      // 一行确认：它去了哪，比"已送出"有用得多。
      setNotice(message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPendingId(null);
    }
  };

  /** 丢一个目标：开一条工作线，剩下的交给 Router 决定怎么做。 */
  const submitGoal = async () => {
    const text = goal.trim();
    if (!text || starting) return;
    setStarting(true);
    try {
      await window.opc?.threads.start(text);
      setGoal('');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStarting(false);
    }
  };

  const decideCount = queue.filter((entry) => entry.level === 'decide').length;

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-6">
      <PageHeader
        crumbs={[t('attention.crumbs')]}
        title={t('attention.title')}
        description={t('attention.description')}
        actions={
          <button type="button" onClick={() => void load()} className={buttonClass.secondary}>
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            {t('attention.refresh')}
          </button>
        }
      />

      {/* 这一页不只是看板：你在这里丢目标，不需要知道"会话"这个概念。 */}
      <div className="mb-5 rounded-xl border border-line bg-surface p-3">
        <textarea
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submitGoal();
            }
          }}
          rows={2}
          placeholder={t('attention.goalPlaceholder')}
          className="w-full resize-none bg-transparent px-1.5 py-1 text-sm-plus leading-relaxed text-ink outline-none placeholder:text-ink-quaternary"
        />
        <div className="mt-1.5 flex items-center justify-between gap-3 border-t border-line pt-2">
          <span className="truncate text-2xs text-ink-quaternary">{t('attention.goalHint')}</span>
          <button
            type="button"
            onClick={() => void submitGoal()}
            disabled={starting || goal.trim().length === 0}
            className={cn(buttonClass.primary, 'shrink-0')}
          >
            {starting ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />}
            {t('attention.goalStart')}
          </button>
        </div>
      </div>

      {error ? (
        <div className="mb-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {notice ? (
        <div className="mb-4 rounded-xl border border-line bg-surface-muted/40 px-4 py-3 text-sm text-ink-secondary">
          {notice}
        </div>
      ) : null}

      {queue.length === 0 && !loading ? (
        <div className="mb-5 rounded-xl border border-line bg-surface px-6 py-10 text-center">
          <Sparkles className="mx-auto size-6 text-accent-ink" />
          <p className="mt-3 text-base font-semibold text-ink">{t('attention.emptyTitle')}</p>
          <p className="mx-auto mt-1.5 max-w-lg text-sm leading-relaxed text-ink-tertiary">
            {t('attention.emptyHint')}
          </p>
        </div>
      ) : null}

      {LEVEL_ORDER.map((level) => {
        const rows = queue.filter((entry) => entry.level === level);
        if (rows.length === 0) return null;
        return (
          <div key={level} className="mb-5">
            <Section
              title={t(`attention.level.${level}`)}
              description={t(`attention.levelHint.${level}`)}
              action={
                <span className="rounded-full bg-surface-muted px-2 py-0.5 text-2xs font-semibold text-ink-tertiary tabular-nums">
                  {rows.length}
                </span>
              }
            >
              <ul className="divide-y divide-line">
                {rows.map((entry) => (
                  <li key={entry.id} className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <StatusBadge
                        tone={level === 'decide' ? 'amber' : 'gray'}
                        label={level === 'decide' ? t('attention.level.decide') : t('attention.level.notify')}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm-plus font-medium text-ink">{entry.threadTitle}</div>
                        <p className="mt-0.5 line-clamp-2 text-sm leading-relaxed text-ink-secondary">
                          {entry.body || entry.title}
                        </p>
                        <div className="mt-1 text-2xs text-ink-quaternary">
                          {relativeTime(entry.createdAt, t)}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {/*
                          两种 decide 行要分开口令：对**结果**表态是认可/重做，对**问题**
                          作答是回答。以前它们共用一个按钮组，于是"选 A 还是 B"只能靠
                          「重做」写一句意见——那不是回答，那是重开一件活。
                        */}
                        {entry.kind === 'question' ? (
                          <button
                            type="button"
                            onClick={() => {
                              setAnswerId(answerId === entry.id ? null : entry.id);
                              setReply('');
                            }}
                            disabled={pendingId === entry.id}
                            className={cn(buttonClass.primary, 'shrink-0')}
                          >
                            <ArrowUp className="size-3.5" />
                            {t('attention.answer')}
                          </button>
                        ) : level === 'decide' ? (
                          <>
                            <button
                              type="button"
                              onClick={() => void decide(entry, 'approve')}
                              disabled={pendingId === entry.id}
                              className={cn(buttonClass.primary, 'shrink-0')}
                            >
                              <Check className="size-3.5" />
                              {t('attention.approve')}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setReworkId(reworkId === entry.id ? null : entry.id);
                                setNote('');
                              }}
                              disabled={pendingId === entry.id}
                              className={cn(buttonClass.secondary, 'shrink-0')}
                            >
                              <RotateCcw className="size-3.5" />
                              {t('attention.rework')}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void markRead(entry.id)}
                            disabled={busyId === entry.id}
                            className={cn(buttonClass.secondary, 'shrink-0')}
                          >
                            <Check className="size-3.5" />
                            {t('attention.markRead')}
                          </button>
                        )}
                      </div>
                    </div>

                    {answerId === entry.id ? (
                      <div className="mt-2 rounded-lg border border-line bg-surface-muted/40 p-2">
                        <textarea
                          value={reply}
                          onChange={(event) => setReply(event.target.value)}
                          rows={2}
                          autoFocus
                          placeholder={t('attention.answerPlaceholder')}
                          className="w-full resize-none bg-transparent px-1.5 py-1 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-quaternary"
                        />
                        <div className="mt-1 flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setAnswerId(null);
                              setReply('');
                            }}
                            className={buttonClass.secondary}
                          >
                            {t('attention.answerCancel')}
                          </button>
                          <button
                            type="button"
                            onClick={() => void sendAnswer(entry)}
                            disabled={pendingId === entry.id || reply.trim().length === 0}
                            className={buttonClass.primary}
                          >
                            {t('attention.answerConfirm')}
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {reworkId === entry.id ? (
                      <div className="mt-2 rounded-lg border border-line bg-surface-muted/40 p-2">
                        <textarea
                          value={note}
                          onChange={(event) => setNote(event.target.value)}
                          rows={2}
                          autoFocus
                          placeholder={t('attention.reworkPlaceholder')}
                          className="w-full resize-none bg-transparent px-1.5 py-1 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-quaternary"
                        />
                        <div className="mt-1 flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setReworkId(null);
                              setNote('');
                            }}
                            className={buttonClass.secondary}
                          >
                            {t('attention.reworkCancel')}
                          </button>
                          <button
                            type="button"
                            onClick={() => void decide(entry, 'rework', note.trim())}
                            disabled={pendingId === entry.id}
                            className={buttonClass.primary}
                          >
                            {t('attention.reworkConfirm')}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>
          </div>
        );
      })}

      <Section
        title={t('attention.threads')}
        description={t('attention.threadsHint')}
        action={
          <span className="rounded-full bg-surface-muted px-2 py-0.5 text-2xs font-semibold text-ink-tertiary tabular-nums">
            {threads.length}
          </span>
        }
      >
        {threads.length === 0 ? (
          <div className="flex items-center gap-2.5 px-4 py-6 text-sm text-ink-tertiary">
            <Inbox className="size-4" />
            {t('attention.noThreads')}
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {threads.map((thread) => (
              <li key={thread.id} className="flex items-center gap-3 px-4 py-2.5">
                <StatusBadge
                  tone={STATE_TONE[thread.state] ?? 'gray'}
                  label={t(`attention.state.${thread.state}`)}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{thread.title}</div>
                  {thread.goal && thread.goal !== thread.title ? (
                    <div className="truncate text-2xs text-ink-quaternary">{thread.goal}</div>
                  ) : null}
                </div>
                <span className="shrink-0 text-2xs text-ink-quaternary tabular-nums">
                  {relativeTime(thread.lastActivityAt, t)}
                </span>
                {thread.state !== 'done' && thread.state !== 'archived' ? (
                  <button
                    type="button"
                    onClick={() => void closeThread(thread.id)}
                    disabled={busyId === thread.id}
                    className={cn(buttonClass.secondary, 'shrink-0')}
                  >
                    {t('attention.close')}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {decideCount > 0 ? (
        <p className="mt-4 text-2xs text-ink-quaternary">
          {t('attention.decideFootNote', { count: decideCount })}
        </p>
      ) : null}
    </div>
  );
}

/** "3 分钟前" — enough for a queue; exact timestamps live on the row's title. */
function relativeTime(at: number, t: (key: string, options?: Record<string, unknown>) => string): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return t('attention.time.justNow');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('attention.time.minutes', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('attention.time.hours', { count: hours });
  return t('attention.time.days', { count: Math.round(hours / 24) });
}
