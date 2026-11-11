import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ToolsSection } from '@/features/capabilities/ui/ToolsSection';
import { useCapabilities } from '@/features/capabilities/model/useCapabilities';
import { buttonClass, PageHeader } from '../kit';
import { cn } from '@/shared/lib/cn';

/** 技能与工具 · 工具：模型实际可调用的工具与执行体视角。 */
export function CapabilitiesToolsPage() {
  const { t } = useTranslation();
  const capabilities = useCapabilities();
  const total = capabilities.toolNames.size;

  return (
    <div className="mx-auto w-full max-w-[55rem] px-6 py-6">
      <PageHeader
        crumbs={[t('settings.group.capabilities')]}
        title={t('settings.page.capabilitiesTools')}
        description={t('capabilities.toolsTab.description', { count: total })}
        actions={
          <button
            type="button"
            className={buttonClass.secondary}
            onClick={() => void capabilities.load()}
            disabled={capabilities.loading}
          >
            <RefreshCw className={cn('size-3.5', capabilities.loading && 'animate-spin')} />
            {t('capabilities.refresh')}
          </button>
        }
      />

      {capabilities.error ? (
        <p className="mb-4 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
          {t('capabilities.loadError', { message: capabilities.error })}
        </p>
      ) : null}

      <ToolsSection groups={capabilities.toolGroups} agents={capabilities.agents} />
    </div>
  );
}
