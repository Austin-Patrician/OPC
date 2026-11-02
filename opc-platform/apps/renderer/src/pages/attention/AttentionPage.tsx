import { useCallback, useEffect, useState } from 'react';
import { Check, Inbox, RefreshCw, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AttentionEntry } from '@opc/shared/ipc';
import type { WorkThread } from '@opc/shared/domain';
import { buttonClass, PageHeader, Section, StatusBadge } from '@/features/settings/ui/kit';
import { cn } from '@/shared/lib/cn';

/**
 * 注意力队列 —— 老板打开应用看到的第一个页面。
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

      {error ? (
        <div className="mb-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
          {error}
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
                  <li key={entry.id} className="flex items-start gap-3 px-4 py-3">
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
                    <button
                      type="button"
                      onClick={() => void markRead(entry.id)}
                      disabled={busyId === entry.id}
                      className={cn(buttonClass.secondary, 'shrink-0')}
                    >
                      <Check className="size-3.5" />
                      {t('attention.markRead')}
                    </button>
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
