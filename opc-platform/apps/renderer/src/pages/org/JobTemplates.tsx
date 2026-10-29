import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Loader2, Plus, RefreshCw, UserPlus, X } from 'lucide-react';
import type { DepartmentNode, JobNode, ModelRef, OrgMember } from '@opc/shared/domain';
import { cn } from '@/shared/lib/cn';
import { CapacityBar } from '@/shared/ui/charts';
import { buttonClass } from '@/features/settings/ui/kit';
import { ModelSelect } from '@/features/employee-stack/ui/ModelSelect';
import {
  modelChoiceValue,
  modelRefLabel,
  parseModelChoice,
  useModelChoices,
  type ModelChoice,
} from '@/features/employee-stack/model/useEmployeeStack';

/**
 * 岗位是公司级职务（测试工程师、产品经理、CFO），编制才是部门的事。
 *
 * A job answers "what does this title owe" once, and every department that hires into
 * it shares that answer. How many people a department wants is `department_job`
 * headcount, edited here per department. The two are deliberately separate: the same
 * 测试工程师 may sit in engineering and in QA, with different caps.
 *
 * Editing the definition never rewrites the people already in it (their skills/model
 * may have been tuned), so pushing a change is the explicit 「同步到在岗员工」 button.
 * Responsibilities are the exception: read live, so the next task sees them.
 */

const input =
  'h-7 w-full rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-accent';

const LEVELS = ['P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'M1', 'M2', 'M3'];

/** One job: definition + (optionally) one department's plan for it. */
function JobRow({
  job,
  departments,
  /** When set, the row is scoped to that department's seat. */
  departmentId,
  choices,
  defaultModel,
  onChanged,
}: {
  job: JobNode;
  departments: DepartmentNode[];
  departmentId?: string;
  choices: ModelChoice[];
  defaultModel: ModelRef | null;
  onChanged: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [duty, setDuty] = useState(job.description);
  const [skills, setSkills] = useState<string[]>(job.skills);
  const [skillDraft, setSkillDraft] = useState('');
  const [model, setModel] = useState<ModelRef | undefined>(job.modelRef);
  const [busy, setBusy] = useState(false);
  const [seatDraft, setSeatDraft] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setDuty(job.description);
    setSkills(job.skills);
    setModel(job.modelRef);
  }, [job, open]);

  const seat = departmentId
    ? job.seats.find((entry) => entry.departmentId === departmentId)
    : undefined;
  const filled = departmentId ? (seat?.filled ?? 0) : job.filled;
  const headcount = departmentId ? (seat?.headcount ?? 0) : job.headcount;
  const over = filled > headcount;
  const full = headcount > 0 && filled >= headcount;

  const defaultLabel = defaultModel
    ? t('org.stackInherit', { model: modelRefLabel(choices, defaultModel) ?? defaultModel.modelId })
    : t('org.stackNoDefault');
  const shownModel = modelRefLabel(choices, job.modelRef) ?? job.model;
  const dirty =
    duty.trim() !== job.description ||
    model?.providerId !== job.modelRef?.providerId ||
    model?.modelId !== job.modelRef?.modelId ||
    skills.join('\u0000') !== job.skills.join('\u0000');

  const run = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await action();
      await onChanged();
      if (done) setNote(done);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(
      () =>
        window.opc!.org.updateJob({
          id: job.id,
          description: duty.trim(),
          skills,
          // Picking nothing means "inherit the default"; a legacy job that only ever
          // had a label keeps it instead of being silently blanked by an unrelated edit.
          model: model
            ? (modelRefLabel(choices, model) ?? `${model.providerId}/${model.modelId}`)
            : job.modelRef
              ? ''
              : job.model,
          // `null` is "inherit the company default", not "leave it alone".
          modelRef: model ?? null,
        }),
      t('org.jobSaved'),
    );

  const setSeat = (target: string, next: number) =>
    run(() => window.opc!.org.setJobSeat({ jobId: job.id, departmentId: target, headcount: next }));

  const sync = () =>
    run(async () => {
      const count = await window.opc!.org.syncJob(job.id);
      setNote(t('org.jobSynced', { count }));
    });

  const addSkill = () => {
    const value = skillDraft.trim();
    if (!value || skills.some((skill) => skill.toLowerCase() === value.toLowerCase())) return;
    setSkills([...skills, value]);
    setSkillDraft('');
  };

  const addableDepartments = departments.filter(
    (node) => !job.seats.some((entry) => entry.departmentId === node.id),
  );

  return (
    <li
      data-testid="dept-job-row"
      className="rounded-lg border border-line bg-surface-muted px-2.5 py-1.5"
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-label={t(open ? 'org.jobCollapse' : 'org.jobEdit')}
          title={t(open ? 'org.jobCollapse' : 'org.jobEdit')}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronDown
            className={cn(
              'size-3 shrink-0 text-ink-quaternary transition-transform',
              !open && '-rotate-90',
            )}
            aria-hidden
          />
          <span className="min-w-0 truncate text-2xs font-medium text-ink">{job.title}</span>
          <span className="shrink-0 rounded bg-surface px-1 font-mono text-3xs text-ink-tertiary">
            {job.level}
          </span>
        </button>
        <span
          className={cn(
            'shrink-0 font-mono text-3xs',
            over || full ? 'text-danger' : headcount > 0 ? 'text-success' : 'text-ink-quaternary',
          )}
          title={headcount > 0 ? undefined : t('org.jobSeatUnplanned')}
        >
          {headcount > 0 ? `${filled}/${headcount}` : `${filled} · ${t('org.jobNoCap')}`}
        </span>
        {departmentId ? null : (
          <button
            type="button"
            aria-label={t('org.jobArchive')}
            title={t('org.jobArchive')}
            disabled={busy || job.filled > 0}
            onClick={() => void run(() => window.opc!.org.archiveJob(job.id))}
            className="flex size-5 shrink-0 items-center justify-center rounded text-ink-quaternary hover:bg-ink/5 hover:text-danger disabled:opacity-30"
          >
            <X className="size-3" />
          </button>
        )}
      </div>

      {headcount > 0 ? (
        <div className="mt-1 flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <CapacityBar
              filled={filled}
              total={headcount}
              ariaLabel={`${job.title}: ${filled}/${headcount}`}
            />
          </div>
        </div>
      ) : null}

      {/* Collapsed: the definition in one glance — that is what makes it reusable. */}
      {open ? null : (
        <div className="mt-1 space-y-0.5">
          <p
            data-testid="dept-job-duty"
            className={cn(
              'line-clamp-2 text-3xs leading-relaxed',
              job.description ? 'text-ink-tertiary' : 'text-ink-quaternary',
            )}
          >
            {job.description || t('org.jobDutyEmpty')}
          </p>
          <p className="flex flex-wrap items-center gap-1 text-3xs text-ink-quaternary">
            {job.skills.length > 0 ? <span>{job.skills.join(' · ')}</span> : null}
            {job.skills.length > 0 && shownModel ? <span aria-hidden>|</span> : null}
            {shownModel ? <span>{shownModel}</span> : null}
          </p>
          {departmentId ? null : job.seats.length > 0 ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-3xs">
              {job.seats.map((entry) => (
                <span key={entry.departmentId} className="text-ink-quaternary">
                  {entry.departmentName}
                  <span className="ml-1 font-mono text-ink-tertiary">
                    {entry.filled}/{entry.headcount}
                  </span>
                </span>
              ))}
            </p>
          ) : (
            <p className="text-3xs text-ink-quaternary">{t('org.jobSeatNone')}</p>
          )}
        </div>
      )}

      {open ? (
        <div className="mt-2 space-y-2 border-t border-line pt-2">
          <label className="block">
            <span className="mb-1 block text-3xs font-medium text-ink-tertiary">
              {t('org.jobDuty')}
            </span>
            <textarea
              data-testid="dept-job-duty-input"
              rows={4}
              value={duty}
              onChange={(event) => setDuty(event.target.value)}
              placeholder={t('org.jobDutyHint')}
              className="w-full resize-y rounded-md border border-line bg-surface px-2 py-1.5 text-xs leading-relaxed text-ink outline-none focus:border-accent"
            />
            <span className="mt-1 block text-3xs leading-relaxed text-ink-quaternary">
              {t('org.jobDutyLive')}
            </span>
          </label>

          <div>
            <span className="mb-1 block text-3xs font-medium text-ink-tertiary">
              {t('org.jobSkills')}
            </span>
            <div className="flex gap-1.5">
              <input
                data-testid="dept-job-skill-input"
                value={skillDraft}
                onChange={(event) => setSkillDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addSkill();
                  }
                }}
                placeholder={t('org.jobSkillsHint')}
                className={input}
              />
              <button
                type="button"
                aria-label={t('wizard.addSkill')}
                onClick={addSkill}
                className="flex size-7 shrink-0 items-center justify-center rounded-md border border-line text-ink-tertiary hover:bg-surface-hover"
              >
                <Plus className="size-3" />
              </button>
            </div>
            {skills.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {skills.map((skill) => (
                  <span
                    key={skill}
                    className="flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-3xs text-ink-secondary"
                  >
                    {skill}
                    <button
                      type="button"
                      aria-label={`${t('common.close')} ${skill}`}
                      onClick={() => setSkills(skills.filter((item) => item !== skill))}
                      className="text-ink-quaternary hover:text-danger"
                    >
                      <X className="size-2.5" />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <label className="block">
            <span className="mb-1 block text-3xs font-medium text-ink-tertiary">
              {t('org.jobModel')}
            </span>
            <ModelSelect
              choices={choices}
              value={model ? modelChoiceValue(model.providerId, model.modelId) : ''}
              defaultLabel={defaultLabel}
              missingLabel={t('org.stackModelMissing')}
              disabled={busy}
              onChange={(value) => setModel(parseModelChoice(value) ?? undefined)}
            />
            <span className="mt-1 block text-3xs leading-relaxed text-ink-quaternary">
              {choices.length === 0 ? t('org.stackNoModels') : t('org.jobModelHint')}
            </span>
          </label>

          {/* 编制：部门 × 岗位。同一个岗位在不同部门各有各的上限。 */}
          <div>
            <span className="mb-1 block text-3xs font-medium text-ink-tertiary">
              {t('org.jobSeats')}
            </span>
            <div className="space-y-1">
              {(departmentId ? (seat ? [seat] : []) : job.seats).map((entry) => (
                <div key={entry.departmentId} className="flex items-center gap-1.5 text-2xs">
                  <span className="min-w-0 flex-1 truncate text-ink-secondary">
                    {entry.departmentName}
                  </span>
                  <span
                    className={cn(
                      'font-mono text-3xs',
                      entry.filled > entry.headcount ? 'text-danger' : 'text-ink-quaternary',
                    )}
                  >
                    {entry.filled}/{entry.headcount}
                  </span>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      aria-label={t('org.jobSeatLess')}
                      disabled={busy || entry.headcount === 0}
                      onClick={() => void setSeat(entry.departmentId, entry.headcount - 1)}
                      className="flex size-5 items-center justify-center rounded border border-line text-ink-tertiary hover:bg-surface-hover disabled:opacity-30"
                    >
                      −
                    </button>
                    <button
                      type="button"
                      aria-label={t('org.jobSeatMore')}
                      disabled={busy}
                      onClick={() => void setSeat(entry.departmentId, entry.headcount + 1)}
                      className="flex size-5 items-center justify-center rounded border border-line text-ink-tertiary hover:bg-surface-hover disabled:opacity-30"
                    >
                      +
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {departmentId && !seat ? (
              <button
                type="button"
                data-testid="dept-job-seat-add"
                disabled={busy}
                onClick={() => void setSeat(departmentId, 1)}
                className={cn(buttonClass.secondary, 'mt-1 h-6 gap-1 px-2 text-3xs')}
              >
                <Plus className="size-3" />
                {t('org.jobSeatPlan')}
              </button>
            ) : null}

            {departmentId || addableDepartments.length === 0 ? null : (
              <div className="mt-1.5 flex gap-1.5">
                <select
                  data-testid="job-seat-department"
                  value={seatDraft}
                  onChange={(event) => setSeatDraft(event.target.value)}
                  aria-label={t('org.jobSeatAdd')}
                  className={input}
                >
                  <option value="">{t('org.jobSeatAdd')}</option>
                  {addableDepartments.map((node) => (
                    <option key={node.id} value={node.id}>
                      {node.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={busy || !seatDraft}
                  onClick={() => {
                    const target = seatDraft;
                    setSeatDraft('');
                    void setSeat(target, 1);
                  }}
                  className={cn(buttonClass.secondary, 'h-7 shrink-0 px-2 text-2xs')}
                >
                  <Plus className="size-3" />
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {job.filled > 0 ? (
              <button
                type="button"
                data-testid="dept-job-sync"
                disabled={busy}
                onClick={() => void sync()}
                title={t('org.jobSyncHint')}
                className={cn(buttonClass.secondary, 'h-7 gap-1 px-2 text-2xs')}
              >
                <RefreshCw className="size-3" />
                {t('org.jobSync', { count: job.filled })}
              </button>
            ) : null}
            <button
              type="button"
              data-testid="dept-job-save"
              disabled={busy || !dirty}
              onClick={() => void save()}
              className={cn(buttonClass.primary, 'h-7 px-2 text-2xs disabled:opacity-40')}
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : null}
              {t('org.jobSave')}
            </button>
          </div>
        </div>
      ) : null}

      {note ? <p className="mt-1 text-3xs text-success">{note}</p> : null}
      {error ? <p className="mt-1 text-3xs text-danger">{error}</p> : null}
    </li>
  );
}

/**
 * 部门档案里的岗位区块：本部门设了编制的职务 + 在岗人数。
 *
 * Only the jobs this department planned or uses appear here — the catalogue itself is
 * company-wide and lives in the 岗位 view.
 */
export function DepartmentJobs({
  departmentId,
  departmentName,
  members,
  onHire,
}: {
  departmentId: string;
  departmentName: string;
  members: OrgMember[];
  onHire: () => void;
}) {
  const { t } = useTranslation();
  const { choices, defaultModel } = useModelChoices();
  const [jobs, setJobs] = useState<JobNode[]>([]);
  const [catalogue, setCatalogue] = useState<JobNode[]>([]);
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [mine, all] = await Promise.all([
        window.opc!.org.jobs(departmentId),
        window.opc!.org.jobs(),
      ]);
      setJobs(mine);
      setCatalogue(all);
    } catch {
      setJobs([]);
      setCatalogue([]);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departmentId]);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const seatOf = (job: JobNode) => job.seats.find((seat) => seat.departmentId === departmentId);
  const planned = jobs.filter((job) => seatOf(job));
  const used = jobs.filter((job) => !seatOf(job));
  const total = jobs.reduce((sum, job) => sum + (seatOf(job)?.headcount ?? 0), 0);
  const filled = jobs.reduce((sum, job) => sum + (seatOf(job)?.filled ?? 0), 0);
  // People with no job at all — over-establishment or simply unplanned.
  const unplanned = members.filter((member) => member.status === 'active' && !member.jobId).length;
  const addable = catalogue.filter((job) => !seatOf(job));

  return (
    <section className="border-t border-line px-5 py-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h4 className="text-2xs font-semibold text-ink-tertiary">{t('org.jobs')}</h4>
        <span className="font-mono text-3xs text-ink-quaternary">
          {filled}/{total}
        </span>
      </div>
      {unplanned > 0 ? (
        <p className="mb-1.5 text-2xs text-ink-quaternary">
          {t('org.jobsUnplanned', { count: unplanned })}
        </p>
      ) : null}

      {jobs.length === 0 ? (
        <p className="text-xs text-ink-quaternary">
          {t('org.jobsEmpty', { name: departmentName })}
        </p>
      ) : (
        <ul data-testid="dept-jobs" className="space-y-1.5">
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              departments={[]}
              departmentId={departmentId}
              choices={choices}
              defaultModel={defaultModel}
              onChanged={load}
            />
          ))}
        </ul>
      )}
      {used.length > 0 ? (
        <p className="mt-1.5 text-3xs text-ink-quaternary">
          {t('org.jobsUnplannedSeats', { count: used.length })}
        </p>
      ) : null}

      <div className="mt-2 flex gap-1.5">
        <select
          data-testid="dept-job-add"
          value={pick}
          onChange={(event) => setPick(event.target.value)}
          aria-label={t('org.jobSeatPick')}
          disabled={busy || addable.length === 0}
          className={input}
        >
          <option value="">
            {addable.length === 0 ? t('org.jobSeatNoAddable') : t('org.jobSeatPick')}
          </option>
          {addable.map((job) => (
            <option key={job.id} value={job.id}>
              {job.title} · {job.level}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="dept-job-seat-plan"
          disabled={busy || !pick}
          onClick={() =>
            void act(async () => {
              await window.opc!.org.setJobSeat({
                jobId: pick,
                departmentId,
                headcount: 1,
              });
              setPick('');
            })
          }
          className={cn(buttonClass.secondary, 'h-7 shrink-0 px-2 text-2xs disabled:opacity-40')}
        >
          <Plus className="size-3" />
        </button>
      </div>
      <p className="mt-1 text-3xs leading-relaxed text-ink-quaternary">{t('org.jobSeatHint')}</p>

      {planned.some((job) => (seatOf(job)?.filled ?? 0) < (seatOf(job)?.headcount ?? 0)) ? (
        <button
          type="button"
          onClick={onHire}
          className="mt-1.5 flex h-7 w-full items-center justify-center gap-1 rounded-md text-2xs text-ink-tertiary hover:bg-surface-hover hover:text-accent"
        >
          <UserPlus className="size-3" />
          {t('org.hireInto')}
        </button>
      ) : null}
      {error ? <p className="mt-1 text-2xs text-danger">{error}</p> : null}
    </section>
  );
}

/**
 * 全公司岗位目录：一个岗位一行，定义在这里改，编制按部门加。
 */
export function JobDirectory({ departments }: { departments: DepartmentNode[] }) {
  const { t } = useTranslation();
  const { choices, defaultModel } = useModelChoices();
  const [jobs, setJobs] = useState<JobNode[] | null>(null);
  const [title, setTitle] = useState('');
  const [level, setLevel] = useState('P5');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setJobs(await window.opc!.org.jobs());
      setError(null);
    } catch (caught) {
      setJobs([]);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    const name = title.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.opc!.org.createJob({ title: name, level });
      setTitle('');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const openSeats = (jobs ?? []).reduce(
    (sum, job) => sum + Math.max(0, job.headcount - job.filled),
    0,
  );

  return (
    <div className="h-full overflow-y-auto px-5 py-4">
      <div className="mb-3">
        <h3 className="text-sm-plus font-semibold text-ink">{t('org.jobDirectory')}</h3>
        <p className="mt-0.5 text-2xs text-ink-quaternary">
          {t('org.jobDirectoryHint', { jobs: jobs?.length ?? 0, count: openSeats })}
        </p>
      </div>

      <div className="mb-3 flex gap-1.5">
        <input
          data-testid="job-new-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void create();
          }}
          placeholder={t('org.jobTitleHint')}
          className={input}
        />
        <select
          value={level}
          onChange={(event) => setLevel(event.target.value)}
          aria-label={t('org.level')}
          className="h-7 w-20 shrink-0 rounded-md border border-line bg-surface px-1 font-mono text-xs text-ink outline-none focus:border-accent"
        >
          {LEVELS.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="job-new-add"
          disabled={busy || !title.trim()}
          onClick={() => void create()}
          className={cn(buttonClass.secondary, 'h-7 shrink-0 px-2 text-2xs disabled:opacity-40')}
        >
          <Plus className="size-3" />
          {t('org.jobCreate')}
        </button>
      </div>

      {error ? <p className="mb-2 text-xs text-danger">{error}</p> : null}
      {jobs === null ? (
        <p className="text-xs text-ink-quaternary">{t('common.loading')}</p>
      ) : jobs.length === 0 ? (
        <p className="text-xs text-ink-quaternary">{t('org.jobDirectoryEmpty')}</p>
      ) : (
        <ul data-testid="job-directory" className="space-y-1.5">
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              departments={departments}
              choices={choices}
              defaultModel={defaultModel}
              onChanged={load}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 员工档案里的岗位职责（只读）：来自岗位定义，同岗位的人共用一份。
 *
 * Deliberately not editable here: editing one person's copy would fork the definition
 * without anyone noticing. The edit lives on the job, in the 岗位 view.
 */
export function JobCharter({ job }: { job?: JobNode }) {
  const { t } = useTranslation();

  return (
    <section className="border-t border-line px-5 py-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="min-w-0 truncate text-2xs font-semibold text-ink-tertiary">
          {t('org.jobDuty')}
        </h4>
        {job ? (
          <span className="shrink-0 text-3xs text-ink-quaternary">
            {t('org.jobDutyFrom', { title: job.title })}
          </span>
        ) : null}
      </div>
      {job ? (
        <pre className="max-h-40 overflow-y-auto rounded-lg border border-line bg-surface-muted p-3 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-ink-secondary select-text">
          {job.description || t('org.jobDutyEmpty')}
        </pre>
      ) : (
        <p className="text-2xs text-ink-quaternary">{t('org.jobDutyNoSeat')}</p>
      )}
      {job ? (
        <p className="mt-1 text-3xs leading-relaxed text-ink-quaternary">
          {t('org.jobDutyShared')}
        </p>
      ) : null}
    </section>
  );
}
