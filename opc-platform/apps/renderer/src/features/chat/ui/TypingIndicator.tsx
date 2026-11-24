import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface TypingIndicatorProps {
  names: readonly string[];
}

export function TypingIndicator({ names }: TypingIndicatorProps) {
  const { t } = useTranslation();
  if (names.length === 0) return null;

  return (
    <div className="inline-flex w-fit items-center gap-2 rounded-full border border-line/80 bg-surface-muted px-3 py-1 text-xs font-medium text-ink-secondary">
      <Sparkles className="size-3 text-accent" aria-hidden />
      <span role="status">{t('chat.typing', { names: names.join('、') })}</span>
    </div>
  );
}
