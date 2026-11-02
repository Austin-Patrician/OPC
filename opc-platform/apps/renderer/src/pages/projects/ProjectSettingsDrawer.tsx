import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Archive, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { OrgMember } from '@opc/shared/domain';
import type { OrgFactView, ProjectView } from '@opc/shared/ipc';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { buttonClass } from '@/features/settings/ui/kit';
import { cn } from '@/shared/lib/cn';

interface ProjectSettingsDrawerProps {
  project: ProjectView;
  /** Active company members, used for the level and the department fallback role. */
  orgById: Map<string, OrgMember>;
  /** Active members who are not on this project yet. */
  candidates: readonly OrgMember[];
  onAssign: (employeeId: string, role?: string) => Promise<void>;
  onRemoveMember: (employeeId: string) => Promise<void>;
  onSetReportsTo: (employeeId: string, managerId: string | null) => Promise<void>;
  onArchive: () => Promise<void>;
  onClose: () => void;
}

/**
 * Everything that changes the project, in one place, behind one button.
 *
 * Team editing used to be a page-wide mode: "编辑团队" swapped every control on the
 * dossier, so the reader could not tell whether a click would read or write. The
 * dossier is now always read-only, and the write surfaces — membership, the working
 * agreement, and archiving — live here.
 */
export function ProjectSettingsDrawer({
  project,
  orgById,
  candidates,
  onAssign,
  onRemoveMember,
  onSetReportsTo,
  onArchive,
  onClose,
}: ProjectSettingsDrawerProps) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label={t('common.close')}
        onClick={onClose}
        className="absolute inset-0 bg-black/25"
      />
      <aside
        role="dialog"
        aria-label={t('projects.settingsTitle')}
        className="relative flex h-full w-[24rem] max-w-[92vw] flex-col border-l border-line bg-panel shadow-popover"
      >
        <header className="flex h-chrome shrink-0 items-center gap-2 border-b border-line px-4">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
            {t('projects.settingsTitle')}
          </h2>
          <span className="truncate font-mono text-3xs text-ink-quaternary">{project.name}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="grid size-7 place-items-center rounded-md text-ink-tertiary hover:bg-ink/5 hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="page-scroll min-h-0 flex-1 overflow-y-auto">
          <TeamSection
            project={project}
            orgById={orgById}
            candidates={candidates}
            onAssign={onAssign}
            onRemoveMember={onRemoveMember}
            onSetReportsTo={onSetReportsTo}
          />
          <RulesSection projectId={project.id} />
          <DangerSection onArchive={onArchive} />
        </div>
      </aside>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-line px-4 py-4 last:border-0">
      <header className="mb-3 flex items-baseline gap-2">
        <h3 className="text-2xs font-semibold tracking-[0.1em] text-ink-tertiary">{title}</h3>
        {hint ? <span className="truncate text-3xs text-ink-quaternary">{hint}</span> : null}
      </header>
      {children}
    </section>
  );
}

function TeamSection({
  project,
  orgById,
  candidates,
  onAssign,
  onRemoveMember,
  onSetReportsTo,
}: Pick<
  ProjectSettingsDrawerProps,
  'project' | 'orgById' | 'candidates' | 'onAssign' | 'onRemoveMember' | 'onSetReportsTo'
>) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState('');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t('projects.teamTitle')} hint={t('projects.peopleShort', { count: project.members.length })}>
      {project.members.length === 0 ? (
        <p className="text-2xs leading-relaxed text-ink-quaternary">{t('projects.teamEmpty')}</p>
      ) : (
        <ul className="space-y-2.5">
          {project.members.map((member) => {
            const employee = orgById.get(member.employeeId);
            return (
              <li key={member.employeeId} data-testid="project-member" className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Avatar name={member.name} src={employee?.avatar || undefined} size="xs" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="truncate text-xs text-ink">{member.name}</span>
                      {member.status === 'paused' ? (
                        <span className="shrink-0 text-3xs text-warning">{t('projects.paused')}</span>
                      ) : null}
                    </div>
                    <div className="truncate text-3xs text-ink-quaternary">
                      {employee?.title || employee?.role || ''}
                      {employee ? ` · ${employee.level}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`${t('projects.remove')} ${member.name}`}
                    onClick={() => void run(() => onRemoveMember(member.employeeId))}
                    className="grid size-7 shrink-0 place-items-center rounded-md text-ink-quaternary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>

                <div className="flex items-center gap-1.5 pl-9">
                  <input
                    defaultValue={member.role}
                    aria-label={`${t('projects.role')} ${member.name}`}
                    placeholder={t('projects.rolePlaceholder')}
                    onBlur={(event) => {
                      const next = event.target.value.trim();
                      if (next !== member.role) void run(() => onAssign(member.employeeId, next));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur();
                    }}
                    className="h-6 min-w-0 flex-1 rounded-md border border-line bg-surface px-1.5 text-3xs text-ink outline-none placeholder:text-ink-quaternary focus:border-accent"
                  />
                  <select
                    data-testid="project-reports-to"
                    aria-label={t('projects.reportsTo')}
                    value={member.reportsToEmployeeId ?? ''}
                    onChange={(event) =>
                      void run(() => onSetReportsTo(member.employeeId, event.target.value || null))
                    }
                    className="h-6 w-[7.5rem] shrink-0 rounded-md border border-line bg-surface px-1 text-3xs text-ink outline-none focus:border-accent"
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
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {candidates.length === 0 ? (
        <p className="mt-3 text-3xs text-ink-quaternary">{t('projects.teamNoneLeft')}</p>
      ) : (
        <div className="mt-3 flex items-center gap-1.5">
          <select
            data-testid="project-add-member"
            aria-label={t('projects.addMember')}
            value={picked}
            onChange={(event) => setPicked(event.target.value)}
            className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-1.5 text-2xs text-ink outline-none focus:border-accent"
          >
            <option value="">{t('projects.pickMember')}</option>
            {candidates.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name} · {member.role}
              </option>
            ))}
          </select>
          <input
            value={role}
            onChange={(event) => setRole(event.target.value)}
            placeholder={t('projects.rolePlaceholder')}
            aria-label={t('projects.role')}
            className="h-7 w-[7.5rem] shrink-0 rounded-md border border-line bg-surface px-1.5 text-2xs text-ink outline-none placeholder:text-ink-quaternary focus:border-accent"
          />
          <button
            type="button"
            disabled={!picked || busy}
            onClick={() =>
              void run(async () => {
                await onAssign(picked, role.trim());
                setPicked('');
                setRole('');
              })
            }
            className={cn(buttonClass.primary, 'h-7 shrink-0 px-2 text-2xs')}
          >
            <Plus className="size-3" />
            {t('projects.addMember')}
          </button>
        </div>
      )}
    </Section>
  );
}

function RulesSection({ projectId }: { projectId: string }) {
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
    <Section title={t('projects.rulesTitle')} hint={t('projects.rulesHint')}>
      {facts.length > 0 ? (
        <ul data-testid="project-facts" className="space-y-1.5">
          {facts.map((fact) => (
            <li
              key={fact.id}
              data-testid="project-fact-row"
              className="border-b border-line/50 pb-1.5 last:border-0 last:pb-0"
            >
              <div className="font-mono text-3xs text-ink-quaternary">{fact.subject}</div>
              <div className="mt-0.5 text-2xs leading-relaxed text-ink-secondary">{fact.object}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-2xs leading-relaxed text-ink-quaternary">{t('projects.rulesEmpty')}</p>
      )}

      {adding ? (
        <div className="mt-3 space-y-1.5">
          <input
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder={t('projects.ruleSubject')}
            autoFocus
            className="h-7 w-full rounded-md border border-line bg-surface px-2 text-2xs text-ink outline-none focus:border-accent"
          />
          <textarea
            data-testid="project-fact-value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            rows={2}
            placeholder={t('projects.ruleValue')}
            className="w-full resize-none rounded-md border border-line bg-surface px-2 py-1.5 text-2xs text-ink outline-none focus:border-accent"
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
          className="mt-2.5 flex items-center gap-1 text-2xs text-ink-tertiary transition-colors hover:text-accent"
        >
          <Plus className="size-3" />
          {t('projects.addRule')}
        </button>
      )}
    </Section>
  );
}

function DangerSection({ onArchive }: { onArchive: () => Promise<void> }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <Section title={t('projects.dangerTitle')}>
      <p className="text-2xs leading-relaxed text-ink-quaternary">{t('projects.archiveHint')}</p>
      {confirming ? (
        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            type="button"
            data-testid="project-archive-confirm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onArchive().finally(() => setBusy(false));
            }}
            className={cn(buttonClass.danger, 'h-7 text-xs')}
          >
            {t('projects.archiveConfirm')}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="h-7 px-2 text-xs text-ink-secondary hover:text-ink"
          >
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          data-testid="project-archive"
          onClick={() => setConfirming(true)}
          className={cn(buttonClass.danger, 'mt-2.5 h-7 text-xs')}
        >
          <Archive className="size-3.5" />
          {t('projects.archive')}
        </button>
      )}
    </Section>
  );
}
