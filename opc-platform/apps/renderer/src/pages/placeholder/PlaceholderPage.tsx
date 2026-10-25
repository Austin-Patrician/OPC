import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';

interface PlaceholderPageProps {
  titleKey: string;
  descriptionKey: string;
  comingSoonKey: string;
  icon: ComponentType<{ className?: string }>;
}

/**
 * Consistent shell for views whose data contract is not wired to the daemon yet.
 * Deliberately not a fake UI: it states what is missing instead of pretending.
 */
export function PlaceholderPage({
  titleKey,
  descriptionKey,
  comingSoonKey,
  icon: Icon,
}: PlaceholderPageProps) {
  const { t } = useTranslation();

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-panel">
      <div className="mx-auto flex max-w-2xl flex-col items-start gap-4 px-6 py-10">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <Icon className="size-6" />
        </span>
        <h1 className="text-2xl font-semibold text-ink">{t(titleKey)}</h1>
        <p className="text-base leading-relaxed text-ink-secondary">{t(descriptionKey)}</p>
        <p className="rounded-lg border border-dashed border-line-strong bg-surface/60 px-3 py-2 text-sm text-ink-tertiary">
          {t(comingSoonKey)}
        </p>
      </div>
    </div>
  );
}
