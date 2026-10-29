import { useTranslation } from 'react-i18next';
import { Cpu, Loader2, Tags } from 'lucide-react';
import { ModelSelect } from './ModelSelect';
import { ToolPolicyEditor } from './ToolPolicyEditor';
import { parseModelChoice, useEmployeeStack, modelChoiceValue, modelRefLabel } from '../model/useEmployeeStack';

/**
 * 底层模型与技能：read + write in one place.
 *
 * The model applies to that employee's next task and next 1v1 reply; tool
 * toggles rebuild the cached harness (or defer it until the current task ends).
 * The section owns its data so a future wizard can mount the same component
 * with just an employee id.
 */
export function EmployeeStackSection({
  employeeId,
  skills = [],
  onSaved,
}: {
  employeeId: string;
  /** Archive tags kept for HR/marketplace matching; not the runtime tool set. */
  skills?: readonly string[];
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const { view, choices, loading, saving, error, save, setPolicy } = useEmployeeStack(employeeId);

  const defaultLabel = (() => {
    if (!view?.defaultModel) return t('org.stackNoDefault');
    return modelRefLabel(choices, view.defaultModel) ?? t('org.stackNoDefault');
  })();

  const persist = (run: () => Promise<unknown>) => {
    void run().then(onSaved).catch(() => undefined);
  };

  return (
    <section className="border-t border-line px-5 py-4">
      <div className="mb-2.5 flex items-center justify-between">
        <h4 className="flex items-center gap-1.5 text-2xs font-semibold text-ink-tertiary">
          <Cpu className="size-3.5 text-accent" aria-hidden />
          {t('org.stack')}
        </h4>
        {saving ? (
          <span className="flex items-center gap-1 text-3xs text-ink-quaternary">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            {t('org.stackSaving')}
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="mb-2 rounded-md border border-danger/30 bg-danger/5 px-2 py-1 text-3xs text-danger">
          {error}
        </p>
      ) : null}

      {!view ? (
        <p className="text-2xs text-ink-quaternary">{loading ? t('common.loading') : '—'}</p>
      ) : (
        <div className="space-y-3.5">
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-2xs font-semibold text-ink-secondary">{t('org.stackModel')}</span>
              <span className="truncate text-3xs text-ink-quaternary">
                {t('org.stackModelNow')}：{view.model ? view.modelLabel : defaultLabel}
              </span>
            </div>
            <ModelSelect
              choices={choices}
              value={view.model ? modelChoiceValue(view.model.providerId, view.model.modelId) : ''}
              defaultLabel={t('org.stackInherit', { model: defaultLabel })}
              missingLabel={view.modelLabel || t('org.stackModelMissing')}
              disabled={saving}
              onChange={(value) =>
                persist(() => save({ model: parseModelChoice(value) }))
              }
            />
            <p className="mt-1 text-3xs leading-relaxed text-ink-quaternary">
              {choices.length === 0 ? t('org.stackNoModels') : t('org.stackModelHint')}
            </p>
          </div>

          <ToolPolicyEditor
            view={view}
            disabled={saving}
            onChange={(policy) => persist(() => setPolicy(policy))}
          />

          <div>
            <div className="mb-1.5 flex items-center gap-1 text-2xs font-semibold text-ink-secondary">
              <Tags className="size-3 text-ink-tertiary" aria-hidden />
              {t('org.stackSkillTags')}
            </div>
            {skills.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {skills.map((skill) => (
                  <span
                    key={skill}
                    className="rounded-md bg-surface-muted px-2 py-0.5 text-2xs text-ink-secondary"
                  >
                    {skill}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-2xs text-ink-quaternary">—</span>
            )}
            <p className="mt-1 text-3xs leading-relaxed text-ink-quaternary">
              {t('org.stackSkillTagsHint')}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
