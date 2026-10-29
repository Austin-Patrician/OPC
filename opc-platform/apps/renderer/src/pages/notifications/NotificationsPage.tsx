import { useCallback, useEffect, useState } from 'react';
import { BellOff, Inbox, RefreshCw, ShieldAlert, Users2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CommInboxView, CommOverview } from '@opc/shared/ipc';
import { PageHeader, Section } from '@/features/settings/ui/kit';
import { cn } from '@/shared/lib/cn';

const PRIORITY_STYLE: Record<number, string> = {
  0: 'bg-danger/12 text-danger',
  1: 'bg-accent-soft text-accent-ink',
  2: 'bg-ink/5 text-ink-tertiary',
  3: 'bg-ink/5 text-ink-quaternary',
};

/**
 * 通知与护栏：员工什么时候被唤醒、被谁拦下、和谁在说话。
 *
 * Every number here is a row in `inbox_item` / `guard_event` / `relationship` /
 * `wake_quota` — nothing is estimated in the renderer. Empty states say what is
 * missing instead of showing a zero-filled dashboard, and a refused wake is shown as
 * prominently as a delivered message (决定② C: 压制要可见).
 */
export function NotificationsPage() {
  const { t } = useTranslation();
  const [overview, setOverview] = useState<CommOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Last action's outcome, shown inline instead of a modal nobody reads. */
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!window.opc?.comm) return;
    try {
      setOverview(await window.opc.comm.overview());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // The main process coalesces bursts; here we only re-read the projection.
    const unsubscribe = window.opc?.comm.onOverviewChanged(() => void load());
    return () => unsubscribe?.();
  }, [load]);

  /** 老板手动唤醒：绕过心跳与配额（P0 特权）。 */
  const wakeNow = async (employeeId: string, employeeName: string) => {
    if (!window.opc?.comm) return;
    setBusyId(employeeId);
    setNotice(null);
    try {
      const result = await window.opc.comm.wake(employeeId);
      setNotice(
        result.ok
          ? t('notifications.woke', { name: employeeName, items: result.items })
          : t('notifications.wakeFailed', { name: employeeName, reason: result.message }),
      );
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(null);
    }
  };

  /** 标记护栏为已读；记录保留，只是不再占位置。 */
  const dismissGuards = async (ids?: string[]) => {
    if (!window.opc?.comm) return;
    setNotice(null);
    try {
      const count = await window.opc.comm.dismissGuards(ids);
      setNotice(t('notifications.dismissed', { count }));
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const clock = (at: number) =>
    new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const waiting = overview?.inbox.length ?? 0;
  const guarded = overview?.guards.length ?? 0;

  return (
    <div className="page-scroll flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-panel">
      <div className="mx-auto w-full max-w-[62rem] px-6 py-6">
        <PageHeader
          crumbs={[t('nav.mail')]}
          title={t('notifications.title')}
          description={t('notifications.subtitle')}
          actions={
            <button
              type="button"
              onClick={() => void load()}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-secondary transition-colors hover:text-ink"
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
              {t('notifications.refresh')}
            </button>
          }
        />

        {error ? (
          <p className="mb-4 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}

        {notice ? (
          <p className="mb-4 rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-sm text-accent-ink">
            {notice}
          </p>
        ) : null}

        <div className="flex flex-col gap-4">
          <Section
            title={`${t('notifications.inbox')} · ${waiting}`}
            description={t('notifications.inboxHint')}
            action={<Inbox className="size-4 text-ink-quaternary" />}
          >
            {overview && overview.inbox.length > 0 ? (
              <ul className="divide-y divide-line">
                {overview.inbox.map((item) => (
                  <InboxRow
                    key={item.id}
                    item={item}
                    clock={clock}
                    busy={busyId === item.employeeId}
                    onWake={() => void wakeNow(item.employeeId, item.employeeName)}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState text={t('notifications.inboxEmpty')} />
            )}
          </Section>

          <Section
            title={`${t('notifications.guards')} · ${guarded}`}
            description={t('notifications.guardsHint')}
            action={
              <div className="flex items-center gap-2">
                {guarded > 0 ? (
                  <button
                    type="button"
                    onClick={() => void dismissGuards()}
                    className="rounded px-2 py-1 text-2xs font-medium text-ink-tertiary transition-colors hover:bg-ink/5 hover:text-ink"
                  >
                    {t('notifications.dismissAll')}
                  </button>
                ) : null}
                <ShieldAlert className="size-4 text-ink-quaternary" />
              </div>
            }
          >
            {overview && overview.guards.length > 0 ? (
              <ul className="divide-y divide-line">
                {overview.guards.map((guard) => (
                  <li key={guard.id} className="flex items-start gap-3 px-4 py-2.5">
                    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-warning/12 text-warning">
                      <BellOff className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm-plus font-medium text-ink">
                        {guard.employeeName}
                        <span className="ml-1.5 rounded bg-ink/5 px-1.5 py-0.5 text-2xs font-medium text-ink-tertiary">
                          {t(`notifications.guard.${guard.kind}`)}
                        </span>
                      </p>
                      <p className="mt-0.5 text-xs-plus leading-relaxed text-ink-tertiary">
                        {describeGuard(guard.detail, t)}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs-plus text-ink-quaternary">
                      {clock(guard.createdAt)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void dismissGuards([guard.id])}
                      className="shrink-0 self-center rounded px-2 py-1 text-2xs font-medium text-ink-tertiary transition-colors hover:bg-ink/5 hover:text-ink"
                    >
                      {t('notifications.dismiss')}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState text={t('notifications.guardsEmpty')} />
            )}
          </Section>

          <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
            <Section
              title={`${t('notifications.relationships')} · ${overview?.relationships.length ?? 0}`}
              description={t('notifications.relationshipsHint')}
              action={<Users2 className="size-4 text-ink-quaternary" />}
            >
              {overview && overview.relationships.length > 0 ? (
                <ul className="divide-y divide-line">
                  {overview.relationships.map((edge) => (
                    <li key={edge.id} className="flex items-center gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm-plus font-medium text-ink">
                          {edge.fromName}
                          <span className="mx-1.5 text-ink-quaternary">→</span>
                          {edge.toName}
                        </p>
                        <p className="mt-0.5 text-xs-plus text-ink-tertiary">
                          {t(`notifications.relation.${edge.kind}`)} ·{' '}
                          {t('notifications.interactions', { count: edge.interactionCount })}
                        </p>
                      </div>
                      <div className="flex w-24 shrink-0 items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink/8">
                          <div
                            className={cn(
                              'h-full rounded-full',
                              edge.strength >= 0.7
                                ? 'bg-success'
                                : edge.strength >= 0.55
                                  ? 'bg-accent'
                                  : 'bg-ink-quaternary',
                            )}
                            style={{ width: `${Math.round(edge.strength * 100)}%` }}
                          />
                        </div>
                        <span className="w-9 text-right text-2xs text-ink-quaternary">
                          {edge.strength.toFixed(2)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState text={t('notifications.relationshipsEmpty')} />
              )}
            </Section>

            <Section
              title={t('notifications.quotas')}
              description={t('notifications.quotasHint')}
            >
              <ul className="divide-y divide-line">
                {(overview?.quotas ?? []).map((quota) => (
                  <li key={quota.employeeId} className="flex items-center justify-between gap-3 px-4 py-2">
                    <span className="min-w-0 truncate text-sm-plus text-ink">{quota.employeeName}</span>
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium',
                        quota.remaining === 0
                          ? 'bg-warning/12 text-warning'
                          : 'bg-ink/5 text-ink-tertiary',
                      )}
                    >
                      {quota.used}/{quota.limit}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

function InboxRow({
  item,
  clock,
  busy,
  onWake,
}: {
  item: CommInboxView;
  clock: (at: number) => string;
  busy: boolean;
  onWake: () => void;
}) {
  const { t } = useTranslation();
  const open = () => {
    if (item.conversationId) window.location.hash = `#/chat/${item.conversationId}`;
  };

  return (
    <li className="flex items-start gap-3 px-4 py-2.5">
      <span
        className={cn(
          'mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium',
          PRIORITY_STYLE[item.priority] ?? PRIORITY_STYLE[3],
        )}
      >
        {t(`notifications.priority.${item.priority}`)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm-plus text-ink">
          <span className="font-medium">{item.employeeName}</span>
          {item.fromName ? (
            <span className="ml-1 text-ink-tertiary">
              ← {item.fromName} · {t(`notifications.source.${item.sourceType}`)}
            </span>
          ) : (
            <span className="ml-1 text-ink-tertiary">
              · {t(`notifications.source.${item.sourceType}`)}
            </span>
          )}
        </p>
        {item.preview ? (
          <p className="mt-0.5 truncate text-xs-plus text-ink-tertiary">{item.preview}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-xs-plus text-ink-quaternary">{clock(item.createdAt)}</span>
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-2xs font-medium',
            item.requiresWake ? 'bg-accent-soft text-accent-ink' : 'bg-ink/5 text-ink-tertiary',
          )}
        >
          {item.requiresWake ? t('notifications.wakeNow') : t('notifications.wakeLater')}
        </span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 self-center">
        <button
          type="button"
          onClick={onWake}
          disabled={busy}
          className="rounded px-2 py-1 text-2xs font-medium text-accent transition-colors hover:bg-accent-soft disabled:opacity-50"
        >
          {busy ? t('notifications.waking') : t('notifications.wake')}
        </button>
        {item.conversationId ? (
          <button
            type="button"
            onClick={open}
            className="rounded px-2 py-1 text-2xs font-medium text-ink-tertiary transition-colors hover:bg-ink/5 hover:text-ink"
          >
            {t('notifications.openChat')}
          </button>
        ) : null}
      </div>
    </li>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="px-4 py-6 text-center text-sm text-ink-quaternary">{text}</p>;
}

/** Turns guard detail into one readable line; unknown keys stay visible, not hidden. */
function describeGuard(
  detail: Readonly<Record<string, string | number | boolean>>,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (typeof detail.reason === 'string') {
    const key = `notifications.reason.${detail.reason}`;
    const translated = t(key);
    if (translated !== key) return translated;
  }
  if (typeof detail.sentInHour === 'number' && typeof detail.limit === 'number') {
    return t('notifications.guardRate', {
      sent: detail.sentInHour,
      limit: detail.limit,
      to: typeof detail.toName === 'string' ? detail.toName : '',
    });
  }
  if (typeof detail.fromName === 'string') {
    return t('notifications.guardQuota', { from: detail.fromName });
  }
  // Never hide an unexplained row: show the raw detail instead.
  return Object.entries(detail)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' · ');
}
