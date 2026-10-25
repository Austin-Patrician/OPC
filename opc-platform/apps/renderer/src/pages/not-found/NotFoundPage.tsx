import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

export function NotFoundPage() {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-panel">
      <h1 className="text-2xl font-semibold text-ink">{t('notFound.title')}</h1>
      <p className="text-base text-ink-tertiary">{t('notFound.description')}</p>
      <Link
        to="/chat"
        className="mt-2 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
      >
        {t('notFound.action')}
      </Link>
    </div>
  );
}
