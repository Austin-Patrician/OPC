import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { StatStrip } from '@/features/capabilities/ui/CapabilityPrimitives';
import { ToolsSection } from '@/features/capabilities/ui/ToolsSection';
import { useCapabilities } from '@/features/capabilities/model/useCapabilities';
import { cn } from '@/shared/lib/cn';
import { buttonClass, PageHeader } from '../kit';

/** 技能与工具 · 工具：模型实际可调用的工具与执行体视角。 */
export function CapabilitiesToolsPage() {
  const { t } = useTranslation();
  const capabilities = useCapabilities();
  const total = capabilities.toolNames.size;

  return (
    <>
      <PageHeader
        crumbs={[t('settings.group.capabilities'), t('settings.page.capabilitiesTools')]}
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
        <p className="mb-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-2.5 text-sm text-danger">
          {t('capabilities.loadError', { message: capabilities.error })}
        </p>
      ) : null}

      <div className="space-y-5">
        <StatStrip
          items={[
            {
              label: t('capabilities.ui.statTools'),
              value: total,
              accent: total > 0,
            },
            {
              label: t('capabilities.ui.statGroups'),
              value: capabilities.toolGroups.length,
            },
            {
              label: t('capabilities.ui.statAgents'),
              value: capabilities.agents.length,
            },
          ]}
        />

        <ToolsSection groups={capabilities.toolGroups} agents={capabilities.agents} />
      </div>
    </>
  );
}
