import { useEffect, useRef, useState } from 'react';
import { Loader2, MoreHorizontal, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SkillsSection } from '@/features/capabilities/ui/SkillsSection';
import { useCapabilities } from '@/features/capabilities/model/useCapabilities';
import { cn } from '@/shared/lib/cn';
import { buttonClass, PageHeader } from '../kit';

/** 技能与工具 · 技能：OPC 专属精选内置技能统一视图。 */
export function CapabilitiesSkillsPage() {
  const { t } = useTranslation();
  const capabilities = useCapabilities();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const packs = capabilities.skillPacks?.packs ?? [];
  const allReady = packs.length > 0 && packs.every((pack) => pack.ready);
  const envReady = capabilities.skillPacks?.env.state === 'ready';
  const isInstalling =
    capabilities.skillPacks?.env.state === 'installing' || capabilities.skillPackEnvBusy;

  useEffect(() => {
    if (!menuOpen) return undefined;

    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  const handleUpgrade = () => {
    setMenuOpen(false);
    void capabilities.upgradeSkillPackEnv();
  };

  const handleUninstall = () => {
    setMenuOpen(false);
    if (!window.confirm(t('capabilities.skillPacks.confirmUninstall'))) return;
    void capabilities.uninstallSkillPackEnv();
  };

  return (
    <>
      <PageHeader
        crumbs={[t('settings.group.capabilities'), t('settings.page.capabilitiesSkills')]}
        title={t('settings.page.capabilitiesSkills')}
        description={t('capabilities.skills.description')}
        actions={
          <>
            {packs.length > 0 && !allReady ? (
              <button
                type="button"
                className={buttonClass.primary}
                disabled={isInstalling}
                onClick={() => void capabilities.enableAllSkillPacks()}
              >
                {isInstalling ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                {t('capabilities.skillPacks.enableAll')}
              </button>
            ) : null}

            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => void capabilities.load()}
              disabled={capabilities.loading}
            >
              <RefreshCw className={cn('size-3.5', capabilities.loading && 'animate-spin')} />
              {t('capabilities.refresh')}
            </button>

            {envReady ? (
              <div ref={menuRef} className="relative">
                <button
                  type="button"
                  aria-label={t('capabilities.skillPacks.moreActions')}
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  disabled={isInstalling}
                  onClick={() => setMenuOpen((prev) => !prev)}
                  className={cn(buttonClass.secondary, 'size-[30px] px-0')}
                >
                  <MoreHorizontal className="size-3.5" />
                </button>

                {menuOpen ? (
                  <div
                    role="menu"
                    className="absolute top-full right-0 z-20 mt-1.5 w-44 rounded-xl border border-line bg-surface p-1 shadow-[0_8px_24px_-4px_rgba(0,0,0,0.12)]"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      disabled={isInstalling}
                      onClick={handleUpgrade}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-ink transition-colors hover:bg-surface-muted disabled:opacity-50"
                    >
                      <RefreshCw className={cn('size-3.5 text-ink-tertiary', isInstalling && 'animate-spin')} />
                      <span>{t('capabilities.skillPacks.upgradeEnv')}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={isInstalling}
                      onClick={handleUninstall}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
                    >
                      <Trash2 className="size-3.5" />
                      <span>{t('capabilities.skillPacks.uninstallEnv')}</span>
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        }
      />

      {capabilities.error ? (
        <p className="mb-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-2.5 text-sm text-danger">
          {t('capabilities.loadError', { message: capabilities.error })}
        </p>
      ) : null}

      <SkillsSection
        skillPacks={capabilities.skillPacks}
        skillPackProgress={capabilities.skillPackProgress}
        busySkillPack={capabilities.busySkillPack}
        skillPackEnvBusy={capabilities.skillPackEnvBusy}
        skillPackError={capabilities.skillPackError}
        skills={capabilities.skills}
        busySkill={capabilities.busySkill}
        skillError={capabilities.skillError}
        onTogglePack={(pack, next) => void capabilities.toggleSkillPack(pack, next)}
        onToggleSkill={(entry, next) => void capabilities.toggleSkill(entry, next)}
      />
    </>
  );
}
