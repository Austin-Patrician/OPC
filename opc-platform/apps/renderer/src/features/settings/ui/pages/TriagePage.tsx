import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TriggerSource, TriagePolicy } from '@opc/shared/domain';
import { DEFAULT_TRIAGE_POLICY } from '@opc/shared/domain';
import { cn } from '@/shared/lib/cn';
import { PageHeader, Row, Section, Segmented } from '../kit';
import { TriggerSourceSection } from './TriggerSourceSection';

/**
 * Settings → 通用 → 调度。
 *
 * 这一页只配一件事：**哪些东西值得惊动 Router**。它之所以是设置而不是常量，是因为
 * 代价结构随人而变——有人希望一条都不漏（宁可多花 token），有人只让它盯收件箱。
 *
 * 两层的语义在这里是明示的：
 *   - 程序层不花钱，所以它只挡"确定不是活"的东西；
 *   - 语义层要花钱，付了钱的这一层可以用来减少 Router 的上下文占用。
 *
 * 无论怎么配，活都不会丢：两层的失败方向都是"往上交"。
 */
const SOURCES: readonly TriggerSource[] = ['im', 'folder', 'manual', 'calendar', 'github'];

const THRESHOLDS = [0.5, 0.7, 0.9] as const;

export function TriagePage() {
  const { t } = useTranslation();
  const [policy, setPolicy] = useState<TriagePolicy>(DEFAULT_TRIAGE_POLICY);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void window
      .opc!.router.getTriage()
      .then((next) => {
        if (!alive) return;
        setPolicy(next);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 每次改动立刻落库：这一页没有保存按钮，改完下一轮调度就生效。 */
  const patch = (next: Partial<TriagePolicy>) => {
    const optimistic = { ...policy, ...next };
    setPolicy(optimistic);
    void window.opc!.router.setTriage(next).then(setPolicy);
  };

  const toggleSource = (source: TriggerSource) => {
    const next = policy.sources.includes(source)
      ? policy.sources.filter((entry) => entry !== source)
      : [...policy.sources, source];
    // 空名单等于关掉调度，界面不给这个状态。
    if (next.length === 0) return;
    patch({ sources: next });
  };

  return (
    <>
      <PageHeader
        crumbs={[t('settings.title'), t('settings.group.general')]}
        title={t('settings.page.triage')}
        description={t('settings.triage.desc')}
      />

      <div className="space-y-4">
        <Section title={t('settings.triage.fastTitle')} description={t('settings.triage.fastDesc')}>
          <Row label={t('settings.triage.mode')} settingKey="router.triage.fastPath">
            <Segmented
              label={t('settings.triage.mode')}
              value={policy.fastPath}
              options={[
                { value: 'noise', label: t('settings.triage.fastNoise') },
                { value: 'allowlist', label: t('settings.triage.fastAllowlist') },
              ]}
              onChange={(fastPath) => patch({ fastPath })}
            />
          </Row>

          {policy.fastPath === 'allowlist' ? (
            <Row label={t('settings.triage.sources')} hint={t('settings.triage.sourcesHint')}>
              <div className="flex flex-wrap justify-end gap-1.5" data-testid="triage-sources">
                {SOURCES.map((source) => {
                  const active = policy.sources.includes(source);
                  return (
                    <button
                      key={source}
                      type="button"
                      data-testid={`triage-source-${source}`}
                      aria-pressed={active}
                      onClick={() => toggleSource(source)}
                      className={cn(
                        'h-7 cursor-pointer rounded-full border px-2.5 text-sm transition-colors',
                        active
                          ? 'border-accent bg-accent-soft font-medium text-accent-ink'
                          : 'border-line bg-surface text-ink-secondary hover:border-line-strong',
                      )}
                    >
                      {t(`settings.triage.source.${source}`)}
                    </button>
                  );
                })}
              </div>
            </Row>
          ) : null}
        </Section>

        <Section
          title={t('settings.triage.semanticTitle')}
          description={t('settings.triage.semanticDesc')}
        >
          <Row label={t('settings.triage.semantic')} settingKey="router.triage.semantic">
            <Segmented
              label={t('settings.triage.semantic')}
              value={policy.semantic}
              options={[
                { value: 'router', label: t('settings.triage.semanticRouter') },
                { value: 'decision', label: t('settings.triage.semanticDecision') },
              ]}
              onChange={(semantic) => patch({ semantic })}
            />
          </Row>

          {policy.semantic === 'decision' ? (
            <Row
              label={t('settings.triage.threshold')}
              hint={t('settings.triage.thresholdHint')}
              disabled={!loaded}
            >
              <Segmented
                label={t('settings.triage.threshold')}
                value={String(policy.noiseThreshold)}
                options={THRESHOLDS.map((value) => ({
                  value: String(value),
                  label: t(`settings.triage.threshold${String(value).replace('.', '')}`),
                }))}
                onChange={(next) => patch({ noiseThreshold: Number(next) })}
              />
            </Row>
          ) : null}

          {policy.semantic === 'decision' ? (
            <Row
              label={t('settings.triage.prompt')}
              hint={t('settings.triage.promptHint')}
              disabled={!loaded}
            >
              <textarea
                aria-label={t('settings.triage.prompt')}
                data-testid="triage-semantic-prompt"
                value={policy.semanticPrompt}
                rows={4}
                onChange={(event) => patch({ semanticPrompt: event.target.value })}
                className="w-full resize-y rounded-md border border-line bg-surface px-2.5 py-2 text-xs leading-relaxed text-ink outline-none focus:border-accent"
              />
            </Row>
          ) : null}

          <p className="px-4 py-3 text-xs leading-relaxed text-ink-tertiary">
            {t('settings.triage.decisionHint')}
          </p>
        </Section>

        <p className="px-1 text-2xs leading-relaxed text-ink-quaternary">
          {t('settings.triage.footnote')}
        </p>

        {/* 事件**从哪进来**和**怎么被过滤**是同一件事的两半，放在一页里。 */}
        <TriggerSourceSection />
      </div>
    </>
  );
}
