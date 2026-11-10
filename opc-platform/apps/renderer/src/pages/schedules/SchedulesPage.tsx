import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, Check, LoaderCircle, Pause, Play, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import type { RouterSchedule, RouterScheduleDraft, RouterScheduleOccurrence, RouterScheduleRule } from '@opc/shared/domain';
import { cn } from '@/shared/lib/cn';
import { Select } from '@/shared/ui/Select';

type FormState = { title: string; instruction: string; kind: RouterScheduleRule['kind']; date: string; time: string; dayOfMonth: number; days: number[]; timezone: string };
const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const emptyForm = (): FormState => ({ title: '', instruction: '', kind: 'once', date: '', time: '09:00', dayOfMonth: 1, days: [1], timezone: localTimezone });
type ScheduleFilter = 'all' | 'active' | 'paused' | 'finished';

export function SchedulesPage() {
  const [schedules, setSchedules] = useState<RouterSchedule[]>([]);
  const [occurrences, setOccurrences] = useState<Record<string, RouterScheduleOccurrence[]>>({});
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editing, setEditing] = useState<RouterSchedule | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [filter, setFilter] = useState<ScheduleFilter>('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const rows = await window.opc!.router.listSchedules();
    setSchedules(rows);
    const recent = await Promise.all(rows.map(async (row) => [row.id, await window.opc!.router.listScheduleOccurrences(row.id)] as const));
    setOccurrences(Object.fromEntries(recent));
  }, []);

  useEffect(() => {
    void refresh().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    return window.opc!.router.onScheduleChanged(() => void refresh());
  }, [refresh]);

  const activeCount = useMemo(() => schedules.filter((schedule) => schedule.status === 'active').length, [schedules]);
  const patchForm = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const rule: RouterScheduleRule = form.kind === 'once'
        ? { kind: 'once', at: wallTimeToEpoch(form.date, form.time, form.timezone) }
        : form.kind === 'weekly'
          ? { kind: 'weekly', time: form.time, daysOfWeek: form.days }
          : form.kind === 'monthly'
            ? { kind: 'monthly', time: form.time, dayOfMonth: form.dayOfMonth }
            : { kind: form.kind, time: form.time };
      const draft: RouterScheduleDraft = { title: form.title, instruction: form.instruction, rule, timezone: form.timezone };
      if (editing) {
        await window.opc!.router.updateSchedule(editing.id, draft);
      } else {
        await window.opc!.router.createSchedule(draft);
      }
      setEditing(null); setDialogOpen(false); setForm(emptyForm());
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  const beginEdit = (schedule: RouterSchedule) => {
    const rule = schedule.rule;
    const date = rule.kind === 'once' ? datePartsInZone(rule.at, schedule.timezone) : datePartsInZone(Date.now(), schedule.timezone);
    setEditing(schedule);
    setDialogOpen(true);
    setForm({ title: schedule.title, instruction: schedule.instruction, kind: rule.kind,
      date: `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`,
      time: rule.kind === 'once' ? `${String(date.hour).padStart(2, '0')}:${String(date.minute).padStart(2, '0')}` : rule.time,
      dayOfMonth: rule.kind === 'monthly' ? rule.dayOfMonth : 1,
      days: rule.kind === 'weekly' ? rule.daysOfWeek : [1],
      timezone: schedule.timezone,
    });
  };

  const setStatus = async (schedule: RouterSchedule, status: 'active' | 'paused') => {
    setError('');
    try { await window.opc!.router.updateSchedule(schedule.id, { status }); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const cancel = async (schedule: RouterSchedule) => {
    setError('');
    try { await window.opc!.router.cancelSchedule(schedule.id); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const pausedCount = schedules.filter((schedule) => schedule.status === 'paused').length;
  const finishedCount = schedules.filter((schedule) => ['completed', 'cancelled'].includes(schedule.status)).length;
  const visibleSchedules = schedules.filter((schedule) => {
    const matchesFilter = filter === 'all' || (filter === 'active' && schedule.status === 'active') ||
      (filter === 'paused' && schedule.status === 'paused') ||
      (filter === 'finished' && ['completed', 'cancelled'].includes(schedule.status));
    const needle = query.trim().toLocaleLowerCase();
    return matchesFilter && (!needle || `${schedule.title} ${schedule.instruction}`.toLocaleLowerCase().includes(needle));
  });

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-panel text-ink">
      <div className="mx-auto w-full max-w-[1180px] px-5 py-7 sm:px-8 sm:py-9">
        <header className="mb-7 flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-line bg-surface text-accent"><CalendarClock size={19} strokeWidth={1.8} /></span>
            <div className="min-w-0"><div className="text-xs text-ink-quaternary">Router</div><h1 className="text-xl font-semibold leading-tight">定时计划</h1></div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" title="刷新计划" onClick={() => void refresh()} className="grid size-9 place-items-center rounded-md border border-line bg-surface text-ink-secondary transition hover:bg-surface-muted"><RefreshCw size={15} /></button>
            <button type="button" onClick={() => { setEditing(null); setForm(emptyForm()); setError(''); setDialogOpen(true); }} className="inline-flex h-9 items-center gap-2 rounded-md bg-ink px-3 text-sm font-medium text-white transition hover:bg-ink/85"><Plus size={16} />新建计划</button>
          </div>
        </header>

        <section className="mb-6 grid grid-cols-3 border-y border-line bg-surface/45">
          <Metric label="运行中" value={activeCount} tone="green" />
          <Metric label="已暂停" value={pausedCount} />
          <Metric label="已结束" value={finishedCount} />
        </section>

        <section aria-label="计划列表">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 overflow-x-auto" role="tablist" aria-label="计划状态">
              {([['all', '全部'], ['active', '运行中'], ['paused', '已暂停'], ['finished', '已结束']] as const).map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={filter === id} onClick={() => setFilter(id)} className={cn('shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition', filter === id ? 'bg-surface text-ink shadow-sm' : 'text-ink-tertiary hover:bg-surface/60 hover:text-ink')}>{label}<span className="ml-1.5 font-mono text-[10px] text-ink-quaternary">{id === 'all' ? schedules.length : id === 'active' ? activeCount : id === 'paused' ? pausedCount : finishedCount}</span></button>
              ))}
            </div>
            <label className="flex h-8 w-full max-w-[250px] items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-ink-quaternary focus-within:border-accent">
              <Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索计划" className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-quaternary" />
            </label>
          </div>

          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <div className="hidden grid-cols-[minmax(0,1fr)_205px_110px_78px] items-center gap-4 border-b border-line bg-surface-muted/55 px-4 py-2.5 text-[10px] font-semibold text-ink-quaternary sm:grid"><span>计划</span><span>下次执行</span><span>状态</span><span className="text-right">操作</span></div>
            {visibleSchedules.map((schedule) => (
              <ScheduleRow key={schedule.id} schedule={schedule} occurrence={occurrences[schedule.id]?.[0]}
                onEdit={() => beginEdit(schedule)}
                onToggle={() => void setStatus(schedule, schedule.status === 'active' ? 'paused' : 'active')}
                onCancel={() => void cancel(schedule)} />
            ))}
            {visibleSchedules.length === 0 ? (
              <div className="flex min-h-[245px] flex-col items-center justify-center px-6 py-10 text-center">
                <span className="mb-3 grid size-11 place-items-center rounded-full bg-surface-muted text-ink-quaternary"><CalendarClock size={19} /></span>
                <p className="text-sm font-medium text-ink">{schedules.length === 0 ? '还没有计划' : '没有匹配的计划'}</p>
                <p className="mt-1 max-w-sm text-xs leading-relaxed text-ink-tertiary">{schedules.length === 0 ? '创建一个提醒或周期检查，Router 会在到期时处理。' : '换一个状态或关键词再试试。'}</p>
                {schedules.length === 0 ? <button type="button" onClick={() => { setEditing(null); setForm(emptyForm()); setDialogOpen(true); }} className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-xs font-medium text-ink-secondary hover:bg-surface-muted"><Plus size={14} />创建计划</button> : null}
              </div>
            ) : null}
          </div>
          {error && !dialogOpen ? <p role="alert" className="mt-3 text-xs text-red-700">{error}</p> : null}
        </section>
      </div>

      {dialogOpen ? (
        <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/25 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDialogOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="schedule-dialog-title" className="my-auto max-h-[min(90vh,760px)] w-full max-w-[520px] overflow-y-auto rounded-lg border border-line bg-surface shadow-xl">
            <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface px-5 py-4">
              <div><h2 id="schedule-dialog-title" className="text-base font-semibold">{editing ? '编辑计划' : '新建计划'}</h2><p className="mt-0.5 text-xs text-ink-tertiary">时间按所选时区执行</p></div>
              <button type="button" title="关闭" onClick={() => setDialogOpen(false)} className="grid size-8 place-items-center rounded-md text-ink-tertiary hover:bg-surface-muted hover:text-ink"><X size={17} /></button>
            </header>
            <form onSubmit={(event) => void save(event)} className="space-y-4 px-5 py-5">
              <label className="block text-xs font-medium text-ink-secondary">名称<input required value={form.title} onChange={(event) => patchForm({ title: event.target.value })} className="mt-1.5 h-10 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none transition placeholder:text-ink-quaternary focus:border-accent focus:ring-2 focus:ring-accent/15" /></label>
              <label className="block text-xs font-medium text-ink-secondary">到期时需要处理的内容<textarea required rows={3} value={form.instruction} onChange={(event) => patchForm({ instruction: event.target.value })} className="mt-1.5 w-full resize-y rounded-md border border-line bg-surface px-3 py-2.5 text-sm leading-relaxed text-ink outline-none transition placeholder:text-ink-quaternary focus:border-accent focus:ring-2 focus:ring-accent/15" /></label>
              <div className="grid grid-cols-2 gap-3">
                <div className="block min-w-0 text-xs font-medium text-ink-secondary"><span>重复规则</span><Select
                  ariaLabel="重复规则"
                  value={form.kind}
                  onValueChange={(value) => patchForm({ kind: value as FormState['kind'] })}
                  size="default"
                  className="mt-1.5 w-full"
                  options={[
                    { value: 'once', label: '仅一次' },
                    { value: 'daily', label: '每天' },
                    { value: 'weekdays', label: '每个工作日' },
                    { value: 'weekly', label: '每周' },
                    { value: 'monthly', label: '每月' },
                  ]}
                /></div>
                <label className="block text-xs font-medium text-ink-secondary">时区<input required value={form.timezone} onChange={(event) => patchForm({ timezone: event.target.value })} className="mt-1.5 h-10 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15" /></label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {form.kind === 'once' ? <label className="text-xs font-medium text-ink-secondary">日期<input required type="date" value={form.date} onChange={(event) => patchForm({ date: event.target.value })} className="mt-1.5 h-10 w-full min-w-0 rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15" /></label> : null}
                <label className="text-xs font-medium text-ink-secondary">时间<input required type="time" value={form.time} onChange={(event) => patchForm({ time: event.target.value })} className="mt-1.5 h-10 w-full min-w-0 rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15" /></label>
                {form.kind === 'monthly' ? <label className="text-xs font-medium text-ink-secondary">每月日期<input required type="number" min={1} max={31} value={form.dayOfMonth} onChange={(event) => patchForm({ dayOfMonth: Number(event.target.value) })} className="mt-1.5 h-10 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/15" /></label> : null}
              </div>
              {form.kind === 'weekly' ? <fieldset><legend className="mb-2 text-xs font-medium text-ink-secondary">星期</legend><div className="flex gap-1.5">{weekdays.map((day, index) => <button key={day} type="button" aria-pressed={form.days.includes(index + 1)} onClick={() => patchForm({ days: form.days.includes(index + 1) ? form.days.filter((value) => value !== index + 1) : [...form.days, index + 1].sort() })} className={cn('grid size-8 place-items-center rounded-md border text-xs', form.days.includes(index + 1) ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line text-ink-tertiary')}>{day}</button>)}</div></fieldset> : null}
              {error ? <p role="alert" className="text-xs text-red-700">{error}</p> : null}
              <footer className="flex justify-end gap-2 border-t border-line pt-4">
                <button type="button" onClick={() => setDialogOpen(false)} className="h-9 rounded-md border border-line px-3 text-sm text-ink-secondary hover:bg-surface-muted">取消</button>
                <button type="submit" disabled={busy || (form.kind === 'weekly' && form.days.length === 0)} className="flex h-9 min-w-28 items-center justify-center gap-2 rounded-md bg-ink px-3 text-sm font-medium text-white hover:bg-ink/85 disabled:opacity-50">{busy ? <LoaderCircle size={15} className="animate-spin" /> : editing ? <Check size={15} /> : <Plus size={15} />}{editing ? '保存修改' : '创建计划'}</button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: 'green' }) {
  return <div className="flex items-center gap-2 border-r border-line px-4 py-3 last:border-r-0 sm:px-5"><span className={cn('font-mono text-xl font-semibold tabular-nums', tone === 'green' ? 'text-[#16834b]' : 'text-ink')}>{value.toString().padStart(2, '0')}</span><span className="text-xs text-ink-tertiary">{label}</span></div>;
}

function ScheduleRow({ schedule, occurrence, onEdit, onToggle, onCancel }: {
  schedule: RouterSchedule;
  occurrence?: RouterScheduleOccurrence;
  onEdit: () => void;
  onToggle: () => void;
  onCancel: () => void;
}) {
  const isLive = schedule.status === 'active' || schedule.status === 'paused';
  return (
    <article className="grid gap-3 border-b border-line px-4 py-4 last:border-b-0 transition-colors hover:bg-panel/70 sm:grid-cols-[minmax(0,1fr)_205px_110px_78px] sm:items-center sm:gap-4">
      <button type="button" onClick={onEdit} className="min-w-0 text-left">
        <span className="block truncate text-sm font-medium text-ink hover:text-accent-ink">{schedule.title}</span>
        <span className="mt-1 block line-clamp-2 text-xs leading-relaxed text-ink-tertiary">{schedule.instruction}</span>
        <span className="mt-2 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-quaternary"><span>{ruleLabel(schedule.rule, schedule.timezone)}</span><span aria-hidden>·</span><span>{schedule.timezone}</span>{occurrence ? <><span aria-hidden>·</span><span>最近 {formatScheduleDate(occurrence.scheduledFor, schedule.timezone)}</span>{occurrence.missedCount > 0 ? <span>· 合并 {occurrence.missedCount} 次</span> : null}</> : null}</span>
      </button>
      <div className="flex items-center justify-between gap-3 sm:block"><span className="text-[11px] text-ink-quaternary sm:hidden">下次执行</span><span className="text-xs tabular-nums text-ink-secondary">{schedule.nextRunAt ? formatScheduleDate(schedule.nextRunAt, schedule.timezone) : '—'}</span></div>
      <div><span className={cn('inline-flex items-center gap-1.5 text-xs', schedule.status === 'active' ? 'text-[#16834b]' : schedule.status === 'paused' ? 'text-[#a36b16]' : 'text-ink-quaternary')}><span className={cn('size-1.5 rounded-full', schedule.status === 'active' ? 'bg-[#28a765]' : schedule.status === 'paused' ? 'bg-[#d3932e]' : 'bg-[#a7aaa5]')} />{statusLabel(schedule.status)}</span></div>
      <div className="flex justify-end gap-1">
        {isLive ? <button type="button" title={schedule.status === 'active' ? '暂停计划' : '恢复计划'} onClick={onToggle} className="grid size-8 place-items-center rounded-md text-ink-tertiary transition hover:bg-surface-muted hover:text-ink">{schedule.status === 'active' ? <Pause size={15} /> : <Play size={15} />}</button> : null}
        {isLive ? <button type="button" title="取消计划" onClick={onCancel} className="grid size-8 place-items-center rounded-md text-ink-quaternary transition hover:bg-red-50 hover:text-red-700"><Trash2 size={15} /></button> : null}
      </div>
    </article>
  );
}

function ruleLabel(rule: RouterScheduleRule, timezone: string): string {
  if (rule.kind === 'once') return `仅一次 · ${formatScheduleDate(rule.at, timezone)}`;
  if (rule.kind === 'weekly') return `每周 ${rule.daysOfWeek.map((day) => weekdays[day - 1]).join('、')} · ${rule.time}`;
  if (rule.kind === 'monthly') return `每月 ${rule.dayOfMonth} 日 · ${rule.time}`;
  return `${rule.kind === 'daily' ? '每天' : '工作日'} · ${rule.time}`;
}

function formatScheduleDate(at: number, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(at);
}

function statusLabel(status: RouterSchedule['status']): string {
  return ({ active: '运行中', paused: '已暂停', cancelled: '已取消', completed: '已完成' })[status];
}

function datePartsInZone(at: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { year: values.year, month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute) };
}

function wallTimeToEpoch(date: string, time: string, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = datePartsInZone(candidate, timeZone);
    const localAsUtc = Date.UTC(Number(parts.year), parts.month - 1, parts.day, parts.hour, parts.minute);
    const delta = target - localAsUtc;
    candidate += delta;
    if (delta === 0) return candidate;
  }
  const resolved = datePartsInZone(candidate, timeZone);
  if (Number(resolved.year) !== year || resolved.month !== month || resolved.day !== day || resolved.hour !== hour || resolved.minute !== minute) {
    throw new Error('所选时区中的这个本地时间不存在（可能处于夏令时切换时段）');
  }
  return candidate;
}
