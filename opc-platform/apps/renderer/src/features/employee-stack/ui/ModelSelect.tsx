import { useTranslation } from 'react-i18next';
import type { ModelChoice } from '../model/useEmployeeStack';
import { modelChoiceValue } from '../model/useEmployeeStack';

interface ModelSelectProps {
  choices: readonly ModelChoice[];
  /** `''` = inherit the company default. */
  value: string;
  /** Shown in the inherit option when a default exists. */
  defaultLabel: string;
  /** Shown when the stored choice no longer exists in the catalog. */
  missingLabel?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

/**
 * The one model picker. It only offers chat models the runtime has enabled, so
 * an employee can never be assigned an image or voice model by mistake.
 */
export function ModelSelect({
  choices,
  value,
  defaultLabel,
  missingLabel,
  disabled,
  onChange,
}: ModelSelectProps) {
  const { t } = useTranslation();
  const known = choices.some((choice) => modelChoiceValue(choice.providerId, choice.modelId) === value);
  const providers = [...new Map(choices.map((choice) => [choice.providerId, choice.providerName])).entries()];

  return (
    <select
      value={known ? value : ''}
      disabled={disabled || choices.length === 0}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 w-full rounded-lg border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-accent disabled:opacity-50"
    >
      <option value="">{defaultLabel}</option>
      {value && !known ? (
        <option value={value} disabled>
          {missingLabel ?? t('org.stackModelMissing')}
        </option>
      ) : null}
      {providers.map(([providerId, providerName]) => (
        <optgroup key={providerId} label={providerName}>
          {choices
            .filter((choice) => choice.providerId === providerId)
            .map((choice) => (
              <option
                key={modelChoiceValue(choice.providerId, choice.modelId)}
                value={modelChoiceValue(choice.providerId, choice.modelId)}
              >
                {choice.name}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}
