import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SkillsSection } from '@/features/capabilities/ui/SkillsSection';
import { useCapabilities } from '@/features/capabilities/model/useCapabilities';
import { buttonClass, PageHeader } from '../kit';
import { cn } from '@/shared/lib/cn';

/** 技能与工具 · 技能：本机 Markdown 技能的启用与成本。 */
export function CapabilitiesSkillsPage() {
  const { t } = useTranslation();
  const capabilities = useCapabilities();

  return (
    <div className="mx-auto w-full max-w-[55rem] px-6 py-6">
      <PageHeader
        crumbs={[t('settings.group.capabilities')]}
        title={t('settings.page.capabilitiesSkills')}
        description={t('capabilities.skills.description')}
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

      <SkillsSection
        catalog={capabilities.skills}
        busyId={capabilities.busySkill}
        error={capabilities.skillError}
        onToggle={(entry, next) => void capabilities.toggleSkill(entry, next)}
      />
    </div>
  );
}
