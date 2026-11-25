import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { assistantName } from '@/entities/company/model/options';
import { useCompanyProfile } from '@/entities/company/model/useCompany';

interface TypingIndicatorProps {
  names: readonly string[];
}

export function TypingIndicator({ names }: TypingIndicatorProps) {
  const { t } = useTranslation();
  const profile = useCompanyProfile();
  if (names.length === 0) return null;

  const customAssistant = assistantName(profile, t('company.assistantFallback'));
  const resolvedNames = names.map((name) =>
    name === '助手' || name === t('chat.sender.routerName') ? customAssistant : name,
  );

  return (
    <div className="inline-flex w-fit items-center gap-2 rounded-full border border-line/80 bg-surface-muted px-3 py-1 text-xs font-medium text-ink-secondary">
      <Sparkles className="size-3 text-accent" aria-hidden />
      <span role="status">{t('chat.typing', { names: resolvedNames.join('、') })}</span>
    </div>
  );
}
