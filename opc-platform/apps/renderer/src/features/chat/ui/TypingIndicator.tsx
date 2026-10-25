import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface TypingIndicatorProps {
  names: readonly string[];
}

export function TypingIndicator({ names }: TypingIndicatorProps) {
  const { t } = useTranslation();
  if (names.length === 0) return null;

  return (
    <div className="flex w-fit items-center gap-2 rounded-full bg-accent-soft px-3 py-1.5 text-sm text-accent-ink">
      <Sparkles className="size-3.5" aria-hidden />
      <span role="status">{t('chat.typing', { names: names.join('、') })}</span>
    </div>
  );
}
