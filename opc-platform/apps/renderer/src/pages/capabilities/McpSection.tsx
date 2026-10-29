import { PlugZap, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Section } from '@/features/settings/ui/kit';

/**
 * MCP tab — deliberately a placeholder.
 *
 * OPC has no MCP client yet, and a fake list (or a "coming soon" spinner) would
 * be worse than saying so: the page's whole promise is that it shows what is
 * actually installed. So this states the gap and what it would take, in the same
 * tone as the rest of the page.
 */
export function McpSection() {
  const { t } = useTranslation();

  return (
    <Section
      title={t('capabilities.mcp.title')}
      description={t('capabilities.mcp.description')}
      action={<PlugZap className="size-4 text-ink-quaternary" />}
    >
      <div className="px-4 py-6">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg border border-dashed border-line bg-surface-muted text-ink-quaternary">
            <Server className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink-secondary">{t('capabilities.mcp.empty')}</p>
            <p className="mt-1 max-w-[42rem] text-xs leading-relaxed text-ink-tertiary">
              {t('capabilities.mcp.emptyHint')}
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-line bg-surface-muted/40 p-3">
          <div className="text-2xs font-semibold text-ink-tertiary">
            {t('capabilities.mcp.needsTitle')}
          </div>
          <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-ink-tertiary">
            <li>· {t('capabilities.mcp.needClient')}</li>
            <li>· {t('capabilities.mcp.needTools')}</li>
            <li>· {t('capabilities.mcp.needPolicy')}</li>
          </ul>
        </div>
      </div>
    </Section>
  );
}
