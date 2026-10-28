import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Archive, ArrowRight, FileText, FolderPlus, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { Budget, DepartmentNode, OrgMember, TaskStatus, WorkTask } from '@opc/shared/domain';
import type { OrgFactView, ProjectView } from '@opc/shared/ipc';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { buttonClass, Field } from '@/features/settings/ui/kit';
import { cn } from '@/shared/lib/cn';
import { StackedBar, toneForRatio } from '@/shared/ui/charts';

/**
 * The project room.
 *
 * A project is not a row in a CRUD table: it is a standing commitment with a team,
 * a scope, a budget and its own workstream. So the page is a dossier — an index on
 * the left, one project's file on the right — instead of four identical cards with
 * every control exposed at once. Editing (members, reporting, rules) is a mode, not
 * the default state; reading is.
 */

const STATUS_DOT: Record<TaskStatus, string> = {
  open: 'bg-ink-quaternary',
  running: 'bg-accent',
  review: 'bg-warning',
  accepted: 'bg-accent',
  delivered: 'bg-success',
  rejected: 'bg-danger',
  failed: 'bg-danger',
  cancelled: 'bg-ink-quaternary',
};

const STATUS_INK: Record<TaskStatus, string> = {
  open: 'text-ink-tertiary',
  running: 'text-accent',
  review: 'text-warning',
  accepted: 'text-accent',
  delivered: 'text-success',
  rejected: 'text-danger',
  failed: 'text-danger',
  cancelled: 'text-ink-quaternary',
};

/** Live work first, finished work last: what the reader opens the file for. */
const STATUS_RANK: Record<TaskStatus, number> = {
  running: 0,
  review: 1,
  accepted: 2,
  open: 3,
  rejected: 4,
  failed: 4,
  delivered: 5,
  cancelled: 6,
};

const TONE_VAR = {
  accent: 'var(--accent)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
  neutral: 'var(--text-quaternary)',
} as const;

interface ProjectStats {
  total: number;
  done: number;
  active: number;
  blocked: number;
  todo: number;
}

function statsOf(tasks: readonly WorkTask[]): ProjectStats {
  const stats: ProjectStats = { total: tasks.length, done: 0, active: 0, blocked: 0, todo: 0 };
  for (const task of tasks) {
    if (task.status === 'delivered') stats.done += 1;
    else if (task.status === 'running' || task.status === 'review' || task.status === 'accepted')
      stats.active += 1;
    else if (task.status === 'rejected' || task.status === 'failed') stats.blocked += 1;
    else stats.todo += 1;
  }
  return stats;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function periodKeyOf(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** A quiet section header: one short rule, then the label. */
function SectionHead({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <header className="mb-3 flex items-center gap-2">
      <span aria-hidden className="h-px w-4 shrink-0 bg-line-strong" />
      <h3 className="shrink-0 text-2xs font-semibold tracking-[0.12em] text-ink-tertiary">
        {title}
      </h3>
      {hint ? (
        <span className="truncate font-mono text-3xs text-ink-quaternary">{hint}</span>
      ) : null}
      <span className="flex-1" />
      {action}
    </header>
  );
}

function Panel({
  title,
  hint,
  action,
  className,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('px-6 py-5', className)}>
      <SectionHead title={title} hint={hint} action={action} />
      {children}
    </section>
  );
}

function Metric({
  label,
  value,
  hint,
  children,
}: {
  label: string;
  value: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0 bg-panel px-5 py-3.5">
      <div className="text-3xs font-medium tracking-wide text-ink-quaternary">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="font-mono text-lg leading-none font-semibold tracking-tight text-ink">
          {value}
        </span>
        {hint ? (
          <span className="min-w-0 truncate text-3xs text-ink-quaternary">{hint}</span>
        ) : null}
      </div>
      {children ? <div className="mt-2.5">{children}</div> : null}
    </div>
  );
}

/**
 * Project rules: facts scoped to this project, which only assigned people receive.
 * Read first; the two inputs only appear when the boss asks to add one.
 */
function ProjectRules({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [facts, setFacts] = useState<OrgFactView[]>([]);
  const [subject, setSubject] = useState('');
  const [value, setValue] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let alive = true;
    void window
      .opc!.facts.list({ projectId })
      .then((rows) => {
        if (alive) setFacts(rows);
      })
      .catch(() => {
        if (alive) setFacts([]);
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  const save = async () => {
    if (!subject.trim() || !value.trim()) return;
    setFacts(
      await window.opc!.facts.write({
        scopeType: 'project',
        scopeId: projectId,
        subject: subject.trim(),
        object: value.trim(),
      }),
    );
    setSubject('');
    setValue('');
    setAdding(false);
  };

  return (
    <div>
      {facts.length > 0 ? (
        <ul data-testid="project-facts" className="space-y-1.5">
          {facts.map((fact) => (
            <li
              key={fact.id}
              data-testid="project-fact-row"
              className="flex items-baseline gap-2 border-b border-line/50 pb-1.5 last:border-0 last:pb-0"
            >
              <code className="shrink-0 font-mono text-3xs text-ink-quaternary">
                {fact.subject}
              </code>
              <span className="min-w-0 flex-1 text-xs leading-relaxed text-ink-secondary">
                {fact.object}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-3xs text-ink-quaternary">{t('projects.rulesEmpty')}</p>
      )}

      {adding ? (
        <div className="mt-3 space-y-1.5">
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder={t('projects.ruleSubject')}
            className="h-7 w-full rounded-md border border-line bg-surface px-2 text-2xs text-ink outline-none focus:border-accent"
          />
          <input
            data-testid="project-fact-value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save();
            }}
            placeholder={t('projects.ruleValue')}
            className="h-7 w-full rounded-md border border-line bg-surface px-2 text-2xs text-ink outline-none focus:border-accent"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-testid="project-fact-save"
              disabled={!subject.trim() || !value.trim()}
              onClick={() => void save()}
              className={cn(buttonClass.primary, 'h-6 px-2 text-2xs')}
            >
              {t('common.save')}
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="h-6 px-1.5 text-2xs text-ink-tertiary hover:text-ink"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-3 flex items-center gap-1 text-2xs text-ink-tertiary transition-colors hover:text-accent"
        >
          <Plus className="size-3" />
          {t('projects.addRule')}
        </button>
      )}
    </div>
  );
}

function CreateProjectPanel({
  departments,
  draft,
  onChange,
  onSubmit,
  onCancel,
}: {
  departments: DepartmentNode[];
  draft: { name: string; code: string; description: string; departmentId: string };
  onChange: (next: typeof draft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="mx-auto w-full max-w-[34rem] px-6 py-10">
      <div className="flex items-center gap-1.5 text-2xs text-ink-quaternary">
        <span>{t('projects.title')}</span>
        <span>›</span>
        <span>{t('projects.create')}</span>
      </div>
      <h2 className="mt-2 text-xl font-semibold tracking-tight text-ink">
        {t('projects.createTitle')}
      </h2>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-tertiary">{t('projects.createHint')}</p>

      <div className="mt-6 space-y-3.5">
        <Field label={t('projects.name')}>
          <input
            data-testid="project-name"
            autoFocus
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            placeholder={t('projects.namePlaceholder')}
            className="h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-accent"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('projects.codeLabel')} hint={t('projects.codeHint')}>
            <input
              value={draft.code}
              onChange={(event) =>
                onChange({ ...draft, code: event.target.value.toUpperCase().slice(0, 12) })
              }
              placeholder="PR-01"
              className="h-9 w-full rounded-lg border border-line bg-surface px-3 font-mono text-sm text-ink outline-none focus:border-accent"
            />
          </Field>
          <Field label={t('projects.department')}>
            <select
              value={draft.departmentId}
              onChange={(event) => onChange({ ...draft, departmentId: event.target.value })}
              className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent"
            >
              <option value="">{t('projects.noDepartment')}</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={t('projects.description')}>
          <textarea
            value={draft.description}
            onChange={(event) => onChange({ ...draft, description: event.target.value })}
            placeholder={t('projects.descriptionPlaceholder')}
            rows={3}
            className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm leading-relaxed text-ink outline-none focus:border-accent"
          />
        </Field>
      </div>

      <div className="mt-6 flex items-center gap-2">
        <button
          type="button"
          data-testid="project-create"
          disabled={!draft.name.trim()}
          onClick={onSubmit}
          className={buttonClass.primary}
        >
          {t('projects.createConfirm')}
        </button>
        <button type="button" onClick={onCancel} className={buttonClass.secondary}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

export function ProjectsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [tasks, setTasks] = useState<WorkTask[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [departments, setDepartments] = useState<DepartmentNode[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingTeam, setEditingTeam] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: '', code: '', description: '', departmentId: '' });
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const [list, tree, taskRows, budgetRows] = await Promise.all([
      window.opc!.projects.list(),
      window.opc!.org.list(),
      window.opc!.work.listTasks(500),
      window.opc!.work.listBudgets(),
    ]);
    setProjects(list);
    setDepartments(tree);
    setMembers(
      tree
        .flatMap((department) => department.members)
        .filter((member) => member.status === 'active'),
    );
    setTasks(taskRows);
    setBudgets(budgetRows);
    setSelectedId((current) =>
      current && list.some((project) => project.id === current) ? current : (list[0]?.id ?? null),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Work and money move while the page is open; the dossier follows without a reload.
  useEffect(() => {
    const offTask = window.opc!.work.onTaskChanged((task) => {
      setTasks((current) => {
        const index = current.findIndex((entry) => entry.id === task.id);
        if (index === -1) return [task, ...current];
        const next = current.slice();
        next[index] = task;
        return next;
      });
    });
    const offBudget = window.opc!.work.onBudgetsChanged(setBudgets);
    return () => {
      offTask();
      offBudget();
    };
  }, []);

  // Opening another file starts at its cover, not wherever the last one was left.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [selectedId, creating]);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const orgById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const tasksByProject = useMemo(() => {
    const map = new Map<string, WorkTask[]>();
    for (const task of tasks) {
      if (!task.projectGroupId) continue;
      const list = map.get(task.projectGroupId) ?? [];
      list.push(task);
      map.set(task.projectGroupId, list);
    }
    return map;
  }, [tasks]);

  const project = projects.find((entry) => entry.id === selectedId) ?? null;
  const projectTasks = useMemo(
    () => (project ? (tasksByProject.get(project.id) ?? []) : []),
    [project, tasksByProject],
  );
  const orderedTasks = useMemo(
    () =>
      [...projectTasks].sort(
        (left, right) =>
          STATUS_RANK[left.status] - STATUS_RANK[right.status] || right.updatedAt - left.updatedAt,
      ),
    [projectTasks],
  );
  const stats = useMemo(() => statsOf(projectTasks), [projectTasks]);
  const deliverables = useMemo(
    () =>
      projectTasks
        .flatMap((task) => task.artifacts.map((artifact) => ({ artifact, task })))
        .sort(
          (left, right) =>
            (right.task.finishedAt ?? right.task.updatedAt) -
            (left.task.finishedAt ?? left.task.updatedAt),
        )
        .slice(0, 8),
    [projectTasks],
  );
  // Count every file, not just the eight the panel lists.
  const artifactTotals = useMemo(() => {
    let count = 0;
    let bytes = 0;
    for (const task of projectTasks) {
      count += task.artifacts.length;
      for (const artifact of task.artifacts) bytes += artifact.bytes;
    }
    return { count, bytes };
  }, [projectTasks]);
  const budget = useMemo(
    () =>
      project
        ? budgets.find(
            (entry) =>
              entry.scope === 'project' &&
              entry.scopeId === project.id &&
              entry.periodKey === periodKeyOf(),
          )
        : undefined,
    [budgets, project],
  );

  const department = departments.find((entry) => entry.id === project?.departmentId);
  const accent = department?.color ?? 'var(--accent)';
  const percent = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;
  const budgetRatio = budget && budget.limitTokens > 0 ? budget.usedTokens / budget.limitTokens : 0;

  const submitCreate = () =>
    void run(async () => {
      const created = await window.opc!.projects.create({
        name: draft.name.trim(),
        code: draft.code.trim() || undefined,
        description: draft.description.trim() || undefined,
        departmentId: draft.departmentId || undefined,
      });
      setDraft({ name: '', code: '', description: '', departmentId: '' });
      setCreating(false);
      setSelectedId(created[0]?.id ?? null);
    });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-panel">
      {/* ── Index ─────────────────────────────────────────────────────── */}
      <aside className="flex w-[16rem] shrink-0 flex-col border-r border-line bg-surface-muted/30 xl:w-[17.5rem]">
        <div className="flex items-center gap-2 px-4 pt-5 pb-2.5">
          <h1 className="text-sm font-semibold tracking-tight text-ink">{t('projects.title')}</h1>
          <span className="font-mono text-3xs text-ink-quaternary">
            {String(projects.length).padStart(2, '0')}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            data-testid="project-create-open"
            aria-label={t('projects.create')}
            title={t('projects.create')}
            onClick={() => {
              setCreating(true);
              setError(null);
            }}
            className="grid size-6 place-items-center rounded-md border border-line bg-surface text-ink-tertiary transition-colors hover:text-ink"
          >
            <Plus className="size-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {projects.length === 0 ? (
            <p className="px-2 py-6 text-3xs leading-relaxed text-ink-quaternary">
              {t('projects.empty')}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {projects.map((entry) => {
                const entryStats = statsOf(tasksByProject.get(entry.id) ?? []);
                const ratio = entryStats.total > 0 ? entryStats.done / entryStats.total : 0;
                const entryDepartment = departments.find(
                  (departmentRow) => departmentRow.id === entry.departmentId,
                );
                // Each entry keeps its own department colour; the rail must not repaint
                // every project in the accent of whichever one happens to be open.
                const entryAccent = entryDepartment?.color ?? 'var(--accent)';
                const selected = !creating && entry.id === project?.id;
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      data-testid="project-row"
                      onClick={() => {
                        setSelectedId(entry.id);
                        setCreating(false);
                        setEditingTeam(false);
                      }}
                      className={cn(
                        'w-full rounded-lg px-2.5 py-2 text-left transition-colors',
                        selected
                          ? 'bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                          : 'hover:bg-surface/70',
                      )}
                    >
                      <span className="flex items-center gap-1.5">
                        <span
                          aria-hidden
                          className="size-1.5 shrink-0 rounded-full"
                          style={{ background: entryAccent }}
                        />
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-xs',
                            selected ? 'font-medium text-ink' : 'text-ink-secondary',
                          )}
                        >
                          {entry.name}
                        </span>
                      </span>
                      <span className="mt-1 flex items-center gap-1.5 pl-3">
                        <code className="font-mono text-3xs text-ink-quaternary">
                          {entry.code || '—'}
                        </code>
                        <span className="font-mono text-3xs text-ink-quaternary">
                          {entryStats.done}/{entryStats.total}
                        </span>
                        <span className="flex-1" />
                        <span className="text-3xs text-ink-quaternary">
                          {t('projects.peopleShort', { count: entry.members.length })}
                        </span>
                      </span>
                      <span className="mt-1.5 ml-3 block h-[3px] overflow-hidden rounded-full bg-line/60">
                        <span
                          className="block h-full rounded-full transition-[width]"
                          style={{
                            width: `${ratio * 100}%`,
                            background: ratio >= 1 ? 'var(--success)' : entryAccent,
                          }}
                        />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <p className="border-t border-line px-4 py-3 text-3xs leading-relaxed text-ink-quaternary">
          {t('projects.railHint')}
        </p>
      </aside>

      {/* ── Dossier ───────────────────────────────────────────────────── */}
      <div ref={scroller} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        {error ? (
          <p className="shrink-0 border-b border-danger/20 bg-danger/5 px-6 py-2 text-xs text-danger">
            {error}
          </p>
        ) : null}

        {creating ? (
          <CreateProjectPanel
            departments={departments}
            draft={draft}
            onChange={setDraft}
            onSubmit={submitCreate}
            onCancel={() => {
              setCreating(false);
              setDraft({ name: '', code: '', description: '', departmentId: '' });
            }}
          />
        ) : !project ? (
          <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
            <span className="grid size-12 place-items-center rounded-2xl border border-line bg-surface text-ink-quaternary">
              <FolderPlus className="size-5" />
            </span>
            <h2 className="mt-4 text-base font-semibold text-ink">{t('projects.emptyTitle')}</h2>
            <p className="mt-1.5 max-w-[26rem] text-xs leading-relaxed text-ink-tertiary">
              {t('projects.emptyHint')}
            </p>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className={cn(buttonClass.primary, 'mt-5')}
            >
              <Plus className="size-4" />
              {t('projects.create')}
            </button>
          </div>
        ) : (
          <div className="flex min-h-full flex-col">
            {/* Masthead: the project's identity, read like the cover of its file. */}
            <header className="relative shrink-0 overflow-hidden px-6 pt-7 pb-5">
              <span
                aria-hidden
                className="pointer-events-none absolute -top-7 right-4 font-mono text-[6rem] leading-none font-semibold tracking-tighter text-ink opacity-[0.035] select-none"
              >
                {project.code || 'PROJ'}
              </span>
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-[3px]"
                style={{ background: accent }}
              />

              <div className="relative">
                <div className="flex flex-wrap items-center gap-2 text-2xs text-ink-quaternary">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full" style={{ background: accent }} />
                    {department?.name ?? t('projects.noDepartment')}
                  </span>
                  <span aria-hidden>·</span>
                  <code className="font-mono">{project.code || '—'}</code>
                  {project.createdAt ? (
                    <>
                      <span aria-hidden>·</span>
                      <span>
                        {t('projects.createdOn', {
                          date: new Date(project.createdAt).toLocaleDateString(),
                        })}
                      </span>
                    </>
                  ) : null}
                </div>

                <h2 className="mt-2 text-[1.45rem] leading-tight font-semibold tracking-tight text-ink">
                  {project.name}
                </h2>
                <p className="mt-1.5 max-w-[46rem] text-xs-plus leading-relaxed text-ink-secondary">
                  {project.description || t('projects.noDescription')}
                </p>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-3xs font-medium text-success">
                    <span className="size-1.5 rounded-full bg-current" />
                    {t('projects.status.active')}
                  </span>
                  <span className="text-3xs text-ink-quaternary">
                    {t('projects.peopleShort', { count: project.members.length })}
                  </span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={() => setEditingTeam((value) => !value)}
                    className={cn(buttonClass.secondary, 'h-7 text-xs')}
                  >
                    {editingTeam ? t('projects.doneEditing') : t('projects.editTeam')}
                  </button>
                </div>
              </div>
            </header>

            {/* Metrics: progress, live work, output, money — the four questions asked first. */}
            <div className="grid shrink-0 grid-cols-2 gap-px border-y border-line bg-line/70 lg:grid-cols-4">
              <Metric
                label={t('projects.metrics.progress')}
                value={`${percent}%`}
                hint={t('projects.metrics.progressHint', {
                  done: stats.done,
                  total: stats.total,
                })}
              >
                <StackedBar
                  ariaLabel={t('projects.metrics.progress')}
                  segments={[
                    {
                      key: 'done',
                      label: t('projects.metrics.done'),
                      value: stats.done,
                      color: 'var(--success)',
                    },
                    {
                      key: 'active',
                      label: t('projects.metrics.active'),
                      value: stats.active,
                      color: 'var(--accent)',
                    },
                    {
                      key: 'blocked',
                      label: t('projects.metrics.blocked'),
                      value: stats.blocked,
                      color: 'var(--danger)',
                    },
                    {
                      key: 'todo',
                      label: t('projects.metrics.todo'),
                      value: stats.todo,
                      color: 'var(--text-quaternary)',
                    },
                  ]}
                  height={4}
                />
              </Metric>
              <Metric
                label={t('projects.metrics.active')}
                value={String(stats.active)}
                hint={t('projects.metrics.activeHint')}
              />
              <Metric
                label={t('projects.metrics.artifacts')}
                value={String(artifactTotals.count)}
                hint={
                  artifactTotals.bytes > 0
                    ? formatBytes(artifactTotals.bytes)
                    : t('projects.metrics.artifactsNone')
                }
              />
              <Metric
                label={t('projects.metrics.budget')}
                value={budget ? `${Math.round(budgetRatio * 100)}%` : '—'}
                hint={
                  budget
                    ? t('projects.metrics.budgetHint', {
                        used: budget.usedTokens.toLocaleString(),
                        limit: budget.limitTokens.toLocaleString(),
                      })
                    : t('projects.metrics.noBudget')
                }
              >
                <span className="block h-1 overflow-hidden rounded-full bg-line/60">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.min(100, Math.round(budgetRatio * 100))}%`,
                      background: TONE_VAR[toneForRatio(budgetRatio)],
                    }}
                  />
                </span>
              </Metric>
            </div>

            <div className="grid shrink-0 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
              {/* Left column: the work itself. */}
              <div className="min-w-0 divide-y divide-line xl:border-r xl:border-line">
                <Panel
                  title={t('projects.workTitle')}
                  hint={t('projects.workHint', { count: projectTasks.length })}
                  action={
                    <button
                      type="button"
                      onClick={() => navigate('/issues')}
                      className="flex items-center gap-1 text-3xs text-ink-quaternary transition-colors hover:text-accent"
                    >
                      {t('projects.viewAllWork')}
                      <ArrowRight className="size-3" />
                    </button>
                  }
                >
                  {orderedTasks.length === 0 ? (
                    <p className="text-3xs leading-relaxed text-ink-quaternary">
                      {t('projects.workEmpty')}
                    </p>
                  ) : (
                    <ul className="divide-y divide-line/50">
                      {orderedTasks.slice(0, 8).map((task) => {
                        const overdue =
                          task.dueAt &&
                          task.dueAt < Date.now() &&
                          task.status !== 'delivered' &&
                          task.status !== 'accepted';
                        return (
                          <li key={task.id} className="flex items-center gap-2 py-2 first:pt-0">
                            <span
                              aria-hidden
                              className={cn(
                                'size-1.5 shrink-0 rounded-full',
                                STATUS_DOT[task.status],
                              )}
                            />
                            <code className="w-14 shrink-0 truncate font-mono text-3xs text-ink-quaternary">
                              {task.issueKey ?? '—'}
                            </code>
                            <span
                              className={cn(
                                'min-w-0 flex-1 truncate text-xs',
                                task.status === 'delivered'
                                  ? 'text-ink-tertiary line-through decoration-line-strong'
                                  : 'text-ink',
                              )}
                              title={task.title}
                            >
                              {task.title}
                            </span>
                            {task.priority === 'P0' || task.priority === 'P1' ? (
                              <span className="shrink-0 rounded bg-danger/10 px-1 font-mono text-3xs text-danger">
                                {task.priority}
                              </span>
                            ) : null}
                            {overdue ? (
                              <span className="shrink-0 text-3xs text-danger">
                                {t('issues.overdue')}
                              </span>
                            ) : null}
                            <span className="w-14 shrink-0 truncate text-right text-3xs text-ink-tertiary">
                              {task.assigneeName}
                            </span>
                            <span
                              className={cn(
                                'w-16 shrink-0 text-right text-3xs',
                                STATUS_INK[task.status],
                              )}
                            >
                              {t(`task.status.${task.status}`)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {orderedTasks.length > 8 ? (
                    <p className="mt-2 text-3xs text-ink-quaternary">
                      {t('projects.workMore', { count: orderedTasks.length - 8 })}
                    </p>
                  ) : null}
                </Panel>

                <Panel
                  title={t('projects.artifactsTitle')}
                  hint={t('projects.artifactsHint', { count: artifactTotals.count })}
                >
                  {deliverables.length === 0 ? (
                    <p className="text-3xs leading-relaxed text-ink-quaternary">
                      {t('projects.artifactsEmpty')}
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {deliverables.map(({ artifact, task }) => (
                        <li
                          key={artifact.id}
                          className="flex items-baseline gap-2"
                          title={artifact.relPath}
                        >
                          <FileText className="size-3 shrink-0 self-center text-ink-quaternary" />
                          <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink">
                            {artifact.relPath.split('/').pop()}
                          </span>
                          <span className="shrink-0 font-mono text-3xs text-ink-quaternary">
                            {formatBytes(artifact.bytes)}
                          </span>
                          <code className="w-14 shrink-0 text-right font-mono text-3xs text-ink-quaternary">
                            {task.issueKey ?? '—'}
                          </code>
                        </li>
                      ))}
                    </ul>
                  )}
                  {artifactTotals.count > deliverables.length ? (
                    <p className="mt-2 text-3xs text-ink-quaternary">
                      {t('projects.artifactsMore', {
                        count: artifactTotals.count - deliverables.length,
                      })}
                    </p>
                  ) : null}
                </Panel>
              </div>

              {/* Right column: the people and the rules they work under. */}
              <div className="flex min-w-0 flex-col divide-y divide-line">
                <Panel
                  title={t('projects.teamTitle')}
                  hint={t('projects.peopleShort', { count: project.members.length })}
                >
                  {project.members.length === 0 ? (
                    <p className="text-3xs text-ink-quaternary">{t('projects.teamEmpty')}</p>
                  ) : (
                    <ul className="space-y-2">
                      {project.members.map((member) => {
                        const employee = orgById.get(member.employeeId);
                        const manager = project.members.find(
                          (entry) => entry.employeeId === member.reportsToEmployeeId,
                        );
                        return (
                          <li key={member.employeeId} data-testid="project-member">
                            <div className="flex items-center gap-2">
                              <Avatar
                                name={member.name}
                                src={employee?.avatar || undefined}
                                size="xs"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-baseline gap-1.5">
                                  <span className="truncate text-xs text-ink">{member.name}</span>
                                  {member.status === 'paused' ? (
                                    <span className="shrink-0 text-3xs text-warning">
                                      {t('projects.paused')}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="truncate text-3xs text-ink-quaternary">
                                  {member.role || employee?.role || ''}
                                  {manager ? (
                                    <>
                                      <span aria-hidden> · </span>
                                      {t('projects.reportsToName', { name: manager.name })}
                                    </>
                                  ) : null}
                                </div>
                              </div>
                              <code className="shrink-0 font-mono text-3xs text-ink-quaternary">
                                {employee?.level ?? ''}
                              </code>
                              {editingTeam ? (
                                <button
                                  type="button"
                                  aria-label={`${t('projects.remove')} ${member.name}`}
                                  onClick={() =>
                                    void run(() =>
                                      window.opc!.projects.removeMember(
                                        project.id,
                                        member.employeeId,
                                      ),
                                    )
                                  }
                                  className="shrink-0 rounded p-0.5 text-ink-quaternary transition-colors hover:text-danger"
                                >
                                  <X className="size-3" />
                                </button>
                              ) : null}
                            </div>

                            {editingTeam ? (
                              <label className="mt-1.5 flex items-center gap-1.5 pl-8">
                                <span className="shrink-0 text-3xs text-ink-quaternary">
                                  {t('projects.reportsTo')}
                                </span>
                                <select
                                  data-testid="project-reports-to"
                                  value={member.reportsToEmployeeId ?? ''}
                                  onChange={(event) =>
                                    void run(() =>
                                      window.opc!.projects.setReportsTo(
                                        project.id,
                                        member.employeeId,
                                        event.target.value || null,
                                      ),
                                    )
                                  }
                                  className="h-6 min-w-0 flex-1 rounded-md border border-line bg-surface px-1.5 text-3xs text-ink outline-none focus:border-accent"
                                >
                                  <option value="">{t('projects.noReportsTo')}</option>
                                  {project.members
                                    .filter((entry) => entry.employeeId !== member.employeeId)
                                    .map((entry) => (
                                      <option key={entry.employeeId} value={entry.employeeId}>
                                        {entry.name}
                                      </option>
                                    ))}
                                </select>
                              </label>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {editingTeam ? (
                    <select
                      data-testid="project-add-member"
                      aria-label={t('projects.addMember')}
                      defaultValue=""
                      onChange={(event) => {
                        if (!event.target.value) return;
                        void run(() => window.opc!.projects.assign(project.id, event.target.value));
                      }}
                      className="mt-3 h-7 w-full rounded-md border border-dashed border-line bg-surface px-1.5 text-2xs text-ink outline-none focus:border-accent"
                    >
                      <option value="">{t('projects.pickMember')}</option>
                      {members
                        .filter(
                          (member) =>
                            !project.members.some((entry) => entry.employeeId === member.id),
                        )
                        .map((member) => (
                          <option key={member.id} value={member.id}>
                            {member.name} · {member.role}
                          </option>
                        ))}
                    </select>
                  ) : null}
                </Panel>

                <Panel title={t('projects.rulesTitle')} hint={t('projects.rulesHint')}>
                  <ProjectRules projectId={project.id} />
                </Panel>
              </div>
            </div>

            {/* The footer is page chrome, not a column: archiving ends the file, so it
                belongs at the bottom of the page, never floating inside a section. */}
            <footer className="mt-auto flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-6 py-3">
              <p className="min-w-0 flex-1 text-3xs leading-relaxed text-ink-quaternary">
                {t('projects.archiveHint')}
              </p>
              <button
                type="button"
                data-testid="project-archive"
                onClick={() => void run(() => window.opc!.projects.archive(project.id))}
                className={cn(buttonClass.danger, 'h-7 text-xs')}
              >
                <Archive className="size-3.5" />
                {t('projects.archive')}
              </button>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
