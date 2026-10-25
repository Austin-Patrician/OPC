import { useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DepartmentNode, HireInput, OrgMember } from '@opc/shared/domain';
import { cn } from '@/shared/lib/cn';
import { buttonClass } from '@/features/settings/ui/kit';

const LEVELS = ['P3', 'P4', 'P5', 'P6', 'P7', 'P8'];
const STEPS = ['identity', 'reporting', 'capability', 'confirm'] as const;

export interface HireDraft extends HireInput {
  skills: string[];
  persona: string;
}

/**
 * Four real steps — identity, reporting line, capability, confirmation — over a
 * single draft. Nothing is written until the last step, and every field here is
 * persisted (skills + persona land on the employee row and the persona is part
 * of the agent's prompt).
 */
export function HireWizard({
  departments,
  defaultDepartmentId,
  onClose,
  onSubmit,
}: {
  departments: DepartmentNode[];
  defaultDepartmentId: string;
  onClose: () => void;
  onSubmit: (input: HireDraft) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skillDraft, setSkillDraft] = useState('');
  const [draft, setDraft] = useState<HireDraft>({
    name: '',
    role: '',
    level: 'P5',
    model: '',
    departmentId: defaultDepartmentId || departments[0]?.id || '',
    title: '',
    reportsToEmployeeId: undefined,
    isHead: false,
    skills: [],
    persona: '',
  });

  const patch = (next: Partial<HireDraft>) => setDraft((current) => ({ ...current, ...next }));

  const members: OrgMember[] = departments.find((node) => node.id === draft.departmentId)?.members ?? [];
  const canAdvance =
    step === 0
      ? draft.name.trim().length > 0 && (draft.title ?? '').trim().length > 0 && draft.departmentId !== ''
      : true;

  const addSkill = () => {
    const value = skillDraft.trim();
    if (!value || draft.skills.includes(value)) return;
    patch({ skills: [...draft.skills, value] });
    setSkillDraft('');
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        ...draft,
        name: draft.name.trim(),
        title: (draft.title ?? '').trim(),
        role: draft.role.trim() || (draft.title ?? '').trim(),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  };

  const label = (text: string) => <span className="mb-1 block text-xs font-medium text-ink-secondary">{text}</span>;
  const input =
    'h-8 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-label={t('wizard.title')}
        data-testid="hire-wizard"
        className="flex max-h-[85vh] w-[34rem] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="text-base-plus font-semibold text-ink">{t('wizard.title')}</span>
          <button type="button" aria-label={t('common.close')} onClick={onClose} className="text-ink-tertiary hover:text-ink">
            <X className="size-4" />
          </button>
        </div>

        {/* Step rail */}
        <ol className="flex shrink-0 items-center gap-1 border-b border-line px-4 py-2.5">
          {STEPS.map((id, index) => {
            const done = index < step;
            const active = index === step;
            return (
              <li key={id} className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={index > step}
                  onClick={() => setStep(index)}
                  data-testid={`wizard-step-${id}`}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
                    active
                      ? 'bg-accent-soft font-medium text-accent-ink'
                      : done
                        ? 'text-ink-secondary hover:bg-surface-hover'
                        : 'text-ink-quaternary',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-4 items-center justify-center rounded-full text-3xs',
                      active ? 'bg-accent text-white' : done ? 'bg-success text-white' : 'bg-surface-muted text-ink-tertiary',
                    )}
                  >
                    {done ? <Check className="size-2.5" /> : index + 1}
                  </span>
                  {t(`wizard.step.${id}`)}
                </button>
                {index < STEPS.length - 1 ? <span className="text-3xs text-ink-quaternary">›</span> : null}
              </li>
            );
          })}
        </ol>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {step === 0 ? (
            <>
              <label className="block">
                {label(t('wizard.name'))}
                <input
                  autoFocus
                  data-testid="wizard-name"
                  value={draft.name}
                  onChange={(event) => patch({ name: event.target.value })}
                  className={input}
                />
              </label>
              <label className="block">
                {label(t('wizard.role'))}
                <input
                  data-testid="wizard-role"
                  value={draft.title ?? ''}
                  onChange={(event) => patch({ title: event.target.value, role: event.target.value })}
                  placeholder={t('wizard.roleHint')}
                  className={input}
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  {label(t('org.level'))}
                  <select
                    value={draft.level}
                    onChange={(event) => patch({ level: event.target.value })}
                    className={input}
                  >
                    {LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  {label(t('wizard.department'))}
                  <select
                    data-testid="wizard-department"
                    value={draft.departmentId}
                    onChange={(event) => patch({ departmentId: event.target.value, reportsToEmployeeId: undefined })}
                    className={input}
                  >
                    {departments.map((node) => (
                      <option key={node.id} value={node.id}>
                        {node.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <label className="block">
                {label(t('wizard.reportsTo'))}
                <select
                  value={draft.reportsToEmployeeId ?? ''}
                  onChange={(event) => patch({ reportsToEmployeeId: event.target.value || undefined })}
                  className={input}
                >
                  <option value="">{t('wizard.noManager')}</option>
                  {members
                    .filter((member) => member.status === 'active')
                    .map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name} · {member.title}
                      </option>
                    ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={draft.isHead ?? false}
                  onChange={(event) => patch({ isHead: event.target.checked })}
                />
                {t('org.asHead')}
              </label>
              <p className="text-2xs leading-relaxed text-ink-quaternary">{t('wizard.reportingHint')}</p>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <label className="block">
                {label(t('org.model'))}
                <input
                  value={draft.model ?? ''}
                  onChange={(event) => patch({ model: event.target.value })}
                  placeholder={t('org.modelHint')}
                  className={input}
                />
              </label>
              <div>
                {label(t('wizard.skills'))}
                <div className="flex gap-1.5">
                  <input
                    value={skillDraft}
                    onChange={(event) => setSkillDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addSkill();
                      }
                    }}
                    placeholder={t('wizard.skillHint')}
                    className={input}
                  />
                  <button
                    type="button"
                    onClick={addSkill}
                    aria-label={t('wizard.addSkill')}
                    className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line text-ink-tertiary hover:bg-surface-hover"
                  >
                    <Plus className="size-3.5" />
                  </button>
                </div>
                {draft.skills.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {draft.skills.map((skill) => (
                      <span
                        key={skill}
                        className="flex items-center gap-1 rounded bg-surface-muted px-1.5 py-0.5 text-2xs text-ink-secondary"
                      >
                        {skill}
                        <button
                          type="button"
                          aria-label={`${t('common.close')} ${skill}`}
                          onClick={() => patch({ skills: draft.skills.filter((item) => item !== skill) })}
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
                {label(t('wizard.persona'))}
                <textarea
                  rows={4}
                  data-testid="wizard-persona"
                  value={draft.persona}
                  onChange={(event) => patch({ persona: event.target.value })}
                  placeholder={t('wizard.personaHint')}
                  className="w-full resize-none rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
                />
              </label>
            </>
          ) : null}

          {step === 3 ? (
            <dl className="space-y-1.5 text-sm">
              {[
                [t('wizard.name'), draft.name],
                [t('wizard.role'), draft.title ?? ''],
                [t('org.level'), draft.level ?? ''],
                [t('wizard.department'), departments.find((node) => node.id === draft.departmentId)?.name ?? ''],
                [
                  t('wizard.reportsTo'),
                  members.find((member) => member.id === draft.reportsToEmployeeId)?.name ?? t('wizard.noManager'),
                ],
                [t('org.model'), draft.model || t('wizard.inheritModel')],
                [t('wizard.skills'), draft.skills.join(' · ') || '—'],
                [t('wizard.persona'), draft.persona ? `${draft.persona.slice(0, 60)}${draft.persona.length > 60 ? '…' : ''}` : '—'],
              ].map(([key, value]) => (
                <div key={key} className="flex gap-3">
                  <dt className="w-24 shrink-0 text-xs text-ink-tertiary">{key}</dt>
                  <dd className="min-w-0 flex-1 break-words text-ink">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-line px-4 py-3">
          <button
            type="button"
            disabled={step === 0}
            onClick={() => setStep((value) => Math.max(0, value - 1))}
            className={cn(buttonClass.secondary, step === 0 && 'opacity-40')}
          >
            <ChevronLeft className="size-3.5" />
            {t('wizard.back')}
          </button>
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              disabled={!canAdvance}
              onClick={() => setStep((value) => value + 1)}
              data-testid="wizard-next"
              className={cn(buttonClass.primary, !canAdvance && 'opacity-40')}
            >
              {t('wizard.next')}
              <ChevronRight className="size-3.5" />
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              data-testid="wizard-submit"
              className={buttonClass.primary}
            >
              {t('wizard.submit')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
