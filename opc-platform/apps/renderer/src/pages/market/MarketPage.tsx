import { useEffect, useState } from 'react';
import { Award, Cpu, FileCode2, Network, PackagePlus, UserPlus, X, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentCandidate, DepartmentNode, OrgMember } from '@opc/shared/domain';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { cn } from '@/shared/lib/cn';
import { Section } from '@/features/settings/ui/kit';
import { HireWizard } from '@/pages/org/HireWizard';

/**
 * Talent market, laid out like the design: a gradient hero with the custom-hire
 * entry, then a card grid of imported candidates (portrait, level, role, model,
 * skills, their charter text, department picker, one-click hire that opens the
 * DM). The internal talent pool sits underneath — it is real data, not a decoy.
 */
export function MarketPage() {
  const { t } = useTranslation();
  const [departments, setDepartments] = useState<DepartmentNode[]>([]);
  const [pool, setPool] = useState<OrgMember[]>([]);
  const [candidates, setCandidates] = useState<AgentCandidate[]>([]);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [hiredNames, setHiredNames] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (candidateId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });

  const load = async () => {
    const [tree, unplaced, imported] = await Promise.all([
      window.opc!.org.list(),
      window.opc!.org.unplaced(),
      window.opc!.market.candidates(),
    ]);
    setDepartments(tree);
    setPool(unplaced);
    setCandidates(imported);
    setHiredNames(new Set(tree.flatMap((node) => node.members).map((member) => member.name)));
  };

  useEffect(() => {
    void load();
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const importPackage = () =>
    run(async () => {
      setCandidates(await window.opc!.market.importPackage());
      setQuery('');
    });

  const hireCandidate = (candidateId: string) =>
    run(async () => {
      const departmentId = targets[candidateId] || departments[0]?.id;
      if (!departmentId) throw new Error(t('market.needDepartment'));
      const { candidates: left, employeeId } = await window.opc!.market.hireCandidate(candidateId, {
        departmentId,
      });
      setCandidates(left);
      await load();
      // Design promises "聘用入职并开启 IM 对话": open the DM for real.
      const conversationId = await window.opc!.chat.openDirect(employeeId);
      window.location.hash = `#/chat/${conversationId}`;
    });

  const place = (employeeId: string, departmentId: string) =>
    run(async () => {
      if (!departmentId) return;
      await window.opc!.org.place(employeeId, departmentId);
      await load();
    });

  const needle = query.trim().toLowerCase();
  const matches = (candidate: AgentCandidate) =>
    !needle ||
    candidate.name.toLowerCase().includes(needle) ||
    candidate.role.toLowerCase().includes(needle) ||
    candidate.skills.some((skill) => skill.toLowerCase().includes(needle));
  const visibleCandidates = candidates.filter(matches);
  const visiblePool = pool.filter(
    (member) =>
      !needle ||
      member.name.toLowerCase().includes(needle) ||
      member.role.toLowerCase().includes(needle) ||
      member.skills.some((skill) => skill.toLowerCase().includes(needle)),
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-panel">
      <header className="flex h-[3.375rem] shrink-0 items-center gap-3 border-b border-line bg-surface px-6">
        <div className="flex items-center gap-0.5 rounded-lg bg-surface-muted p-0.5">
          <button
            type="button"
            onClick={() => {
              window.location.hash = '#/org';
            }}
            className="flex items-center gap-1.5 rounded-md px-3 py-1 text-base-plus font-medium text-ink-tertiary transition-colors hover:text-ink"
          >
            <Network className="size-3.5 text-accent" />
            <span>{t('org.tabOrg')}</span>
          </button>
          <button
            type="button"
            aria-pressed
            data-testid="tab-market"
            className="flex items-center gap-1.5 rounded-md bg-surface px-3 py-1 text-base-plus font-medium text-ink shadow-xs"
          >
            <UserPlus className="size-3.5 text-danger" />
            <span>
              {t('org.tabMarket')} ({candidates.length} {t('market.waiting')})
            </span>
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('market.search')}
            aria-label={t('common.search')}
            className="h-7 w-52 rounded-lg bg-surface-muted px-2.5 text-xs text-ink outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            data-testid="import-package"
            disabled={busy}
            onClick={() => void importPackage()}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-base-plus font-medium text-ink transition-colors hover:bg-surface-hover disabled:opacity-50"
          >
            <PackagePlus className="size-3.5 text-accent" />
            {t('market.importPackage')}
          </button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[68rem] space-y-4 px-6 py-5">
        {/* Hero: gradient banner + the custom-hire entry, like the design */}
        <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-accent/20 bg-[linear-gradient(90deg,color-mix(in_srgb,var(--accent)_10%,transparent),color-mix(in_srgb,var(--accent)_2%,transparent))] p-5 sm:flex-row sm:items-center">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Zap className="size-4 text-accent" />
              <h2 className="text-base-plus font-bold text-ink">{t('market.heroTitle')}</h2>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-ink-secondary">{t('market.heroDesc')}</p>
          </div>
          <button
            type="button"
            onClick={() => setWizardOpen(true)}
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-xs font-medium text-white hover:opacity-90"
          >
            <Zap className="size-3.5 text-warning" />
            {t('market.customAgent')}
          </button>
        </div>

        {error ? (
          <p className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">{error}</p>
        ) : null}

        {/* Candidate grid — 1/2/3 columns like the design */}
        {visibleCandidates.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {visibleCandidates.map((candidate) => {
              const alreadyHired = hiredNames.has(candidate.name);
              const isExpanded = expanded.has(candidate.id);
              const target = targets[candidate.id] ?? departments[0]?.id ?? '';
              return (
                <article
                  key={candidate.id}
                  data-testid="candidate-row"
                  className="flex flex-col justify-between gap-3.5 rounded-2xl border border-line bg-surface p-4 shadow-card"
                >
                  <div className="space-y-3">
                    <div className="flex items-start gap-3">
                      <Avatar name={candidate.name} size="lg" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <h3 className="truncate text-base font-bold text-ink">{candidate.name}</h3>
                          <span className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-3xs font-semibold text-accent-ink">
                            {candidate.level}
                          </span>
                        </div>
                        <div className="mt-0.5 truncate text-xs text-ink-tertiary">{candidate.role}</div>
                      </div>
                      <button
                        type="button"
                        aria-label={t('market.remove')}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            setCandidates(await window.opc!.market.removeCandidate(candidate.id));
                          })
                        }
                        className="ml-auto shrink-0 rounded p-1 text-ink-quaternary hover:text-danger"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>

                    <div className="flex items-center justify-between rounded-lg bg-surface-muted px-3 py-1.5 text-2xs">
                      <span className="flex items-center gap-1 truncate text-accent-ink">
                        <Cpu className="size-3.5" />
                        {candidate.model || t('wizard.inheritModel')}
                      </span>
                      <span className="flex items-center gap-1 font-mono text-ink-tertiary">
                        <Award className="size-3.5" />
                        {candidate.source}
                      </span>
                    </div>

                    {candidate.persona ? (
                      <p
                        className={cn(
                          'text-xs leading-relaxed text-ink-secondary',
                          isExpanded ? '' : 'line-clamp-3',
                        )}
                      >
                        {candidate.persona}
                      </p>
                    ) : null}

                    <div className="flex flex-wrap gap-1">
                      {candidate.skills.map((skill) => (
                        <span key={skill} className="rounded-md bg-surface-muted px-2 py-0.5 text-3xs text-ink-secondary">
                          {skill}
                        </span>
                      ))}
                    </div>

                    <div className="rounded-lg border border-line bg-panel p-2.5">
                      <div className="mb-1 flex items-center gap-1 font-mono text-3xs text-ink-tertiary">
                        <FileCode2 className="size-3 text-accent" />
                        <span className="flex-1">{t('market.charter')}</span>
                        <button
                          type="button"
                          data-testid="candidate-expand"
                          aria-expanded={isExpanded}
                          onClick={() => toggleExpanded(candidate.id)}
                          className="shrink-0 rounded px-1 text-3xs text-accent hover:bg-accent-soft"
                        >
                          {isExpanded ? t('market.collapse') : t('market.expand')}
                        </button>
                      </div>
                      <pre
                        className={cn(
                          'font-mono text-3xs leading-relaxed whitespace-pre-wrap text-ink-secondary',
                          isExpanded ? 'max-h-64 overflow-y-auto' : 'line-clamp-3',
                        )}
                      >
                        {candidate.persona || '—'}
                      </pre>

                      {isExpanded ? (
                        <dl className="mt-2 space-y-1 border-t border-line pt-2 text-3xs">
                          {[
                            [t('market.source'), candidate.source],
                            [t('org.model'), candidate.model || t('wizard.inheritModel')],
                            [t('wizard.skills'), candidate.skills.join(' · ') || '—'],
                            [t('market.importedAt'), new Date(candidate.createdAt).toLocaleString()],
                          ].map(([key, value]) => (
                            <div key={key} className="flex gap-2">
                              <dt className="w-16 shrink-0 text-ink-quaternary">{key}</dt>
                              <dd className="min-w-0 flex-1 break-words text-ink-secondary">{value}</dd>
                            </div>
                          ))}
                        </dl>
                      ) : null}
                    </div>
                  </div>

                  <div className="space-y-2 border-t border-line pt-3">
                    <label className="flex items-center justify-between text-2xs text-ink-tertiary">
                      {t('market.hireIntoLabel')}
                      <select
                        value={target}
                        aria-label={t('market.hireIntoLabel')}
                        onChange={(event) =>
                          setTargets((current) => ({ ...current, [candidate.id]: event.target.value }))
                        }
                        className="rounded-md bg-surface-muted px-2 py-1 text-2xs font-medium text-ink outline-none"
                      >
                        {departments.map((department) => (
                          <option key={department.id} value={department.id}>
                            {department.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    {alreadyHired ? (
                      <button
                        type="button"
                        disabled
                        className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-surface-muted py-2 text-xs font-medium text-ink-quaternary"
                      >
                        {t('market.alreadyHired')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid="hire-candidate"
                        disabled={busy}
                        onClick={() => void hireCandidate(candidate.id)}
                        className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent py-2 text-xs font-medium text-white shadow-xs hover:bg-accent-hover disabled:opacity-50"
                      >
                        <UserPlus className="size-3.5" />
                        {t('market.hireAndChat')}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void importPackage()}
            className="flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed border-line bg-surface py-10 text-center transition-colors hover:border-accent/50"
          >
            <PackagePlus className="size-5 text-ink-quaternary" />
            <span className="text-sm font-medium text-ink-secondary">{t('market.emptyTitle')}</span>
            <span className="max-w-[26rem] text-xs leading-relaxed text-ink-quaternary">
              {t('market.emptyHint')}
            </span>
          </button>
        )}

        {/* Internal talent pool: people without a position */}
        <Section
          title={`${t('market.pool')} · ${visiblePool.length}`}
          description={t('market.poolDesc')}
        >
          {visiblePool.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-ink-quaternary">{t('market.poolEmpty')}</p>
          ) : (
            <ul>
              {visiblePool.map((member) => (
                <li
                  key={member.id}
                  data-testid="market-row"
                  className="flex items-center gap-3 border-t border-line px-4 py-2.5 first:border-t-0"
                >
                  <Avatar
                    name={member.name}
                    src={member.avatar || undefined}
                    size="sm"
                    status={member.status === 'active' ? 'online' : 'idle'}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm-plus font-medium text-ink">{member.name}</span>
                      <span className="rounded bg-surface-muted px-1 font-mono text-3xs text-ink-tertiary">
                        {member.level}
                      </span>
                      <span
                        className={cn(
                          'rounded px-1 text-3xs',
                          member.status === 'active' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger',
                        )}
                      >
                        {member.status === 'active' ? t('org.active') : t('org.terminated')}
                      </span>
                    </div>
                    <div className="truncate text-2xs text-ink-quaternary">{member.role}</div>
                  </div>
                  <select
                    aria-label={t('market.placeInto')}
                    value=""
                    disabled={busy}
                    onChange={(event) => void place(member.id, event.target.value)}
                    className="h-7 w-[9rem] shrink-0 rounded-md border border-line bg-surface px-1.5 text-xs text-ink outline-none focus:border-accent disabled:opacity-50"
                  >
                    <option value="">{t('market.placeInto')}</option>
                    {departments.map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.name}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <p className="px-1 text-2xs leading-relaxed text-ink-quaternary">{t('market.footnote')}</p>
      </div>

      {wizardOpen ? (
        <HireWizard
          departments={departments}
          defaultDepartmentId={departments[0]?.id ?? ''}
          onClose={() => setWizardOpen(false)}
          onSubmit={async (input) => {
            await window.opc!.org.hire(input);
            setWizardOpen(false);
            window.location.hash = '#/org';
          }}
        />
      ) : null}
    </div>
  );
}
