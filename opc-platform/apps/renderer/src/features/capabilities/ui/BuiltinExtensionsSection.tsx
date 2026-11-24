import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Section } from '@/features/settings/ui/kit';
import type { ExtensionGroup } from '../model/grouping';
import { ExtensionCard, ExtensionDetailsDialog } from './ExtensionCard';

/** Built-in capability modules grouped in a unified settings section. */
export function BuiltinExtensionsSection({
  groups,
  filteredEmpty = false,
}: {
  groups: readonly ExtensionGroup[];
  filteredEmpty?: boolean;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<ExtensionGroup | null>(null);

  return (
    <>
      <Section
        title={t('capabilities.extensionsTitle')}
        description={t('capabilities.extensionsHint')}
        action={
          <span className="rounded-full border border-line bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-ink-secondary tabular-nums">
            {groups.length}
          </span>
        }
      >
        {groups.length > 0 ? (
          <div className="grid gap-3 p-4 md:grid-cols-2">
            {groups.map((group) => (
              <ExtensionCard key={group.name} group={group} onSelect={setSelected} />
            ))}
          </div>
        ) : (
          <p className="px-4 py-8 text-center text-sm text-ink-tertiary">
            {filteredEmpty ? t('capabilities.ui.noMatches') : t('capabilities.empty')}
          </p>
        )}
      </Section>

      {selected ? (
        <ExtensionDetailsDialog group={selected} onClose={() => setSelected(null)} />
      ) : null}
    </>
  );
}
