import { useEffect, useMemo, useState } from 'react';
import { KeyRound, Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CatalogModel, ProviderDraft } from '@opc/shared/domain';
import { useModels } from '@/features/models/model/useModels';
import { useCatalog } from '@/features/models/model/useCatalog';
import { LLM_PROVIDERS, PROVIDER_GROUPS, THINKING_LEVELS, formatContext, type ThinkingLevel } from '@/shared/providers/catalog';
import { ProviderMark } from '@/shared/ui/ProviderMark';
import { cn } from '@/shared/lib/cn';
import { buttonClass, KeyTag, PageHeader, Section, Segmented, SelectField, StatusBadge, TextField } from '../kit';
import { AddProviderDialog } from './AddProviderDialog';
import { AuthLoginPanel } from './AuthLoginPanel';

const OTHER_GROUP = { id: 'other', label: '其他' };
const DESIGN = new Map(LLM_PROVIDERS.map((provider) => [provider.id, provider]));

interface DisplayProvider {
  id: string;
  name: string;
  group: string;
  baseUrl: string;
  apis: string[];
  counts: { chat: number; image: number; classifier: number };
  models: CatalogModel[];
  description?: string;
}

/**
 * LLM settings over pi's **entire** catalog (42 providers, all 14 API kinds),
 * with the model list rendered as a table whose price columns are prefilled from
 * pi and editable per model.
 */
/** OAuth only exists for a few providers; the rest log in with an API key. */
function OauthSection({ providerId }: { providerId: string }) {
  const { t } = useTranslation();
  const [supported, setSupported] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    void window.opc?.models
      .supportsOauth(providerId)
      .then((value) => {
        if (alive) setSupported(value);
      })
      .catch(() => {
        if (alive) setSupported(false);
      });
    return () => {
      alive = false;
    };
  }, [providerId]);

  if (supported === null) return null;
  if (!supported) {
    return (
      <p data-testid="apikey-only" className="text-xs text-ink-quaternary">
        {t('settings.llm.apiKeyOnly')}
      </p>
    );
  }
  return <AuthLoginPanel providerId={providerId} />;
}

export function LlmPage({ initialProviderId }: { initialProviderId?: string } = {}) {
  const { t } = useTranslation();
  const models = useModels();
  const { catalog, loading } = useCatalog();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>(() => initialProviderId ?? '');
  const [keyDraft, setKeyDraft] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [priceDraft, setPriceDraft] = useState<Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>>({});
  const [customOpen, setCustomOpen] = useState(false);
  const [customModel, setCustomModel] = useState({ id: '', name: '', contextWindow: '' });
  const [customError, setCustomError] = useState<string | null>(null);
  const [modelNotice, setModelNotice] = useState<string | null>(null);

  const configured = useMemo(
    () => new Map(models.providers.map((provider) => [provider.id, provider])),
    [models.providers],
  );

  const providers: DisplayProvider[] = useMemo(() => {
    const fromCatalog: DisplayProvider[] = catalog.map((entry) => {
      const design = DESIGN.get(entry.id);
      return {
        id: entry.id,
        name: design?.name ?? entry.id,
        group: design?.group ?? OTHER_GROUP.id,
        baseUrl: entry.baseUrl,
        apis: entry.apis,
        counts: entry.counts,
        models: entry.models,
        description: design?.description,
      };
    });

    // Custom providers exist only in our DB.
    const custom = models.providers
      .filter((provider) => provider.isCustom && !catalog.some((entry) => entry.id === provider.id))
      .map<DisplayProvider>((provider) => ({
        id: provider.id,
        name: provider.name,
        group: OTHER_GROUP.id,
        baseUrl: provider.baseUrl,
        apis: [provider.api],
        counts: {
          chat: provider.models.filter((model) => model.capability === 'chat').length,
          image: provider.models.filter((model) => model.capability === 'image').length,
          classifier: 0,
        },
        models: provider.models.map((model) => ({
          id: model.id,
          name: model.name,
          type: model.capability,
          api: model.api ?? provider.api,
          contextWindow: model.contextWindow,
          price: {
            input: model.inputUsdPerM ?? 0,
            output: model.outputUsdPerM ?? 0,
            cacheRead: model.cacheReadUsdPerM ?? 0,
            cacheWrite: model.cacheWriteUsdPerM ?? 0,
            tiers: model.tiers?.map((tier) => ({
              inputTokensAbove: tier.inputTokensAbove,
              input: tier.inputUsdPerM,
              output: tier.outputUsdPerM,
              cacheRead: tier.cacheReadUsdPerM,
              cacheWrite: tier.cacheWriteUsdPerM,
            })),
          },
        })),
      }));

    return [...fromCatalog, ...custom];
  }, [catalog, models.providers]);

  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];
  const selectedConfig = selected ? configured.get(selected.id) : undefined;
  const chatModels = selected?.models.filter((model) => model.type === 'chat') ?? [];
  const statusOf = (providerId: string) => {
    const config = configured.get(providerId);
    if (!config) return { tone: 'gray' as const, label: t('settings.llm.unconfigured') };
    if (!config.hasKey) return { tone: 'amber' as const, label: t('settings.llm.keyMissing') };
    return { tone: 'green' as const, label: t('settings.llm.keyReady') };
  };

  /** Materialises the provider + its models in SQLite before the first edit. */
  const ensureProvider = async (provider: DisplayProvider) => {
    if (configured.has(provider.id)) return;
    await models.saveProvider({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: provider.apis[0] ?? 'openai-completions',
      isCustom: provider.group === OTHER_GROUP.id,
    });
    await models.setModels(
      provider.id,
      provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        capability: model.type === 'classifier' ? 'chat' : model.type,
        api: model.api,
        contextWindow: model.contextWindow,
        inputUsdPerM: model.price?.input,
        outputUsdPerM: model.price?.output,
        cacheReadUsdPerM: model.price?.cacheRead,
        cacheWriteUsdPerM: model.price?.cacheWrite,
      })),
    );
  };

  const readyCount = providers.filter((provider) => statusOf(provider.id).tone === 'green').length;
  const needle = query.trim().toLowerCase();
  const visible = providers.filter(
    (provider) =>
      !needle ||
      provider.id.includes(needle) ||
      provider.name.toLowerCase().includes(needle) ||
      provider.models.some((model) => model.id.toLowerCase().includes(needle)),
  );

  const defaultValue = models.defaults.llm
    ? `${models.defaults.llm.providerId}::${models.defaults.llm.modelId}`
    : '';
  const pricedModels = selectedConfig ? new Map(selectedConfig.models.map((model) => [model.id, model])) : new Map();

  useEffect(() => setKeyDraft(''), [selected?.id]);

  const priceOf = (model: CatalogModel) => {
    const local = pricedModels.get(model.id);
    return priceDraft[model.id] ?? {
      input: local?.inputUsdPerM ?? model.price?.input ?? 0,
      output: local?.outputUsdPerM ?? model.price?.output ?? 0,
      cacheRead: local?.cacheReadUsdPerM ?? model.price?.cacheRead ?? 0,
      cacheWrite: local?.cacheWriteUsdPerM ?? model.price?.cacheWrite ?? 0,
    };
  };

  const savePrice = async (provider: DisplayProvider, model: CatalogModel) => {
    const price = priceOf(model);
    await ensureProvider(provider);
    await models.setModelPricing(provider.id, model.id, price);
    setPriceDraft((previous) => {
      const next = { ...previous };
      delete next[model.id];
      return next;
    });
  };

  return (
    <>
      <PageHeader
        crumbs={[t('settings.group.models'), 'LLM']}
        title={t('settings.llm.title')}
        description={t('settings.llm.descAll', { providers: providers.length, models: providers.reduce((sum, provider) => sum + provider.models.length, 0) })}
        actions={
          <StatusBadge
            tone={readyCount > 0 ? 'blue' : 'amber'}
            label={t('settings.llm.readyCount', { count: readyCount })}
          />
        }
      />

      <div className="space-y-4">
        <Section title={t('settings.llm.defaultTitle')} description={t('settings.llm.defaultDesc')}>
          <div className="flex items-center gap-6 border-t border-line px-4 py-3 first:border-t-0">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-base text-ink">
                {t('settings.llm.default')}
                <KeyTag>defaultProvider · defaultModel</KeyTag>
              </div>
              <div className="mt-0.5 text-xs-plus text-ink-tertiary">
                {models.defaults.llm ? (
                  <span className="font-mono select-text">
                    {models.defaults.llm.providerId}/{models.defaults.llm.modelId}
                  </span>
                ) : (
                  t('settings.llm.defaultAuto')
                )}
              </div>
            </div>
            <div className="w-[17.5rem] shrink-0">
              <SelectField
                ariaLabel={t('settings.llm.default')}
                value={defaultValue}
                onChange={(next) => {
                  const [providerId = '', modelId = ''] = next.split('::');
                  void models.setDefault('llm', providerId && modelId ? { providerId, modelId } : null);
                }}
              >
                <option value="">{t('settings.llm.defaultAuto')}</option>
                {models.providers
                  .filter((provider) => provider.hasKey)
                  .map((provider) => (
                    <optgroup key={provider.id} label={provider.name}>
                      {provider.models
                        .filter((model) => model.capability === 'chat')
                        .map((model) => (
                          <option key={model.id} value={`${provider.id}::${model.id}`}>
                            {model.name}
                          </option>
                        ))}
                    </optgroup>
                  ))}
              </SelectField>
            </div>
          </div>
          <div className="border-t border-line px-4 py-3">
            <div className="flex items-center gap-6">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-base text-ink">
                  {t('settings.llm.thinking')}
                  <KeyTag>defaultThinkingLevel</KeyTag>
                </div>
                <div className="mt-0.5 text-xs-plus text-ink-tertiary">{t('settings.llm.thinkingHint')}</div>
              </div>
              <Segmented<ThinkingLevel>
                label={t('settings.llm.thinking')}
                value={models.thinking as ThinkingLevel}
                onChange={(next) => void models.setThinking(next)}
                options={THINKING_LEVELS.map((level) => ({ value: level.value, label: level.label }))}
              />
            </div>
          </div>
        </Section>

        <Section
          title={t('settings.llm.providersTitle')}
          description={t('settings.llm.providersDescAll', { count: providers.length })}
          action={
            <button type="button" data-testid="add-provider" onClick={() => setAddOpen(true)} className={buttonClass.secondary}>
              <Plus className="size-3.5" />
              {t('settings.llm.addProvider')}
            </button>
          }
        >
          <div className="flex min-h-[34rem]">
            <div className="flex w-[14.75rem] shrink-0 flex-col border-r border-line bg-sidebar">
              <div className="p-2.5">
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-quaternary" />
                  <TextField
                    ariaLabel={t('settings.llm.search')}
                    value={query}
                    onChange={setQuery}
                    placeholder={t('settings.llm.search')}
                    className="pl-8"
                  />
                </div>
              </div>
              <nav className="max-h-[40rem] flex-1 overflow-y-auto px-2 pb-3">
                {[...PROVIDER_GROUPS, { id: OTHER_GROUP.id, label: OTHER_GROUP.label }].map((group) => {
                  const items = visible.filter((provider) => provider.group === group.id);
                  if (items.length === 0) return null;
                  return (
                    <div key={group.id} className="mb-2">
                      <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-ink-tertiary">{group.label}</div>
                      {items.map((provider) => {
                        const status = statusOf(provider.id);
                        const active = provider.id === selected?.id;
                        return (
                          <button
                            key={provider.id}
                            type="button"
                            data-testid="provider-row"
                            onClick={() => setSelectedId(provider.id)}
                            aria-current={active ? 'true' : undefined}
                            className={cn(
                              'flex h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors',
                              active ? 'bg-surface-active' : 'hover:bg-ink/5',
                            )}
                          >
                            <ProviderMark providerId={provider.id} size="sm" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm-plus font-medium text-ink">{provider.name}</span>
                              <span className="block truncate font-mono text-2xs text-ink-tertiary">
                                {provider.counts.chat} chat
                              </span>
                            </span>
                            <span
                              className="size-2 shrink-0 rounded-full"
                              title={status.label}
                              style={{
                                background:
                                  status.tone === 'green'
                                    ? 'var(--success)'
                                    : status.tone === 'amber'
                                      ? 'var(--warning)'
                                      : 'var(--text-quaternary)',
                              }}
                            />
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
                {loading ? <p className="px-3 py-4 text-sm text-ink-tertiary">…</p> : null}
              </nav>
            </div>

            <div className="flex min-w-0 flex-1 flex-col">
              {!selected ? null : (
                <>
                  <div className="flex items-start gap-3 border-b border-line px-5 py-4">
                    <ProviderMark providerId={selected.id} size="lg" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-lg font-bold text-ink">{selected.name}</h4>
                        <StatusBadge {...statusOf(selected.id)} />
                      </div>
                      <p className="mt-1 text-sm leading-relaxed text-ink-tertiary">
                        {selected.description ?? `${selected.apis.join(' · ')}`}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <KeyTag className="text-accent-ink">{selected.id}</KeyTag>
                        {selected.apis.map((api) => (
                          <KeyTag key={api}>{api}</KeyTag>
                        ))}
                        <span className="ml-0.5 text-xs text-ink-tertiary">
                          {t('settings.llm.counts', {
                            chat: selected.counts.chat,
                            image: selected.counts.image,
                            classifier: selected.counts.classifier,
                          })}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4 px-5 py-4">
                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-sm font-medium text-ink-secondary">
                          <KeyRound className="size-3.5 text-ink-tertiary" />
                          {t('models.field.key')}
                        </span>
                        {selectedConfig?.hasKey ? <KeyTag>{t('settings.llm.keyReady')}</KeyTag> : null}
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="password"
                          value={keyDraft}
                          onChange={(event) => setKeyDraft(event.target.value)}
                          placeholder={t('settings.llm.keyPlaceholder', { name: selected.name })}
                          className="h-[30px] min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 font-mono text-sm text-ink outline-none focus:border-accent"
                        />
                        <button
                          type="button"
                          onClick={async () => {
                            await ensureProvider(selected);
                            await models.setKey(selected.id, keyDraft);
                            setKeyDraft('');
                          }}
                          className={buttonClass.primary}
                        >
                          {t('common.save')}
                        </button>
                      </div>
                    </div>

                    <OauthSection providerId={selected.id} />

                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-sm font-medium text-ink-secondary">Base URL</span>
                        <KeyTag>{selected.baseUrl || '—'}</KeyTag>
                      </div>
                    </div>

                    <div>
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-ink-secondary">{t('settings.llm.tableTitle')}</span>
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            data-testid="refresh-models"
                            onClick={async () => {
                              await ensureProvider(selected);
                              const before = chatModels.length;
                              await models.refreshModels(selected.id);
                              setModelNotice(t('settings.llm.fetchRequested', { before }));
                            }}
                            className="text-xs text-accent-ink hover:text-accent"
                          >
                            {t('settings.llm.fetchModels')}
                          </button>
                          <button
                            type="button"
                            data-testid="add-custom-model"
                            onClick={() => setCustomOpen((open) => !open)}
                            className="text-xs text-accent-ink hover:text-accent"
                          >
                            {t('settings.llm.addModel')}
                          </button>
                          <button
                            type="button"
                            data-testid="apply-builtin-pricing"
                            onClick={async () => {
                              await ensureProvider(selected);
                              await models.applyBuiltinPricing(selected.id);
                            }}
                            className="text-xs text-accent-ink hover:text-accent"
                          >
                            {t('settings.pricing.useOfficial')}
                          </button>
                        </div>
                      </div>

                      {customOpen ? (
                        <div className="mb-2 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface-muted px-3 py-2">
                          <label className="flex flex-col gap-1 text-2xs text-ink-tertiary">
                            {t('settings.llm.modelId')}
                            <input
                              data-testid="custom-model-id"
                              value={customModel.id}
                              onChange={(event) =>
                                setCustomModel((current) => ({ ...current, id: event.target.value }))
                              }
                              placeholder="my-finetune-v1"
                              className="h-7 w-44 rounded-md border border-line bg-surface px-2 font-mono text-xs text-ink outline-none focus:border-accent"
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-2xs text-ink-tertiary">
                            {t('settings.llm.col.name')}
                            <input
                              value={customModel.name}
                              onChange={(event) =>
                                setCustomModel((current) => ({ ...current, name: event.target.value }))
                              }
                              placeholder={t('settings.llm.nameOptional')}
                              className="h-7 w-40 rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-accent"
                            />
                          </label>
                          <label className="flex flex-col gap-1 text-2xs text-ink-tertiary">
                            {t('settings.llm.col.context')}
                            <input
                              value={customModel.contextWindow}
                              onChange={(event) =>
                                setCustomModel((current) => ({ ...current, contextWindow: event.target.value }))
                              }
                              placeholder="128000"
                              inputMode="numeric"
                              className="h-7 w-28 rounded-md border border-line bg-surface px-2 font-mono text-xs text-ink outline-none focus:border-accent"
                            />
                          </label>
                          <button
                            type="button"
                            data-testid="custom-model-save"
                            onClick={async () => {
                              setCustomError(null);
                              try {
                                await ensureProvider(selected);
                                await models.addModel(selected.id, {
                                  id: customModel.id.trim(),
                                  name: customModel.name.trim() || undefined,
                                  contextWindow: Number(customModel.contextWindow) || undefined,
                                });
                                setCustomModel({ id: '', name: '', contextWindow: '' });
                                setCustomOpen(false);
                                setModelNotice(t('settings.llm.added'));
                              } catch (error) {
                                setCustomError(error instanceof Error ? error.message : String(error));
                              }
                            }}
                            className="h-7 rounded-md bg-accent px-3 text-xs font-medium text-white"
                          >
                            {t('common.save')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setCustomOpen(false)}
                            className="h-7 rounded-md px-2 text-xs text-ink-tertiary hover:bg-ink/5"
                          >
                            {t('common.cancel')}
                          </button>
                        </div>
                      ) : null}
                      {customError ? <p className="mb-2 text-xs text-danger">{customError}</p> : null}
                      {modelNotice ? (
                        <p className="mb-2 text-2xs text-ink-tertiary">{modelNotice}</p>
                      ) : null}

                      <div
                        data-testid="llm-model-table"
                        className="max-h-[22rem] overflow-y-auto rounded-lg border border-line"
                      >
                        <table className="w-full table-fixed border-collapse text-sm">
                          <thead className="sticky top-0 z-10 bg-surface-muted">
                            <tr className="text-2xs text-ink-tertiary">
                              <th className="px-3 py-1.5 text-left font-medium">{t('settings.llm.col.name')}</th>
                              <th className="w-[4.5rem] px-1 py-1.5 text-right font-medium">{t('settings.llm.col.context')}</th>
                              <th className="w-[4.75rem] px-1 py-1.5 text-right font-medium">{t('settings.pricing.input')}</th>
                              <th className="w-[4.75rem] px-1 py-1.5 text-right font-medium">{t('settings.pricing.output')}</th>
                              <th className="w-[4.75rem] px-1 py-1.5 text-right font-medium">{t('settings.pricing.cacheRead')}</th>
                              <th className="w-[4.75rem] px-1 py-1.5 text-right font-medium">{t('settings.pricing.cacheWrite')}</th>
                              <th className="w-[5.25rem] px-2 py-1.5 text-right font-medium">{t('settings.llm.col.default')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {chatModels.map((model) => {
                              const price = priceOf(model);
                              const dirty = Boolean(priceDraft[model.id]);
                              const isDefault =
                                models.defaults.llm?.providerId === selected.id &&
                                models.defaults.llm?.modelId === model.id;
                              return (
                                <tr key={model.id} className="border-t border-line align-middle">
                                  <td className="px-3 py-1.5">
                                    <div className="truncate text-sm-plus font-medium text-ink">{model.name}</div>
                                    <div className="truncate font-mono text-2xs text-ink-tertiary">{model.id}</div>
                                  </td>
                                  <td className="px-1 py-1.5 text-right font-mono text-xs text-ink-tertiary">
                                    {model.contextWindow ? formatContext(Math.round(model.contextWindow / 1000)) : '—'}
                                  </td>
                                  {(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map((field) => (
                                    <td key={field} className="px-1 py-1.5">
                                      <input
                                        type="number"
                                        step="0.001"
                                        min={0}
                                        aria-label={`${model.id} ${field}`}
                                        value={price[field]}
                                        onChange={(event) =>
                                          setPriceDraft((previous) => ({
                                            ...previous,
                                            [model.id]: { ...price, [field]: Number(event.target.value) },
                                          }))
                                        }
                                        onBlur={() => dirty && void savePrice(selected, model)}
                                        className={cn(
                                          'h-6 w-full rounded border bg-surface px-1 text-right font-mono text-2xs text-ink outline-none focus:border-accent',
                                          dirty ? 'border-accent' : 'border-transparent hover:border-line',
                                        )}
                                      />
                                    </td>
                                  ))}
                                  <td className="px-2 py-1.5 text-right">
                                    {isDefault ? (
                                      <span className="text-xs font-medium text-accent-ink">{t('settings.llm.current')}</span>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={async () => {
                                          await ensureProvider(selected);
                                          await models.setDefault('llm', { providerId: selected.id, modelId: model.id });
                                        }}
                                        className="text-xs text-accent-ink hover:text-accent"
                                      >
                                        {t('settings.llm.setDefault')}
                                      </button>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <p className="mt-1.5 text-xs text-ink-tertiary">{t('settings.pricing.hint')}</p>
                    </div>

                    {models.error ? <p className="text-xs text-danger">{models.error}</p> : null}
                  </div>
                </>
              )}
            </div>
          </div>
        </Section>
      </div>

      {addOpen ? (
        <AddProviderDialog
          apiKinds={Array.from(new Set(providers.flatMap((provider) => provider.apis))).sort()}
          onClose={() => setAddOpen(false)}
          onCreate={(draft: ProviderDraft) => void models.saveProvider(draft)}
        />
      ) : null}
    </>
  );
}
