import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  CalendarClock,
  PauseCircle,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Timer,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  RouterSchedule,
  RouterScheduleDraft,
  RouterScheduleOccurrence,
} from '@opc/shared/domain';
import { assistantName } from '@/entities/company/model/options';
import { useCompanyProfile } from '@/entities/company/model/useCompany';
import { cn } from '@/shared/lib/cn';
import { BuddyMark } from '@/shared/ui/BuddyMark';
import {
  defaultScheduleTimeZone,
  formatRelativeCountdown,
  formatScheduleDateTime,
  SCHEDULE_TEMPLATES,
  type ScheduleTemplatePreset,
} from '../lib/scheduleTime';
import { ScheduleCard } from './ScheduleCard';
import { ScheduleDialog, type ScheduleDraftSource } from './ScheduleDialog';

type ScheduleFilter = 'all' | 'active' | 'paused' | 'finished';

export function SchedulesView() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const profile = useCompanyProfile();
  const assistantLabel = assistantName(profile, t('company.assistantFallback'));

  const [schedules, setSchedules] = useState<RouterSchedule[]>([]);
  const [occurrences, setOccurrences] = useState<Record<string, RouterScheduleOccurrence[]>>({});
  const [editing, setEditing] = useState<RouterSchedule | null>(null);
  const [seed, setSeed] = useState<ScheduleTemplatePreset | ScheduleDraftSource | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [filter, setFilter] = useState<ScheduleFilter>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    if (!window.opc?.router) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await window.opc.router.listSchedules();
      setSchedules(rows);
      const recent = await Promise.all(
        rows.map(
          async (row) => [row.id, await window.opc!.router.listScheduleOccurrences(row.id)] as const,
        ),
      );
      setOccurrences(Object.fromEntries(recent));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsubscribe = window.opc?.router.onScheduleChanged(() => void refresh());
    const ticker = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => {
      unsubscribe?.();
      window.clearInterval(ticker);
    };
  }, [refresh]);

  const activeSchedules = useMemo(
    () => schedules.filter((schedule) => schedule.status === 'active'),
    [schedules],
  );
  const pausedSchedules = useMemo(
    () => schedules.filter((schedule) => schedule.status === 'paused'),
    [schedules],
  );
  const finishedSchedules = useMemo(
    () =>
      schedules.filter((schedule) => ['completed', 'cancelled'].includes(schedule.status)),
    [schedules],
  );

  const nextUpcoming = useMemo(() => {
    return (
      activeSchedules
        .filter((s): s is RouterSchedule & { nextRunAt: number } => typeof s.nextRunAt === 'number')
        .sort((a, b) => a.nextRunAt - b.nextRunAt)[0] ?? null
    );
  }, [activeSchedules]);

  const recurringActiveCount = activeSchedules.filter((s) => s.rule.kind !== 'once').length;
  const onceActiveCount = activeSchedules.length - recurringActiveCount;

  const visibleSchedules = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return schedules.filter((schedule) => {
      const matchesFilter =
        filter === 'all' ||
        (filter === 'active' && schedule.status === 'active') ||
        (filter === 'paused' && schedule.status === 'paused') ||
        (filter === 'finished' && ['completed', 'cancelled'].includes(schedule.status));
      if (!matchesFilter) return false;
      if (!needle) return true;
      return `${schedule.title} ${schedule.instruction} ${schedule.timezone}`
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [filter, query, schedules]);

  const openCreate = (preset: ScheduleTemplatePreset | ScheduleDraftSource | null = null) => {
    setEditing(null);
    setSeed(preset);
    setError('');
    setDialogOpen(true);
  };

  const openEdit = (schedule: RouterSchedule) => {
    setEditing(schedule);
    setSeed(null);
    setError('');
    setDialogOpen(true);
  };

  const openDuplicate = (schedule: RouterSchedule) => {
    openCreate({
      title: schedule.title,
      instruction: schedule.instruction,
      rule: schedule.rule,
      timezone: schedule.timezone,
    });
  };

  const save = async (draft: RouterScheduleDraft) => {
    setBusy(true);
    setError('');
    try {
      if (editing) {
        await window.opc!.router.updateSchedule(editing.id, draft);
      } else {
        await window.opc!.router.createSchedule(draft);
      }
      setEditing(null);
      setSeed(null);
      setDialogOpen(false);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (schedule: RouterSchedule) => {
    setError('');
    const nextStatus = schedule.status === 'active' ? 'paused' : 'active';
    try {
      await window.opc!.router.updateSchedule(schedule.id, { status: nextStatus });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const cancelSchedule = async (schedule: RouterSchedule) => {
    setError('');
    try {
      await window.opc!.router.cancelSchedule(schedule.id);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const filterTabs: { id: ScheduleFilter; label: string; count: number }[] = [
    { id: 'all', label: t('schedules.filters.all'), count: schedules.length },
    { id: 'active', label: t('schedules.filters.active'), count: activeSchedules.length },
    { id: 'paused', label: t('schedules.filters.paused'), count: pausedSchedules.length },
    { id: 'finished', label: t('schedules.filters.finished'), count: finishedSchedules.length },
  ];

  const currentZone = defaultScheduleTimeZone();

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-panel text-ink">
      <div className="mx-auto w-full max-w-[1120px] px-5 pt-11 pb-8 sm:px-8">
        {/* Top Header */}
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3.5">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-accent/20 bg-accent-soft text-accent-ink">
              <CalendarClock size={19} strokeWidth={1.85} />
            </span>
            <div className="min-w-0">
              <h1 className="text-xl font-bold tracking-tight text-ink">
                {t('schedules.title')}
              </h1>
              <p className="mt-0.5 text-xs-plus text-ink-tertiary">
                {t('schedules.subtitle', { assistant: assistantLabel })}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              title={t('schedules.refresh')}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-xs-plus font-medium text-ink-secondary transition hover:border-line-strong hover:text-ink disabled:opacity-50"
            >
              <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
              <span className="hidden sm:inline">{t('schedules.refresh')}</span>
            </button>
            <button
              type="button"
              onClick={() => openCreate(null)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-sm font-medium text-white shadow-xs transition hover:bg-accent-hover"
            >
              <Plus size={16} />
              {t('schedules.newPlan')}
            </button>
          </div>
        </header>

        {/* Hero Bento Summary */}
        <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div className="flex flex-col justify-between rounded-xl border border-line bg-gradient-to-br from-accent/[0.06] via-surface to-surface p-4 sm:col-span-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-ink-tertiary">
                {t('schedules.spotlight.label')}
              </span>
              <span className="grid size-7 place-items-center rounded-lg border border-accent/20 bg-accent-soft text-accent-ink">
                <Timer size={14} />
              </span>
            </div>
            {nextUpcoming ? (
              <div className="mt-2.5 flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => openEdit(nextUpcoming)}
                    className="block max-w-full truncate text-left text-base font-semibold text-ink transition hover:text-accent-ink"
                  >
                    {nextUpcoming.title}
                  </button>
                  <p className="mt-0.5 truncate font-mono text-2xs text-ink-tertiary tabular-nums">
                    {formatScheduleDateTime(
                      nextUpcoming.nextRunAt,
                      nextUpcoming.timezone,
                      locale,
                      nowMs,
                    )}{' '}
                    · {nextUpcoming.timezone}
                  </p>
                </div>
                <span className="shrink-0 rounded-full border border-accent/25 bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent-ink tabular-nums">
                  {formatRelativeCountdown(nextUpcoming.nextRunAt, nowMs, locale)}
                </span>
              </div>
            ) : (
              <div className="mt-2.5">
                <div className="text-sm font-medium text-ink-secondary">
                  {t('schedules.spotlight.noneTitle')}
                </div>
                <p className="mt-0.5 text-2xs text-ink-quaternary">
                  {t('schedules.spotlight.noneHint')}
                </p>
              </div>
            )}
          </div>

          <div className="flex flex-col justify-between rounded-xl border border-line bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-ink-tertiary">
                {t('schedules.metrics.active')}
              </span>
              <span className="grid size-7 place-items-center rounded-lg border border-success/25 bg-success/10 text-success">
                <Activity size={14} />
              </span>
            </div>
            <div className="mt-2.5">
              <div className="font-mono text-[1.45rem] leading-none font-bold text-ink tabular-nums">
                {activeSchedules.length}
              </div>
              <div className="mt-1.5 text-3xs text-ink-quaternary tabular-nums">
                {t('schedules.metrics.activeDetail', {
                  recurring: recurringActiveCount,
                  once: onceActiveCount,
                })}
              </div>
            </div>
          </div>

          <div className="flex flex-col justify-between rounded-xl border border-line bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-ink-tertiary">
                {t('schedules.metrics.pausedAndDone')}
              </span>
              <span className="grid size-7 place-items-center rounded-lg border border-line bg-surface-muted text-ink-secondary">
                <PauseCircle size={14} />
              </span>
            </div>
            <div className="mt-2.5 flex items-baseline gap-3">
              <div>
                <div className="font-mono text-[1.45rem] leading-none font-bold text-ink tabular-nums">
                  {pausedSchedules.length}
                </div>
                <div className="mt-1.5 text-3xs text-ink-quaternary">
                  {t('schedules.metrics.pausedCount')}
                </div>
              </div>
              <span className="h-6 w-px bg-line" aria-hidden />
              <div>
                <div className="font-mono text-[1.45rem] leading-none font-bold text-ink-tertiary tabular-nums">
                  {finishedSchedules.length}
                </div>
                <div className="mt-1.5 text-3xs text-ink-quaternary">
                  {t('schedules.metrics.doneCount')}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Filter & Search Toolbar */}
        <section aria-label={t('schedules.title')}>
          <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2.5">
            <div
              role="tablist"
              aria-label={t('schedules.title')}
              className="inline-flex overflow-x-auto rounded-lg border border-line bg-surface-muted/70 p-0.5"
            >
              {filterTabs.map((tab) => {
                const active = filter === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setFilter(tab.id)}
                    className={cn(
                      'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] px-2.5 text-xs whitespace-nowrap transition-colors',
                      active
                        ? 'bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                        : 'text-ink-tertiary hover:text-ink',
                    )}
                  >
                    <span>{tab.label}</span>
                    <span className="font-mono text-[10px] text-ink-quaternary tabular-nums">
                      {tab.count}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex w-full items-center gap-2 sm:w-auto">
              <span className="hidden rounded-md bg-surface-muted/80 px-2 py-1 font-mono text-3xs text-ink-quaternary lg:inline-flex">
                {currentZone}
              </span>
              <label className="flex h-8 w-full items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-ink-quaternary focus-within:border-accent sm:w-[240px]">
                <Search size={14} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('schedules.searchPlaceholder')}
                  className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-quaternary"
                />
                {query ? (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    aria-label={t('schedules.clearSearch')}
                    className="rounded p-0.5 text-ink-quaternary hover:text-ink"
                  >
                    <X size={12} />
                  </button>
                ) : null}
              </label>
            </div>
          </div>

          {error && !dialogOpen ? (
            <p
              role="alert"
              className="mb-3 rounded-xl border border-danger/35 bg-danger/10 px-3.5 py-2.5 text-xs text-danger"
            >
              {error}
            </p>
          ) : null}

          {/* Schedule Cards or Empty/Template Experience */}
          {visibleSchedules.length > 0 ? (
            <div className="space-y-2.5">
              {visibleSchedules.map((schedule) => (
                <ScheduleCard
                  key={schedule.id}
                  schedule={schedule}
                  occurrences={occurrences[schedule.id] ?? []}
                  nowMs={nowMs}
                  locale={locale}
                  onEdit={() => openEdit(schedule)}
                  onDuplicate={() => openDuplicate(schedule)}
                  onToggle={() => void toggleStatus(schedule)}
                  onCancel={() => void cancelSchedule(schedule)}
                />
              ))}
            </div>
          ) : schedules.length === 0 ? (
            <div className="rounded-2xl border border-line bg-surface px-6 py-9">
              <div className="mx-auto flex max-w-md flex-col items-center text-center">
                <BuddyMark size="lg" phase="idle" interactive />
                <h2 className="mt-2 text-base font-semibold text-ink">
                  {t('schedules.empty.title')}
                </h2>
                <p className="mt-1 text-xs-plus leading-relaxed text-ink-tertiary">
                  {t('schedules.empty.subtitle', { assistant: assistantLabel })}
                </p>
                <button
                  type="button"
                  onClick={() => openCreate(null)}
                  className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-4 text-sm font-medium text-white transition hover:bg-accent-hover"
                >
                  <Plus size={15} />
                  {t('schedules.newPlan')}
                </button>
              </div>

              <div className="mt-7 border-t border-line pt-5">
                <div className="mb-3 flex items-center gap-1.5 text-xs font-medium text-ink-tertiary">
                  <Sparkles size={13} className="text-accent-ink" />
                  <span>{t('schedules.empty.quickStart')}</span>
                </div>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {SCHEDULE_TEMPLATES.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => openCreate(preset)}
                      className="group rounded-xl border border-line bg-surface-muted/35 p-3.5 text-left transition hover:border-accent/45 hover:bg-accent-soft/40"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-ink group-hover:text-accent-ink">
                          {t(preset.titleKey)}
                        </span>
                        <span className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-3xs text-ink-tertiary">
                          {t(`schedules.ruleKinds.${preset.kind}`)}
                          {preset.time ? ` · ${preset.time}` : ''}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-tertiary">
                        {t(preset.instructionKey)}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-line bg-surface px-6 py-12 text-center">
              <span className="mb-3 grid size-10 place-items-center rounded-full bg-surface-muted text-ink-quaternary">
                <CalendarClock size={18} />
              </span>
              <p className="text-sm font-medium text-ink">{t('schedules.empty.noMatchTitle')}</p>
              <p className="mt-1 text-xs text-ink-tertiary">
                {t('schedules.empty.noMatchSubtitle')}
              </p>
              <button
                type="button"
                onClick={() => {
                  setFilter('all');
                  setQuery('');
                }}
                className="mt-4 h-8 rounded-lg border border-line px-3 text-xs font-medium text-ink-secondary transition hover:border-line-strong hover:text-ink"
              >
                {t('schedules.empty.resetFilters')}
              </button>
            </div>
          )}
        </section>
      </div>

      <ScheduleDialog
        open={dialogOpen}
        editing={editing}
        seed={seed}
        busy={busy}
        error={error}
        locale={locale}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
          setSeed(null);
          setError('');
        }}
        onSave={save}
      />
    </main>
  );
}
