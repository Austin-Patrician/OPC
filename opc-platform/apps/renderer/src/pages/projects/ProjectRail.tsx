import { useState } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProjectStatus } from '@opc/shared/domain';
import type { ProjectView } from '@opc/shared/ipc';
import { cn } from '@/shared/lib/cn';

export interface RailProject {
  project: ProjectView;
  accent: string;
  done: number;
  total: number;
}

/**
 * The index beside a project's file.
 *
 * One row is three things: a name, one line of counts, and a bar. Everything else
 * (code, department, creation date) belongs to the file, not to the index —
 * repeating it here was what made twelve projects read like a spreadsheet.
 *
 * Archived projects are kept behind a fold instead of vanishing: archiving used to
 * remove a project from the only list that could reach it.
 */
export function ProjectRail({
  projects,
  archived,
  selectedId,
  creating,
  onSelect,
  onCreate,
}: {
  projects: readonly RailProject[];
  archived: readonly RailProject[];
  selectedId: string | null;
  creating: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  const [showArchived, setShowArchived] = useState(false);

  return (
    <aside className="flex w-[15rem] shrink-0 flex-col border-r border-line bg-surface-muted/40">
      <header className="flex items-center gap-2 px-4 pt-5 pb-2.5">
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
          onClick={onCreate}
          className="grid size-6 place-items-center rounded-md border border-line bg-surface text-ink-tertiary transition-colors hover:text-ink"
        >
          <Plus className="size-3.5" />
        </button>
      </header>

      <div className="page-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {projects.length === 0 ? (
          <p className="px-2 py-6 text-3xs leading-relaxed text-ink-quaternary">
            {t('projects.empty')}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {projects.map((entry) => (
              <RailRow
                key={entry.project.id}
                entry={entry}
                selected={!creating && entry.project.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}

        {archived.length > 0 ? (
          <div className="mt-3 border-t border-line pt-2">
            <button
              type="button"
              data-testid="project-archived-toggle"
              onClick={() => setShowArchived((value) => !value)}
              className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-3xs text-ink-quaternary transition-colors hover:text-ink-secondary"
            >
              <ChevronRight
                className={cn('size-3 transition-transform', showArchived && 'rotate-90')}
              />
              {t('projects.archivedCount', { count: archived.length })}
            </button>
            {showArchived ? (
              <ul className="mt-1 space-y-0.5">
                {archived.map((entry) => (
                  <RailRow
                    key={entry.project.id}
                    entry={entry}
                    selected={!creating && entry.project.id === selectedId}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

/** The row is shared by the live list and the archived fold; only the tone differs. */
function RailRow({
  entry,
  selected,
  onSelect,
}: {
  entry: RailProject;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { project, accent, done, total } = entry;
  const ratio = total > 0 ? done / total : 0;
  const archived = project.status === 'archived';

  return (
    <li>
      <button
        type="button"
        data-testid="project-row"
        onClick={() => onSelect(project.id)}
        title={project.code ? `${project.name} · ${project.code}` : project.name}
        className={cn(
          'w-full rounded-lg px-2.5 py-2 text-left transition-colors',
          selected ? 'bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.06)]' : 'hover:bg-surface/70',
        )}
      >
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={cn('size-1.5 shrink-0 rounded-full', archived && 'opacity-40')}
            style={{ background: accent }}
          />
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-xs',
              selected ? 'font-medium text-ink' : archived ? 'text-ink-quaternary' : 'text-ink-secondary',
            )}
          >
            {project.name}
          </span>
        </span>

        <span className="mt-1 flex items-center gap-1.5 pl-3">
          <StatusPrefix status={project.status} />
          <span className="font-mono text-3xs text-ink-quaternary">
            {done}/{total}
          </span>
          <span className="flex-1" />
          <span className="text-3xs text-ink-quaternary">
            {t('projects.peopleShort', { count: project.members.length })}
          </span>
        </span>

        {archived ? null : (
          <span className="mt-1.5 ml-3 block h-[3px] overflow-hidden rounded-full bg-line/60">
            <span
              className="block h-full rounded-full transition-[width]"
              style={{
                width: `${ratio * 100}%`,
                background: ratio >= 1 ? 'var(--success)' : barToneOf(project.status, accent),
              }}
            />
          </span>
        )}
      </button>
    </li>
  );
}

/** Only non-active states get a word; "进行中" is the default and needs no label. */
function StatusPrefix({ status }: { status: ProjectStatus }) {
  const { t } = useTranslation();
  if (status === 'active') return null;
  return (
    <span className="shrink-0 text-3xs text-ink-quaternary">
      {t(`projects.status.${status}`)}
      <span aria-hidden> · </span>
    </span>
  );
}

function barToneOf(status: ProjectStatus, accent: string): string {
  if (status === 'paused') return 'var(--warning)';
  if (status === 'done') return 'var(--success)';
  if (status === 'planning') return 'var(--text-quaternary)';
  return accent;
}
