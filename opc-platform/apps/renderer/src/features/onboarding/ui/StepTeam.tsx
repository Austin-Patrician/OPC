import { useState } from 'react';
import { Check, Cpu, Network, PackagePlus, UsersRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentCandidate, DepartmentNode } from '@opc/shared/domain';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { cn } from '@/shared/lib/cn';
import { StepHeader } from './onboardingUi';

interface StepTeamProps {
  departments: DepartmentNode[];
  candidates: AgentCandidate[];
  agentCount: number;
  /** candidateId → target department for the current selection. */
  selection: Record<string, string>;
  onSelectionChange: (next: Record<string, string>) => void;
  /** candidateId → department, for candidates hired during this run. */
  hired: Record<string, string>;
  onCandidatesChange: (candidates: AgentCandidate[]) => void;
  /** Re-reads the org after the first department is created. */
  onDepartmentsChange: () => Promise<void>;
}

/**
 * Hiring from the real talent market.
 *
 * A fresh install has an organisation (seeded departments and staff) but an empty
 * candidate table, so the honest first screen is an empty state that imports an
 * agent package through the native file picker — the same `market.importPackage`
 * call the market page uses. Hires are committed by the guide's "下一步", through
 * `market.hireCandidate`, which is also what creates the employee row.
 */
export function StepTeam({
  departments,
  candidates,
  agentCount,
  selection,
  onSelectionChange,
  hired,
  onCandidatesChange,
  onDepartmentsChange,
}: StepTeamProps) {
  const { t } = useTranslation();
  const [importing, setImporting] = useState(false);
  const [creatingDept, setCreatingDept] = useState(false);
  const [deptDraft, setDeptDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const deptName = (id: string) => departments.find((department) => department.id === id)?.name ?? '—';
  const defaultDept = departments[0]?.id ?? '';

  const toggle = (candidate: AgentCandidate) => {
    if (hired[candidate.id]) return;
    // A hire needs a department; point at the banner instead of silently doing nothing.
    if (!defaultDept) {
      setError(t('onboarding.team.needDepartmentFirst'));
      return;
    }
    setError(null);
    const next = { ...selection };
    if (next[candidate.id]) delete next[candidate.id];
    else next[candidate.id] = defaultDept;
    onSelectionChange(next);
  };

  const importPackage = async () => {
    setImporting(true);
    setError(null);
    try {
      const imported = await window.opc!.market.importPackage();
      onCandidatesChange(imported);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setImporting(false);
    }
  };

  /** A fresh install has no departments, and `hireCandidate` requires one. */
  const createDepartment = async () => {
    const name = deptDraft.trim();
    if (!name) return;
    setCreatingDept(true);
    setError(null);
    try {
      await window.opc!.org.createDepartment({ name });
      setDeptDraft('');
      await onDepartmentsChange();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreatingDept(false);
    }
  };

  const pending = candidates.filter((candidate) => selection[candidate.id] && !hired[candidate.id]);

  return (
    <>
      <StepHeader
        eyebrow={t('onboarding.team.eyebrow')}
        title={t('onboarding.team.title')}
        description={
          agentCount === 0 && departments.length === 0
            ? t('onboarding.team.descriptionEmpty')
            : t('onboarding.team.description', { agents: agentCount, departments: departments.length })
        }
        aside={
          <div className="text-right">
            <div className="flex h-8 justify-end -space-x-2">
              {pending.slice(0, 4).map((candidate) => (
                <Avatar
                  key={candidate.id}
                  name={candidate.name}
                  size="sm"
                  className="onb-pop ring-2 ring-surface"
                />
              ))}
              {pending.length === 0 ? (
                <span className="size-8 rounded-full border border-dashed border-line-strong" />
              ) : null}
            </div>
            <div className="mt-1.5 text-sm text-ink-tertiary">
              {t('onboarding.team.selectedCount', { count: pending.length })}
            </div>
          </div>
        }
      />

      {departments.length === 0 ? (
        <div className="mb-4 rounded-xl border border-accent/30 bg-accent-soft/60 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface text-accent">
              <Network className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm-plus font-medium text-ink">{t('onboarding.team.firstDepartment')}</div>
              <div className="mt-0.5 text-xs text-ink-tertiary">{t('onboarding.team.firstDepartmentHint')}</div>
            </div>
            <input
              value={deptDraft}
              aria-label={t('onboarding.team.firstDepartment')}
              placeholder={t('onboarding.team.firstDepartmentPlaceholder')}
              onChange={(event) => setDeptDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void createDepartment();
              }}
              className="h-8 w-[9.5rem] rounded-lg border border-line bg-surface px-2.5 text-sm text-ink outline-none placeholder:text-ink-quaternary focus:border-accent"
            />
            <button
              type="button"
              disabled={creatingDept || !deptDraft.trim()}
              onClick={() => void createDepartment()}
              className="h-8 shrink-0 cursor-pointer rounded-lg bg-accent px-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {creatingDept ? t('onboarding.team.creating') : t('onboarding.team.create')}
            </button>
          </div>
        </div>
      ) : null}

      {candidates.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-strong bg-surface-muted/40 px-6 py-9 text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <PackagePlus className="size-6" />
          </span>
          <h3 className="mt-3 text-md-plus font-semibold text-ink">{t('onboarding.team.emptyTitle')}</h3>
          <p className="mx-auto mt-1.5 max-w-[26rem] text-sm leading-relaxed text-ink-tertiary">
            {t('onboarding.team.emptyDescription')}
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <button
              type="button"
              disabled={importing}
              onClick={() => void importPackage()}
              className="flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-accent px-4 text-sm-plus font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              <PackagePlus className="size-4" />
              {importing ? t('onboarding.team.importing') : t('onboarding.team.importPackage')}
            </button>
            <span className="flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-sm text-ink-secondary">
              <UsersRound className="size-3.5 text-ink-tertiary" />
              {t('onboarding.team.existingTeam', { departments: departments.length, agents: agentCount })}
            </span>
          </div>
          {error ? <p className="mt-3 text-xs text-danger">{error}</p> : null}
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-sm text-ink-tertiary">{t('onboarding.team.quickTeam')}</span>
            <button
              type="button"
              onClick={() =>
                onSelectionChange(
                  Object.fromEntries(candidates.filter((candidate) => !hired[candidate.id]).map((candidate) => [candidate.id, defaultDept])),
                )
              }
              className="h-7 cursor-pointer rounded-full bg-accent px-2.5 text-sm text-white transition-colors hover:bg-accent-hover"
            >
              {t('onboarding.team.selectAll')}
            </button>
            {pending.length > 0 ? (
              <button
                type="button"
                onClick={() =>
                  onSelectionChange(Object.fromEntries(Object.entries(selection).filter(([id]) => hired[id])))
                }
                className="h-7 cursor-pointer px-2 text-sm text-ink-tertiary hover:text-ink"
              >
                {t('onboarding.team.clear')}
              </button>
            ) : null}
            <button
              type="button"
              disabled={importing}
              onClick={() => void importPackage()}
              className="ml-auto flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-sm text-ink-secondary transition-colors hover:border-accent hover:text-accent disabled:opacity-60"
            >
              <PackagePlus className="size-3.5" />
              {importing ? t('onboarding.team.importing') : t('onboarding.team.importPackage')}
            </button>
          </div>

          {error ? <p className="mb-3 text-xs text-danger">{error}</p> : null}

          <div className="grid grid-cols-2 gap-3">
            {candidates.map((candidate) => {
              const hiredDept = hired[candidate.id];
              const selected = Boolean(selection[candidate.id] || hiredDept);
              return (
                <div
                  key={candidate.id}
                  role="button"
                  tabIndex={hiredDept ? -1 : 0}
                  aria-pressed={selected}
                  aria-disabled={Boolean(hiredDept)}
                  onClick={() => toggle(candidate)}
                  onKeyDown={(event) => {
                    if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
                      event.preventDefault();
                      event.stopPropagation();
                      toggle(candidate);
                    }
                  }}
                  className={cn(
                    'relative rounded-2xl border bg-surface p-4 transition-all duration-200 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none',
                    hiredDept
                      ? 'cursor-default border-success/40'
                      : selected
                        ? 'cursor-pointer border-accent shadow-[0_0_0_3px_var(--accent-soft),0_10px_28px_-14px_rgba(0,119,204,0.5)]'
                        : 'cursor-pointer border-line hover:-translate-y-px hover:border-line-strong hover:shadow-[0_8px_24px_-14px_rgba(0,0,0,0.3)]',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-3.5 right-3.5 flex size-5 items-center justify-center rounded-full transition-all',
                      hiredDept
                        ? 'bg-success'
                        : selected
                          ? 'bg-accent'
                          : 'border-[1.5px] border-line-strong',
                    )}
                  >
                    {selected ? <Check className="size-3 text-white" strokeWidth={3} /> : null}
                  </span>

                  <div className="flex gap-3 pr-7">
                    <Avatar name={candidate.name} size="lg" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-md font-bold text-ink">{candidate.name}</span>
                        <span className="flex h-[1.125rem] items-center rounded bg-surface-muted px-1.5 text-2xs font-semibold text-ink-tertiary">
                          {candidate.level}
                        </span>
                      </div>
                      <div className="truncate text-xs-plus text-accent-ink">{candidate.role}</div>
                      <div className="mt-0.5 flex items-center gap-1 truncate font-mono text-2xs text-ink-quaternary">
                        <Cpu className="size-3 shrink-0" />
                        {candidate.model || '—'}
                      </div>
                    </div>
                  </div>

                  <div className="mt-2.5 flex flex-wrap gap-1">
                    {candidate.skills.slice(0, 3).map((skill) => (
                      <span
                        key={skill}
                        className="flex h-5 items-center rounded bg-surface-muted px-1.5 text-2xs text-ink-secondary"
                      >
                        {skill}
                      </span>
                    ))}
                  </div>

                  <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
                    {hiredDept ? (
                      <span className="text-xs-plus font-medium text-success">
                        {t('onboarding.team.hiredIn', { department: deptName(hiredDept) })}
                      </span>
                    ) : (
                      <>
                        <span className="shrink-0 text-xs text-ink-tertiary">{t('onboarding.team.department')}</span>
                        <select
                          aria-label={t('onboarding.team.departmentFor', { name: candidate.name })}
                          value={selection[candidate.id] ?? defaultDept}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            onSelectionChange({ ...selection, [candidate.id]: event.target.value })
                          }
                          className="h-7 min-w-0 flex-1 cursor-pointer rounded-md border border-line bg-surface-muted px-2 text-xs-plus text-ink outline-none focus:border-accent"
                        >
                          {departments.map((department) => (
                            <option key={department.id} value={department.id}>
                              {department.name}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
