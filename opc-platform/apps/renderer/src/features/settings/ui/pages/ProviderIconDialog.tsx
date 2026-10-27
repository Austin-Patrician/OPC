import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ProviderMark } from '@/shared/ui/ProviderMark';
import { cn } from '@/shared/lib/cn';
import { buttonClass } from '../kit';

export interface ProviderIconChoice {
  /** Provider id whose icon file is reused. */
  id: string;
  /** Provider name, shown as the tooltip. */
  name: string;
}

/**
 * Icon picker for custom providers: every icon that ships with the provider
 * catalogue, one tile each, plus the initials fallback. Picking a tile applies it
 * to the form draft — the provider is only written when the page is saved.
 */
export function ProviderIconDialog({
  providerId,
  name,
  choices,
  value,
  onSelect,
  onClose,
}: {
  providerId: string;
  name: string;
  choices: readonly ProviderIconChoice[];
  /** Currently chosen icon provider id; `''` means the initials fallback. */
  value: string;
  onSelect: (icon: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pick = (icon: string) => {
    onSelect(icon);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.llm.iconChoose')}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-xl overflow-hidden rounded-xl border border-line bg-surface shadow-popover"
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-base-plus font-semibold text-ink">{t('settings.llm.iconChoose')}</h2>
          <button type="button" onClick={onClose} aria-label={t('common.close')}>
            <X className="size-4 text-ink-tertiary hover:text-ink" />
          </button>
        </header>

        <div
          data-testid="provider-icon-grid"
          className="grid max-h-[22rem] grid-cols-8 gap-1.5 overflow-y-auto px-4 py-3"
        >
          <button
            type="button"
            title={t('settings.llm.iconDefault')}
            aria-label={t('settings.llm.iconDefault')}
            onClick={() => pick('')}
            className={cn(
              'flex items-center justify-center rounded-lg p-1.5 transition-colors hover:bg-ink/5',
              value === '' && 'bg-surface-active ring-1 ring-accent',
            )}
          >
            <ProviderMark providerId={providerId} label={name} size="md" />
          </button>
          {choices.map((choice) => (
            <button
              key={choice.id}
              type="button"
              title={choice.name}
              aria-label={choice.name}
              onClick={() => pick(choice.id)}
              className={cn(
                'flex items-center justify-center rounded-lg p-1.5 transition-colors hover:bg-ink/5',
                value === choice.id && 'bg-surface-active ring-1 ring-accent',
              )}
            >
              <ProviderMark providerId={choice.id} size="md" />
            </button>
          ))}
        </div>

        <footer className="flex justify-end gap-2 border-t border-line bg-surface-muted px-4 py-3">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            {t('common.cancel')}
          </button>
        </footer>
      </div>
    </div>
  );
}
