import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderPlus, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Budget, DepartmentNode, OrgMember, WorkTask } from '@opc/shared/domain';
import type { ProjectView } from '@opc/shared/ipc';
import { buttonClass, Field } from '@/features/settings/ui/kit';
import { useWorkRuntime } from '@/features/task/model/useWorkRuntime';
import {
  DispatchTaskDialog,
  type DispatchCandidate,
  type DispatchDraft,
} from '@/features/task/ui/DispatchTaskDialog';
import { cn } from '@/shared/lib/cn';
import { ProjectDossier } from './ProjectDossier';
import { ProjectRail, type RailProject } from './ProjectRail';
import { ProjectSettingsDrawer } from './ProjectSettingsDrawer';
import {
  artifactTotalsOf,
  boardOf,
  periodKeyOf,
  statsOf,
} from './projectBoard';

/**
 * Projects, as a room with an index rather than a table with cards.
 *
 * The page answers four questions in order: what is this project, how far along
 * is it, what is stuck, and who is on it. Anything that only *changes* the project
 * lives in the settings drawer, so the body never doubles as a form.
 */
export function ProjectsPage() {
  const { t } = useTranslation();
  const { createTask, budgetFor } = useWorkRuntime();

  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [tasks, setTasks] = useState<WorkTask[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [departments, setDepartments] = useState<DepartmentNode[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [draft, setDraft] = useState({ name: '', code: '', description: '', departmentId: '' });
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const [list, tree, taskRows, budgetRows] = await Promise.all([
      // The index keeps archived projects one fold away instead of losing them.
      window.opc!.projects.list({ includeArchived: true }),
      window.opc!.org.list(),
      window.opc!.work.listTasks(500),
      window.opc!.work.listBudgets(),
    ]);
    setProjects(list);
    setDepartments(tree);
    setMembers(
      tree.flatMap((department) => department.members).filter((member) => member.status === 'active'),
    );
    setTasks(taskRows);
    setBudgets(budgetRows);
    setSelectedId((current) => {
      if (current && list.some((project) => project.id === current)) return current;
      const firstLive = list.find((project) => project.status !== 'archived');
      return (firstLive ?? list[0])?.id ?? null;
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Work moves while the page is open; the board follows without a reload.
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
    setSettingsOpen(false);
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

  const railRows: RailProject[] = useMemo(
    () =>
      projects.map((entry) => {
        const stats = statsOf(tasksByProject.get(entry.id) ?? []);
        const department = departments.find((node) => node.id === entry.departmentId);
        return {
          project: entry,
          accent: department?.color ?? 'var(--accent)',
          done: stats.done,
          total: stats.total,
        };
      }),
    [projects, tasksByProject, departments],
  );
  const rail = useMemo(
    () => railRows.filter((entry) => entry.project.status !== 'archived'),
    [railRows],
  );
  const archivedRail = useMemo(
    () => railRows.filter((entry) => entry.project.status === 'archived'),
    [railRows],
  );

  const project = projects.find((entry) => entry.id === selectedId) ?? null;
  const projectTasks = useMemo(
    () => (project ? (tasksByProject.get(project.id) ?? []) : []),
    [project, tasksByProject],
  );
  const stats = useMemo(() => statsOf(projectTasks), [projectTasks]);
  const board = useMemo(() => boardOf(projectTasks), [projectTasks]);
  const artifactTotals = useMemo(() => artifactTotalsOf(projectTasks), [projectTasks]);
  const artifacts = useMemo(
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
  const candidates = useMemo(
    () => members.filter((member) => !project?.members.some((entry) => entry.employeeId === member.id)),
    [members, project],
  );
  // Dispatch needs an id/name/role; a project member carries `employeeId`, the org
  // roster carries `id`. Normalising here keeps the dialog unaware of both shapes.
  const dispatchAgents: DispatchCandidate[] = useMemo(() => {
    if (!project) return [];
    if (project.members.length > 0) {
      return project.members.map((member) => ({
        id: member.employeeId,
        name: member.name,
        role: member.role,
      }));
    }
    return members.map((member) => ({ id: member.id, name: member.name, role: member.role }));
  }, [project, members]);

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

  const dispatch = async (input: DispatchDraft) => {
    const result = await createTask(input);
    if (result.ok) await load();
    return result;
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-panel">
      <ProjectRail
        projects={rail}
        archived={archivedRail}
        selectedId={project?.id ?? null}
        creating={creating}
        onSelect={(id) => {
          setSelectedId(id);
          setCreating(false);
        }}
        onCreate={() => {
          setCreating(true);
          setError(null);
        }}
      />

      <div ref={scroller} className="page-scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
        {error ? (
          <p className="border-b border-danger/20 bg-danger/5 px-6 py-2 text-xs text-danger">{error}</p>
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
          <div className="flex h-full flex-col items-center justify-center px-8 text-center">
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
          <ProjectDossier
            project={project}
            department={department}
            stats={stats}
            board={board}
            artifacts={artifacts}
            artifactTotals={artifactTotals}
            budget={budget}
            cancelled={projectTasks.filter((task) => task.status === 'cancelled').length}
            orgById={orgById}
            onDispatch={() => setDispatchOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            onSetStatus={(status) => {
              void run(() => window.opc!.projects.setStatus(project.id, status));
            }}
          />
        )}
      </div>

      {settingsOpen && project && project.status !== 'archived' ? (
        <ProjectSettingsDrawer
          project={project}
          orgById={orgById}
          candidates={candidates}
          onAssign={(employeeId, role) =>
            run(() => window.opc!.projects.assign(project.id, employeeId, role))
          }
          onRemoveMember={(employeeId) =>
            run(() => window.opc!.projects.removeMember(project.id, employeeId))
          }
          onSetReportsTo={(employeeId, managerId) =>
            run(() => window.opc!.projects.setReportsTo(project.id, employeeId, managerId))
          }
          onAddMilestone={(title, dueAt) =>
            run(() => window.opc!.projects.addMilestone(project.id, { title, dueAt }))
          }
          onUpdateMilestone={(milestoneId, patch) =>
            run(() => window.opc!.projects.updateMilestone(milestoneId, patch))
          }
          onRemoveMilestone={(milestoneId) =>
            run(() => window.opc!.projects.removeMilestone(milestoneId))
          }
          onArchive={async () => {
            await run(() => window.opc!.projects.archive(project.id));
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {dispatchOpen && project && project.status === 'active' ? (
        <DispatchTaskDialog
          agents={dispatchAgents}
          defaultAssigneeId={dispatchAgents[0]?.id ?? ''}
          projects={[project]}
          defaultProjectId={project.id}
          budgetFor={budgetFor}
          onSubmit={dispatch}
          onClose={() => setDispatchOpen(false)}
        />
      ) : null}
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
  departments: readonly DepartmentNode[];
  draft: { name: string; code: string; description: string; departmentId: string };
  onChange: (draft: { name: string; code: string; description: string; departmentId: string }) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="mx-auto w-full max-w-[36rem] px-7 py-8"
    >
      <h2 className="text-lg font-semibold tracking-tight text-ink">{t('projects.createTitle')}</h2>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-tertiary">{t('projects.createHint')}</p>

      <div className="mt-6 space-y-4">
        <Field label={t('projects.name')}>
          <input
            data-testid="project-name"
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            placeholder={t('projects.namePlaceholder')}
            autoFocus
            required
            className="h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-ink outline-none placeholder:text-ink-quaternary focus:border-accent"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('projects.codeLabel')} hint={t('projects.codeHint')}>
            <input
              value={draft.code}
              onChange={(event) => onChange({ ...draft, code: event.target.value.toUpperCase() })}
              className="h-9 w-full rounded-lg border border-line bg-surface px-2.5 font-mono text-sm text-ink outline-none focus:border-accent"
            />
          </Field>
          <Field label={t('projects.department')}>
            <select
              value={draft.departmentId}
              onChange={(event) => onChange({ ...draft, departmentId: event.target.value })}
              className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent"
            >
              <option value="">{t('projects.noDepartment')}</option>
              {departments.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label={t('projects.description')}>
          <textarea
            value={draft.description}
            onChange={(event) => onChange({ ...draft, description: event.target.value })}
            rows={3}
            placeholder={t('projects.descriptionPlaceholder')}
            className="w-full resize-none rounded-lg border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none placeholder:text-ink-quaternary focus:border-accent"
          />
        </Field>
      </div>

      <div className="mt-6 flex items-center gap-2">
        <button
          type="submit"
          data-testid="project-create"
          disabled={!draft.name.trim()}
          className={buttonClass.primary}
        >
          {t('projects.createConfirm')}
        </button>
        <button type="button" onClick={onCancel} className="px-3 text-sm text-ink-secondary hover:text-ink">
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
