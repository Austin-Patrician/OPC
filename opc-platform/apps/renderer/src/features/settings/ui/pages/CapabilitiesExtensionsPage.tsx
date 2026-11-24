import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BuiltinExtensionsSection } from '@/features/capabilities/ui/BuiltinExtensionsSection';
import {
  FilterPills,
  FilterToolbar,
  StatStrip,
} from '@/features/capabilities/ui/CapabilityPrimitives';
import { ExternalExtensionsSection } from '@/features/capabilities/ui/ExternalExtensionsSection';
import { useCapabilities } from '@/features/capabilities/model/useCapabilities';
import {
  extensionDescriptionKey,
  extensionFallbackTitle,
  extensionTitleKey,
} from '@/shared/lib/extensionCopy';
import { cn } from '@/shared/lib/cn';
import { buttonClass, PageHeader } from '../kit';

type ScopeFilter = 'all' | 'external' | 'builtin';

/** 技能与工具 · 扩展：本机 Pi 扩展 + 内置能力模块。 */
export function CapabilitiesExtensionsPage() {
  const { t } = useTranslation();
  const capabilities = useCapabilities();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<ScopeFilter>('all');

  const externalEntries = useMemo(() => capabilities.extensions?.entries ?? [], [capabilities.extensions]);
  const enabledExternal = externalEntries.filter((entry) => entry.enabled).length;
  const q = query.trim().toLowerCase();

  const filteredExternal = useMemo(() => {
    if (!q) return externalEntries;
    return externalEntries.filter(
      (entry) =>
        entry.name.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q) ||
        entry.tools.some((tool) => tool.toLowerCase().includes(q)),
    );
  }, [externalEntries, q]);

  const filteredBuiltin = useMemo(() => {
    if (!q) return capabilities.groups;
    return capabilities.groups.filter((group) => {
      const titleKey = extensionTitleKey(group.name);
      const descKey = extensionDescriptionKey(group.name);
      const title = titleKey ? t(titleKey) : extensionFallbackTitle(group.name);
      const desc = descKey ? t(descKey) : '';
      return (
        title.toLowerCase().includes(q) ||
        desc.toLowerCase().includes(q) ||
        group.name.toLowerCase().includes(q) ||
        group.tools.some((tool) => tool.name.toLowerCase().includes(q))
      );
    });
  }, [capabilities.groups, q, t]);

  const filteredExternalCatalog = useMemo(
    () =>
      capabilities.extensions
        ? { ...capabilities.extensions, entries: filteredExternal }
        : null,
    [capabilities.extensions, filteredExternal],
  );

  return (
    <>
      <PageHeader
        crumbs={[t('settings.group.capabilities'), t('settings.page.capabilitiesExtensions')]}
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
        <p className="mb-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-2.5 text-sm text-danger">
          {t('capabilities.loadError', { message: capabilities.error })}
        </p>
      ) : null}

      <div className="space-y-5">
        <StatStrip
          items={[
            {
              label: t('capabilities.ui.statExternal'),
              value: `${enabledExternal}/${externalEntries.length}`,
              accent: enabledExternal > 0,
            },
            {
              label: t('capabilities.ui.statBuiltin'),
              value: capabilities.groups.length,
            },
            {
              label: t('capabilities.ui.statTools'),
              value: capabilities.toolNames.size,
            },
          ]}
        />

        <FilterToolbar
          query={query}
          onQueryChange={setQuery}
          placeholder={t('capabilities.ui.searchExtensions')}
          rightSlot={
            <FilterPills<ScopeFilter>
              label={t('capabilities.ui.filterScopeLabel')}
              value={scope}
              onChange={setScope}
              options={[
                {
                  value: 'all',
                  label: t('capabilities.ui.filterAll'),
                  count: externalEntries.length + capabilities.groups.length,
                },
                {
                  value: 'external',
                  label: t('capabilities.ui.filterExternal'),
                  count: externalEntries.length,
                },
                {
                  value: 'builtin',
                  label: t('capabilities.ui.filterBuiltin'),
                  count: capabilities.groups.length,
                },
              ]}
            />
          }
        />

        {scope !== 'builtin' ? (
          <ExternalExtensionsSection
            catalog={filteredExternalCatalog}
            filteredEmpty={Boolean(q) && externalEntries.length > 0 && filteredExternal.length === 0}
            busyId={capabilities.busyExtension}
            error={capabilities.extensionError}
            onToggle={(entry, next) => void capabilities.toggleExtension(entry, next)}
          />
        ) : null}

        {scope !== 'external' ? (
          <BuiltinExtensionsSection
            groups={filteredBuiltin}
            filteredEmpty={Boolean(q) && capabilities.groups.length > 0 && filteredBuiltin.length === 0}
          />
        ) : null}
      </div>
    </>
  );
}
