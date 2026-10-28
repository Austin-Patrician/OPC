import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, Link2, Loader2, Plus, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useModels } from '@/features/models/model/useModels';
import { useCatalog } from '@/features/models/model/useCatalog';
import { providerMeta } from '@/shared/providers/catalog';
import { ProviderMark } from '@/shared/ui/ProviderMark';
import { cn } from '@/shared/lib/cn';
import {
  buttonClass,
  KeyTag,
  PageHeader,
  SecretField,
  Section,
  Segmented,
  SelectField,
  StatusBadge,
  TextField,
  Toggle,
} from '../kit';
import { AddProviderDialog } from './AddProviderDialog';
import {
  buildVoiceProviders,
  mergeVoiceModels,
  toVoiceModelOption,
  type VoiceModelView,
  type VoiceProviderView,
  type VoiceRole,
} from './voiceProviders';

/** Wire protocols a speech model can speak. */
const VOICE_PROTOCOLS = ['xiaomi-audio', 'openai-audio'] as const;

const EMPTY_VOICE_MODEL_DRAFT = {
  id: '',
  name: '',
  api: VOICE_PROTOCOLS[0] as string,
};

/**
 * Settings → 模型 → Voice.
 *
 * ASR and TTS share one page because they share the provider, key and base URL;
 * the segmented switch only changes which model rows are shown. Unlike Image,
 * the capability itself is the switch: a stored row with `capability: 'asr'`
 * is usable, and turning it off removes it from the provider's list.
 */
export function VoicePage() {
  const { t } = useTranslation();
  const models = useModels();
  const { catalog, loading } = useCatalog();
  const [role, setRole] = useState<VoiceRole>('asr');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  /**
   * The provider created on this page, before it owns any voice model. Without
   * this the new row would vanish from the list immediately (it has no models),
   * and with a blanket "show every custom provider" rule the LLM page's chat
   * providers would leak in here instead.
   */
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);

  const [keyDraft, setKeyDraft] = useState('');
  const [savedKey, setSavedKey] = useState('');
  const [baseUrlDraft, setBaseUrlDraft] = useState('');
  const [customOpen, setCustomOpen] = useState(false);
  const [customModel, setCustomModel] = useState(EMPTY_VOICE_MODEL_DRAFT);
  const customRowRef = useRef<HTMLTableRowElement>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  const providers = useMemo(
    () =>
      buildVoiceProviders(catalog, models.providers, role, (id) => providerMeta(id)?.name, {
        includeProviderId: pendingProviderId ?? undefined,
      }),
    [catalog, models.providers, role, pendingProviderId],
  );

  const selected = providers.find((entry) => entry.id === selectedId) ?? providers[0];
  const selectedConfig = selected?.config;
  const activeProviderId = selected?.id;
  const selectedBaseUrl = selected?.baseUrl;

  const defaultRef = models.defaults[role];

  const selectableProviders = useMemo(
    () =>
      providers
        .filter((entry) => entry.hasKey)
        .map((entry) => ({ ...entry, models: entry.models.filter((model) => model.enabled) }))
        .filter((entry) => entry.models.length > 0),
    [providers],
  );

  const needle = query.trim().toLowerCase();
  const visibleProviders = providers.filter(
    (entry) =>
      !needle ||
      entry.id.includes(needle) ||
      entry.name.toLowerCase().includes(needle) ||
      entry.models.some((model) => model.id.toLowerCase().includes(needle)),
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

  // A half-filled draft belongs to the provider (and the role) it started on.
  useEffect(() => {
    setCustomOpen(false);
    setCustomModel(EMPTY_VOICE_MODEL_DRAFT);
    setCustomError(null);
    setSaveError(null);
    setSavedNotice(false);
  }, [activeProviderId, role]);

  useEffect(() => {
    if (!customOpen) return;
    customRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [customOpen]);

  /** Creates the provider row so a base URL / key / model has somewhere to live. */
  const ensureProvider = async (entry: VoiceProviderView) => {
    if (entry.config) return;
    await models.saveProvider({
      id: entry.id,
      name: entry.name,
      baseUrl: entry.baseUrl,
      api: entry.api,
      isCustom: false,
    });
  };

  /** Turns every built-in row of this role on in one write. */
  const enableAll = async (entry: VoiceProviderView) => {
    if (!entry.hasKey) return;
    setSaveError(null);
    setSaving(true);
    try {
      await ensureProvider(entry);
      const merged = mergeVoiceModels(entry.config?.models ?? [], entry.catalogModels, role);
      const builtinIds = new Set(entry.catalogModels.map((model) => model.id));
      await models.setModels(
        entry.id,
        merged.map((model) =>
          builtinIds.has(model.id)
            ? { ...model, capability: role, api: model.api ?? VOICE_PROTOCOLS[0] }
            : model,
        ),
      );
      await models.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  /**
   * A row's switch: on stores the row with this voice capability, off only
   * flips `voiceEnabled`. Turning off the current default clears it, so the mic
   * and read-aloud buttons never resolve to a model that cannot run.
   */
  const setModelEnabled = async (entry: VoiceProviderView, model: VoiceModelView, enabled: boolean) => {
    if (!entry.hasKey) return;
    setSaveError(null);
    setSaving(true);
    try {
      await ensureProvider(entry);
      const current = entry.config?.models ?? [];
      const previous = current.find((candidate) => candidate.id === model.id);
      // One row per id: a `/models` refresh or the LLM page may have stored this
      // voice id as a chat model, so replace it instead of appending a twin.
      const next = enabled
        ? [
            ...current.filter((candidate) => candidate.id !== model.id),
            {
              ...(previous ??
                toVoiceModelOption(
                  model.catalog ?? {
                    id: model.id,
                    name: model.name,
                    type: role,
                    api: model.api ?? VOICE_PROTOCOLS[0],
                  },
                  role,
                )),
              id: model.id,
              name: model.name,
              capability: role,
              api: model.api ?? previous?.api,
              voiceEnabled: true,
            },
          ]
        : // Switching off keeps a row that already belongs to this capability
          // (its prices/context stay); a chat row with the same id is left alone.
          previous && previous.capability === role
          ? current.map((candidate) =>
              candidate.id === model.id ? { ...candidate, voiceEnabled: false } : candidate,
            )
          : current;
      await models.setModels(entry.id, next);

      const isDefault = defaultRef?.providerId === entry.id && defaultRef.modelId === model.id;
      if (!enabled && isDefault) await models.setDefault(role, null);
      await models.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const customRowFilled = Object.values(customModel).some((value) => String(value).trim() !== '');
  const keyDirty = Boolean(selected) && keyDraft !== savedKey;
  const baseUrlDirty = baseUrlDraft.trim() !== (selectedBaseUrl ?? '').trim();
  const dirty = keyDirty || baseUrlDirty || (customOpen && customRowFilled);

  const cancelCustomModel = () => {
    setCustomOpen(false);
    setCustomModel(EMPTY_VOICE_MODEL_DRAFT);
    setCustomError(null);
  };

  const discardChanges = () => {
    setKeyDraft(savedKey);
    setBaseUrlDraft(selectedBaseUrl ?? '');
    setCustomOpen(false);
    setCustomModel(EMPTY_VOICE_MODEL_DRAFT);
    setCustomError(null);
    setSaveError(null);
    setSavedNotice(false);
  };

  /**
   * One save writes the panel: key, Base URL and the pending custom row. Model
   * rows themselves are controlled by their switches, not by Save.
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

      if (customOpen && customModel.id.trim()) {
        await bridge.addModel(selected.id, {
          id: customModel.id.trim(),
          name: customModel.name.trim() || undefined,
          api: customModel.api,
          capability: role,
        });
        setCustomModel(EMPTY_VOICE_MODEL_DRAFT);
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

  const roleLabel = role === 'asr' ? t('settings.voice.asr') : t('settings.voice.tts');

  return (
    <>
      <PageHeader
        crumbs={[t('settings.group.models'), 'Voice']}
        title={t('settings.voice.title')}
        description={t('settings.voice.desc')}
      />

      {/* Two global defaults: the composer mic and read-aloud resolve through them. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-ink">
            {role === 'asr' ? t('settings.voice.defaultTitle') : t('settings.voice.defaultTtsTitle')}
            <KeyTag>{role === 'asr' ? 'default.asr' : 'default.tts'}</KeyTag>
          </div>
          <div className="mt-0.5 text-xs-plus text-ink-tertiary">
            {defaultRef ? (
              <span className="font-mono select-text">
                {defaultRef.providerId}/{defaultRef.modelId}
              </span>
            ) : role === 'asr' ? (
              t('settings.voice.noDefault')
            ) : (
              t('settings.voice.noDefaultTts')
            )}
          </div>
        </div>
        <div className="w-[22rem] max-w-full shrink-0">
          <SelectField
            ariaLabel={roleLabel}
            value={defaultRef ? `${defaultRef.providerId}::${defaultRef.modelId}` : ''}
            onChange={(next) => {
              if (!next) {
                void models.setDefault(role, null);
                return;
              }
              const [providerId = '', modelId = ''] = next.split('::');
              const entry = selectableProviders.find((candidate) => candidate.id === providerId);
              const model = entry?.models.find((candidate) => candidate.id === modelId);
              if (entry && model) void models.setDefault(role, { providerId: entry.id, modelId: model.id });
            }}
          >
            <option value="">
              {role === 'asr' ? t('settings.voice.noDefault') : t('settings.voice.noDefaultTts')}
            </option>
            {selectableProviders.map((entry) => (
              <optgroup key={entry.id} label={entry.name}>
                {entry.models.map((model) => (
                  <option key={model.id} value={`${entry.id}::${model.id}`}>
                    {model.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </SelectField>
          {selectableProviders.length === 0 ? (
            <p className="mt-1 text-2xs text-ink-quaternary">{t('settings.voice.noneEnabled')}</p>
          ) : null}
        </div>
      </div>

      <Section
        title={t('settings.voice.providersTitle')}
        description={t('settings.voice.providersDesc')}
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
        <div className="border-b border-line px-4 py-3">
          <Segmented
            label={t('settings.voice.title')}
            value={role}
            onChange={(next) => {
              setRole(next);
              setSelectedId('');
              // The pending row belongs to the tab it was created on.
              setPendingProviderId(null);
            }}
            options={[
              { value: 'asr', label: t('settings.voice.asr') },
              { value: 'tts', label: t('settings.voice.tts') },
            ]}
          />
          <p className="mt-1.5 text-xs text-ink-tertiary">
            {role === 'asr' ? t('settings.voice.asrDesc') : t('settings.voice.ttsDesc')}
          </p>
        </div>

        <div className="flex min-h-[30rem]">
          <div className="flex w-[14.75rem] shrink-0 flex-col border-r border-line bg-sidebar">
            <div className="p-2.5">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-quaternary" />
                <TextField
                  ariaLabel={t('common.search')}
                  value={query}
                  onChange={setQuery}
                  placeholder={t('settings.voice.search')}
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
                        {t('settings.voice.enabledOf', {
                          enabled: entry.models.filter((model) => model.enabled).length,
                          total: entry.models.length,
                        })}
                      </span>
                    </span>
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{
                        background: entry.hasKey ? 'var(--success)' : 'var(--text-quaternary)',
                      }}
                    />
                  </button>
                );
              })}
              {visibleProviders.length === 0 && !loading ? (
                <p className="px-3 py-6 text-center text-sm text-ink-tertiary">
                  {t('settings.voice.emptyProvider')}
                </p>
              ) : null}
              {loading ? <p className="px-3 py-4 text-sm text-ink-tertiary">…</p> : null}
            </nav>
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            {!selected ? (
              <p className="p-6 text-sm text-ink-tertiary">{t('settings.voice.emptyProvider')}</p>
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
                      {selected.models.length} {t('settings.voice.models')} · {roleLabel}
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
                        ? t('settings.voice.currentBaseUrl', { url: selected.baseUrl || '—' })
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
                      placeholder={t('settings.voice.keyPlaceholder')}
                    />
                  </div>

                  <div>
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-ink-secondary">
                        {t('settings.voice.modelsTitle')}
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
                          {t('settings.voice.addModel')}
                        </button>
                        <button
                          type="button"
                          data-testid="enable-all-voice-models"
                          disabled={!selected.hasKey || saving}
                          onClick={() => void enableAll(selected)}
                          className="text-xs text-accent-ink hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {t('settings.voice.enableAll')}
                        </button>
                      </div>
                    </div>
                    {customError ? <p className="mb-2 text-xs text-danger">{customError}</p> : null}

                    <div className="overflow-hidden rounded-lg border border-line">
                      <div className="overflow-y-auto border-b border-line bg-surface-muted [scrollbar-gutter:stable]">
                        <table className="w-full table-fixed border-collapse text-sm">
                          <colgroup>
                            <col />
                            <col style={{ width: '9rem' }} />
                            <col style={{ width: '3.25rem' }} />
                          </colgroup>
                          <thead>
                            <tr className="text-2xs text-ink-tertiary">
                              <th className="px-3 py-1.5 text-left font-medium">
                                {t('settings.llm.col.name')}
                              </th>
                              <th className="px-3 py-1.5 text-left font-medium">
                                {t('settings.voice.protocol')}
                              </th>
                              <th className="px-1 py-1.5 text-center font-medium">
                                <span className="sr-only">{t('settings.voice.enabled')}</span>
                              </th>
                            </tr>
                          </thead>
                        </table>
                      </div>

                      <div
                        data-testid="voice-model-table"
                        className="max-h-[22rem] overflow-y-auto [scrollbar-gutter:stable]"
                      >
                        <table className="w-full table-fixed border-collapse text-sm">
                          <colgroup>
                            <col />
                            <col style={{ width: '9rem' }} />
                            <col style={{ width: '3.25rem' }} />
                          </colgroup>
                          <tbody className="[&>tr:first-child]:border-t-0">
                            {selected.models.map((model) => (
                              <tr
                                key={model.id}
                                data-testid="voice-model-row"
                                className="border-t border-line align-middle"
                              >
                                <td className="px-3 py-1.5">
                                  <div className="flex items-center gap-2">
                                    <ProviderMark providerId={selected.id} size="sm" />
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
                                <td className="px-3 py-1.5">
                                  <span className="font-mono text-2xs text-ink-tertiary">
                                    {model.api ?? '—'}
                                  </span>
                                </td>
                                <td className="px-1 py-1.5">
                                  <div className="flex items-center justify-center">
                                    <Toggle
                                      label={`${model.name} ${t('settings.voice.enabled')}`}
                                      checked={selected.hasKey && model.enabled}
                                      disabled={!selected.hasKey || saving}
                                      title={selected.hasKey ? undefined : t('settings.voice.enableNeedsKey')}
                                      onChange={(next) => void setModelEnabled(selected, model, next)}
                                    />
                                  </div>
                                </td>
                              </tr>
                            ))}

                            {customOpen ? (
                              <tr
                                ref={customRowRef}
                                data-testid="custom-voice-model-row"
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
                                        data-testid="custom-voice-model-id"
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
                                        placeholder={t('settings.voice.addModelPlaceholder')}
                                        spellCheck={false}
                                        className="h-6 w-full rounded border border-line bg-surface px-1 font-mono text-2xs text-ink outline-none focus:border-accent"
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
                                <td className="px-3 py-1.5">
                                  <select
                                    aria-label={t('settings.voice.protocol')}
                                    value={customModel.api}
                                    onChange={(event) =>
                                      setCustomModel((current) => ({
                                        ...current,
                                        api: event.target.value,
                                      }))
                                    }
                                    className="h-6 w-full rounded border border-line bg-surface px-1 font-mono text-2xs text-ink-tertiary outline-none focus:border-accent"
                                  >
                                    {VOICE_PROTOCOLS.map((protocol) => (
                                      <option key={protocol} value={protocol}>
                                        {protocol}
                                      </option>
                                    ))}
                                  </select>
                                </td>
                                <td className="px-1 py-1.5" />
                              </tr>
                            ) : null}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <p className="mt-1.5 text-xs text-ink-tertiary">{t('settings.voice.billingHint')}</p>
                    <p className="mt-1 text-xs text-ink-tertiary">{t('settings.voice.configHint')}</p>
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
            // No voice model yet, so the list would skip it; pin it until one exists.
            setPendingProviderId(draft.id);
            setSelectedId(draft.id);
          }}
        />
      ) : null}
    </>
  );
}
