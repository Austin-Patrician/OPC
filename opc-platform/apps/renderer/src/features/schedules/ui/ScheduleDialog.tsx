import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, Check, LoaderCircle, Plus, Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RouterSchedule, RouterScheduleDraft, RouterScheduleRule } from '@opc/shared/domain';
import { cn } from '@/shared/lib/cn';
import { Select } from '@/shared/ui/Select';
import {
  buildTimezoneOptions,
  computePreviewNextRun,
  datePartsInZone,
  defaultOnceDateAndTime,
  defaultScheduleTimeZone,
  formatRelativeCountdown,
  formatScheduleDateTime,
  offsetDateInput,
  SCHEDULE_TEMPLATES,
  wallTimeToEpoch,
  type ScheduleTemplatePreset,
} from '../lib/scheduleTime';

export interface ScheduleDraftSource {
  title: string;
  instruction: string;
  rule: RouterScheduleRule;
  timezone: string;
}

interface FormState {
  title: string;
  instruction: string;
  kind: RouterScheduleRule['kind'];
  date: string;
  time: string;
  dayOfMonth: number;
  days: number[];
  timezone: string;
}

const RULE_KINDS: readonly RouterScheduleRule['kind'][] = [
  'once',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
];

const QUICK_TIMES = ['08:30', '09:00', '18:00', '21:00'] as const;

function buildInitialForm(
  editing: RouterSchedule | null,
  seed: ScheduleTemplatePreset | ScheduleDraftSource | null,
): FormState {
  const defaultZone = defaultScheduleTimeZone();
  if (editing) {
    const rule = editing.rule;
    const onceParts =
      rule.kind === 'once'
        ? datePartsInZone(rule.at, editing.timezone)
        : datePartsInZone(Date.now(), editing.timezone);
    const defaultOnce = defaultOnceDateAndTime(editing.timezone);
    return {
      title: editing.title,
      instruction: editing.instruction,
      kind: rule.kind,
      date:
        rule.kind === 'once'
          ? `${onceParts.year}-${String(onceParts.month).padStart(2, '0')}-${String(onceParts.day).padStart(2, '0')}`
          : defaultOnce.date,
      time:
        rule.kind === 'once'
          ? `${String(onceParts.hour).padStart(2, '0')}:${String(onceParts.minute).padStart(2, '0')}`
          : rule.time,
      dayOfMonth: rule.kind === 'monthly' ? rule.dayOfMonth : 1,
      days: rule.kind === 'weekly' ? rule.daysOfWeek : [1],
      timezone: editing.timezone,
    };
  }

  if (seed && 'rule' in seed) {
    const tz = seed.timezone || defaultZone;
    const defaultOnce = defaultOnceDateAndTime(tz);
    const rule = seed.rule;
    return {
      title: seed.title,
      instruction: seed.instruction,
      kind: rule.kind,
      date: defaultOnce.date,
      time: rule.kind === 'once' ? defaultOnce.time : rule.time,
      dayOfMonth: rule.kind === 'monthly' ? rule.dayOfMonth : 1,
      days: rule.kind === 'weekly' ? rule.daysOfWeek : [1],
      timezone: tz,
    };
  }

  const defaultOnce = defaultOnceDateAndTime(defaultZone);
  return {
    title: '',
    instruction: '',
    kind: seed?.kind ?? 'once',
    date: defaultOnce.date,
    time: seed?.time ?? defaultOnce.time,
    dayOfMonth: seed?.dayOfMonth ?? 1,
    days: seed?.days ?? [1],
    timezone: defaultZone,
  };
}

interface ScheduleDialogProps {
  open: boolean;
  editing: RouterSchedule | null;
  seed: ScheduleTemplatePreset | ScheduleDraftSource | null;
  busy: boolean;
  error: string;
  locale: string;
  onClose: () => void;
  onSave: (draft: RouterScheduleDraft) => Promise<void>;
}

export function ScheduleDialog({
  open,
  editing,
  seed,
  busy,
  error,
  locale,
  onClose,
  onSave,
}: ScheduleDialogProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState>(() => buildInitialForm(editing, seed));

  useEffect(() => {
    if (!open) return;
    const next = buildInitialForm(editing, seed);
    if (seed && !('rule' in seed)) {
      next.title = t(seed.titleKey);
      next.instruction = t(seed.instructionKey);
    }
    setForm(next);
  }, [editing, open, seed, t]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose, open]);

  const patchForm = (patch: Partial<FormState>) =>
    setForm((current) => ({ ...current, ...patch }));

  const timezoneOptions = useMemo(
    () => buildTimezoneOptions([defaultScheduleTimeZone(), form.timezone]),
    [form.timezone],
  );

  const applyTemplate = (preset: ScheduleTemplatePreset) => {
    const once = defaultOnceDateAndTime(form.timezone);
    patchForm({
      title: t(preset.titleKey),
      instruction: t(preset.instructionKey),
      kind: preset.kind,
      date: once.date,
      time: preset.time ?? once.time,
      dayOfMonth: preset.dayOfMonth ?? 1,
      days: preset.days ?? [1],
    });
  };

  const weekdayLabels = useMemo(
    () => [1, 2, 3, 4, 5, 6, 7].map((day) => t(`schedules.weekdaysShort.${day}`)),
    [t],
  );

  const preview = useMemo(() => {
    try {
      if (form.kind === 'once' && (!form.date || !form.time)) return { nextAt: null, pastOnce: true };
      const rule: RouterScheduleRule =
        form.kind === 'once'
          ? { kind: 'once', at: wallTimeToEpoch(form.date, form.time, form.timezone) }
          : form.kind === 'weekly'
            ? { kind: 'weekly', time: form.time, daysOfWeek: form.days }
            : form.kind === 'monthly'
              ? { kind: 'monthly', time: form.time, dayOfMonth: form.dayOfMonth }
              : { kind: form.kind, time: form.time };
      const nextAt = computePreviewNextRun(rule, form.timezone);
      return {
        nextAt,
        pastOnce: form.kind === 'once' && nextAt === null,
      };
    } catch {
      return { nextAt: null, pastOnce: form.kind === 'once' };
    }
  }, [form]);

  if (!open) return null;

  const canSubmit =
    !busy &&
    form.title.trim().length > 0 &&
    form.instruction.trim().length > 0 &&
    !(form.kind === 'weekly' && form.days.length === 0) &&
    preview.nextAt !== null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const rule: RouterScheduleRule =
      form.kind === 'once'
        ? { kind: 'once', at: wallTimeToEpoch(form.date, form.time, form.timezone) }
        : form.kind === 'weekly'
          ? { kind: 'weekly', time: form.time, daysOfWeek: form.days }
          : form.kind === 'monthly'
            ? { kind: 'monthly', time: form.time, dayOfMonth: form.dayOfMonth }
            : { kind: form.kind, time: form.time };
    await onSave({
      title: form.title,
      instruction: form.instruction,
      rule,
      timezone: form.timezone,
    });
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/35 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-dialog-title"
        className="my-auto max-h-[min(92vh,780px)] w-full max-w-[540px] overflow-y-auto rounded-2xl border border-line bg-surface text-ink shadow-2xl"
      >
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface/95 px-5 py-4 backdrop-blur-md">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg border border-accent/20 bg-accent-soft text-accent-ink">
              <CalendarClock size={16} />
            </span>
            <div>
              <h2 id="schedule-dialog-title" className="text-base font-semibold text-ink">
                {editing ? t('schedules.dialog.editTitle') : t('schedules.dialog.createTitle')}
              </h2>
              <p className="text-xs text-ink-tertiary">{t('schedules.dialog.subtitle')}</p>
            </div>
          </div>
          <button
            type="button"
            title={t('common.close')}
            aria-label={t('common.close')}
            onClick={onClose}
            disabled={busy}
            className="grid size-8 place-items-center rounded-lg text-ink-tertiary transition hover:bg-surface-muted hover:text-ink disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </header>

        <form onSubmit={(event) => void submit(event)} className="space-y-4 px-5 py-4">
          {!editing ? (
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-medium text-ink-tertiary">
                <Sparkles size={12} className="text-accent-ink" />
                <span>{t('schedules.dialog.quickTemplates')}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {SCHEDULE_TEMPLATES.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyTemplate(preset)}
                    className="rounded-full border border-line bg-surface-muted/50 px-2.5 py-1 text-xs text-ink-secondary transition hover:border-accent/45 hover:bg-accent-soft hover:text-accent-ink"
                  >
                    {t(preset.titleKey)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <label className="block text-xs font-medium text-ink-secondary">
            {t('schedules.dialog.name')}
            <input
              required
              value={form.title}
              placeholder={t('schedules.dialog.namePlaceholder')}
              onChange={(event) => patchForm({ title: event.target.value })}
              className="mt-1.5 h-10 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink outline-none transition placeholder:text-ink-quaternary focus:border-accent focus:ring-2 focus:ring-accent/15"
            />
          </label>

          <label className="block text-xs font-medium text-ink-secondary">
            {t('schedules.dialog.instruction')}
            <textarea
              required
              rows={3}
              value={form.instruction}
              placeholder={t('schedules.dialog.instructionPlaceholder')}
              onChange={(event) => patchForm({ instruction: event.target.value })}
              className="mt-1.5 w-full resize-y rounded-lg border border-line bg-surface px-3 py-2.5 text-sm leading-relaxed text-ink outline-none transition placeholder:text-ink-quaternary focus:border-accent focus:ring-2 focus:ring-accent/15"
            />
          </label>

          <div>
            <span className="block text-xs font-medium text-ink-secondary">
              {t('schedules.dialog.frequency')}
            </span>
            <div
              role="radiogroup"
              aria-label={t('schedules.dialog.frequency')}
              className="mt-1.5 grid grid-cols-5 gap-1 rounded-xl border border-line bg-surface-muted/60 p-1"
            >
              {RULE_KINDS.map((kind) => {
                const active = form.kind === kind;
                return (
                  <button
                    key={kind}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => patchForm({ kind })}
                    className={cn(
                      'h-8 rounded-lg text-xs font-medium transition-all',
                      active
                        ? 'bg-surface text-ink shadow-xs'
                        : 'text-ink-tertiary hover:text-ink',
                    )}
                  >
                    {t(`schedules.ruleKinds.${kind}`)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {form.kind === 'once' ? (
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-ink-secondary">
                    {t('schedules.dialog.date')}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => patchForm({ date: offsetDateInput(form.timezone, 0) })}
                      className="rounded px-1.5 py-0.5 text-3xs text-accent-ink hover:bg-accent-soft"
                    >
                      {t('schedules.dialog.today')}
                    </button>
                    <button
                      type="button"
                      onClick={() => patchForm({ date: offsetDateInput(form.timezone, 1) })}
                      className="rounded px-1.5 py-0.5 text-3xs text-accent-ink hover:bg-accent-soft"
                    >
                      {t('schedules.dialog.tomorrow')}
                    </button>
                  </div>
                </div>
                <input
                  required
                  type="date"
                  aria-label={t('schedules.dialog.date')}
                  value={form.date}
                  onChange={(event) => patchForm({ date: event.target.value })}
                  className="mt-1.5 h-10 w-full min-w-0 rounded-lg border border-line bg-surface px-3 text-sm text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15"
                />
              </div>
            ) : null}

            {form.kind === 'monthly' ? (
              <label className="text-xs font-medium text-ink-secondary">
                {t('schedules.dialog.dayOfMonth')}
                <input
                  required
                  type="number"
                  min={1}
                  max={31}
                  value={form.dayOfMonth}
                  onChange={(event) =>
                    patchForm({
                      dayOfMonth: Math.min(31, Math.max(1, Number(event.target.value) || 1)),
                    })
                  }
                  className="mt-1.5 h-10 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15"
                />
              </label>
            ) : null}

            <div>
              <span className="text-xs font-medium text-ink-secondary">
                {t('schedules.dialog.time')}
              </span>
              <input
                required
                type="time"
                aria-label={t('schedules.dialog.time')}
                value={form.time}
                onChange={(event) => patchForm({ time: event.target.value })}
                className="mt-1.5 h-10 w-full min-w-0 rounded-lg border border-line bg-surface px-3 font-mono text-sm text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15"
              />
              <div className="mt-1.5 flex flex-wrap gap-1">
                {QUICK_TIMES.map((presetTime) => (
                  <button
                    key={presetTime}
                    type="button"
                    onClick={() => patchForm({ time: presetTime })}
                    className={cn(
                      'rounded border px-1.5 py-0.5 font-mono text-3xs transition',
                      form.time === presetTime
                        ? 'border-accent/40 bg-accent-soft text-accent-ink'
                        : 'border-line text-ink-quaternary hover:border-line-strong hover:text-ink-secondary',
                    )}
                  >
                    {presetTime}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-w-0">
              <span className="block text-xs font-medium text-ink-secondary">
                {t('schedules.dialog.timezone')}
              </span>
              <Select
                ariaLabel={t('schedules.dialog.timezone')}
                value={form.timezone}
                onValueChange={(value) => patchForm({ timezone: value })}
                options={timezoneOptions}
                size="large"
                searchable
                className="mt-1.5 w-full"
              />
            </div>
          </div>

          {form.kind === 'weekly' ? (
            <fieldset>
              <legend className="mb-2 text-xs font-medium text-ink-secondary">
                {t('schedules.dialog.weekdays')}
              </legend>
              <div className="flex flex-wrap gap-1.5">
                {weekdayLabels.map((label, index) => {
                  const day = index + 1;
                  const active = form.days.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      aria-pressed={active}
                      onClick={() =>
                        patchForm({
                          days: active
                            ? form.days.filter((v) => v !== day)
                            : [...form.days, day].sort((a, b) => a - b),
                        })
                      }
                      className={cn(
                        'grid size-9 place-items-center rounded-lg border text-xs font-medium transition',
                        active
                          ? 'border-accent bg-accent-soft text-accent-ink'
                          : 'border-line bg-surface text-ink-tertiary hover:border-line-strong hover:text-ink',
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ) : null}

          {/* Live Next-Trigger Preview */}
          <div
            className={cn(
              'flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-xs',
              preview.nextAt
                ? 'border-accent/25 bg-accent-soft/60 text-ink'
                : 'border-warning/35 bg-warning/10 text-warning',
            )}
          >
            {preview.nextAt ? (
              <>
                <span className="text-ink-secondary">{t('schedules.dialog.nextPreview')}</span>
                <span className="font-mono font-medium text-ink tabular-nums">
                  {formatScheduleDateTime(preview.nextAt, form.timezone, locale)} ·{' '}
                  <span className="text-accent-ink">
                    {formatRelativeCountdown(preview.nextAt, Date.now(), locale)}
                  </span>
                </span>
              </>
            ) : (
              <span className="flex items-center gap-1.5">
                <AlertTriangle size={14} className="shrink-0" />
                {preview.pastOnce
                  ? t('schedules.dialog.pastWarning')
                  : t('schedules.dialog.invalidRule')}
              </span>
            )}
          </div>

          {error ? (
            <p role="alert" className="rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </p>
          ) : null}

          <footer className="flex justify-end gap-2 border-t border-line pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="h-9 rounded-lg border border-line bg-surface px-3.5 text-sm text-ink-secondary transition hover:border-line-strong hover:text-ink disabled:opacity-45"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex h-9 min-w-28 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
            >
              {busy ? (
                <LoaderCircle size={15} className="animate-spin" />
              ) : editing ? (
                <Check size={15} />
              ) : (
                <Plus size={15} />
              )}
              {editing ? t('schedules.dialog.saveEdit') : t('schedules.dialog.createSubmit')}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
