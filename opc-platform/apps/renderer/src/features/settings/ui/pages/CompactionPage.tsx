import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { OrgFactView } from '@opc/shared/ipc';
import { cn } from '@/shared/lib/cn';
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

      <CompanyFacts />
    </>
  );
}

/**
 * Company-level facts (org_fact): the rules that enter every employee's prompt.
 * Writing the same subject again supersedes the old value — history stays in the DB.
 */
function CompanyFacts() {
  const { t } = useTranslation();
  const [facts, setFacts] = useState<OrgFactView[]>([]);
  const [subject, setSubject] = useState('');
  const [object, setObject] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window
      .opc!.facts.list({})
      .then((rows) => {
        if (alive) setFacts(rows);
      })
      .catch(() => {
        if (alive) setFacts([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    if (!subject.trim() || !object.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setFacts(
        await window.opc!.facts.write({
          scopeType: 'org',
          subject: subject.trim(),
          object: object.trim(),
        }),
      );
      setSubject('');
      setObject('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={`${t('settings.facts.title')} · ${facts.length}`}
      description={t('settings.facts.desc')}
    >
      {facts.length === 0 ? (
        <p className="px-4 py-5 text-sm text-ink-quaternary">{t('settings.facts.empty')}</p>
      ) : (
        <ul data-testid="org-facts">
          {facts.map((fact) => (
            <li
              key={fact.id}
              data-testid="org-fact-row"
              className="flex items-start gap-3 border-t border-line px-4 py-2.5 first:border-t-0"
            >
              <span className="mt-0.5 rounded bg-surface-muted px-1.5 py-0.5 font-mono text-3xs text-ink-tertiary">
                {fact.subject}
              </span>
              <span className="min-w-0 flex-1 text-sm leading-relaxed text-ink">{fact.object}</span>
              <span className="shrink-0 font-mono text-3xs text-ink-quaternary">
                {new Date(fact.validFrom).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2 border-t border-line px-4 py-3">
        <input
          data-testid="org-fact-subject"
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder={t('settings.facts.subject')}
          className="h-8 w-36 rounded-md border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent"
        />
        <input
          data-testid="org-fact-object"
          value={object}
          onChange={(event) => setObject(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save();
          }}
          placeholder={t('settings.facts.object')}
          className="h-8 min-w-40 flex-1 rounded-md border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent"
        />
        <button
          type="button"
          data-testid="org-fact-save"
          disabled={busy || !subject.trim() || !object.trim()}
          onClick={() => void save()}
          className={cn(
            'h-8 rounded-md bg-accent px-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover',
            (busy || !subject.trim() || !object.trim()) && 'opacity-40',
          )}
        >
          {t('settings.facts.save')}
        </button>
      </div>
      {error ? <p className="px-4 pb-3 text-xs text-danger">{error}</p> : null}
    </Section>
  );
}
