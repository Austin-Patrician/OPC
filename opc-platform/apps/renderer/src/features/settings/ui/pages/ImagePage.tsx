import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, Link2, Loader2, Plus, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useModels } from '@/features/models/model/useModels';
import { useCatalog } from '@/features/models/model/useCatalog';
import { providerMeta } from '@/shared/providers/catalog';
import { ProviderMark } from '@/shared/ui/ProviderMark';
import { vendorProviderId } from '@/shared/providers/visuals';
import { cn } from '@/shared/lib/cn';
import {
  buttonClass,
  KeyTag,
  PageHeader,
  SecretField,
  Section,
  SelectField,
  StatusBadge,
  TextField,
  Toggle,
} from '../kit';
import { AddProviderDialog } from './AddProviderDialog';
import {
  buildImageProviders,
  mergeImageModels,
  toImageModelOption,
  type ImageModelView,
  type ImageProviderView,
} from './imageProviders';

/** Protocols an image model can speak. */
const IMAGE_PROTOCOLS = ['openai-images', 'openrouter-images', 'google-images'] as const;

/** A blank row at the bottom of the model table; its columns are edited in place. */
const EMPTY_IMAGE_MODEL_DRAFT = {
  id: '',
  name: '',
  api: IMAGE_PROTOCOLS[0] as string,
  input: '',
  output: '',
  cacheRead: '',
  cacheWrite: '',
};

/** The four price columns, in table order. Same set the LLM table edits. */
const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
type PriceField = (typeof PRICE_FIELDS)[number];
type PriceDraft = Record<PriceField, number>;

/**
 * Settings → 模型 → Image, same shape as LLM: providers on the left; on the right
 * the key, Base URL and a model table whose price cells are edited in place and
 * whose last row adds a custom model. Everything is a draft until Save runs, so
 * one click writes the provider, the credential, the prices and the new row.
 *
 * Built-in models ship with the app, so the first save also materialises them —
 * there is no separate "import N models" step.
 */
export function ImagePage() {
  const { t } = useTranslation();
  const models = useModels();
  const { catalog, loading } = useCatalog();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>('');
  const [addOpen, setAddOpen] = useState(false);
  /** The provider just created here: listed even before it owns an image model. */
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);

  // Drafts for the selected provider; cleared when the selection changes.
  const [keyDraft, setKeyDraft] = useState('');
  const [savedKey, setSavedKey] = useState('');
  const [baseUrlDraft, setBaseUrlDraft] = useState('');
  const [priceDraft, setPriceDraft] = useState<Record<string, PriceDraft>>({});
  const [customOpen, setCustomOpen] = useState(false);
  const [customModel, setCustomModel] = useState(EMPTY_IMAGE_MODEL_DRAFT);
  const customRowRef = useRef<HTMLTableRowElement>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  // Starts from pi's catalog, so providers that own built-in image models show
  // up before they have been configured (OpenRouter is the main one).
  const providersWithImages = useMemo(
    () =>
      buildImageProviders(catalog, models.providers, (id) => providerMeta(id)?.name, {
        includeProviderId: pendingProviderId ?? undefined,
      }),
    [catalog, models.providers, pendingProviderId],
  );

  const selected = providersWithImages.find((entry) => entry.id === selectedId) ?? providersWithImages[0];
  const selectedConfig = selected?.config;
  const activeProviderId = selected?.id;
  const selectedBaseUrl = selected?.baseUrl;
  const storedModels = useMemo(() => selectedConfig?.models ?? [], [selectedConfig]);
  const storedById = useMemo(() => new Map(storedModels.map((model) => [model.id, model])), [storedModels]);

  /**
   * What "默认生图模型" may point at: a provider that actually has a credential,
   * and a row that is switched on. Listing the whole catalog here let the boss
   * pick a model that cannot run (no key, or never enabled).
   */
  const selectableProviders = useMemo(
    () =>
      providersWithImages
        .filter((entry) => entry.hasKey)
        .map((entry) => ({ ...entry, images: entry.images.filter((model) => model.enabled) }))
        .filter((entry) => entry.images.length > 0),
    [providersWithImages],
  );

  const needle = query.trim().toLowerCase();
  const visibleProviders = providersWithImages.filter(
    (entry) =>
      !needle ||
      entry.id.includes(needle) ||
      entry.name.toLowerCase().includes(needle) ||
      entry.images.some((model) => model.id.toLowerCase().includes(needle)),
  );

  // Load the stored key lazily per selection; the field stays masked until the
  // eye is used, and an untouched save writes the same credential back.
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

  // A half-filled draft row belongs to the provider it was started on.
  useEffect(() => {
    setCustomOpen(false);
    setCustomModel(EMPTY_IMAGE_MODEL_DRAFT);
    setCustomError(null);
    setPriceDraft({});
    setSaveError(null);
    setSavedNotice(false);
  }, [activeProviderId]);

  // The draft row lives at the bottom of a scrollable table: bring it into view.
  useEffect(() => {
    if (!customOpen) return;
    customRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [customOpen]);

  /** Creates the provider row so a base URL / key / model has somewhere to live. */
  const ensureProvider = async (entry: ImageProviderView) => {
    if (entry.config) return;
    await models.saveProvider({
      id: entry.id,
      name: entry.name,
      baseUrl: entry.baseUrl,
      api: entry.api,
      isCustom: false,
    });
  };

  /** Turns every built-in row of this provider on in one write. */
  const enableAll = async (entry: ImageProviderView) => {
    if (!entry.hasKey) return;
    setSaveError(null);
    setSaving(true);
    try {
      await ensureProvider(entry);
      const builtinIds = new Set(entry.catalogImages.map((model) => model.id));
      const merged = mergeImageModels(entry.config?.models ?? [], entry.catalogImages);
      await models.setModels(
        entry.id,
        merged.map((model) =>
          builtinIds.has(model.id) ? { ...model, capability: 'image' as const, imageEnabled: true } : model,
        ),
      );
      await models.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  /** Only stored rows reach this (the dropdown lists nothing else). */
  const setDefaultImage = (entry: ImageProviderView, model: ImageModelView) =>
    models.setDefault('image', { providerId: entry.id, modelId: model.id });

  /**
   * A row's switch: on = the model is part of the provider's list (a real row in
   * SQLite), off = removed. Turning off the current default clears it, so the
   * agent never resolves to a model that is no longer enabled.
   */
  const setModelEnabled = async (entry: ImageProviderView, model: ImageModelView, enabled: boolean) => {
    if (!entry.hasKey) return;
    setSaveError(null);
    setSaving(true);
    try {
      await ensureProvider(entry);
      const current = entry.config?.models ?? [];
      // A row outlives the switch: the same id may be a chat model for this
      // provider, so disabling it for images must not delete it.
      const base = model.stored
        ? current
        : [
            ...current,
            toImageModelOption(
              model.catalog ?? {
                id: model.id,
                name: model.name,
                type: 'image',
                api: model.api ?? IMAGE_PROTOCOLS[0],
              },
              enabled,
            ),
          ];
      const next = base.map((candidate) =>
        candidate.id === model.id
          ? { ...candidate, capability: 'image' as const, imageEnabled: enabled }
          : candidate,
      );
      await models.setModels(entry.id, next);

      const isDefault =
        models.defaults.image?.providerId === entry.id && models.defaults.image.modelId === model.id;
      if (!enabled && isDefault) await models.setDefault('image', null);
      await models.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const priceOf = (model: ImageModelView): PriceDraft =>
    priceDraft[model.id] ?? {
      input: storedById.get(model.id)?.inputUsdPerM ?? model.catalog?.price?.input ?? 0,
      output: storedById.get(model.id)?.outputUsdPerM ?? model.catalog?.price?.output ?? 0,
      cacheRead: storedById.get(model.id)?.cacheReadUsdPerM ?? model.catalog?.price?.cacheRead ?? 0,
      cacheWrite: storedById.get(model.id)?.cacheWriteUsdPerM ?? model.catalog?.price?.cacheWrite ?? 0,
    };

  const customRowFilled = Object.values(customModel).some((value) => String(value).trim() !== '');
  const keyDirty = Boolean(selected) && keyDraft !== savedKey;
  const baseUrlDirty = baseUrlDraft.trim() !== (selectedBaseUrl ?? '').trim();
  const pricesDirty = Object.keys(priceDraft).length > 0;
  const dirty = keyDirty || baseUrlDirty || pricesDirty || (customOpen && customRowFilled);

  const cancelCustomModel = () => {
    setCustomOpen(false);
    setCustomModel(EMPTY_IMAGE_MODEL_DRAFT);
    setCustomError(null);
  };

  const discardChanges = () => {
    setKeyDraft(savedKey);
    setBaseUrlDraft(selectedBaseUrl ?? '');
    setPriceDraft({});
    setCustomOpen(false);
    setCustomModel(EMPTY_IMAGE_MODEL_DRAFT);
    setCustomError(null);
    setSaveError(null);
    setSavedNotice(false);
  };

  /**
   * "Use official prices": copies pi's costs onto the rows that are switched on.
   * Staged cell edits are dropped afterwards, because that is what the official
   * prices just replaced.
   */
  const applyOfficialPrices = async () => {
    if (!selected) return;
    setSaveError(null);
    setSaving(true);
    try {
      await ensureProvider(selected);
      const result = await window.opc!.models.applyBuiltinPricing(selected.id);
      setPriceDraft({});
      await models.reload();
      if (result.unmatched.length > 0) {
        setSaveError(t('settings.image.unmatchedPricing', { count: result.unmatched.length }));
      } else {
        setSavedNotice(true);
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  /**
   * One save writes everything in the panel: key, Base URL, price cells and the
   * pending custom row. On the first save the provider's built-in image models
   * are materialised too (prices land on those same rows).
   */
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
      if (baseUrlDirty) {
        await bridge.saveProvider({
          id: selected.id,
          name: selected.name,
          baseUrl: baseUrlDraft.trim() || selected.baseUrl,
          api: selectedConfig?.api ?? selected.api,
          isCustom: selectedConfig?.isCustom ?? false,
          icon: selectedConfig?.icon,
        });
      }

      // Saving never flips a switch: the table's own switches decide which rows
      // exist, so a row the boss turned off is not resurrected by a save.
      let nextModels = storedModels;
      for (const [modelId, price] of Object.entries(priceDraft)) {
        if (!nextModels.some((model) => model.id === modelId)) continue;
        nextModels = nextModels.map((model) =>
          model.id === modelId
            ? {
                ...model,
                inputUsdPerM: Math.max(0, price.input),
                outputUsdPerM: Math.max(0, price.output),
                cacheReadUsdPerM: Math.max(0, price.cacheRead),
                cacheWriteUsdPerM: Math.max(0, price.cacheWrite),
              }
            : model,
        );
      }
      if (nextModels !== storedModels) await bridge.setModels(selected.id, nextModels);

      if (customOpen && customModel.id.trim()) {
        await bridge.addModel(selected.id, {
          id: customModel.id.trim(),
          name: customModel.name.trim() || undefined,
          api: customModel.api,
          capability: 'image',
          inputUsdPerM: Math.max(0, Number(customModel.input) || 0),
          outputUsdPerM: Math.max(0, Number(customModel.output) || 0),
          cacheReadUsdPerM: Math.max(0, Number(customModel.cacheRead) || 0),
          cacheWriteUsdPerM: Math.max(0, Number(customModel.cacheWrite) || 0),
        });
        setCustomModel(EMPTY_IMAGE_MODEL_DRAFT);
        setCustomOpen(false);
      }

      setPriceDraft({});
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
        crumbs={[t('settings.group.models'), 'Image']}
        title={t('settings.image.title')}
        description={t('settings.image.descProvider')}
      />

      {/* One global default: the agent's generate_image tool resolves through it. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-ink">
            {t('settings.image.defaultTitle')}
            <KeyTag>default.image</KeyTag>
          </div>
          <div className="mt-0.5 text-xs-plus text-ink-tertiary">
            {models.defaults.image ? (
              <span className="font-mono select-text">
                {models.defaults.image.providerId}/{models.defaults.image.modelId}
              </span>
            ) : (
              t('settings.image.noDefault')
            )}
          </div>
        </div>
        <div className="w-[22rem] max-w-full shrink-0">
          <SelectField
            ariaLabel={t('settings.image.defaultTitle')}
            value={
              models.defaults.image
                ? `${models.defaults.image.providerId}::${models.defaults.image.modelId}`
                : ''
            }
            onChange={(next) => {
              if (!next) {
                void models.setDefault('image', null);
                return;
              }
              const [providerId = '', modelId = ''] = next.split('::');
              const entry = selectableProviders.find((candidate) => candidate.id === providerId);
              const image = entry?.images.find((candidate) => candidate.id === modelId);
              if (entry && image) void setDefaultImage(entry, image);
            }}
          >
            <option value="">{t('settings.image.noDefault')}</option>
            {selectableProviders.map((entry) => (
              <optgroup key={entry.id} label={entry.name}>
                {entry.images.map((model) => (
                  <option key={model.id} value={`${entry.id}::${model.id}`}>
                    {model.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </SelectField>
          {selectableProviders.length === 0 ? (
            <p className="mt-1 text-2xs text-ink-quaternary">{t('settings.image.noneEnabled')}</p>
          ) : null}
        </div>
      </div>

      <Section
        title={t('settings.image.providersTitle')}
        description={t('settings.image.providersDesc')}
        action={
          <button
            type="button"
            data-testid="add-provider"
            onClick={() => setAddOpen(true)}
            className={buttonClass.secondary}
          >
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
                  ariaLabel={t('common.search')}
                  value={query}
                  onChange={setQuery}
                  placeholder={t('settings.image.search')}
                  className="pl-8"
                />
              </div>
            </div>
            <nav className="flex-1 overflow-y-auto px-2 pb-3">
              {visibleProviders.map((entry) => {
                const active = entry.id === selected?.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    data-testid="provider-row"
                    onClick={() => setSelectedId(entry.id)}
                    className={cn(
                      'flex h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors',
                      active ? 'bg-surface-active' : 'hover:bg-ink/5',
                    )}
                  >
                    <ProviderMark providerId={entry.id} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm-plus font-medium text-ink">{entry.name}</span>
                      <span className="block truncate font-mono text-2xs text-ink-tertiary">
                        {t('settings.image.enabledOf', {
                          enabled: entry.images.filter((model) => model.enabled).length,
                          total: entry.images.length,
                        })}
                      </span>
                    </span>
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: entry.hasKey ? 'var(--success)' : 'var(--text-quaternary)' }}
                    />
                  </button>
                );
              })}
              {visibleProviders.length === 0 && !loading ? (
                <p className="px-3 py-6 text-center text-sm text-ink-tertiary">
                  {t('settings.image.emptyProvider')}
                </p>
              ) : null}
              {loading ? <p className="px-3 py-4 text-sm text-ink-tertiary">…</p> : null}
            </nav>
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            {!selected ? (
              <p className="p-6 text-sm text-ink-tertiary">{t('settings.image.emptyProvider')}</p>
            ) : (
              <>
                <div className="flex items-start gap-3 border-b border-line px-5 py-4">
                  <ProviderMark providerId={selected.id} size="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-lg font-bold text-ink">{selected.name}</h4>
                      <StatusBadge
                        tone={selected.config ? (selected.hasKey ? 'green' : 'amber') : 'gray'}
                        label={
                          selected.config
                            ? selected.hasKey
                              ? t('settings.llm.keyReady')
                              : t('settings.llm.keyMissing')
                            : t('settings.llm.unconfigured')
                        }
                      />
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-ink-tertiary">
                      {selected.images.length} {t('settings.image.models')}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {/* Fixed slot: the header must not resize when the label swaps. */}
                      <span
                        aria-live="polite"
                        className={cn(
                          'w-12 shrink-0 text-right text-2xs',
                          dirty ? 'text-ink-tertiary' : 'text-success',
                        )}
                      >
                        {dirty ? t('settings.llm.unsaved') : savedNotice ? t('settings.llm.saved') : null}
                      </span>
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
                        <Loader2 className={cn('size-3.5 animate-spin', !saving && 'invisible')} />
                        {t('common.save')}
                      </button>
                    </div>
                    {saveError ? (
                      <p className="max-w-[16rem] text-right text-2xs text-danger">{saveError}</p>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-4 px-5 py-4">
                  {/* Base URL first, then the key: pick the endpoint, then the credential
                      for it. Nothing sits above the input except its own label, so the
                      stored value cannot be mistaken for a second field. */}
                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-ink-secondary">
                      <Link2 className="size-3.5 text-ink-tertiary" />
                      {t('models.field.baseUrl')}
                    </div>
                    <TextField
                      mono
                      ariaLabel={t('models.field.baseUrl')}
                      value={baseUrlDraft}
                      onChange={(next) => {
                        setBaseUrlDraft(next);
                        setSavedNotice(false);
                      }}
                      placeholder="https://api.example.com/v1"
                    />
                    <p className="mt-1 text-2xs text-ink-quaternary">
                      {baseUrlDirty
                        ? t('settings.image.currentBaseUrl', { url: selected.baseUrl || '—' })
                        : t('settings.llm.baseUrlHint')}
                    </p>
                  </div>

                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-ink-secondary">
                        <KeyRound className="size-3.5 text-ink-tertiary" />
                        {t('models.field.key')}
                      </span>
                      {selected.hasKey ? <KeyTag>{t('settings.llm.keyReady')}</KeyTag> : null}
                    </div>
                    <SecretField
                      ariaLabel={t('models.field.key')}
                      value={keyDraft}
                      onChange={(next) => {
                        setKeyDraft(next);
                        setSavedNotice(false);
                      }}
                      placeholder={t('settings.image.keyPlaceholder')}
                    />
                  </div>

                  <div>
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-ink-secondary">
                        {t('settings.image.modelsTitle')}
                      </span>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          data-testid="add-custom-model"
                          onClick={() => {
                            setCustomError(null);
                            setCustomOpen(true);
                          }}
                          className="text-xs text-accent-ink hover:text-accent"
                        >
                          {t('settings.image.addModel')}
                        </button>
                        <button
                          type="button"
                          data-testid="enable-all-image-models"
                          disabled={!selected.hasKey || saving}
                          onClick={() => void enableAll(selected)}
                          className="text-xs text-accent-ink hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {t('settings.image.enableAll')}
                        </button>
                        <button
                          type="button"
                          data-testid="apply-builtin-pricing"
                          disabled={saving}
                          onClick={() => void applyOfficialPrices()}
                          className="text-xs text-accent-ink hover:text-accent disabled:opacity-40"
                        >
                          {t('settings.pricing.useOfficial')}
                        </button>
                      </div>
                    </div>
                    {customError ? <p className="mb-2 text-xs text-danger">{customError}</p> : null}

                    <div className="overflow-hidden rounded-lg border border-line">
                      {/* Header and body are separate tables so the scrollbar starts
                          below the column titles instead of running past them. Both
                          reserve the same gutter, which keeps the columns aligned. */}
                      <div className="overflow-y-auto border-b border-line bg-surface-muted [scrollbar-gutter:stable]">
                        <table className="w-full table-fixed border-collapse text-sm">
                          <colgroup>
                            <col />
                            <col style={{ width: '3.75rem' }} />
                            <col style={{ width: '3.75rem' }} />
                            <col style={{ width: '3.75rem' }} />
                            <col style={{ width: '3.75rem' }} />
                            <col style={{ width: '3.25rem' }} />
                          </colgroup>
                          <thead>
                            <tr className="text-2xs text-ink-tertiary">
                              <th className="px-3 py-1.5 text-left font-medium">
                                {t('settings.llm.col.name')}
                              </th>
                              <th className="px-1 py-1.5 text-right font-medium">
                                {t('settings.pricing.input')}
                              </th>
                              <th className="px-1 py-1.5 text-right font-medium">
                                {t('settings.pricing.output')}
                              </th>
                              <th className="px-1 py-1.5 text-right font-medium">
                                {t('settings.pricing.cacheRead')}
                              </th>
                              <th className="px-1 py-1.5 text-right font-medium">
                                {t('settings.pricing.cacheWrite')}
                              </th>
                              <th className="px-1 py-1.5 text-center font-medium">
                                <span className="sr-only">{t('settings.image.enabled')}</span>
                              </th>
                            </tr>
                          </thead>
                        </table>
                      </div>

                      <div
                        data-testid="image-model-table"
                        className="max-h-[22rem] overflow-y-auto [scrollbar-gutter:stable]"
                      >
                        <table className="w-full table-fixed border-collapse text-sm">
                          <colgroup>
                            <col />
                            <col style={{ width: '3.75rem' }} />
                            <col style={{ width: '3.75rem' }} />
                            <col style={{ width: '3.75rem' }} />
                            <col style={{ width: '3.75rem' }} />
                            <col style={{ width: '3.25rem' }} />
                          </colgroup>
                          <tbody className="[&>tr:first-child]:border-t-0">
                            {selected.images.map((model) => {
                              const price = priceOf(model);
                              const rowPriced = Boolean(priceDraft[model.id]);
                              return (
                                <tr
                                  key={model.id}
                                  data-testid="image-model-row"
                                  className="border-t border-line align-middle"
                                >
                                  <td className="px-3 py-1.5">
                                    <div className="flex items-center gap-2">
                                      <ProviderMark
                                        providerId={vendorProviderId(
                                          model.id.includes('/')
                                            ? (model.id.split('/')[0] ?? selected.id)
                                            : selected.id,
                                        )}
                                        size="sm"
                                      />
                                      <span className="min-w-0">
                                        <span className="block truncate text-sm-plus text-ink">
                                          {model.name}
                                        </span>
                                        <span className="block truncate font-mono text-2xs text-ink-tertiary">
                                          {model.id}
                                        </span>
                                      </span>
                                    </div>
                                  </td>
                                  {PRICE_FIELDS.map((field) => (
                                    <td key={field} className="px-1 py-1.5">
                                      <input
                                        type="number"
                                        step="0.001"
                                        min={0}
                                        aria-label={`${model.id} ${field}`}
                                        disabled={!model.enabled}
                                        value={price[field]}
                                        onChange={(event) =>
                                          setPriceDraft((previous) => ({
                                            ...previous,
                                            [model.id]: { ...price, [field]: Number(event.target.value) },
                                          }))
                                        }
                                        className={cn(
                                          'h-6 w-full rounded border bg-surface px-1 text-right font-mono text-2xs text-ink outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-45',
                                          rowPriced
                                            ? 'border-accent'
                                            : 'border-transparent hover:border-line',
                                        )}
                                      />
                                    </td>
                                  ))}
                                  <td className="px-1 py-1.5">
                                    {/* Without a key there is nothing to call, so the switch is off
                                        and locked: rows imported by the LLM page must not read as
                                        "enabled for images" just because they exist. */}
                                    <div className="flex items-center justify-center">
                                      <Toggle
                                        label={`${model.name} ${t('settings.image.enabled')}`}
                                        checked={selected.hasKey && model.enabled}
                                        disabled={!selected.hasKey || saving}
                                        title={
                                          selected.hasKey ? undefined : t('settings.image.enableNeedsKey')
                                        }
                                        onChange={(next) => void setModelEnabled(selected, model, next)}
                                      />
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}

                            {customOpen ? (
                              <tr
                                ref={customRowRef}
                                data-testid="custom-image-model-row"
                                className="border-t border-accent/40 bg-accent/5 align-middle"
                              >
                                <td className="px-3 py-1.5">
                                  <div className="flex items-start gap-1.5">
                                    <div className="min-w-0 flex-1 space-y-1">
                                      <input
                                        value={customModel.name}
                                        onChange={(event) =>
                                          setCustomModel((current) => ({
                                            ...current,
                                            name: event.target.value,
                                          }))
                                        }
                                        onKeyDown={(event) => {
                                          if (event.key === 'Escape') cancelCustomModel();
                                        }}
                                        aria-label={t('settings.llm.col.name')}
                                        placeholder={t('settings.llm.nameOptional')}
                                        className="h-6 w-full rounded border border-line bg-surface px-1 text-sm-plus font-medium text-ink outline-none focus:border-accent"
                                      />
                                      <input
                                        data-testid="custom-image-model-id"
                                        autoFocus
                                        value={customModel.id}
                                        onChange={(event) =>
                                          setCustomModel((current) => ({
                                            ...current,
                                            id: event.target.value,
                                          }))
                                        }
                                        onKeyDown={(event) => {
                                          if (event.key === 'Escape') cancelCustomModel();
                                        }}
                                        aria-label={t('settings.llm.modelId')}
                                        placeholder={t('settings.image.addModelPlaceholder')}
                                        spellCheck={false}
                                        className="h-6 w-full rounded border border-line bg-surface px-1 font-mono text-2xs text-ink outline-none focus:border-accent"
                                      />
                                      {/* The protocol column is gone; a hand-added id still has to
                                          say which image API it speaks, so it lives with the draft. */}
                                      <select
                                        aria-label={t('settings.image.protocol')}
                                        value={customModel.api}
                                        onChange={(event) =>
                                          setCustomModel((current) => ({
                                            ...current,
                                            api: event.target.value,
                                          }))
                                        }
                                        className="h-6 w-full rounded border border-line bg-surface px-1 font-mono text-2xs text-ink-tertiary outline-none focus:border-accent"
                                      >
                                        {IMAGE_PROTOCOLS.map((protocol) => (
                                          <option key={protocol} value={protocol}>
                                            {protocol}
                                          </option>
                                        ))}
                                      </select>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={cancelCustomModel}
                                      aria-label={t('common.cancel')}
                                      title={t('common.cancel')}
                                      className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-ink-tertiary transition-colors hover:bg-ink/5"
                                    >
                                      <X className="size-3" />
                                    </button>
                                  </div>
                                </td>
                                {PRICE_FIELDS.map((field) => (
                                  <td key={field} className="px-1 py-1.5">
                                    <input
                                      type="number"
                                      step="0.001"
                                      min={0}
                                      value={customModel[field]}
                                      onChange={(event) =>
                                        setCustomModel((current) => ({
                                          ...current,
                                          [field]: event.target.value,
                                        }))
                                      }
                                      aria-label={`${t('settings.llm.modelId')} ${field}`}
                                      placeholder="0"
                                      className="h-6 w-full rounded border border-line bg-surface px-1 text-right font-mono text-2xs text-ink outline-none focus:border-accent"
                                    />
                                  </td>
                                ))}
                                <td className="px-1 py-1.5" />
                              </tr>
                            ) : null}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <p className="mt-1.5 text-xs text-ink-tertiary">{t('settings.pricing.hint')}</p>
                    <p className="mt-1 text-xs text-ink-tertiary">{t('settings.image.protocolHint')}</p>
                    <p className="mt-1 text-xs text-ink-tertiary">{t('settings.image.configHint')}</p>
                  </div>

                  {models.error ? <p className="text-xs text-danger">{models.error}</p> : null}
                </div>
              </>
            )}
          </div>
        </div>
      </Section>

      {addOpen ? (
        <AddProviderDialog
          apiKinds={['openai-completions', 'anthropic-messages']}
          onClose={() => setAddOpen(false)}
          onCreate={(draft) => {
            void models.saveProvider(draft);
            setPendingProviderId(draft.id);
            setSelectedId(draft.id);
          }}
        />
      ) : null}
    </>
  );
}
