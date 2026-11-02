import { AlertTriangle, ArrowRight, Check, ChevronDown, FileText, Settings2, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { Budget, DepartmentNode, EditableProjectStatus, OrgMember, ProjectStatus, WorkTask } from '@opc/shared/domain';
import { PROJECT_STATUSES } from '@opc/shared/domain';
import type { ProjectView } from '@opc/shared/ipc';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { buttonClass } from '@/features/settings/ui/kit';
import { cn } from '@/shared/lib/cn';
import { StackedBar, toneForRatio } from '@/shared/ui/charts';
import {
  BOARD_COLUMNS,
  type BoardColumn,
  type ProjectStats,
  completionOf,
  formatBytes,
  isOverdue,
  needsAttention,
} from './projectBoard';

interface ProjectDossierProps {
  project: ProjectView;
  department?: DepartmentNode;
  stats: ProjectStats;
  board: Record<BoardColumn, WorkTask[]>;
  artifacts: { artifact: WorkTask['artifacts'][number]; task: WorkTask }[];
  artifactTotals: { count: number; bytes: number };
  budget?: Budget;
  cancelled: number;
  orgById: Map<string, OrgMember>;
  onDispatch: () => void;
  onOpenSettings: () => void;
  onSetStatus: (status: EditableProjectStatus) => void;
}

/**
 * One project, read top to bottom in the order the question is asked:
 * **what is this → how far along → what is stuck → who is on it.**
 *
 * The four big metric cards and the two-column panel grid it replaces gave every
 * block the same weight, so the only thing the eye could find was the title. The
 * board is now the body of the page, and everything that changes the project
 * moved into the settings drawer.
 */
export function ProjectDossier({
  project,
  department,
  stats,
  board,
  artifacts,
  artifactTotals,
  budget,
  cancelled,
  orgById,
  onDispatch,
  onOpenSettings,
  onSetStatus,
}: ProjectDossierProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const accent = department?.color ?? 'var(--accent)';
  const percent = Math.round(completionOf(stats) * 100);
  const budgetRatio = budget && budget.limitTokens > 0 ? budget.usedTokens / budget.limitTokens : 0;
  const archived = project.status === 'archived';

  return (
    <div className="flex min-h-full flex-col">
      <header className="relative shrink-0 px-7 pt-6 pb-4">
        <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: accent }} />
        <div className="flex flex-wrap items-center gap-1.5 text-2xs text-ink-quaternary">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-1.5 rounded-full" style={{ background: accent }} />
            {department?.name ?? t('projects.noDepartment')}
          </span>
          <span aria-hidden>·</span>
          <code className="font-mono">{project.code || '—'}</code>
          {project.createdAt ? (
            <>
              <span aria-hidden>·</span>
              <span>{t('projects.createdOn', { date: new Date(project.createdAt).toLocaleDateString() })}</span>
            </>
          ) : null}
        </div>

        <div className="mt-2 flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-[1.4rem] leading-tight font-semibold tracking-tight text-ink">
                {project.name}
              </h2>
              <StatusChip status={project.status} onChange={archived ? undefined : onSetStatus} />
            </div>
            <p className="mt-1 max-w-[46rem] text-xs-plus leading-relaxed text-ink-secondary">
              {project.description || t('projects.noDescription')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {archived ? null : (
              <button
                type="button"
                data-testid="project-dispatch"
                onClick={onDispatch}
                disabled={project.status !== 'active'}
                title={project.status === 'active' ? undefined : t('projects.dispatchInactive')}
                className={cn(buttonClass.primary, 'h-8 px-2.5 text-xs disabled:opacity-50')}
              >
                <Zap className="size-3.5" />
                {t('projects.dispatch')}
              </button>
            )}
            {archived ? null : (
              <button
                type="button"
                data-testid="project-settings"
                aria-label={t('projects.settingsTitle')}
                title={t('projects.settingsTitle')}
                onClick={onOpenSettings}
                className={cn(buttonClass.secondary, 'h-8 px-2 text-xs')}
              >
                <Settings2 className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Vitals: one strip, because four cards spent 100px on four numbers. */}
      <div className="grid shrink-0 grid-cols-2 border-y border-line bg-line/70 lg:grid-cols-4 lg:divide-x lg:divide-line">
        <Vital
          label={t('projects.metrics.progress')}
          value={`${percent}%`}
          hint={t('projects.metrics.progressHint', { done: stats.done, total: stats.total })}
        >
          <StackedBar
            ariaLabel={t('projects.metrics.progress')}
            segments={[
              { key: 'done', label: t('projects.metrics.done'), value: stats.done, color: 'var(--success)' },
              { key: 'active', label: t('projects.metrics.active'), value: stats.active, color: 'var(--accent)' },
              { key: 'blocked', label: t('projects.metrics.blocked'), value: stats.blocked, color: 'var(--danger)' },
              { key: 'todo', label: t('projects.metrics.todo'), value: stats.todo, color: 'var(--text-quaternary)' },
            ]}
            height={4}
          />
        </Vital>
        <Vital
          label={t('projects.metrics.active')}
          value={String(stats.active)}
          hint={t('projects.metrics.activeHint')}
        />
        <Vital
          label={t('projects.metrics.team')}
          value={String(project.members.length)}
          hint={t('projects.metrics.teamHint')}
        />
        <Vital
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
          {budget ? (
            <span className="block h-1 overflow-hidden rounded-full bg-line/60">
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${Math.min(100, Math.round(budgetRatio * 100))}%`,
                  background: `var(--${toneForRatio(budgetRatio)})`,
                }}
              />
            </span>
          ) : null}
        </Vital>
      </div>

      {/* Board: the page's body. A list of eight rows hid the shape of the work. */}
      <section className="shrink-0 px-7 py-5">
        <div className="mb-3 flex items-center gap-2">
          <h3 className="text-2xs font-semibold tracking-[0.12em] text-ink-tertiary">
            {t('projects.boardTitle')}
          </h3>
          <span className="truncate font-mono text-3xs text-ink-quaternary">
            {t('projects.boardHint', { count: stats.total })}
            {cancelled > 0 ? ` · ${t('projects.boardCancelled', { count: cancelled })}` : ''}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => navigate('/issues')}
            className="flex items-center gap-1 text-3xs text-ink-quaternary transition-colors hover:text-accent"
          >
            {t('projects.viewAllWork')}
            <ArrowRight className="size-3" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {BOARD_COLUMNS.map((column) => (
            <div key={column} data-testid={`project-column-${column}`} className="min-w-0">
              <div className="mb-1.5 flex items-baseline gap-1.5 px-0.5">
                <span className="text-3xs font-medium text-ink-secondary">
                  {t(`issues.group.${column}`)}
                </span>
                <span className="font-mono text-3xs text-ink-quaternary">
                  {board[column].length}
                </span>
              </div>
              <ul className="space-y-1.5">
                {board[column].length === 0 ? (
                  <li className="rounded-lg border border-dashed border-line px-2.5 py-3 text-center text-3xs text-ink-quaternary">
                    {t('projects.boardEmpty')}
                  </li>
                ) : (
                  board[column].map((task) => (
                    <li key={task.id}>
                      <button
                        type="button"
                        data-testid="project-task"
                        onClick={() => navigate('/issues')}
                        title={task.title}
                        className={cn(
                          'w-full rounded-lg border bg-surface px-2.5 py-2 text-left transition-colors hover:border-line-strong',
                          needsAttention(task.status) ? 'border-danger/40' : 'border-line',
                        )}
                      >
                        <span className="line-clamp-2 text-2xs leading-snug text-ink">
                          {task.title}
                        </span>
                        <span className="mt-1.5 flex items-center gap-1.5">
                          {task.issueKey ? (
                            <code className="shrink-0 font-mono text-3xs text-ink-quaternary">
                              {task.issueKey}
                            </code>
                          ) : null}
                          {task.priority === 'P0' || task.priority === 'P1' ? (
                            <span className="shrink-0 rounded bg-danger/10 px-1 font-mono text-3xs text-danger">
                              {task.priority}
                            </span>
                          ) : null}
                          {needsAttention(task.status) ? (
                            <span className="inline-flex shrink-0 items-center gap-0.5 text-3xs text-danger">
                              <AlertTriangle className="size-2.5" />
                              {t(`issues.group.blocked`)}
                            </span>
                          ) : null}
                          {isOverdue(task) ? (
                            <span className="shrink-0 text-3xs text-danger">{t('issues.overdue')}</span>
                          ) : null}
                          <span className="flex-1" />
                          <span className="max-w-[5.5rem] truncate text-3xs text-ink-tertiary">
                            {task.assigneeName}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* People and output share the bottom, because both answer "what came out of this". */}
      <div className="grid shrink-0 border-t border-line xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] xl:divide-x xl:divide-line">
        <section className="min-w-0 px-7 py-5">
          <PanelHead title={t('projects.teamTitle')} hint={t('projects.peopleShort', { count: project.members.length })} />
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
                  <li
                    key={member.employeeId}
                    data-testid="project-member"
                    className="flex items-center gap-2"
                  >
                    <Avatar name={member.name} src={employee?.avatar || undefined} size="xs" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <span className="truncate text-xs text-ink">{member.name}</span>
                        {member.status === 'paused' ? (
                          <span className="shrink-0 text-3xs text-warning">{t('projects.paused')}</span>
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
                  </li>
                );
              })}
            </ul>
          )}
          <button
            type="button"
            onClick={onOpenSettings}
            className="mt-3 flex items-center gap-1 text-2xs text-ink-tertiary transition-colors hover:text-accent"
          >
            {t('projects.manageTeam')}
            <ArrowRight className="size-3" />
          </button>
        </section>

        <section className="min-w-0 px-7 py-5">
          <PanelHead title={t('projects.artifactsTitle')} hint={t('projects.artifactsHint', { count: artifactTotals.count })} />
          {artifacts.length === 0 ? (
            <p className="text-3xs leading-relaxed text-ink-quaternary">{t('projects.artifactsEmpty')}</p>
          ) : (
            <ul className="space-y-1.5">
              {artifacts.map(({ artifact, task }) => (
                <li key={artifact.id} className="flex items-baseline gap-2" title={artifact.relPath}>
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
          {artifactTotals.count > artifacts.length ? (
            <p className="mt-2 text-3xs text-ink-quaternary">
              {t('projects.artifactsMore', { count: artifactTotals.count - artifacts.length })}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function Vital({
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
    <div className="min-w-0 bg-panel px-5 py-3">
      <div className="text-3xs font-medium tracking-wide text-ink-quaternary">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span className="font-mono text-base leading-none font-semibold tracking-tight text-ink">
          {value}
        </span>
        {hint ? <span className="min-w-0 truncate text-3xs text-ink-quaternary">{hint}</span> : null}
      </div>
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}

function PanelHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <header className="mb-3 flex items-center gap-2">
      <span aria-hidden className="h-px w-3 shrink-0 bg-line-strong" />
      <h3 className="shrink-0 text-2xs font-semibold tracking-[0.12em] text-ink-tertiary">{title}</h3>
      {hint ? <span className="truncate font-mono text-3xs text-ink-quaternary">{hint}</span> : null}
    </header>
  );
}

const STATUS_DOT: Record<ProjectStatus, string> = {
  planning: 'var(--text-quaternary)',
  active: 'var(--success)',
  paused: 'var(--warning)',
  done: 'var(--accent)',
  archived: 'var(--text-quaternary)',
};

/**
 * The project's state, and the only place it changes.
 *
 * Without an `onChange` it is a plain chip — that is how archived projects render,
 * since archived is terminal and reached through the archive action, not a menu.
 */
function StatusChip({
  status,
  onChange,
}: {
  status: ProjectStatus;
  onChange?: (next: EditableProjectStatus) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const label = (
    <>
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: STATUS_DOT[status] }}
      />
      {t(`projects.status.${status}`)}
    </>
  );

  if (!onChange) {
    return (
      <span
        data-testid="project-status"
        className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-3xs text-ink-quaternary"
      >
        {label}
      </span>
    );
  }

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        data-testid="project-status"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 text-3xs text-ink-secondary transition-colors hover:border-line-strong hover:text-ink"
      >
        {label}
        <ChevronDown className={cn('size-3 text-ink-quaternary transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute top-full left-0 z-20 mt-1 w-32 rounded-lg border border-line bg-panel p-0.5 shadow-popover"
        >
          {PROJECT_STATUSES.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={option === status}
              data-testid={`project-status-${option}`}
              onClick={() => {
                setOpen(false);
                if (option !== status) onChange(option);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-2xs text-ink-secondary transition-colors hover:bg-ink/5 hover:text-ink"
            >
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: STATUS_DOT[option] }}
              />
              <span className="flex-1">{t(`projects.status.${option}`)}</span>
              {option === status ? <Check className="size-3 text-accent" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
