import { useEffect, useMemo, useState } from 'react';
import { Brain, ChevronDown, Eye, KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CatalogModel, ModelOption } from '@opc/shared/domain';
import { useModels } from '@/features/models/model/useModels';
import { useCatalog } from '@/features/models/model/useCatalog';
import { AuthLoginPanel } from '@/features/settings/ui/pages/AuthLoginPanel';
import { Segmented, StatusBadge } from '@/features/settings/ui/kit';
import { AUTH_MODE_LABEL, LLM_PROVIDERS, PROVIDER_GROUPS, THINKING_LEVELS, type ThinkingLevel } from '@/shared/providers/catalog';
import { ProviderMark } from '@/shared/ui/ProviderMark';
import { cn } from '@/shared/lib/cn';
import { Block, ChoiceCard, StepHeader } from './onboardingUi';

/** Providers shown before "查看全部": the ones a first company realistically starts with. */
const FEATURED = ['anthropic', 'openai', 'google', 'deepseek', 'openrouter', 'moonshotai', 'zai', 'groq'];

const DESIGN = new Map(LLM_PROVIDERS.map((provider) => [provider.id, provider]));

interface DisplayProvider {
  id: string;
  name: string;
  group: string;
  baseUrl: string;
  api: string;
  description?: string;
  auth: string;
  models: CatalogModel[];
  modelCount: number;
}

const toModelOption = (model: CatalogModel): ModelOption => ({
  id: model.id,
  name: model.name,
  capability: model.type === 'classifier' ? 'chat' : model.type,
  api: model.api,
  contextWindow: model.contextWindow,
  inputUsdPerM: model.price?.input,
  outputUsdPerM: model.price?.output,
  cacheReadUsdPerM: model.price?.cacheRead,
  cacheWriteUsdPerM: model.price?.cacheWrite,
});

/**
 * Model engine setup over pi's real catalog.
 *
 * Picking a provider materialises it in SQLite (provider + its models) exactly
 * like Settings → LLM does, so "默认模型" and "思考强度" here write the same rows
 * the runtime reads — the guide cannot leave behind a half-configured provider.
 */
export function StepModel() {
  const { t } = useTranslation();
  const models = useModels();
  const { catalog } = useCatalog();
  const [selectedId, setSelectedId] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [oauthSupport, setOauthSupport] = useState<Record<string, boolean>>({});
  const [loggedIn, setLoggedIn] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const configured = useMemo(
    () => new Map(models.providers.map((provider) => [provider.id, provider])),
    [models.providers],
  );

  const providers: DisplayProvider[] = useMemo(() => {
    const fromCatalog = catalog.map<DisplayProvider>((entry) => {
      const design = DESIGN.get(entry.id);
      return {
        id: entry.id,
        name: design?.name ?? entry.id,
        group: design?.group ?? 'other',
        baseUrl: entry.baseUrl,
        api: entry.apis[0] ?? 'openai-completions',
        description: design?.description,
        auth: design ? design.auth.map((mode) => AUTH_MODE_LABEL[mode]).join(' / ') : (entry.apis[0] ?? ''),
        models: entry.models,
        modelCount: entry.counts.chat,
      };
    });

    // Custom providers only exist in our database, never in pi's catalog.
    const custom = models.providers
      .filter((provider) => provider.isCustom && !catalog.some((entry) => entry.id === provider.id))
      .map<DisplayProvider>((provider) => ({
        id: provider.id,
        name: provider.name,
        group: 'other',
        baseUrl: provider.baseUrl,
        api: provider.api,
        auth: provider.api,
        models: [],
        modelCount: provider.models.filter((model) => model.capability === 'chat').length,
      }));

    return [...fromCatalog, ...custom];
  }, [catalog, models.providers]);

  const selected =
    providers.find((provider) => provider.id === selectedId) ??
    providers.find((provider) => provider.id === models.defaults.llm?.providerId) ??
    providers[0];

  // Default selection: the model already in use, otherwise the first featured provider.
  useEffect(() => {
    if (selectedId || providers.length === 0) return;
    const current = models.defaults.llm?.providerId;
    const preferred =
      (current && providers.find((provider) => provider.id === current)?.id) ??
      providers.find((provider) => FEATURED.includes(provider.id))?.id ??
      providers[0]!.id;
    setSelectedId(preferred);
  }, [providers, selectedId, models.defaults.llm?.providerId]);

  const selectedConfig = selected ? configured.get(selected.id) : undefined;

  // OAuth is provider-owned in pi; ask the main process instead of guessing.
  useEffect(() => {
    const providerId = selected?.id;
    if (!providerId || oauthSupport[providerId] !== undefined) return;
    let alive = true;
    void window.opc?.models
      .supportsOauth(providerId)
      .then((supported) => {
        if (alive) setOauthSupport((previous) => ({ ...previous, [providerId]: supported }));
      })
      .catch(() => {
        if (alive) setOauthSupport((previous) => ({ ...previous, [providerId]: false }));
      });
    return () => {
      alive = false;
    };
  }, [selected?.id, oauthSupport]);

  useEffect(() => {
    void window.opc?.auth.status().then((items) => {
      setLoggedIn(new Set(items.map((item) => item.providerId)));
    });
  }, [selected?.id]);

  useEffect(() => {
    setKeyDraft('');
    setNotice(null);
  }, [selected?.id]);

  // Catalog metadata (reasoning / vision / context) is richer than the stored row,
  // so display prefers it and only custom providers fall back to the database list.
  const chatModels = useMemo<CatalogModel[]>(() => {
    const fromCatalog = (selected?.models ?? []).filter((model) => model.type === 'chat');
    if (fromCatalog.length > 0) return fromCatalog;
    if (!selectedConfig) return [];
    return selectedConfig.models
      .filter((model) => model.capability === 'chat')
      .map<CatalogModel>((model) => ({
        id: model.id,
        name: model.name,
        type: 'chat',
        api: model.api ?? selectedConfig.api,
        contextWindow: model.contextWindow,
      }));
  }, [selected, selectedConfig]);

  /** Writes provider + models into SQLite the first time the boss touches it. */
  const ensureProvider = async (provider: DisplayProvider) => {
    if (configured.has(provider.id)) return;
    await models.saveProvider({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: provider.api,
      isCustom: provider.group === 'other',
    });
    if (provider.models.length > 0) await models.setModels(provider.id, provider.models.map(toModelOption));
  };

  const saveKey = async () => {
    if (!selected || !keyDraft.trim()) return;
    setBusy(true);
    try {
      await ensureProvider(selected);
      await models.setKey(selected.id, keyDraft.trim());
      setKeyDraft('');
      setNotice(t('onboarding.model.keySaved'));
    } finally {
      setBusy(false);
    }
  };

  const pickModel = async (modelId: string) => {
    if (!selected) return;
    const active = models.defaults.llm?.providerId === selected.id && models.defaults.llm?.modelId === modelId;
    setBusy(true);
    try {
      if (active) {
        await models.setDefault('llm', null);
      } else {
        await ensureProvider(selected);
        await models.setDefault('llm', { providerId: selected.id, modelId });
      }
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const visible = showAll ? providers : providers.filter((provider) => FEATURED.includes(provider.id) || provider.id === selected?.id);

  const status = (() => {
    if (!selected) return { tone: 'gray' as const, label: t('onboarding.model.status.unconfigured') };
    if (loggedIn.has(selected.id)) return { tone: 'green' as const, label: t('onboarding.model.status.loggedIn') };
    if (selectedConfig?.hasKey) return { tone: 'green' as const, label: t('onboarding.model.status.ready') };
    if (selectedConfig) return { tone: 'amber' as const, label: t('onboarding.model.status.keyMissing') };
    return { tone: 'gray' as const, label: t('onboarding.model.status.unconfigured') };
  })();

  const defaultProvider = models.defaults.llm ? configured.get(models.defaults.llm.providerId) : undefined;
  const defaultModel = defaultProvider?.models.find((model) => model.id === models.defaults.llm?.modelId);
  const needsOauth = Boolean(selected && oauthSupport[selected.id]);

  return (
    <>
      <StepHeader
        eyebrow={t('onboarding.model.eyebrow')}
        title={t('onboarding.model.title')}
        description={t('onboarding.model.description')}
        aside={
          <div className="text-right">
            <div className="text-xs text-ink-tertiary">{t('onboarding.model.currentDefault')}</div>
            <div className="mt-1 max-w-[12rem] truncate text-base font-semibold text-ink">
              {defaultModel?.name ?? t('onboarding.model.autoPick')}
            </div>
            <div className="mt-0.5 max-w-[12rem] truncate text-2xs text-ink-quaternary">
              {defaultProvider?.name ?? 'pi'}
            </div>
          </div>
        }
      />

      <div className="space-y-6">
        <Block
          title={t('onboarding.model.providers')}
          hint={
            <button
              type="button"
              onClick={() => setShowAll((value) => !value)}
              className="inline-flex cursor-pointer items-center gap-0.5 text-sm text-accent-ink hover:text-accent"
            >
              {showAll
                ? t('onboarding.model.collapse')
                : t('onboarding.model.showAll', { count: providers.length })}
              <ChevronDown className={cn('size-3.5 transition-transform', showAll && 'rotate-180')} />
            </button>
          }
        >
          <div className="grid max-h-[13.5rem] grid-cols-4 gap-2.5 overflow-y-auto pr-0.5">
            {visible.map((provider) => (
              <ChoiceCard
                key={provider.id}
                selected={provider.id === selected?.id}
                onClick={() => setSelectedId(provider.id)}
                className="p-3"
                label={provider.name}
              >
                <div className="flex items-center gap-2.5 pr-4">
                  <ProviderMark providerId={provider.id} />
                  <div className="min-w-0">
                    <div className="truncate text-sm-plus font-semibold text-ink">{provider.name}</div>
                    <div className="truncate text-2xs text-ink-quaternary">
                      {provider.auth || PROVIDER_GROUPS.find((group) => group.id === provider.group)?.label || '—'}
                    </div>
                  </div>
                </div>
              </ChoiceCard>
            ))}
          </div>
        </Block>

        {selected ? (
          <div key={selected.id} className="onb-slide-next rounded-2xl border border-line bg-surface-muted/50 p-5">
            <div className="flex items-start gap-3">
              <ProviderMark providerId={selected.id} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-md-plus font-semibold text-ink">{selected.name}</span>
                  <StatusBadge tone={status.tone} label={status.label} />
                </div>
                <p className="mt-0.5 text-sm leading-relaxed text-ink-tertiary">
                  {selected.description ?? selected.baseUrl ?? '—'}
                </p>
              </div>
            </div>

            <div className="mt-4">
              {needsOauth ? (
                <AuthLoginPanel providerId={selected.id} />
              ) : (
                <>
                  <div className="flex items-end gap-2">
                    <label className="min-w-0 flex-1">
                      <span className="mb-1 block text-sm font-medium text-ink-secondary">
                        {t('onboarding.model.keyLabel', { provider: selected.name })}
                      </span>
                      <input
                        type="password"
                        value={keyDraft}
                        onChange={(event) => setKeyDraft(event.target.value)}
                        placeholder={
                          selectedConfig?.hasKey ? t('onboarding.model.keyPlaceholderSaved') : 'sk-…'
                        }
                        spellCheck={false}
                        className="h-9 w-full rounded-lg border border-line bg-surface px-2.5 font-mono text-sm text-ink outline-none placeholder:text-ink-quaternary focus:border-accent"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={busy || !keyDraft.trim()}
                      onClick={() => void saveKey()}
                      className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <KeyRound className="size-3.5" />
                      {t('onboarding.model.keySave')}
                    </button>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-quaternary">
                    {t('onboarding.model.keyHint')}
                  </p>
                </>
              )}
              {notice ? <p className="mt-2 text-xs text-success">{notice}</p> : null}
              {models.error ? <p className="mt-2 text-xs text-danger">{models.error}</p> : null}
            </div>

            <div className="mt-5">
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-sm-plus font-semibold text-ink">{t('onboarding.model.defaultModel')}</span>
                <span className="text-xs text-ink-quaternary">
                  {t('onboarding.model.modelCount', { count: chatModels.length })}
                </span>
              </div>
              {chatModels.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line-strong px-3 py-2.5 text-xs text-ink-tertiary">
                  {t('onboarding.model.noModels')}
                </p>
              ) : (
                <div className="grid max-h-[10.5rem] grid-cols-2 gap-2 overflow-y-auto pr-0.5">
                  {chatModels.map((model) => {
                    const active =
                      models.defaults.llm?.providerId === selected.id && models.defaults.llm?.modelId === model.id;
                    return (
                      <ChoiceCard
                        key={model.id}
                        selected={active}
                        onClick={() => void pickModel(model.id)}
                        className="px-3 py-2.5"
                      >
                        <div className="truncate pr-6 text-sm-plus font-medium text-ink">{model.name}</div>
                        <div className="mt-0.5 flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-quaternary">
                            {model.id}
                          </span>
                          {model.reasoning ? (
                            <Brain className="size-3 shrink-0 text-[#7A4CE0]" aria-label={t('onboarding.model.reasoning')} />
                          ) : null}
                          {model.vision ? (
                            <Eye className="size-3 shrink-0 text-success" aria-label={t('onboarding.model.vision')} />
                          ) : null}
                          {model.contextWindow ? (
                            <span className="shrink-0 font-mono text-2xs text-ink-tertiary">
                              {Math.round(model.contextWindow / 1000)}K
                            </span>
                          ) : null}
                        </div>
                      </ChoiceCard>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="mt-5 flex items-center justify-between gap-4">
              <div>
                <div className="text-sm-plus font-semibold text-ink">{t('onboarding.model.thinking')}</div>
                <div className="mt-0.5 text-xs text-ink-quaternary">{t('onboarding.model.thinkingHint')}</div>
              </div>
              <Segmented
                label={t('onboarding.model.thinking')}
                value={models.thinking as ThinkingLevel}
                onChange={(level) => void models.setThinking(level)}
                options={THINKING_LEVELS.map((level) => ({ value: level.value, label: level.label }))}
              />
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
