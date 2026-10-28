import { useEffect, useMemo, useRef, useState } from 'react';
import { Brain, Eye, KeyRound, Loader2, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CatalogModel, ProviderDraft } from '@opc/shared/domain';
import { useModels } from '@/features/models/model/useModels';
import { useCatalog } from '@/features/models/model/useCatalog';
import { PROVIDER_GROUPS, THINKING_LEVELS, formatContext, providerMeta, type ThinkingLevel } from '@/shared/providers/catalog';
import { providerIconUrl } from '@/shared/providers/visuals';
import { ProviderMark } from '@/shared/ui/ProviderMark';
import { cn } from '@/shared/lib/cn';
import { buttonClass, KeyTag, PageHeader, Section, SecretField, Segmented, SelectField, StatusBadge, TextField } from '../kit';
import { AddProviderDialog } from './AddProviderDialog';
import { AuthLoginPanel } from './AuthLoginPanel';
import { ProviderIconDialog, type ProviderIconChoice } from './ProviderIconDialog';

const OTHER_GROUP = { id: 'other', label: '其他' };

/** A blank row at the bottom of the model table; its columns are edited in place. */
const EMPTY_MODEL_DRAFT = {
  id: '',
  name: '',
  contextWindow: '',
  input: '',
  output: '',
  cacheRead: '',
  cacheWrite: '',
};

interface DisplayProvider {
  id: string;
  name: string;
  group: string;
  baseUrl: string;
  apis: string[];
  /** Reused icon from the provider catalogue (custom providers only). */
  icon?: string;
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
  const [savedKey, setSavedKey] = useState('');
  const [baseUrlDraft, setBaseUrlDraft] = useState('');
  const [iconDraft, setIconDraft] = useState('');
  const [iconDialogOpen, setIconDialogOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [priceDraft, setPriceDraft] = useState<Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>>({});
  const [customOpen, setCustomOpen] = useState(false);
  const [customModel, setCustomModel] = useState(EMPTY_MODEL_DRAFT);
  const customRowRef = useRef<HTMLTableRowElement>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const [modelNotice, setModelNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  const configured = useMemo(
    () => new Map(models.providers.map((provider) => [provider.id, provider])),
    [models.providers],
  );

  const providers: DisplayProvider[] = useMemo(() => {
    const fromCatalog: DisplayProvider[] = catalog.map((entry) => {
      const meta = providerMeta(entry.id);
      // Stored models the pi catalogue does not know about (typically ids returned by
      // "拉取模型") still belong in the table, otherwise a refresh looks like a no-op.
      const stored = configured.get(entry.id);
      const catalogIds = new Set(entry.models.map((model) => model.id));
      const extra = (stored?.models ?? [])
        .filter((model) => !catalogIds.has(model.id))
        .map<CatalogModel>((model) => ({
          id: model.id,
          name: model.name || model.id,
          type: model.capability,
          api: model.api ?? entry.apis[0] ?? 'openai-completions',
          contextWindow: model.contextWindow,
          vision: model.vision,
          reasoning: model.reasoning,
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
        }));
      return {
        id: entry.id,
        name: meta?.name ?? entry.id,
        group: meta?.group ?? OTHER_GROUP.id,
        baseUrl: entry.baseUrl,
        apis: entry.apis,
        icon: stored?.icon,
        counts: {
          chat: entry.counts.chat + extra.filter((model) => model.type === 'chat').length,
          image: entry.counts.image + extra.filter((model) => model.type === 'image').length,
          classifier: entry.counts.classifier + extra.filter((model) => model.type === 'classifier').length,
        },
        models: [...entry.models, ...extra],
        description: meta?.description,
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
        icon: provider.icon,
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
          vision: model.vision,
          reasoning: model.reasoning,
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
  }, [catalog, configured, models.providers]);

  // The icon picker offers every icon the catalogue actually ships, once each
  // (several provider ids share one brand file), labelled with a provider name.
  const iconChoices = useMemo<ProviderIconChoice[]>(() => {
    const seen = new Set<string>();
    const choices: ProviderIconChoice[] = [];
    for (const provider of providers) {
      const url = providerIconUrl(provider.id);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      choices.push({ id: provider.id, name: provider.name });
    }
    return choices;
  }, [providers]);

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
        vision: model.vision,
        reasoning: model.reasoning,
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

  // Load the stored key lazily per selection: the field is always shown masked,
  // and the eye reveals it without a round-trip.
  const activeProviderId = selected?.id;
  const selectedBaseUrl = selected?.baseUrl;
  useEffect(() => {
    let alive = true;
    setKeyDraft('');
    setSavedKey('');
    if (activeProviderId) {
      void window.opc?.models
        .getKey(activeProviderId)
        .then((key) => {
          if (alive) {
            setKeyDraft(key);
            setSavedKey(key);
          }
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [activeProviderId]);

  useEffect(() => setBaseUrlDraft(selectedBaseUrl ?? ''), [activeProviderId, selectedBaseUrl]);

  const selectedIcon = selectedConfig?.icon;
  useEffect(() => setIconDraft(selectedIcon ?? ''), [activeProviderId, selectedIcon]);

  // A half-filled draft belongs to the provider it was started on.
  useEffect(() => {
    setCustomOpen(false);
    setCustomModel(EMPTY_MODEL_DRAFT);
    setCustomError(null);
    setPriceDraft({});
    setSaveError(null);
    setSavedNotice(false);
    setIconDialogOpen(false);
  }, [activeProviderId]);

  // The draft row lives at the bottom of a scrollable table: bring it into view,
  // otherwise "+ 自定义模型" looks like it did nothing on long model lists.
  useEffect(() => {
    if (!customOpen) return;
    customRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [customOpen]);

  const priceOf = (model: CatalogModel) => {
    const local = pricedModels.get(model.id);
    return priceDraft[model.id] ?? {
      input: local?.inputUsdPerM ?? model.price?.input ?? 0,
      output: local?.outputUsdPerM ?? model.price?.output ?? 0,
      cacheRead: local?.cacheReadUsdPerM ?? model.price?.cacheRead ?? 0,
      cacheWrite: local?.cacheWriteUsdPerM ?? model.price?.cacheWrite ?? 0,
    };
  };

  // Everything in the detail panel is a draft until the single Save button runs:
  // key, base URL, price cells and the pending custom-model row.
  const customRowFilled = Object.values(customModel).some((value) => value.trim() !== '');
  const keyDirty = Boolean(selected) && keyDraft !== savedKey;
  const baseUrlDirty =
    Boolean(selectedConfig?.isCustom) && baseUrlDraft.trim() !== (selectedBaseUrl ?? '').trim();
  const iconDirty =
    Boolean(selectedConfig?.isCustom) && iconDraft !== (selectedConfig?.icon ?? '');
  const pricesDirty = Object.keys(priceDraft).length > 0;
  const dirty = keyDirty || baseUrlDirty || iconDirty || pricesDirty || (customOpen && customRowFilled);

  const cancelCustomModel = () => {
    setCustomOpen(false);
    setCustomModel(EMPTY_MODEL_DRAFT);
    setCustomError(null);
  };

  const discardChanges = () => {
    setKeyDraft(savedKey);
    setBaseUrlDraft(selectedBaseUrl ?? '');
    setIconDraft(selectedConfig?.icon ?? '');
    setIconDialogOpen(false);
    setPriceDraft({});
    setCustomOpen(false);
    setCustomModel(EMPTY_MODEL_DRAFT);
    setCustomError(null);
    setSaveError(null);
    setSavedNotice(false);
  };

  const saveAll = async () => {
    const bridge = window.opc?.models;
    if (!selected || !bridge) return;
    if (customOpen && customRowFilled && !customModel.id.trim()) {
      setCustomError(t('settings.llm.modelIdRequired'));
      return;
    }
    setSaveError(null);
    setCustomError(null);
    setSaving(true);
    try {
      await ensureProvider(selected);
      if (keyDirty) {
        await bridge.setKey(selected.id, keyDraft);
        setSavedKey(keyDraft);
      }
      if (baseUrlDirty || iconDirty) {
        await bridge.saveProvider({
          id: selected.id,
          name: selected.name,
          baseUrl: baseUrlDraft.trim(),
          api: selectedConfig?.api ?? selected.apis[0] ?? 'openai-completions',
          isCustom: true,
          icon: iconDraft,
        });
      }
      for (const [modelId, price] of Object.entries(priceDraft)) {
        await bridge.setModelPricing(selected.id, modelId, price);
      }
      setPriceDraft({});
      if (customOpen && customModel.id.trim()) {
        const contextWindow = Number(customModel.contextWindow);
        await bridge.addModel(selected.id, {
          id: customModel.id.trim(),
          name: customModel.name.trim() || undefined,
          contextWindow: contextWindow > 0 ? contextWindow : undefined,
          inputUsdPerM: Math.max(0, Number(customModel.input) || 0),
          outputUsdPerM: Math.max(0, Number(customModel.output) || 0),
          cacheReadUsdPerM: Math.max(0, Number(customModel.cacheRead) || 0),
          cacheWriteUsdPerM: Math.max(0, Number(customModel.cacheWrite) || 0),
        });
        setCustomModel(EMPTY_MODEL_DRAFT);
        setCustomOpen(false);
      }
      await models.reload();
      setSavedNotice(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
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
                            <ProviderMark
                              providerId={provider.id}
                              icon={provider.icon}
                              label={provider.name}
                              size="sm"
                            />
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
                    {selectedConfig?.isCustom ? (
                      <button
                        type="button"
                        data-testid="provider-icon-picker"
                        onClick={() => setIconDialogOpen(true)}
                        aria-label={t('settings.llm.iconChoose')}
                        title={t('settings.llm.iconChoose')}
                        className="group relative shrink-0 self-start rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        <ProviderMark
                          providerId={selected.id}
                          icon={iconDraft || selected.icon}
                          label={selected.name}
                          size="lg"
                        />
                        <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                          <Pencil className="size-4" />
                        </span>
                      </button>
                    ) : (
                      <ProviderMark providerId={selected.id} size="lg" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-lg font-bold text-ink">{selected.name}</h4>
                        <StatusBadge {...statusOf(selected.id)} />
                      </div>
                      <p className="mt-1 text-sm leading-relaxed text-ink-tertiary">
                        {selected.description ?? `${selected.apis.join(' · ')}`}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {/* Fixed slot: mounting/unmounting or swapping this text must not
                            resize the header, which re-wraps the description beside it. */}
                        <span
                          aria-live="polite"
                          className={cn(
                            'w-12 shrink-0 text-right text-2xs',
                            dirty ? 'text-ink-tertiary' : 'text-success',
                          )}
                        >
                          {dirty
                            ? t('settings.llm.unsaved')
                            : savedNotice
                              ? t('settings.llm.saved')
                              : null}
                        </span>
                        {selectedConfig?.isCustom ? (
                          <button
                            type="button"
                            data-testid="remove-provider"
                            disabled={saving}
                            onClick={async () => {
                              if (!window.confirm(t('settings.llm.removeConfirm', { name: selected.name }))) return;
                              await models.removeProvider(selected.id);
                              setSelectedId('');
                            }}
                            aria-label={t('settings.llm.removeProvider')}
                            title={t('settings.llm.removeProvider')}
                            className="flex size-7 items-center justify-center rounded-md text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={!dirty || saving}
                          onClick={discardChanges}
                          className={buttonClass.secondary}
                        >
                          {t('settings.llm.discard')}
                        </button>
                        <button
                          type="button"
                          data-testid="save-provider"
                          disabled={!dirty || saving}
                          aria-busy={saving}
                          onClick={() => void saveAll()}
                          className={buttonClass.primary}
                        >
                          {/* The spinner always occupies its box: swapping the label to
                              "加载中…" resized the button and shook the whole header. */}
                          <Loader2 className={cn('size-3.5 animate-spin', !saving && 'invisible')} />
                          {t('common.save')}
                        </button>
                      </div>
                      {saveError ? <p className="max-w-[16rem] text-right text-2xs text-danger">{saveError}</p> : null}
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
                      <SecretField
                        ariaLabel={t('models.field.key')}
                        value={keyDraft}
                        onChange={(next) => {
                          setKeyDraft(next);
                          setSavedNotice(false);
                        }}
                        placeholder={t('settings.llm.keyPlaceholder', { name: selected.name })}
                      />
                    </div>

                    <OauthSection providerId={selected.id} />

                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="text-sm font-medium text-ink-secondary">Base URL</span>
                        {!selectedConfig?.isCustom ? <KeyTag>{selected.baseUrl || '—'}</KeyTag> : null}
                      </div>
                      {selectedConfig?.isCustom ? (
                        <input
                          data-testid="provider-base-url"
                          value={baseUrlDraft}
                          onChange={(event) => {
                            setBaseUrlDraft(event.target.value);
                            setSavedNotice(false);
                          }}
                          placeholder="https://api.example.com/v1"
                          spellCheck={false}
                          className="h-[30px] w-full rounded-md border border-line bg-surface px-2.5 font-mono text-sm text-ink outline-none focus:border-accent"
                        />
                      ) : null}
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
                              const result = await models.refreshModels(selected.id);
                              setModelNotice(
                                !result
                                  ? null
                                  : result.ok
                                    ? `${result.message}${result.added.length > 0 ? t('settings.llm.fetchAdded', {
                                      ids: result.added.slice(0, 5).join('、'),
                                      more:
                                        result.added.length > 5
                                          ? `${t('settings.llm.more')} ${result.added.length - 5}`
                                          : '',
                                    }) : t('settings.llm.fetchNothingNew')}`
                                    : `${result.message}`,
                              );
                            }}
                            className="text-xs text-accent-ink hover:text-accent"
                          >
                            {t('settings.llm.fetchModels')}
                          </button>
                          <button
                            type="button"
                            data-testid="add-custom-model"
                            onClick={() => {
                              setCustomError(null);
                              setCustomOpen(true);
                            }}
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
                              // Official prices replace whatever was staged for this provider.
                              setPriceDraft({});
                            }}
                            className="text-xs text-accent-ink hover:text-accent"
                          >
                            {t('settings.pricing.useOfficial')}
                          </button>
                        </div>
                      </div>

                      {customError ? <p className="mb-2 text-xs text-danger">{customError}</p> : null}
                      {modelNotice ? (
                        <p className="mb-2 text-2xs text-ink-tertiary">{modelNotice}</p>
                      ) : null}

                      <div className="overflow-hidden rounded-lg border border-line">
                        {/* Header and body are separate tables so the scrollbar starts
                            below the column titles instead of running past them. Both
                            reserve the same gutter, which keeps the columns aligned. */}
                        <div className="overflow-y-auto border-b border-line bg-surface-muted [scrollbar-gutter:stable]">
                          <table className="w-full table-fixed border-collapse text-sm">
                            <colgroup>
                              <col />
                              <col style={{ width: '4.5rem' }} />
                              <col style={{ width: '4.25rem' }} />
                              <col style={{ width: '4.5rem' }} />
                              <col style={{ width: '4.5rem' }} />
                              <col style={{ width: '4.5rem' }} />
                              <col style={{ width: '4.5rem' }} />
                            </colgroup>
                            <thead>
                              <tr className="text-2xs text-ink-tertiary">
                                <th className="px-3 py-1.5 text-left font-medium">{t('settings.llm.col.name')}</th>
                                <th className="px-1 py-1.5 text-center font-medium">{t('settings.llm.col.capability')}</th>
                                <th className="px-1 py-1.5 text-right font-medium">{t('settings.llm.col.context')}</th>
                                <th className="px-1 py-1.5 text-right font-medium">{t('settings.pricing.input')}</th>
                                <th className="px-1 py-1.5 text-right font-medium">{t('settings.pricing.output')}</th>
                                <th className="px-1 py-1.5 text-right font-medium">{t('settings.pricing.cacheRead')}</th>
                                <th className="px-1 py-1.5 text-right font-medium">{t('settings.pricing.cacheWrite')}</th>
                              </tr>
                            </thead>
                          </table>
                        </div>
                        <div
                          data-testid="llm-model-table"
                          className="max-h-[22rem] overflow-y-auto [scrollbar-gutter:stable]"
                        >
                          <table className="w-full table-fixed border-collapse text-sm">
                            <colgroup>
                              <col />
                              <col style={{ width: '4.5rem' }} />
                              <col style={{ width: '4.25rem' }} />
                              <col style={{ width: '4.5rem' }} />
                              <col style={{ width: '4.5rem' }} />
                              <col style={{ width: '4.5rem' }} />
                              <col style={{ width: '4.5rem' }} />
                            </colgroup>
                            <tbody className="[&>tr:first-child]:border-t-0">
                            {chatModels.map((model) => {
                              const price = priceOf(model);
                              const priceDirty = Boolean(priceDraft[model.id]);
                              return (
                                <tr key={model.id} className="border-t border-line align-middle">
                                  <td className="px-3 py-1.5">
                                    <div className="truncate text-sm-plus font-medium text-ink">{model.name}</div>
                                    <div className="truncate font-mono text-2xs text-ink-tertiary">{model.id}</div>
                                  </td>
                                  <td className="px-1 py-1.5">
                                    {model.reasoning || model.vision ? (
                                      <div className="flex items-center justify-center gap-1.5">
                                        {model.reasoning ? (
                                          <span title={t('settings.llm.reasoning')}>
                                            <Brain
                                              className="size-3.5 text-[#7A4CE0]"
                                              aria-label={t('settings.llm.reasoning')}
                                            />
                                          </span>
                                        ) : null}
                                        {model.vision ? (
                                          <span title={t('settings.llm.vision')}>
                                            <Eye
                                              className="size-3.5 text-success"
                                              aria-label={t('settings.llm.vision')}
                                            />
                                          </span>
                                        ) : null}
                                      </div>
                                    ) : (
                                      <div className="text-center text-xs text-ink-quaternary">—</div>
                                    )}
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
                                        className={cn(
                                          'h-6 w-full rounded border bg-surface px-1 text-right font-mono text-2xs text-ink outline-none focus:border-accent',
                                          priceDirty ? 'border-accent' : 'border-transparent hover:border-line',
                                        )}
                                      />
                                    </td>
                                  ))}
                                </tr>
                              );
                            })}
                            {customOpen ? (
                              <tr
                                ref={customRowRef}
                                data-testid="custom-model-row"
                                className="border-t border-accent/40 bg-accent/5 align-middle"
                              >
                                <td className="px-3 py-1.5">
                                  <div className="flex items-center gap-1.5">
                                    <div className="min-w-0 flex-1">
                                      <input
                                        value={customModel.name}
                                        onChange={(event) =>
                                          setCustomModel((current) => ({ ...current, name: event.target.value }))
                                        }
                                        onKeyDown={(event) => {
                                          if (event.key === 'Escape') cancelCustomModel();
                                        }}
                                        aria-label={t('settings.llm.col.name')}
                                        placeholder={t('settings.llm.nameOptional')}
                                        className="h-6 w-full rounded border border-line bg-surface px-1 text-sm-plus font-medium text-ink outline-none focus:border-accent"
                                      />
                                      <input
                                        data-testid="custom-model-id"
                                        autoFocus
                                        value={customModel.id}
                                        onChange={(event) =>
                                          setCustomModel((current) => ({ ...current, id: event.target.value }))
                                        }
                                        onKeyDown={(event) => {
                                          if (event.key === 'Escape') cancelCustomModel();
                                        }}
                                        aria-label={t('settings.llm.modelId')}
                                        placeholder="model-id"
                                        spellCheck={false}
                                        className="mt-1 h-6 w-full rounded border border-line bg-surface px-1 font-mono text-2xs text-ink outline-none focus:border-accent"
                                      />
                                    </div>
                                    <div className="flex shrink-0 flex-col gap-1">
                                      <button
                                        type="button"
                                        onClick={cancelCustomModel}
                                        aria-label={t('common.cancel')}
                                        title={t('common.cancel')}
                                        className="flex size-5 items-center justify-center rounded text-ink-tertiary transition-colors hover:bg-ink/5"
                                      >
                                        <X className="size-3" />
                                      </button>
                                    </div>
                                  </div>
                                </td>
                                <td className="px-1 py-1.5" />
                                <td className="px-1 py-1.5">
                                  <input
                                    value={customModel.contextWindow}
                                    onChange={(event) =>
                                      setCustomModel((current) => ({
                                        ...current,
                                        contextWindow: event.target.value,
                                      }))
                                    }
                                    onKeyDown={(event) => {
                                      if (event.key === 'Escape') cancelCustomModel();
                                    }}
                                    aria-label={t('settings.llm.col.context')}
                                    placeholder="128000"
                                    inputMode="numeric"
                                    className="h-6 w-full rounded border border-line bg-surface px-1 text-right font-mono text-2xs text-ink outline-none focus:border-accent"
                                  />
                                </td>
                                {(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map((field) => (
                                  <td key={field} className="px-1 py-1.5">
                                    <input
                                      type="number"
                                      step="0.001"
                                      min={0}
                                      value={customModel[field]}
                                      onChange={(event) =>
                                        setCustomModel((current) => ({ ...current, [field]: event.target.value }))
                                      }
                                      aria-label={`${t('settings.llm.modelId')} ${field}`}
                                      placeholder="0"
                                      className="h-6 w-full rounded border border-line bg-surface px-1 text-right font-mono text-2xs text-ink outline-none focus:border-accent"
                                    />
                                  </td>
                                ))}
                              </tr>
                            ) : null}
                          </tbody>
                        </table>
                      </div>
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

      {iconDialogOpen && selected && selectedConfig?.isCustom ? (
        <ProviderIconDialog
          providerId={selected.id}
          name={selected.name}
          choices={iconChoices}
          value={iconDraft}
          onSelect={(icon) => {
            setIconDraft(icon);
            setSavedNotice(false);
          }}
          onClose={() => setIconDialogOpen(false)}
        />
      ) : null}

      {addOpen ? (
        <AddProviderDialog
          apiKinds={Array.from(new Set(providers.flatMap((provider) => provider.apis))).sort()}
          onClose={() => setAddOpen(false)}
          onCreate={(draft: ProviderDraft) => {
            void models.saveProvider(draft);
            setSelectedId(draft.id);
          }}
        />
      ) : null}
    </>
  );
}
