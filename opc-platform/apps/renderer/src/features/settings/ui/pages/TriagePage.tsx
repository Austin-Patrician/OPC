import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TriggerSource, TriagePolicy } from '@opc/shared/domain';
import { DEFAULT_TRIAGE_POLICY, isChatModelEnabled } from '@opc/shared/domain';
import { useModels } from '@/features/models/model/useModels';
import { useCatalog } from '@/features/models/model/useCatalog';
import { cn } from '@/shared/lib/cn';
import { ModelPicker, pickerGroups } from '@/shared/ui/ModelPicker';
import { PageHeader, Row, Section, Segmented } from '../kit';
import { TriggerSourceSection } from './TriggerSourceSection';

/**
 * Settings → 通用 → 事件调度。
 *
 * 这一页只配一件事：**哪些事件值得惊动 Router**。它之所以是设置而不是常量，是因为
 * 代价结构随人而变——有人希望一条都不漏（宁可多花 token），有人只让它盯收件箱。
 *
 * 文案的语域是有意选的：**用规范的工作语言，不用实现词，也不用口语。**
 *
 * - 不用实现词：`程序层` / `语义层` / `noise` / `allowlist` 这些是代码里的名字，
 *   界面上写的是它们**做了什么**——"规则过滤（不产生模型调用）"、
 *   "语义预筛（产生模型调用）"。
 * - 不用口语：设置页是长期存在的界面，不是聊天。每条说明都按照
 *   「是什么 → 判断依据 → 什么情况下生效/失效」写，让它在半年后仍然读得懂。
 * - 代价必须写在界面上，不能只写在文档里：允许静默丢弃的那一项（来源名单）、
 *   以及"被丢弃的事件仍然保留在库里"这一条，都在文案里明说。
 *
 * 无论怎么配，活都不会丢：两层的失败方向都是"往上交"。
 */
const SOURCES: readonly TriggerSource[] = ['im', 'folder', 'manual', 'calendar', 'github'];

const THRESHOLDS = [0.5, 0.7, 0.9] as const;

export function TriagePage() {
  const { t } = useTranslation();
  const models = useModels();
  const { catalog } = useCatalog();
  const [policy, setPolicy] = useState<TriagePolicy>(DEFAULT_TRIAGE_POLICY);
  const [loaded, setLoaded] = useState(false);

  /**
   * Router 的两档模型都在这一页配：会话本身用哪个（`default.router`），
   * 语义预筛用哪个分类模型（`default.decision`）。
   *
   * 放在这一页而不是 LLM / Decision 页，是因为它们影响的是**调度成本**，
   * 和阈值、判定标准是同一个决定；去两页配一个东西，等于让人记住两处设置。
   * 可选项本身仍然来自那两页：这里只挑已经启用的行，不在这里启用新模型。
   */
  const routerGroups = pickerGroups(
    models.providers,
    (model) => model.capability === 'chat' && isChatModelEnabled(model),
    catalog,
  );

  /** 与 `runtime.ts` 注册分类模型的条件一致：显式启用过的才算。 */
  const classifierGroups = pickerGroups(
    models.providers,
    (model) => model.capability === 'classifier' && model.decisionEnabled === true,
    catalog,
  );

  const effectiveRouterModel = models.defaults.router ?? models.defaults.llm;

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
        crumbs={[t('settings.group.behavior'), t('settings.page.triage')]}
        title={t('settings.page.triage')}
        description={t('settings.triage.desc')}
      />

      <div className="space-y-4">
        <Section title={t('settings.triage.modelTitle')} description={t('settings.triage.modelDesc')}>
          <Row
            label={t('settings.triage.routerModel')}
            hint={t('settings.triage.routerModelHint')}
            settingKey="default.router"
          >
            <div className="w-[22rem] max-w-full">
              <ModelPicker
                ariaLabel={t('settings.triage.routerModel')}
                title={t('settings.triage.routerModel')}
                testId="triage-router-model"
                groups={routerGroups}
                value={models.defaults.router}
                thinking={models.routerThinking}
                clearLabel={t('settings.triage.routerModelFollow')}
                emptyLabel={t('settings.triage.routerModelFollow')}
                onClear={() => void models.setDefault('router', null)}
                onSelect={(selection) => {
                  void models.setDefault('router', {
                    providerId: selection.providerId,
                    modelId: selection.modelId,
                  });
                  if (selection.thinking !== undefined) {
                    void models.setRouterThinking(selection.thinking);
                  }
                }}
              />
              <p className="mt-1 text-2xs text-ink-quaternary">
                {t('settings.triage.routerModelEffective', {
                  model: effectiveRouterModel
                    ? `${effectiveRouterModel.providerId}/${effectiveRouterModel.modelId}`
                    : t('settings.triage.routerModelNone'),
                })}
              </p>
            </div>
          </Row>

          {routerGroups.length === 0 ? (
            <p className="border-t border-line px-4 py-3 text-xs leading-relaxed text-ink-tertiary">
              {t('settings.triage.routerModelNoChoices')}
            </p>
          ) : null}
        </Section>

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
              label={t('settings.triage.classifier')}
              hint={t('settings.triage.classifierHint')}
              settingKey="default.decision"
              disabled={models.loading}
            >
              <div className="w-[22rem] max-w-full">
                <ModelPicker
                  ariaLabel={t('settings.triage.classifier')}
                  title={t('settings.triage.classifier')}
                  testId="triage-classifier-model"
                  groups={classifierGroups}
                  value={models.defaults.decision}
                  allowThinking={false}
                  clearLabel={t('settings.triage.classifierNone')}
                  emptyLabel={t('settings.triage.classifierNone')}
                  onClear={() => void models.setDefault('decision', null)}
                  onSelect={(selection) =>
                    void models.setDefault('decision', {
                      providerId: selection.providerId,
                      modelId: selection.modelId,
                    })
                  }
                />
                {classifierGroups.length === 0 ? (
                  <p className="mt-1 text-2xs text-ink-quaternary">
                    {t('settings.triage.classifierNoChoices')}
                  </p>
                ) : null}
              </div>
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
