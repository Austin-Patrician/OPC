import { useEffect, useState } from 'react';
import {
  ChevronDown,
  Clock,
  Copy,
  Pause,
  Pencil,
  Play,
  Repeat,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  RouterSchedule,
  RouterScheduleOccurrence,
  RouterScheduleRule,
} from '@opc/shared/domain';
import { cn } from '@/shared/lib/cn';
import { formatRelativeCountdown, formatScheduleDateTime } from '../lib/scheduleTime';

interface ScheduleCardProps {
  schedule: RouterSchedule;
  occurrences: readonly RouterScheduleOccurrence[];
  nowMs: number;
  locale: string;
  onEdit: () => void;
  onDuplicate: () => void;
  onToggle: () => void;
  onCancel: () => void;
}

export function ScheduleCard({
  schedule,
  occurrences,
  nowMs,
  locale,
  onEdit,
  onDuplicate,
  onToggle,
  onCancel,
}: ScheduleCardProps) {
  const { t } = useTranslation();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    if (!confirmCancel) return undefined;
    const timer = window.setTimeout(() => setConfirmCancel(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmCancel]);

  const isLive = schedule.status === 'active' || schedule.status === 'paused';
  const isRecurring = schedule.rule.kind !== 'once';

  const statusTone =
    schedule.status === 'active'
      ? {
          bar: 'bg-success',
          badge: 'border-success/25 bg-success/10 text-success',
          dot: 'bg-success',
        }
      : schedule.status === 'paused'
        ? {
            bar: 'bg-warning',
            badge: 'border-warning/25 bg-warning/10 text-warning',
            dot: 'bg-warning',
          }
        : {
            bar: 'bg-ink-quaternary/35',
            badge: 'border-line bg-surface-muted text-ink-tertiary',
            dot: 'bg-ink-quaternary',
          };

  const ruleText = (() => {
    const rule: RouterScheduleRule = schedule.rule;
    if (rule.kind === 'once') {
      return t('schedules.ruleSummary.once', {
        time: formatScheduleDateTime(rule.at, schedule.timezone, locale, nowMs),
      });
    }
    if (rule.kind === 'weekly') {
      const days = rule.daysOfWeek
        .map((day) => t(`schedules.weekdaysShort.${day}`))
        .join(locale.startsWith('zh') ? '、' : ', ');
      return t('schedules.ruleSummary.weekly', { days, time: rule.time });
    }
    if (rule.kind === 'monthly') {
      return t('schedules.ruleSummary.monthly', { day: rule.dayOfMonth, time: rule.time });
    }
    if (rule.kind === 'weekdays') {
      return t('schedules.ruleSummary.weekdays', { time: rule.time });
    }
    return t('schedules.ruleSummary.daily', { time: rule.time });
  })();

  return (
    <article className="group relative overflow-hidden rounded-xl border border-line bg-surface transition-colors hover:border-line-strong">
      <span
        aria-hidden
        className={cn('absolute inset-y-0 left-0 w-[3px]', statusTone.bar)}
      />

      <div className="p-4 pl-5">
        {/* Header Row */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {isLive ? (
                <button
                  type="button"
                  onClick={onEdit}
                  className="truncate text-left text-base font-semibold text-ink transition-colors hover:text-accent-ink"
                >
                  {schedule.title}
                </button>
              ) : (
                <h3 className="truncate text-base font-semibold text-ink">{schedule.title}</h3>
              )}

              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-3xs font-medium',
                  statusTone.badge,
                )}
              >
                <span className={cn('size-1.5 rounded-full', statusTone.dot)} />
                {t(`schedules.status.${schedule.status}`)}
              </span>

              <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line bg-surface-muted/60 px-1.5 py-0.5 text-3xs text-ink-secondary">
                {isRecurring ? <Repeat size={11} /> : <Clock size={11} />}
                {ruleText}
              </span>
            </div>

            <p className="mt-1.5 line-clamp-2 text-xs-plus leading-relaxed text-ink-secondary">
              {schedule.instruction}
            </p>
          </div>

          {/* Right Countdown / Next Trigger */}
          <div className="shrink-0 text-right">
            {schedule.status === 'active' && schedule.nextRunAt ? (
              <>
                <div className="text-sm font-semibold text-accent-ink tabular-nums">
                  {formatRelativeCountdown(schedule.nextRunAt, nowMs, locale)}
                </div>
                <div className="mt-0.5 font-mono text-2xs text-ink-tertiary tabular-nums">
                  {formatScheduleDateTime(schedule.nextRunAt, schedule.timezone, locale, nowMs)}
                </div>
              </>
            ) : schedule.status === 'paused' ? (
              <span className="text-xs text-warning">{t('schedules.status.paused')}</span>
            ) : schedule.lastRunAt ? (
              <div className="font-mono text-2xs text-ink-quaternary tabular-nums">
                {t('schedules.lastRunAt', {
                  time: formatScheduleDateTime(schedule.lastRunAt, schedule.timezone, locale, nowMs),
                })}
              </div>
            ) : null}
          </div>
        </div>

        {/* Footer Metadata + Quick Actions */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line/70 pt-2.5">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-ink-quaternary">
            <span className="font-mono">{schedule.timezone}</span>
            {schedule.lastRunAt && schedule.status === 'active' ? (
              <>
                <span aria-hidden>·</span>
                <span>
                  {t('schedules.lastRunAt', {
                    time: formatScheduleDateTime(schedule.lastRunAt, schedule.timezone, locale, nowMs),
                  })}
                </span>
              </>
            ) : null}
            {occurrences.length > 0 ? (
              <>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  aria-expanded={historyOpen}
                  onClick={() => setHistoryOpen((prev) => !prev)}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium text-ink-secondary transition hover:bg-surface-muted hover:text-ink"
                >
                  <span>{t('schedules.historyToggle', { count: occurrences.length })}</span>
                  <ChevronDown
                    size={12}
                    className={cn('transition-transform duration-150', historyOpen && 'rotate-180')}
                  />
                </button>
              </>
            ) : null}
          </div>

          <div className="flex items-center gap-1">
            {isLive ? (
              <>
                <button
                  type="button"
                  title={t('schedules.actions.edit')}
                  aria-label={t('schedules.actions.edit')}
                  onClick={onEdit}
                  className="grid size-7 place-items-center rounded-md text-ink-tertiary transition hover:bg-surface-muted hover:text-ink"
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  title={t(
                    schedule.status === 'active'
                      ? 'schedules.actions.pause'
                      : 'schedules.actions.resume',
                  )}
                  aria-label={t(
                    schedule.status === 'active'
                      ? 'schedules.actions.pause'
                      : 'schedules.actions.resume',
                  )}
                  onClick={onToggle}
                  className="grid size-7 place-items-center rounded-md text-ink-tertiary transition hover:bg-surface-muted hover:text-ink"
                >
                  {schedule.status === 'active' ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button
                  type="button"
                  title={t('schedules.actions.duplicate')}
                  aria-label={t('schedules.actions.duplicate')}
                  onClick={onDuplicate}
                  className="grid size-7 place-items-center rounded-md text-ink-tertiary transition hover:bg-surface-muted hover:text-ink"
                >
                  <Copy size={14} />
                </button>
                {confirmCancel ? (
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmCancel(false);
                      onCancel();
                    }}
                    className="h-7 rounded-md border border-danger/35 bg-danger/10 px-2 text-2xs font-medium text-danger transition hover:bg-danger/15"
                  >
                    {t('schedules.actions.confirmCancel')}
                  </button>
                ) : (
                  <button
                    type="button"
                    title={t('schedules.actions.cancel')}
                    aria-label={t('schedules.actions.cancel')}
                    onClick={() => setConfirmCancel(true)}
                    className="grid size-7 place-items-center rounded-md text-ink-quaternary transition hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                onClick={onDuplicate}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface-muted/50 px-2 text-2xs font-medium text-ink-secondary transition hover:border-line-strong hover:text-ink"
              >
                <Copy size={12} />
                {t('schedules.actions.reuse')}
              </button>
            )}
          </div>
        </div>

        {/* Expandable Occurrence History */}
        {historyOpen && occurrences.length > 0 ? (
          <div className="mt-3 rounded-lg border border-line bg-surface-muted/35 px-3 py-2">
            <ul className="divide-y divide-line/60">
              {occurrences.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-2 py-1.5 text-2xs"
                >
                  <div className="flex items-center gap-2 text-ink-secondary tabular-nums">
                    <span className="font-mono">
                      {formatScheduleDateTime(item.scheduledFor, schedule.timezone, locale, nowMs)}
                    </span>
                    {item.missedCount > 0 ? (
                      <span className="rounded bg-warning/10 px-1.5 py-0.5 text-3xs text-warning">
                        {t('schedules.missedMerged', { count: item.missedCount })}
                      </span>
                    ) : null}
                  </div>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-3xs font-medium',
                      item.triage === 'routed' || item.triage === 'accepted'
                        ? 'bg-success/10 text-success'
                        : item.triage === 'dropped'
                          ? 'bg-surface-muted text-ink-quaternary'
                          : 'bg-accent-soft text-accent-ink',
                    )}
                  >
                    {t(`schedules.triage.${item.triage}`)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </article>
  );
}
