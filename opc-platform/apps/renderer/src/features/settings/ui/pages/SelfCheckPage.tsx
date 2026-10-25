import { useTranslation } from 'react-i18next';
import { DiagnosticsPanel } from '@/features/diagnostics/ui/DiagnosticsPanel';
import { PageHeader } from '../kit';

export function SelfCheckPage() {
  const { t } = useTranslation();

  return (
    <>
      <PageHeader
        crumbs={[t('settings.title'), t('settings.group.selfcheck')]}
        title={t('settings.group.selfcheck')}
        description={t('settings.selfcheck.desc')}
      />
      <DiagnosticsPanel />
    </>
  );
}
