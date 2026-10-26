import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronRight, CircleDashed, Loader2, ShieldAlert, Stamp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TaskStatus, WorkTask } from '@opc/shared/domain';
import { cn } from '@/shared/lib/cn';

/**
 * Issue ledger — every work item in the company, read as a ledger rather than a
 * card wall: a monospaced key column, hairline rows, and one coloured rail that
 * carries the state. Deliberately quiet so a hundred rows stay scannable; the
 * accent is spent only on the state that needs the boss (待你终审 / 卡住).
 */

type Group = 'todo' | 'doing' | 'review' | 'done' | 'blocked';

const GROUP_OF: Record<TaskStatus, Group> = {
  open: 'todo',
  running: 'doing',
  review: 'review',
  accepted: 'done',
  delivered: 'done',
  rejected: 'blocked',
  failed: 'blocked',
  cancelled: 'todo',
};

const GROUP_ORDER: Group[] = ['blocked', 'review', 'doing', 'todo', 'done'];

const RAIL: Record<Group, string> = {
  blocked: 'var(--danger)',
  review: 'var(--warning)',
  doing: 'var(--accent)',
  todo: 'var(--text-quaternary)',
  done: 'var(--success)',
};

function groupIcon(group: Group) {
  if (group === 'blocked') return ShieldAlert;
  if (group === 'review') return Stamp;
  if (group === 'doing') return Loader2;
  if (group === 'done') return CheckCircle2;
  return CircleDashed;
}

const elapsed = (task: WorkTask): string => {
  const from = task.startedAt ?? task.createdAt;
  const to = task.finishedAt ?? Date.now();
  const minutes = Math.max(0, Math.round((to - from) / 60_000));
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
};

export function IssueListPage() {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<WorkTask[]>([]);
  const [status, setStatus] = useState<'all' | Group>('all');
  const [assignee, setAssignee] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.opc!.work.listTasks().then((rows) => {
      if (alive) setTasks(rows);
    });
    return () => {
      alive = false;
    };
  }, []);

  const assignees = useMemo(
    () => Array.from(new Set(tasks.map((task) => task.assigneeName))).sort(),
    [tasks],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tasks.filter((task) => {
      if (status !== 'all' && GROUP_OF[task.status] !== status) return false;
      if (assignee && task.assigneeName !== assignee) return false;
      if (!needle) return true;
      return (
        task.title.toLowerCase().includes(needle) ||
        (task.issueKey ?? '').toLowerCase().includes(needle) ||
        task.brief.toLowerCase().includes(needle)
      );
    });
  }, [tasks, status, assignee, query]);

  const counts = useMemo(() => {
    const base: Record<Group, number> = { todo: 0, doing: 0, review: 0, done: 0, blocked: 0 };
    for (const task of tasks) base[GROUP_OF[task.status]] += 1;
    return base;
  }, [tasks]);

  const selected = filtered.find((task) => task.id === selectedId) ?? tasks.find((task) => task.id === selectedId);
  const waiting = counts.review;
  const stuck = counts.blocked;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 bg-panel">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Ledger header: one line of counts, no cards, no chrome */}
        <header className="shrink-0 border-b border-line px-8 pt-5 pb-3">
          <div className="flex items-baseline gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-ink">{t('issues.title')}</h1>
            <span className="font-mono text-2xs text-ink-quaternary">{tasks.length}</span>
            <span className="flex-1" />
            <span className="text-xs text-ink-tertiary">
              {t('issues.summary', { doing: counts.doing, review: waiting, stuck })}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-0.5 rounded-md bg-surface-muted p-0.5">
              {(['all', ...GROUP_ORDER] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  data-testid={`issue-filter-${key}`}
                  aria-pressed={status === key}
                  onClick={() => setStatus(key)}
                  className={cn(
                    'h-6 rounded px-2 text-2xs transition-colors',
                    status === key ? 'bg-surface font-medium text-ink shadow-xs' : 'text-ink-tertiary hover:text-ink',
                  )}
                >
                  {key === 'all' ? t('issues.all') : t(`issues.group.${key}`)}
                  <span className="ml-1 font-mono text-3xs text-ink-quaternary">
                    {key === 'all' ? tasks.length : counts[key]}
                  </span>
                </button>
              ))}
            </div>

            <select
              aria-label={t('issues.assignee')}
              value={assignee}
              onChange={(event) => setAssignee(event.target.value)}
              className="h-6 rounded-md border border-line bg-surface px-1.5 text-2xs text-ink-secondary outline-none"
            >
              <option value="">{t('issues.allAssignees')}</option>
              {assignees.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>

            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('issues.search')}
              aria-label={t('issues.search')}
              className="h-6 w-52 rounded-md bg-surface-muted px-2 text-2xs text-ink outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        </header>

        {/* Rows, grouped by state — the rail does the colouring */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-8 py-16 text-center text-sm text-ink-quaternary">{t('issues.empty')}</p>
          ) : (
            GROUP_ORDER.filter((group) => filtered.some((task) => GROUP_OF[task.status] === group)).map((group) => {
              const Icon = groupIcon(group);
              const rows = filtered.filter((task) => GROUP_OF[task.status] === group);
              return (
                <section key={group} data-testid={`issue-group-${group}`}>
                  <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-panel/95 px-8 py-1.5 backdrop-blur">
                    <Icon className="size-3" style={{ color: RAIL[group] }} />
                    <span className="text-3xs font-semibold tracking-[0.14em] text-ink-tertiary uppercase">
                      {t(`issues.group.${group}`)}
                    </span>
                    <span className="font-mono text-3xs text-ink-quaternary">{rows.length}</span>
                  </div>

                  {rows.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      data-testid="issue-row"
                      onClick={() => setSelectedId(task.id)}
                      className={cn(
                        'group flex w-full items-center gap-4 border-b border-line/60 py-2 pr-8 pl-0 text-left transition-colors',
                        task.id === selectedId ? 'bg-accent-soft/50' : 'hover:bg-surface-hover',
                      )}
                    >
                      <span aria-hidden className="h-8 w-[3px] shrink-0" style={{ background: RAIL[group] }} />
                      <span className="w-20 shrink-0 font-mono text-2xs text-ink-tertiary">
                        {task.issueKey ?? '—'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-sm text-ink">{task.title}</span>
                          {task.isReview ? (
                            <span className="shrink-0 rounded bg-surface-muted px-1 text-3xs text-ink-quaternary">
                              {t('issues.reviewTask')}
                            </span>
                          ) : null}
                          {task.childCount > 0 ? (
                            <span className="shrink-0 font-mono text-3xs text-ink-quaternary">
                              ↳{task.childCount}
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block truncate text-2xs text-ink-quaternary">
                          {task.deliverableSpec}
                        </span>
                      </span>
                      <span className="w-24 shrink-0 truncate text-2xs text-ink-secondary">{task.assigneeName}</span>
                      <span className="w-14 shrink-0 text-right font-mono text-2xs text-ink-quaternary">
                        {elapsed(task)}
                      </span>
                      <span className="w-16 shrink-0 text-right font-mono text-2xs text-success">
                        ${task.costUsd.toFixed(2)}
                      </span>
                      <span className="w-16 shrink-0 text-right font-mono text-2xs text-ink-quaternary">
                        {t(`task.status.${task.status}`)}
                      </span>
                      <ChevronRight className="size-3 shrink-0 text-ink-quaternary opacity-0 group-hover:opacity-100" />
                    </button>
                  ))}
                </section>
              );
            })
          )}
        </div>
      </div>

      {selected ? <IssueDetail task={selected} onClose={() => setSelectedId(null)} /> : null}
    </div>
  );
}

function IssueDetail({ task, onClose }: { task: WorkTask; onClose: () => void }) {
  const { t } = useTranslation();
  const evidence = task.acceptance?.evidence;

  return (
    <aside className="flex w-[21rem] shrink-0 flex-col border-l border-line bg-surface">
      <header className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="font-mono text-2xs text-ink-quaternary">{task.issueKey ?? '—'}</div>
          <h2 className="mt-0.5 text-sm font-semibold text-ink">{task.title}</h2>
          <div className="mt-1 flex items-center gap-2 text-2xs text-ink-tertiary">
            <span>{task.assigneeName}</span>
            <span className="font-mono">{t(`task.status.${task.status}`)}</span>
            <span className="font-mono">{t('issues.attempts', { count: task.attempts })}</span>
          </div>
        </div>
        <button
          type="button"
          aria-label={t('common.close')}
          data-testid="issue-detail-close"
          onClick={onClose}
          className="shrink-0 text-ink-quaternary hover:text-ink"
        >
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 text-xs">
        <section>
          <h3 className="mb-1 text-3xs font-semibold tracking-[0.14em] text-ink-tertiary uppercase">
            {t('issues.brief')}
          </h3>
          <p className="leading-relaxed whitespace-pre-wrap text-ink-secondary">{task.brief}</p>
        </section>

        <section>
          <h3 className="mb-1 text-3xs font-semibold tracking-[0.14em] text-ink-tertiary uppercase">
            {t('issues.deliverable')}
          </h3>
          <p className="leading-relaxed text-ink-secondary">{task.deliverableSpec}</p>
        </section>

        {task.artifacts.length > 0 ? (
          <section>
            <h3 className="mb-1 text-3xs font-semibold tracking-[0.14em] text-ink-tertiary uppercase">
              {t('issues.artifacts')}
            </h3>
            <ul className="space-y-0.5 font-mono text-2xs text-ink-secondary">
              {task.artifacts.map((artifact) => (
                <li key={artifact.id} className="truncate">
                  {artifact.relPath}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {evidence ? (
          <section>
            <h3 className="mb-1 text-3xs font-semibold tracking-[0.14em] text-ink-tertiary uppercase">
              {t('issues.evidence')}
            </h3>
            <pre className="max-h-40 overflow-auto rounded bg-surface-muted p-2 font-mono text-3xs leading-relaxed whitespace-pre-wrap text-ink-secondary select-text">
              {`$ ${evidence.command.join(' ')}\nexit ${evidence.exitCode ?? 'null'} · ${evidence.durationMs}ms\n${evidence.stdoutTail}${evidence.stderrTail ? `\n${evidence.stderrTail}` : ''}`}
            </pre>
          </section>
        ) : null}

        <section>
          <h3 className="mb-1 text-3xs font-semibold tracking-[0.14em] text-ink-tertiary uppercase">
            {t('issues.activity')}
          </h3>
          <ol className="space-y-1">
            {task.steps.slice(-12).map((step, index) => (
              <li key={`${step.at}-${index}`} className="flex gap-2 text-2xs">
                <span className="shrink-0 font-mono text-ink-quaternary">
                  {new Date(step.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="min-w-0 flex-1 text-ink-secondary">{step.text}</span>
              </li>
            ))}
          </ol>
        </section>

        {task.error ? (
          <p className="rounded bg-danger/10 px-2 py-1.5 text-2xs text-danger">{task.error}</p>
        ) : null}
      </div>
    </aside>
  );
}
