import { useTranslation } from 'react-i18next';
import { useModels } from '@/features/models/model/useModels';
import { NumberField, PageHeader, Row, Section, Toggle } from '../kit';

/**
 * Settings → 工作区与压缩.
 *
 * The thresholds are only meaningful relative to a context window, so this page
 * shows the selected model's window and derives a recommendation from it.
 */
export function CompactionPage() {
  const { t } = useTranslation();
  const models = useModels();

  const llm = models.defaults.llm;
  const provider = models.providers.find((entry) => entry.id === llm?.providerId);
  const model = provider?.models.find((entry) => entry.id === llm?.modelId);
  const contextWindow = model?.contextWindow ?? 128_000;
  const recommendedReserve = Math.min(16_384, Math.round(contextWindow * 0.1));
  const compaction = models.compaction;

  const patch = (next: Partial<typeof compaction>) => void models.setCompaction({ ...compaction, ...next });

  return (
    <>
      <PageHeader
        crumbs={[t('settings.title'), t('settings.group.general')]}
        title={t('settings.page.compaction')}
        description={t('settings.compaction.desc')}
      />

      <div className="space-y-4">
        <Section title={t('settings.compaction.model')} description={t('settings.compaction.modelHint')}>
          <Row
            label={llm ? `${llm.providerId} / ${llm.modelId}` : t('models.notConfigured')}
            hint={t('settings.compaction.contextHint', { tokens: contextWindow.toLocaleString() })}
          >
            <span className="font-mono text-sm text-ink">{contextWindow.toLocaleString()} tok</span>
          </Row>
        </Section>

        <Section title={t('settings.compaction.title')} description={t('settings.compaction.sectionDesc')}>
          <Row label={t('settings.compaction.enabled')} settingKey="compaction.enabled">
            <Toggle
              label={t('settings.compaction.enabled')}
              checked={compaction.enabled}
              onChange={(enabled) => patch({ enabled })}
            />
          </Row>
          <Row
            label={t('settings.compaction.reserve')}
            settingKey="compaction.reserveTokens"
            hint={t('settings.compaction.reserveHint', { recommended: recommendedReserve.toLocaleString() })}
            disabled={!compaction.enabled}
          >
            <div className="flex items-center gap-2">
              <NumberField
                label={t('settings.compaction.reserve')}
                value={compaction.reserveTokens}
                min={1024}
                max={1_000_000}
                unit="tok"
                onChange={(reserveTokens) => patch({ reserveTokens })}
              />
              <button
                type="button"
                onClick={() => patch({ reserveTokens: recommendedReserve })}
                className="text-2xs text-accent-ink hover:text-accent"
              >
                {t('settings.compaction.applyRecommended')}
              </button>
            </div>
          </Row>
          <Row
            label={t('settings.compaction.keep')}
            settingKey="compaction.keepRecentTokens"
            hint={t('settings.compaction.keepHint')}
            disabled={!compaction.enabled}
          >
            <NumberField
              label={t('settings.compaction.keep')}
              value={compaction.keepRecentTokens}
              min={0}
              max={1_000_000}
              unit="tok"
              onChange={(keepRecentTokens) => patch({ keepRecentTokens })}
            />
          </Row>
          <Row
            label={t('settings.compaction.background')}
            settingKey="compaction.backgroundTokens"
            hint={t('settings.compaction.backgroundHint')}
            disabled={!compaction.enabled}
          >
            <NumberField
              label={t('settings.compaction.background')}
              value={compaction.backgroundTokens}
              min={0}
              max={1_000_000}
              unit="tok"
              onChange={(backgroundTokens) => patch({ backgroundTokens })}
            />
          </Row>
        </Section>

        <p className="px-1 text-2xs leading-relaxed text-ink-quaternary">
          {t('settings.compaction.footnote')}
        </p>
      </div>
    </>
  );
}
