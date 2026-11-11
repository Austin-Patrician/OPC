import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BuiltinExtensionsSection } from '@/features/capabilities/ui/BuiltinExtensionsSection';
import { ExternalExtensionsSection } from '@/features/capabilities/ui/ExternalExtensionsSection';
import { useCapabilities } from '@/features/capabilities/model/useCapabilities';
import { buttonClass, PageHeader } from '../kit';
import { cn } from '@/shared/lib/cn';

/** 技能与工具 · 扩展：本机 Pi 扩展 + 内置扩展。 */
export function CapabilitiesExtensionsPage() {
  const { t } = useTranslation();
  const capabilities = useCapabilities();

  return (
    <div className="mx-auto w-full max-w-[55rem] px-6 py-6">
      <PageHeader
        crumbs={[t('settings.group.capabilities')]}
        title={t('settings.page.capabilitiesExtensions')}
        description={t('capabilities.extensionsPageDescription')}
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

      <div className="space-y-6">
        <ExternalExtensionsSection
          catalog={capabilities.extensions}
          busyId={capabilities.busyExtension}
          error={capabilities.extensionError}
          onToggle={(entry, next) => void capabilities.toggleExtension(entry, next)}
        />

        <BuiltinExtensionsSection groups={capabilities.groups} />
      </div>
    </div>
  );
}
