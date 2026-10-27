import { useEffect, useMemo, useState } from 'react';
import { Archive, FolderPlus, Plus, Users, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DepartmentNode, OrgMember } from '@opc/shared/domain';
import type { OrgFactView, ProjectView } from '@opc/shared/ipc';
import { cn } from '@/shared/lib/cn';
import { buttonClass } from '@/features/settings/ui/kit';

/**
 * Project rules: facts scoped to this project, which only assigned people receive.
 * Same shape as the department block — one list, one inline write, no modals.
 */
function ProjectRules({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [facts, setFacts] = useState<OrgFactView[]>([]);
  const [subject, setSubject] = useState('');
  const [value, setValue] = useState('');

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
  };

  return (
    <div className="mt-1.5">
      <div className="mb-1 text-3xs text-ink-quaternary">
        {t('projects.rules')} · {facts.length}
      </div>
      {facts.length > 0 ? (
        <ul data-testid="project-facts" className="mb-1 space-y-0.5">
          {facts.map((fact) => (
            <li key={fact.id} data-testid="project-fact-row" className="flex gap-1.5 text-2xs">
              <span className="shrink-0 font-mono text-3xs text-ink-quaternary">{fact.subject}</span>
              <span className="min-w-0 flex-1 truncate text-ink-secondary">{fact.object}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-1.5">
        <input
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder={t('projects.ruleSubject')}
          className="h-6 w-28 rounded border border-line bg-surface px-1.5 text-2xs text-ink outline-none focus:border-accent"
        />
        <input
          data-testid="project-fact-value"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save();
          }}
          placeholder={t('projects.ruleValue')}
          className="h-6 min-w-40 flex-1 rounded border border-line bg-surface px-1.5 text-2xs text-ink outline-none focus:border-accent"
        />
        <button
          type="button"
          data-testid="project-fact-save"
          disabled={!subject.trim() || !value.trim()}
          onClick={() => void save()}
          className="h-6 rounded bg-accent px-2 text-2xs font-medium text-white disabled:opacity-40"
        >
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}

/**
 * Projects — where an employee works *besides* their seat in the org chart.
 *
 * Same restraint as the issue ledger: a list, hairline rows, one inline create form.
 * The reason this page exists at all is scoping: project facts and memories only
 * reach people who are assigned to that project, so assignment must be visible and
 * editable by the boss, not buried in an API.
 */
export function ProjectsPage() {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [departments, setDepartments] = useState<DepartmentNode[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: '', code: '', description: '', departmentId: '' });
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [list, tree] = await Promise.all([window.opc!.projects.list(), window.opc!.org.list()]);
    setProjects(list);
    setDepartments(tree);
    setMembers(tree.flatMap((department) => department.members).filter((member) => member.status === 'active'));
  };

  useEffect(() => {
    void load();
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const assignable = useMemo(
    () => (project: ProjectView) =>
      members.filter((member) => !project.members.some((entry) => entry.employeeId === member.id)),
    [members],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel">
      <header className="shrink-0 border-b border-line px-8 pt-5 pb-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-ink">{t('projects.title')}</h1>
          <span className="font-mono text-2xs text-ink-quaternary">{projects.length}</span>
          <span className="flex-1" />
          <button
            type="button"
            data-testid="project-create-open"
            onClick={() => setCreating((open) => !open)}
            className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white"
          >
            <FolderPlus className="size-3.5" />
            {t('projects.create')}
          </button>
        </div>
        <p className="mt-1 text-xs text-ink-tertiary">{t('projects.desc')}</p>

        {creating ? (
          <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface px-3 py-2">
            <input
              data-testid="project-name"
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder={t('projects.name')}
              className="h-7 w-40 rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-accent"
            />
            <input
              value={draft.code}
              onChange={(event) => setDraft((current) => ({ ...current, code: event.target.value.toUpperCase() }))}
              placeholder="PR-01"
              className="h-7 w-24 rounded-md border border-line bg-surface px-2 font-mono text-xs text-ink outline-none focus:border-accent"
            />
            <select
              value={draft.departmentId}
              onChange={(event) => setDraft((current) => ({ ...current, departmentId: event.target.value }))}
              aria-label={t('projects.department')}
              className="h-7 rounded-md border border-line bg-surface px-1.5 text-xs text-ink outline-none"
            >
              <option value="">{t('projects.noDepartment')}</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
            <input
              value={draft.description}
              onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
              placeholder={t('projects.description')}
              className="h-7 min-w-48 flex-1 rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-accent"
            />
            <button
              type="button"
              data-testid="project-create"
              disabled={!draft.name.trim()}
              onClick={() =>
                void run(async () => {
                  await window.opc!.projects.create({
                    name: draft.name.trim(),
                    code: draft.code.trim() || undefined,
                    description: draft.description.trim() || undefined,
                    departmentId: draft.departmentId || undefined,
                  });
                  setDraft({ name: '', code: '', description: '', departmentId: '' });
                  setCreating(false);
                })
              }
              className={cn(buttonClass.primary, 'h-7 text-xs', !draft.name.trim() && 'opacity-40')}
            >
              {t('common.save')}
            </button>
          </div>
        ) : null}

        {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {projects.length === 0 ? (
          <p className="px-8 py-16 text-center text-sm text-ink-quaternary">{t('projects.empty')}</p>
        ) : (
          <ul>
            {projects.map((project) => {
              const department = departments.find((entry) => entry.id === project.departmentId);
              const candidates = assignable(project);
              return (
                <li key={project.id} data-testid="project-row" className="border-b border-line/60 px-8 py-3">
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden
                      className="mt-1.5 h-8 w-[3px] shrink-0 rounded"
                      style={{ background: department?.color ?? 'var(--accent)' }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">{project.name}</span>
                        {project.code ? (
                          <span className="shrink-0 font-mono text-3xs text-ink-quaternary">{project.code}</span>
                        ) : null}
                        <span className="shrink-0 rounded bg-surface-muted px-1.5 text-3xs text-ink-tertiary">
                          <Users className="mr-1 inline size-2.5" />
                          {project.members.length}
                        </span>
                        {department ? (
                          <span className="shrink-0 text-3xs text-ink-quaternary">{department.name}</span>
                        ) : null}
                        <span className="flex-1" />
                        <button
                          type="button"
                          aria-label={t('projects.archive')}
                          data-testid="project-archive"
                          onClick={() => void run(() => window.opc!.projects.archive(project.id))}
                          className="rounded p-1 text-ink-quaternary hover:text-danger"
                        >
                          <Archive className="size-3.5" />
                        </button>
                      </div>
                      <p className="mt-0.5 truncate text-2xs text-ink-quaternary">
                        {project.description || t('projects.noDescription')}
                      </p>

                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        {project.members.map((member) => (
                          <span
                            key={member.employeeId}
                            data-testid="project-member"
                            className="flex items-center gap-1 rounded bg-surface-muted px-1.5 py-0.5 text-2xs text-ink-secondary"
                          >
                            {member.name}
                            <button
                              type="button"
                              aria-label={`${t('projects.remove')} ${member.name}`}
                              onClick={() =>
                                void run(() => window.opc!.projects.removeMember(project.id, member.employeeId))
                              }
                              className="text-ink-quaternary hover:text-danger"
                            >
                              <X className="size-2.5" />
                            </button>
                          </span>
                        ))}
                        <button
                          type="button"
                          data-testid="project-add-member"
                          onClick={() => setOpenFor((current) => (current === project.id ? null : project.id))}
                          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-accent hover:bg-accent-soft"
                        >
                          <Plus className="size-3" />
                          {t('projects.addMember')}
                        </button>
                      </div>

                      <ProjectRules projectId={project.id} />

                      {openFor === project.id ? (
                        <select
                          aria-label={t('projects.addMember')}
                          defaultValue=""
                          onChange={(event) => {
                            if (!event.target.value) return;
                            void run(() => window.opc!.projects.assign(project.id, event.target.value));
                            setOpenFor(null);
                          }}
                          className="mt-1.5 h-7 rounded-md border border-line bg-surface px-1.5 text-xs text-ink outline-none"
                        >
                          <option value="">{t('projects.pickMember')}</option>
                          {candidates.map((member) => (
                            <option key={member.id} value={member.id}>
                              {member.name} · {member.role}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
