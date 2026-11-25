import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, Link2, Loader2, Plus, Search, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useModels } from '@/features/models/model/useModels';
import { useCatalog } from '@/features/models/model/useCatalog';
import { providerMeta } from '@/shared/providers/catalog';
import { ProviderMark } from '@/shared/ui/ProviderMark';
import { ModelPicker } from '@/shared/ui/ModelPicker';
import { Select } from '@/shared/ui/Select';
import { cn } from '@/shared/lib/cn';
import {
  buttonClass,
  KeyTag,
  PageHeader,
  SecretField,
  Section,
  StatusBadge,
  TextField,
  Toggle,
} from '../kit';
import { AddProviderDialog } from './AddProviderDialog';
import {
  buildVideoProviders,
  EMPTY_VIDEO_MODEL_DRAFT,
  mergeVideoModels,
  toVideoModelOption,
  VIDEO_PROTOCOLS,
  type VideoModelView,
  type VideoProviderView,
} from './videoProviders';

/**
 * Settings → 模型 → Video: 6 built-in video generation providers + custom providers.
 * Displays pre-filled per-second USD pricing (`usdPerSecond`), customizable Base URL,
 * API Key, model enable switches, and custom model additions.
 */
export function VideoPage() {
  const { t } = useTranslation();
  const models = useModels();
  const { catalog, loading } = useCatalog();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>('');
  const [addOpen, setAddOpen] = useState(false);
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);

  const [keyDraft, setKeyDraft] = useState('');
  const [savedKey, setSavedKey] = useState('');
  const [baseUrlDraft, setBaseUrlDraft] = useState('');
  const [rateDraft, setRateDraft] = useState<Record<string, number>>({});
  const [customOpen, setCustomOpen] = useState(false);
  const [customModel, setCustomModel] = useState(EMPTY_VIDEO_MODEL_DRAFT);
  const customRowRef = useRef<HTMLTableRowElement>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [modelNotice, setModelNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  const providersWithVideos = useMemo(
    () =>
      buildVideoProviders(catalog, models.providers, (id) => providerMeta(id)?.name, {
        includeProviderId: pendingProviderId ?? undefined,
      }),
    [catalog, models.providers, pendingProviderId],
  );

  const selected = providersWithVideos.find((entry) => entry.id === selectedId) ?? providersWithVideos[0];
  const selectedConfig = selected?.config;
  const activeProviderId = selected?.id;
  const selectedBaseUrl = selected?.baseUrl;
  const storedModels = useMemo(() => selectedConfig?.models ?? [], [selectedConfig]);
  const storedById = useMemo(() => new Map(storedModels.map((model) => [model.id, model])), [storedModels]);

  const selectableProviders = useMemo(
    () =>
      providersWithVideos
        .filter((entry) => entry.hasKey)
        .map((entry) => ({ ...entry, videos: entry.videos.filter((model) => model.enabled) }))
        .filter((entry) => entry.videos.length > 0),
    [providersWithVideos],
  );

  const needle = query.trim().toLowerCase();
  const visibleProviders = providersWithVideos.filter(
    (entry) =>
      !needle ||
      entry.id.toLowerCase().includes(needle) ||
      entry.name.toLowerCase().includes(needle) ||
      entry.videos.some((model) => model.id.toLowerCase().includes(needle)),
  );

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

  useEffect(() => {
    setCustomOpen(false);
    setCustomModel({
      ...EMPTY_VIDEO_MODEL_DRAFT,
      api: selected?.api && VIDEO_PROTOCOLS.includes(selected.api as (typeof VIDEO_PROTOCOLS)[number])
        ? selected.api
        : VIDEO_PROTOCOLS[0],
    });
    setCustomError(null);
    setRateDraft({});
    setModelNotice(null);
    setSaveError(null);
    setSavedNotice(false);
  }, [activeProviderId, selected?.api]);

  useEffect(() => {
    if (!customOpen) return;
    customRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [customOpen]);

  const ensureProvider = async (entry: VideoProviderView) => {
    if (entry.config) return;
    await models.saveProvider({
      id: entry.id,
      name: entry.name,
      baseUrl: entry.baseUrl,
      api: entry.api,
      isCustom: false,
    });
  };

  const enableAll = async (entry: VideoProviderView) => {
    if (!entry.hasKey) return;
    setSaveError(null);
    setSaving(true);
    try {
      await ensureProvider(entry);
      const builtinIds = new Set(entry.catalogVideos.map((model) => model.id));
      const merged = mergeVideoModels(entry.config?.models ?? [], entry.catalogVideos);
      await models.setModels(
        entry.id,
        merged.map((model) =>
          builtinIds.has(model.id) ? { ...model, capability: 'video' as const, videoEnabled: true } : model,
        ),
      );
      await models.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const setDefaultVideo = (entry: VideoProviderView, model: VideoModelView) =>
    models.setDefault('video', { providerId: entry.id, modelId: model.id });

  const setModelEnabled = async (entry: VideoProviderView, model: VideoModelView, enabled: boolean) => {
    if (!entry.hasKey) return;
    setSaveError(null);
    setSaving(true);
    try {
      await ensureProvider(entry);
      const current = entry.config?.models ?? [];
      const base = model.stored
        ? current
        : [
            ...current,
            toVideoModelOption(
              model.catalog ?? {
                id: model.id,
                name: model.name,
                type: 'video',
                api: model.api ?? entry.api ?? VIDEO_PROTOCOLS[0],
                usdPerSecond: model.usdPerSecond,
              },
              enabled,
            ),
          ];
      const next = base.map((candidate) =>
        candidate.id === model.id
          ? {
              ...candidate,
              capability: 'video' as const,
              videoEnabled: enabled,
              ...(candidate.usdPerSecond === undefined && model.usdPerSecond !== undefined
                ? { usdPerSecond: model.usdPerSecond }
                : {}),
            }
          : candidate,
      );
      await models.setModels(entry.id, next);

      const isDefault =
        models.defaults.video?.providerId === entry.id && models.defaults.video.modelId === model.id;
      if (!enabled && isDefault) await models.setDefault('video', null);
      await models.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const rateOf = (model: VideoModelView): number =>
    rateDraft[model.id] ?? storedById.get(model.id)?.usdPerSecond ?? model.usdPerSecond ?? 0;

  const customRowFilled = Boolean(
    customModel.id.trim() || customModel.name.trim() || customModel.usdPerSecond.trim(),
  );
  const keyDirty = Boolean(selected) && keyDraft !== savedKey;
  const baseUrlDirty = baseUrlDraft.trim() !== (selectedBaseUrl ?? '').trim();
  const pricesDirty = Object.keys(rateDraft).length > 0;
  const dirty = keyDirty || baseUrlDirty || pricesDirty || (customOpen && customRowFilled);

  const cancelCustomModel = () => {
    setCustomOpen(false);
    setCustomModel({
      ...EMPTY_VIDEO_MODEL_DRAFT,
      api: selected?.api && VIDEO_PROTOCOLS.includes(selected.api as (typeof VIDEO_PROTOCOLS)[number])
        ? selected.api
        : VIDEO_PROTOCOLS[0],
    });
    setCustomError(null);
  };

  const discardChanges = () => {
    setKeyDraft(savedKey);
    setBaseUrlDraft(selectedBaseUrl ?? '');
    setRateDraft({});
    cancelCustomModel();
    setModelNotice(null);
    setSaveError(null);
    setSavedNotice(false);
  };

  const refreshModels = async (entry: VideoProviderView) => {
    const bridge = window.opc?.models;
    if (!bridge || refreshing) return;
    setModelNotice(null);
    setSaveError(null);
    setRefreshing(true);
    try {
      await ensureProvider(entry);
      if (keyDraft !== savedKey) {
        await bridge.setKey(entry.id, keyDraft);
        setSavedKey(keyDraft);
      }
      if (baseUrlDraft.trim() !== (entry.baseUrl ?? '').trim()) {
        await bridge.saveProvider({
          id: entry.id,
          name: entry.name,
          baseUrl: baseUrlDraft.trim() || entry.baseUrl,
          api: entry.config?.api ?? entry.api,
          isCustom: entry.config?.isCustom ?? false,
          scope: entry.config?.scope,
          icon: entry.config?.icon,
        });
      }
      const result = await models.refreshModels(entry.id, 'video');
      if (!result) return;
      if (!result.ok) {
        setModelNotice(result.message);
        return;
      }
      const addedSuffix =
        result.added.length > 0
          ? t('settings.llm.fetchAdded', {
              ids: result.added.slice(0, 5).join('、'),
              more:
                result.added.length > 5
                  ? `${t('settings.llm.more')} ${result.added.length - 5}`
                  : '',
            })
          : t('settings.llm.fetchNothingNew');
      setModelNotice(`${result.message}${addedSuffix}`);
    } catch (error) {
      setModelNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  };

  const removeCustomProvider = async (entry: VideoProviderView) => {
    if (!entry.config?.isCustom) return;
    setSaveError(null);
    setSaving(true);
    try {
      await models.removeProvider(entry.id);
      if (pendingProviderId === entry.id) setPendingProviderId(null);
      if (selectedId === entry.id) setSelectedId('');
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
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
      if (baseUrlDirty) {
        await bridge.saveProvider({
          id: selected.id,
          name: selected.name,
          baseUrl: baseUrlDraft.trim() || selected.baseUrl,
          api: selectedConfig?.api ?? selected.api,
          isCustom: selectedConfig?.isCustom ?? false,
          scope: selectedConfig?.scope,
          icon: selectedConfig?.icon,
        });
      }

      if (pricesDirty) {
        let nextModels = [...storedModels];
        for (const [modelId, rate] of Object.entries(rateDraft)) {
          const cleanRate = Math.max(0, Number.isFinite(rate) ? rate : 0);
          if (nextModels.some((model) => model.id === modelId)) {
            nextModels = nextModels.map((model) =>
              model.id === modelId ? { ...model, usdPerSecond: cleanRate } : model,
            );
          } else {
            const cat = selected.catalogVideos.find((entry) => entry.id === modelId);
            if (cat) {
              nextModels.push({ ...toVideoModelOption(cat, false), usdPerSecond: cleanRate });
            }
          }
        }
        await bridge.setModels(selected.id, nextModels);
      }

      if (customOpen && customModel.id.trim()) {
        await bridge.addModel(selected.id, {
          id: customModel.id.trim(),
          name: customModel.name.trim() || undefined,
          api: customModel.api,
          capability: 'video',
          usdPerSecond: Math.max(0, Number(customModel.usdPerSecond) || 0),
        });
        cancelCustomModel();
      }

      setRateDraft({});
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
        crumbs={[t('settings.group.models'), 'Video']}
        title={t('settings.video.title')}
        description={t('settings.video.descProvider')}
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-ink">
            {t('settings.video.defaultTitle')}
          </div>
          <div className="mt-0.5 text-xs-plus text-ink-tertiary">
            {models.defaults.video ? (
              <span className="font-mono select-text">
                {models.defaults.video.providerId}/{models.defaults.video.modelId}
              </span>
            ) : (
              t('settings.video.noDefault')
            )}
          </div>
        </div>
        <div className="w-[22rem] max-w-full shrink-0">
          <ModelPicker
            ariaLabel={t('settings.video.defaultTitle')}
            title={t('settings.video.defaultTitle')}
            groups={selectableProviders.map((entry) => ({
              providerId: entry.id,
              providerName: entry.name,
              models: entry.videos.map((model) => ({
                modelId: model.id,
                modelName: model.name,
                thinkingLevels: [],
              })),
            }))}
            value={models.defaults.video}
            allowThinking={false}
            clearLabel={t('settings.video.noDefault')}
            emptyLabel={t('settings.video.noDefault')}
            onClear={() => void models.setDefault('video', null)}
            onSelect={(selection) => {
              const entry = selectableProviders.find(
                (candidate) => candidate.id === selection.providerId,
              );
              const video = entry?.videos.find((candidate) => candidate.id === selection.modelId);
              if (entry && video) void setDefaultVideo(entry, video);
            }}
          />
          {selectableProviders.length === 0 ? (
            <p className="mt-1 text-2xs text-ink-quaternary">{t('settings.video.noneEnabled')}</p>
          ) : null}
        </div>
      </div>

      <Section
        title={t('settings.video.providersTitle')}
        description={t('settings.video.providersDesc')}
        action={
          <button
            type="button"
            data-testid="add-video-provider"
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
                  placeholder={t('settings.video.search')}
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
                    data-testid="video-provider-row"
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
                        {t('settings.video.enabledOf', {
                          enabled: entry.videos.filter((model) => model.enabled).length,
                          total: entry.videos.length,
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
                  {t('settings.video.emptyProvider')}
                </p>
              ) : null}
              {loading ? <p className="px-3 py-4 text-sm text-ink-tertiary">…</p> : null}
            </nav>
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            {!selected ? (
              <p className="p-6 text-sm text-ink-tertiary">{t('settings.video.emptyProvider')}</p>
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
                      {selected.videos.length} {t('settings.video.models')}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <span
                        aria-live="polite"
                        className={cn(
                          'w-12 shrink-0 text-right text-2xs',
                          dirty ? 'text-ink-tertiary' : 'text-success',
                        )}
                      >
                        {dirty ? t('settings.llm.unsaved') : savedNotice ? t('settings.llm.saved') : null}
                      </span>
                      {selected.config?.isCustom ? (
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void removeCustomProvider(selected)}
                          aria-label={t('common.delete')}
                          title={t('common.delete')}
                          className={buttonClass.secondary}
                        >
                          <Trash2 className="size-3.5 text-danger" />
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
                        data-testid="save-video-provider"
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
                      placeholder={selected.baseUrl || 'https://api.example.com/v1'}
                    />
                    <p className="mt-1 text-2xs text-ink-quaternary">
                      {baseUrlDirty
                        ? t('settings.video.currentBaseUrl', { url: selected.baseUrl || '—' })
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
                      placeholder={t('settings.video.keyPlaceholder')}
                    />
                    {selected.id === 'kling' ? (
                      <p className="mt-1 text-2xs text-ink-quaternary">{t('settings.video.klingKeyHint')}</p>
                    ) : null}
                  </div>

                  <div>
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-ink-secondary">
                        {t('settings.video.modelsTitle')}
                      </span>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          data-testid="refresh-video-models"
                          disabled={refreshing || saving}
                          onClick={() => void refreshModels(selected)}
                          className="text-xs text-accent-ink hover:text-accent disabled:opacity-40"
                        >
                          {refreshing ? t('settings.video.fetching') : t('settings.llm.fetchModels')}
                        </button>
                        <button
                          type="button"
                          data-testid="add-custom-video-model"
                          onClick={() => {
                            setCustomError(null);
                            setCustomOpen(true);
                          }}
                          className="text-xs text-accent-ink hover:text-accent"
                        >
                          {t('settings.video.addModel')}
                        </button>
                        <button
                          type="button"
                          data-testid="enable-all-video-models"
                          disabled={!selected.hasKey || saving}
                          onClick={() => void enableAll(selected)}
                          className="text-xs text-accent-ink hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {t('settings.video.enableAll')}
                        </button>
                      </div>
                    </div>
                    {modelNotice ? <p className="mb-2 text-xs text-ink-tertiary">{modelNotice}</p> : null}
                    {customError ? <p className="mb-2 text-xs text-danger">{customError}</p> : null}

                    <div className="overflow-hidden rounded-lg border border-line">
                      <div className="overflow-y-auto border-b border-line bg-surface-muted [scrollbar-gutter:stable]">
                        <table className="w-full table-fixed border-collapse text-sm">
                          <colgroup>
                            <col />
                            <col style={{ width: '6.25rem' }} />
                            <col style={{ width: '3.25rem' }} />
                          </colgroup>
                          <thead>
                            <tr className="text-2xs text-ink-tertiary">
                              <th className="px-3 py-1.5 text-left font-medium">
                                {t('settings.llm.col.name')}
                              </th>
                              <th className="px-2 py-1.5 text-right font-medium">
                                {t('settings.video.pricePerSecond')}
                              </th>
                              <th className="px-1 py-1.5 text-center font-medium">
                                <span className="sr-only">{t('settings.video.enabled')}</span>
                              </th>
                            </tr>
                          </thead>
                        </table>
                      </div>

                      <div
                        data-testid="video-model-table"
                        className="max-h-[22rem] overflow-y-auto [scrollbar-gutter:stable]"
                      >
                        <table className="w-full table-fixed border-collapse text-sm">
                          <colgroup>
                            <col />
                            <col style={{ width: '6.25rem' }} />
                            <col style={{ width: '3.25rem' }} />
                          </colgroup>
                          <tbody className="[&>tr:first-child]:border-t-0">
                            {selected.videos.map((model) => {
                              const rate = rateOf(model);
                              const rowEdited = rateDraft[model.id] !== undefined;
                              return (
                                <tr
                                  key={model.id}
                                  data-testid="video-model-row"
                                  className="border-t border-line align-middle"
                                >
                                  <td className="px-3 py-1.5">
                                    <div className="min-w-0">
                                      <span className="block truncate text-sm-plus text-ink">
                                        {model.name}
                                      </span>
                                      <span className="block truncate font-mono text-2xs text-ink-tertiary">
                                        {model.id}
                                      </span>
                                    </div>
                                  </td>
                                  <td className="px-2 py-1.5">
                                    <input
                                      type="number"
                                      step="0.001"
                                      min={0}
                                      aria-label={`${model.id} ${t('settings.video.pricePerSecond')}`}
                                      value={rate}
                                      onChange={(event) => {
                                        setRateDraft((previous) => ({
                                          ...previous,
                                          [model.id]: Number(event.target.value),
                                        }));
                                        setSavedNotice(false);
                                      }}
                                      className={cn(
                                        'h-6 w-full rounded border bg-surface px-1.5 text-right font-mono text-2xs text-ink outline-none focus:border-accent',
                                        rowEdited
                                          ? 'border-accent'
                                          : 'border-transparent hover:border-line',
                                      )}
                                    />
                                  </td>
                                  <td className="px-1 py-1.5">
                                    <div className="flex items-center justify-center">
                                      <Toggle
                                        label={`${model.name} ${t('settings.video.enabled')}`}
                                        checked={selected.hasKey && model.enabled}
                                        disabled={!selected.hasKey || saving}
                                        title={
                                          selected.hasKey ? undefined : t('settings.video.enableNeedsKey')
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
                                data-testid="custom-video-model-row"
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
                                        data-testid="custom-video-model-id"
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
                                        placeholder={t('settings.video.addModelPlaceholder')}
                                        spellCheck={false}
                                        className="h-6 w-full rounded border border-line bg-surface px-1 font-mono text-2xs text-ink outline-none focus:border-accent"
                                      />
                                      <Select
                                        ariaLabel={t('settings.video.protocol')}
                                        value={customModel.api}
                                        onValueChange={(api) => setCustomModel((current) => ({ ...current, api }))}
                                        size="compact"
                                        className="font-mono text-2xs text-ink-tertiary"
                                        options={VIDEO_PROTOCOLS.map((protocol) => ({ value: protocol, label: protocol }))}
                                      />
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
                                <td className="px-2 py-1.5">
                                  <input
                                    type="number"
                                    step="0.001"
                                    min={0}
                                    value={customModel.usdPerSecond}
                                    onChange={(event) =>
                                      setCustomModel((current) => ({
                                        ...current,
                                        usdPerSecond: event.target.value,
                                      }))
                                    }
                                    aria-label={t('settings.video.pricePerSecond')}
                                    placeholder="0.10"
                                    className="h-6 w-full rounded border border-line bg-surface px-1.5 text-right font-mono text-2xs text-ink outline-none focus:border-accent"
                                  />
                                </td>
                                <td className="px-1 py-1.5" />
                              </tr>
                            ) : null}
                          </tbody>
                        </table>
                      </div>
                    </div>
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
          apiKinds={[...VIDEO_PROTOCOLS]}
          onClose={() => setAddOpen(false)}
          onCreate={(draft) => {
            void models.saveProvider({ ...draft, scope: 'video' });
            setPendingProviderId(draft.id);
            setSelectedId(draft.id);
          }}
        />
      ) : null}
    </>
  );
}
