import { useState } from 'react';
import { Puzzle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ExtensionGroup } from '../model/grouping';
import { ExtensionCard, ExtensionDetailsDialog } from './ExtensionCard';

/**
 * 内置扩展 section.
 *
 * The header sits on the page background and the cards live in one large
 * rounded panel, so the eye groups them as a single surface instead of a grid
 * of floating boxes. Each card opens a details dialog rather than navigating:
 * the chevron promises more, and the tools are already in this snapshot.
 */
export function BuiltinExtensionsSection({ groups }: { groups: readonly ExtensionGroup[] }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<ExtensionGroup | null>(null);

  return (
    <section>
      <svg aria-hidden="true" className="absolute size-0">
        <defs>
          <linearGradient id="builtin-puzzle-gradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#5b9bff" />
            <stop offset="55%" stopColor="#3f7cf4" />
            <stop offset="100%" stopColor="#7c6cf6" />
          </linearGradient>
        </defs>
      </svg>

      <div className="flex items-start gap-4 px-1">
        <Puzzle
          aria-hidden="true"
          className="mt-0.5 size-14 shrink-0 drop-shadow-[0_6px_14px_rgba(79,141,247,0.28)]"
          strokeWidth={1.2}
          fill="url(#builtin-puzzle-gradient)"
          stroke="url(#builtin-puzzle-gradient)"
        />
        <div className="min-w-0">
          <h3 className="text-[1.35rem] font-semibold leading-tight text-ink">{t('capabilities.extensionsTitle')}</h3>
          <p className="mt-1.5 max-w-[44rem] text-sm leading-relaxed text-ink-tertiary">
            {t('capabilities.extensionsHint')}
          </p>
          <p className="mt-1 max-w-[44rem] text-sm leading-relaxed text-ink-tertiary">
            {t('capabilities.extensionsHintSecondary')}
          </p>
        </div>
      </div>

      <div className="builtin-extensions-panel mt-4 rounded-[26px] p-2.5">
        {groups.length > 0 ? (
          <div className="grid gap-2 md:grid-cols-2">
            {groups.map((group) => (
              <ExtensionCard key={group.name} group={group} onSelect={setSelected} />
            ))}
          </div>
        ) : (
          <p className="px-4 py-8 text-center text-sm text-ink-tertiary">{t('capabilities.empty')}</p>
        )}
      </div>

      {selected ? <ExtensionDetailsDialog group={selected} onClose={() => setSelected(null)} /> : null}
    </section>
  );
}
