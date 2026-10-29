import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, Link2, Loader2, Play, Plus, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DecisionAnswer, DecisionQuestion } from '@opc/shared/domain';
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
  SelectField,
  StatusBadge,
  TextField,
  Toggle,
} from '../kit';
import { AddProviderDialog } from './AddProviderDialog';
import {
  buildDecisionProviders,
  DECISION_PROTOCOLS,
  isDecisionStoredModel,
  mergeDecisionModels,
  toDecisionModelOption,
  type DecisionModelView,
  type DecisionProviderView,
} from './decisionProviders';

const EMPTY_MODEL_DRAFT = {
  id: '',
  name: '',
  api: DECISION_PROTOCOLS[0] as string,
};

type QuestionKind = 'bool' | 'choice' | 'score';

/**
 * Settings → 模型 → Decision.
 *
 * Jev (TypeSafe System One) answers typed questions about a `state`; it is not a
 * chat model and does not speak `/chat/completions`. This page therefore owns its
 * own provider key, model switch and a small console that exercises the real
 * `decisions.classify` path rather than a mock.
 */
export function DecisionPage() {
  const { t } = useTranslation();
  const models = useModels();
  const { catalog, loading } = useCatalog();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);

  const [keyDraft, setKeyDraft] = useState('');
  const [savedKey, setSavedKey] = useState('');
  const [baseUrlDraft, setBaseUrlDraft] = useState('');
  const [customOpen, setCustomOpen] = useState(false);
  const [customModel, setCustomModel] = useState(EMPTY_MODEL_DRAFT);
  const customRowRef = useRef<HTMLTableRowElement>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  // Decision console: kept local so a failed run does not touch stored config.
  const [tryState, setTryState] = useState('');
  const [kind, setKind] = useState<QuestionKind>('bool');
  const [instructions, setInstructions] = useState('');
  const [choiceLines, setChoiceLines] = useState('');
  const [levelLines, setLevelLines] = useState('');
  const [trying, setTrying] = useState(false);
  const [tryError, setTryError] = useState<string | null>(null);
  const [tryResult, setTryResult] = useState<{
    model?: string;
    answers: Record<string, DecisionAnswer>;
    usage?: { inputTokens: number; outputTokens: number };
  } | null>(null);

  const providers = useMemo(
    () =>
      buildDecisionProviders(catalog, models.providers, (id) => providerMeta(id)?.name, {
        includeProviderId: pendingProviderId ?? undefined,
      }),
    [catalog, models.providers, pendingProviderId],
  );

  const selected = providers.find((entry) => entry.id === selectedId) ?? providers[0];
  const selectedConfig = selected?.config;
  const activeProviderId = selected?.id;
  const selectedBaseUrl = selected?.baseUrl;

  const defaultRef = models.defaults.decision;

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

  useEffect(() => {
    setCustomOpen(false);
    setCustomModel(EMPTY_MODEL_DRAFT);
    setCustomError(null);
    setSaveError(null);
    setSavedNotice(false);
  }, [activeProviderId]);

  useEffect(() => {
    if (!customOpen) return;
    customRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [customOpen]);

  /** Creates the provider row so a base URL / key / model has somewhere to live. */
  const ensureProvider = async (entry: DecisionProviderView) => {
    if (entry.config) return;
    await models.saveProvider({
      id: entry.id,
      name: entry.name,
      baseUrl: entry.baseUrl,
      api: entry.api,
      isCustom: false,
    });
  };

  /** Turns every decision-capable row on in one write. */
  const enableAll = async (entry: DecisionProviderView) => {
    if (!entry.hasKey) return;
    setSaveError(null);
    setSaving(true);
    try {
      await ensureProvider(entry);
      // Catalog ids plus rows already stored as classifiers (hand-added ones).
      // A chat row that happens to share the provider is never converted.
      const eligible = new Set([
        ...entry.catalogModels.map((model) => model.id),
        ...(entry.config?.models ?? [])
          .filter(isDecisionStoredModel)
          .map((model) => model.id),
      ]);
      const merged = mergeDecisionModels(entry.config?.models ?? [], entry.catalogModels);
      await models.setModels(
        entry.id,
        merged.map((model) =>
          eligible.has(model.id)
            ? { ...model, capability: 'classifier' as const, decisionEnabled: true }
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
   * A row's switch: on stores the row with `capability: 'classifier'`, off only
   * flips `decisionEnabled`. Turning off the current default clears it so the
   * API never resolves to a model that cannot run.
   */
  const setModelEnabled = async (
    entry: DecisionProviderView,
    model: DecisionModelView,
    enabled: boolean,
  ) => {
    if (!entry.hasKey) return;
    setSaveError(null);
    setSaving(true);
    try {
      await ensureProvider(entry);
      const current = entry.config?.models ?? [];
      const previous = current.find((candidate) => candidate.id === model.id);
      const next = enabled
        ? [
            ...current.filter((candidate) => candidate.id !== model.id),
            {
              ...(previous ??
                toDecisionModelOption(
                  model.catalog ?? {
                    id: model.id,
                    name: model.name,
                    type: 'classifier',
                    api: model.api ?? DECISION_PROTOCOLS[0],
                  },
                  false,
                )),
              id: model.id,
              name: model.name,
              capability: 'classifier' as const,
              api: model.api ?? previous?.api,
              decisionEnabled: true,
            },
          ]
        : previous && previous.capability === 'classifier'
          ? current.map((candidate) =>
              candidate.id === model.id ? { ...candidate, decisionEnabled: false } : candidate,
            )
          : current;
      await models.setModels(entry.id, next);

      const isDefault = defaultRef?.providerId === entry.id && defaultRef.modelId === model.id;
      if (!enabled && isDefault) await models.setDefault('decision', null);
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
    setCustomModel(EMPTY_MODEL_DRAFT);
    setCustomError(null);
  };

  const discardChanges = () => {
    setKeyDraft(savedKey);
    setBaseUrlDraft(selectedBaseUrl ?? '');
    setCustomOpen(false);
    setCustomModel(EMPTY_MODEL_DRAFT);
    setCustomError(null);
    setSaveError(null);
    setSavedNotice(false);
  };

  /** One save writes the panel: key, Base URL and the pending custom row. */
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
          capability: 'classifier',
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

  /** Builds one typed question from the console's form. */
  const buildQuestion = (): DecisionQuestion | { error: string } => {
    const text = instructions.trim();
    // System One services take `instructions` as the question itself; an empty
    // one would ask the model to classify nothing.
    if (!text) return { error: t('settings.decision.needInstructions') };
    if (kind === 'bool') {
      return {
        type: 'bool',
        instructions: text,
        criteria: {
          true: t('settings.decision.boolTrue'),
          false: t('settings.decision.boolFalse'),
        },
      };
    }

    if (kind === 'choice') {
      const criteria: Record<string, string> = {};
      for (const line of choiceLines.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [name, ...rest] = trimmed.split('=');
        const label = name?.trim();
        if (!label) continue;
        criteria[label] = rest.join('=').trim() || label;
      }
      if (Object.keys(criteria).length < 2) return { error: t('settings.decision.needTwoChoices') };
      return { type: 'choice', instructions: text, criteria };
    }

    const levels = levelLines
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (levels.length < 2) return { error: t('settings.decision.needTwoLevels') };
    return { type: 'score', instructions: text, criteria: levels };
  };

  const runDecision = async () => {
    if (!tryState.trim()) {
      setTryError(t('settings.decision.needState'));
      return;
    }
    const question = buildQuestion();
    if ('error' in question) {
      setTryError(question.error);
      return;
    }
    const bridge = window.opc?.decisions;
    if (!bridge) {
      setTryError(t('settings.decision.bridgeMissing'));
      return;
    }

    setTryError(null);
    setTryResult(null);
    setTrying(true);
    try {
      const result = await bridge.classify({
        state: tryState,
        questions: { answer: question },
        modelId: defaultRef?.modelId,
      });
      if (!result.ok) {
        setTryError(result.error ?? t('settings.decision.runFailed'));
        return;
      }
      setTryResult({
        model: result.model,
        answers: result.answers ?? {},
        usage: result.usage,
      });
    } catch (error) {
      setTryError(error instanceof Error ? error.message : String(error));
    } finally {
      setTrying(false);
    }
  };

  return (
    <>
      <PageHeader
        crumbs={[t('settings.group.models'), 'Decision']}
        title={t('settings.decision.title')}
        description={t('settings.decision.desc')}
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm text-ink">
            {t('settings.decision.defaultTitle')}
            <KeyTag>default.decision</KeyTag>
          </div>
          <div className="mt-0.5 text-xs-plus text-ink-tertiary">
            {defaultRef ? (
              <span className="font-mono select-text">
                {defaultRef.providerId}/{defaultRef.modelId}
              </span>
            ) : (
              t('settings.decision.noDefault')
            )}
          </div>
        </div>
        <div className="w-[22rem] max-w-full shrink-0">
          <SelectField
            ariaLabel={t('settings.decision.defaultTitle')}
            value={defaultRef ? `${defaultRef.providerId}::${defaultRef.modelId}` : ''}
            onChange={(next) => {
              if (!next) {
                void models.setDefault('decision', null);
                return;
              }
              const [providerId = '', modelId = ''] = next.split('::');
              const entry = selectableProviders.find((candidate) => candidate.id === providerId);
              const model = entry?.models.find((candidate) => candidate.id === modelId);
              if (entry && model) {
                void models.setDefault('decision', { providerId: entry.id, modelId: model.id });
              }
            }}
          >
            <option value="">{t('settings.decision.noDefault')}</option>
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
            <p className="mt-1 text-2xs text-ink-quaternary">{t('settings.decision.noneEnabled')}</p>
          ) : null}
        </div>
      </div>

      <Section
        title={t('settings.decision.providersTitle')}
        description={t('settings.decision.providersDesc')}
        action={
          <button type="button" data-testid="add-provider" onClick={() => setAddOpen(true)} className={buttonClass.secondary}>
            <Plus className="size-3.5" />
            {t('settings.llm.addProvider')}
          </button>
        }
      >
        <div className="flex min-h-[30rem]">
          <div className="flex w-[14.75rem] shrink-0 flex-col border-r border-line bg-sidebar">
            <div className="p-2.5">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-quaternary" />
                <TextField
                  ariaLabel={t('common.search')}
                  value={query}
                  onChange={setQuery}
                  placeholder={t('settings.decision.search')}
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
                        {t('settings.decision.enabledOf', {
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
                  {t('settings.decision.emptyProvider')}
                </p>
              ) : null}
              {loading ? <p className="px-3 py-4 text-sm text-ink-tertiary">…</p> : null}
            </nav>
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            {!selected ? (
              <p className="p-6 text-sm text-ink-tertiary">{t('settings.decision.emptyProvider')}</p>
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
                      {selected.models.length} {t('settings.decision.models')}
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
                      <button type="button" disabled={!dirty || saving} onClick={discardChanges} className={buttonClass.secondary}>
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
                        ? t('settings.decision.currentBaseUrl', { url: selected.baseUrl || '—' })
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
                      placeholder={t('settings.decision.keyPlaceholder')}
                    />
                  </div>

                  <div>
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-ink-secondary">
                        {t('settings.decision.modelsTitle')}
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
                          {t('settings.decision.addModel')}
                        </button>
                        <button
                          type="button"
                          data-testid="enable-all-decision-models"
                          disabled={!selected.hasKey || saving || selected.models.length === 0}
                          onClick={() => void enableAll(selected)}
                          className="text-xs text-accent-ink hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {t('settings.decision.enableAll')}
                        </button>
                      </div>
                    </div>
                    {customError ? <p className="mb-2 text-xs text-danger">{customError}</p> : null}

                    <div className="overflow-hidden rounded-lg border border-line">
                      <div className="overflow-y-auto border-b border-line bg-surface-muted [scrollbar-gutter:stable]">
                        <table className="w-full table-fixed border-collapse text-sm">
                          <colgroup>
                            <col />
                            <col style={{ width: '11rem' }} />
                            <col style={{ width: '3.25rem' }} />
                          </colgroup>
                          <thead>
                            <tr className="text-2xs text-ink-tertiary">
                              <th className="px-3 py-1.5 text-left font-medium">{t('settings.llm.col.name')}</th>
                              <th className="px-3 py-1.5 text-left font-medium">{t('settings.decision.protocol')}</th>
                              <th className="px-1 py-1.5 text-center font-medium">
                                <span className="sr-only">{t('settings.decision.enabled')}</span>
                              </th>
                            </tr>
                          </thead>
                        </table>
                      </div>

                      <div
                        data-testid="decision-model-table"
                        className="max-h-[22rem] overflow-y-auto [scrollbar-gutter:stable]"
                      >
                        <table className="w-full table-fixed border-collapse text-sm">
                          <colgroup>
                            <col />
                            <col style={{ width: '11rem' }} />
                            <col style={{ width: '3.25rem' }} />
                          </colgroup>
                          <tbody className="[&>tr:first-child]:border-t-0">
                            {selected.models.map((model) => (
                              <tr key={model.id} data-testid="decision-model-row" className="border-t border-line align-middle">
                                <td className="px-3 py-1.5">
                                  <div className="flex items-center gap-2">
                                    <ProviderMark providerId={selected.id} size="sm" />
                                    <span className="min-w-0">
                                      <span className="block truncate text-sm-plus text-ink">{model.name}</span>
                                      <span className="block truncate font-mono text-2xs text-ink-tertiary">
                                        {model.id}
                                      </span>
                                    </span>
                                  </div>
                                </td>
                                <td className="px-3 py-1.5">
                                  <span className="font-mono text-2xs text-ink-tertiary">{model.api ?? '—'}</span>
                                </td>
                                <td className="px-1 py-1.5">
                                  <div className="flex items-center justify-center">
                                    <Toggle
                                      label={`${model.name} ${t('settings.decision.enabled')}`}
                                      checked={selected.hasKey && model.enabled}
                                      disabled={!selected.hasKey || saving}
                                      title={selected.hasKey ? undefined : t('settings.decision.enableNeedsKey')}
                                      onChange={(next) => void setModelEnabled(selected, model, next)}
                                    />
                                  </div>
                                </td>
                              </tr>
                            ))}

                            {customOpen ? (
                              <tr
                                ref={customRowRef}
                                data-testid="custom-decision-model-row"
                                className="border-t border-accent/40 bg-accent/5 align-middle"
                              >
                                <td className="px-3 py-1.5">
                                  <div className="flex items-start gap-1.5">
                                    <div className="min-w-0 flex-1 space-y-1">
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
                                        data-testid="custom-decision-model-id"
                                        autoFocus
                                        value={customModel.id}
                                        onChange={(event) =>
                                          setCustomModel((current) => ({ ...current, id: event.target.value }))
                                        }
                                        onKeyDown={(event) => {
                                          if (event.key === 'Escape') cancelCustomModel();
                                        }}
                                        aria-label={t('settings.llm.modelId')}
                                        placeholder={t('settings.decision.addModelPlaceholder')}
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
                                    aria-label={t('settings.decision.protocol')}
                                    value={customModel.api}
                                    onChange={(event) =>
                                      setCustomModel((current) => ({ ...current, api: event.target.value }))
                                    }
                                    className="h-6 w-full rounded border border-line bg-surface px-1 font-mono text-2xs text-ink-tertiary outline-none focus:border-accent"
                                  >
                                    {DECISION_PROTOCOLS.map((protocol) => (
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
                    <p className="mt-1.5 text-xs text-ink-tertiary">{t('settings.decision.pricingHint')}</p>
                    <p className="mt-1 text-xs text-ink-tertiary">{t('settings.decision.configHint')}</p>
                  </div>

                  {models.error ? <p className="text-xs text-danger">{models.error}</p> : null}
                </div>
              </>
            )}
          </div>
        </div>
      </Section>

      <div className="mt-4">
        <Section title={t('settings.decision.tryTitle')} description={t('settings.decision.tryDesc')}>
          <div className="space-y-3 px-4 py-3.5">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink-secondary">
                {t('settings.decision.state')}
              </span>
              <textarea
                data-testid="decision-state"
                value={tryState}
                onChange={(event) => setTryState(event.target.value)}
                placeholder={t('settings.decision.statePlaceholder')}
                rows={4}
                className="w-full resize-y rounded-lg border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-accent"
              />
            </label>

            <div className="flex flex-wrap items-end gap-3">
              <label className="w-40">
                <span className="mb-1 block text-sm font-medium text-ink-secondary">
                  {t('settings.decision.questionType')}
                </span>
                <SelectField
                  ariaLabel={t('settings.decision.questionType')}
                  value={kind}
                  onChange={(next) => setKind(next as QuestionKind)}
                >
                  <option value="bool">{t('settings.decision.bool')}</option>
                  <option value="choice">{t('settings.decision.choice')}</option>
                  <option value="score">{t('settings.decision.score')}</option>
                </SelectField>
              </label>
              <label className="min-w-[16rem] flex-1">
                <span className="mb-1 block text-sm font-medium text-ink-secondary">
                  {t('settings.decision.instructions')}
                </span>
                <TextField
                  ariaLabel={t('settings.decision.instructions')}
                  value={instructions}
                  onChange={setInstructions}
                  placeholder={t('settings.decision.instructionsPlaceholder')}
                />
              </label>
            </div>

            {kind === 'choice' ? (
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-ink-secondary">
                  {t('settings.decision.criteriaChoices')}
                </span>
                <textarea
                  data-testid="decision-choices"
                  value={choiceLines}
                  onChange={(event) => setChoiceLines(event.target.value)}
                  placeholder={t('settings.decision.criteriaChoicesPlaceholder')}
                  rows={3}
                  className="w-full resize-y rounded-lg border border-line bg-surface px-2.5 py-2 font-mono text-xs text-ink outline-none focus:border-accent"
                />
              </label>
            ) : null}

            {kind === 'score' ? (
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-ink-secondary">
                  {t('settings.decision.criteriaLevels')}
                </span>
                <textarea
                  data-testid="decision-levels"
                  value={levelLines}
                  onChange={(event) => setLevelLines(event.target.value)}
                  placeholder={t('settings.decision.criteriaLevelsPlaceholder')}
                  rows={3}
                  className="w-full resize-y rounded-lg border border-line bg-surface px-2.5 py-2 font-mono text-xs text-ink outline-none focus:border-accent"
                />
              </label>
            ) : null}

            <div className="flex items-center gap-3">
              <button
                type="button"
                data-testid="run-decision"
                disabled={trying}
                onClick={() => void runDecision()}
                className={buttonClass.primary}
              >
                {trying ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Play className="size-3.5" />
                )}
                {trying ? t('settings.decision.running') : t('settings.decision.run')}
              </button>
              {tryError ? <p className="text-xs text-danger">{tryError}</p> : null}
            </div>

            {tryResult ? (
              <div data-testid="decision-result" className="rounded-lg border border-line bg-surface-muted px-3 py-2.5">
                <div className="mb-1 flex flex-wrap items-center gap-x-3 text-2xs text-ink-tertiary">
                  <span className="font-mono">{tryResult.model ?? '—'}</span>
                  {tryResult.usage ? (
                    <span>
                      {t('settings.decision.usage', {
                        input: tryResult.usage.inputTokens,
                        output: tryResult.usage.outputTokens,
                      })}
                    </span>
                  ) : null}
                </div>
                {Object.entries(tryResult.answers).map(([name, answer]) => (
                  <div key={name} className="flex items-start gap-2 py-0.5 text-sm">
                    <span className="font-mono text-2xs text-ink-tertiary">{name}</span>
                    <span className="min-w-0 flex-1 text-ink">
                      {answer.type === 'bool'
                        ? `${t('settings.decision.bool')} · ${answer.probability.toFixed(3)}`
                        : answer.type === 'choice'
                          ? `${answer.choice} · ${t('settings.decision.confidence')} ${answer.confidence.toFixed(3)}`
                          : `${answer.score.toFixed(2)} · ${t('settings.decision.confidence')} ${answer.confidence.toFixed(3)}`}
                    </span>
                  </div>
                ))}
                {Object.entries(tryResult.answers).map(([name, answer]) => {
                  const probabilities =
                    answer.type === 'choice' || answer.type === 'score' ? answer.probabilities : undefined;
                  if (!probabilities || Object.keys(probabilities).length === 0) return null;
                  return (
                    <div key={`${name}-p`} className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-ink-tertiary">
                      {Object.entries(probabilities).map(([label, value]) => (
                        <span key={label} className="font-mono">
                          {label} {value.toFixed(3)}
                        </span>
                      ))}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </Section>
      </div>

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
