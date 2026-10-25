import { useEffect, useState, type ReactNode } from 'react';
import { Check, Cloud, KeyRound, Plus, RefreshCw, Trash2, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProviderDraft, ProviderTestResult } from '@opc/shared/domain';
import { useModels } from '../model/useModels';

const API_KINDS = [
  { id: 'openai-completions', label: 'openai-completions（OpenAI 兼容）' },
  { id: 'anthropic-messages', label: 'anthropic-messages（Anthropic）' },
] as const;

/**
 * Model settings: providers on the left, one provider's editor on the right.
 *
 * Three capabilities are shown separately because they are genuinely different in
 * pi: chat ✅, image ✅ (model type exists), video ❌ (pi has no video API).
 */
export function ModelSettings() {
  const { t } = useTranslation();
  const models = useModels();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);

  const selected = models.providers.find((provider) => provider.id === selectedId) ?? null;

  // Keep the editor in sync when the selection or the stored config changes.
  const selectedIdValue = selected?.id;
  const selectedUpdatedAt = selected?.updatedAt;

  useEffect(() => {
    if (!selectedIdValue) {
      setDraft(null);
      return;
    }
    // Re-read from the provider list so an external save re-seeds the editor.
    const provider = models.providers.find((item) => item.id === selectedIdValue);
    if (!provider) return;
    setDraft({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: provider.api,
      isCustom: provider.isCustom,
    });
    setKeyInput('');
    setTestResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIdValue, selectedUpdatedAt]);

  const addProvider = () => {
    const id = `custom-${Date.now().toString(36)}`;
    void models.saveProvider({ id, name: '自定义 Provider', baseUrl: '', api: 'openai-completions', isCustom: true });
    setSelectedId(id);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 shadow-card">
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <span className="text-ink-secondary">
            {t('models.defaultLlm')}：
            <span className="ml-1 font-mono text-ink">
              {models.defaults.llm ? `${models.defaults.llm.providerId}/${models.defaults.llm.modelId}` : t('models.notConfigured')}
            </span>
          </span>
          <span className="text-ink-secondary">
            {t('models.defaultImage')}：
            <span className="ml-1 font-mono text-ink">
              {models.defaults.image ? `${models.defaults.image.providerId}/${models.defaults.image.modelId}` : t('models.notConfigured')}
            </span>
          </span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void models.importFromPi()}
            className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-sm text-ink-secondary hover:border-accent hover:text-accent"
          >
            <Cloud className="size-3.5" />
            {t('models.importPi')}
          </button>
          <button
            type="button"
            onClick={addProvider}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-sm font-medium text-white hover:bg-accent-hover"
          >
            <Plus className="size-3.5" />
            {t('models.addProvider')}
          </button>
        </div>
      </div>

      {models.error ? (
        <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {models.error}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
        <aside className="space-y-1 rounded-xl border border-line bg-surface p-2 shadow-card">
          <p className="px-2 pt-1 pb-2 text-2xs text-ink-quaternary">
            {t('models.providers', { count: models.providers.length })}
          </p>
          {models.providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              data-testid="provider-row"
              onClick={() => setSelectedId(provider.id)}
              className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
                provider.id === selected?.id ? 'bg-accent-soft text-accent-ink' : 'text-ink hover:bg-surface-hover'
              }`}
            >
              <span
                aria-hidden
                className={`size-1.5 shrink-0 rounded-full ${provider.hasKey ? 'bg-success' : 'bg-ink-quaternary'}`}
              />
              <span className="min-w-0 flex-1 truncate">{provider.name}</span>
              <span className="shrink-0 font-mono text-3xs text-ink-quaternary">
                {provider.models.length}
              </span>
            </button>
          ))}
        </aside>

        <section className="space-y-4 rounded-xl border border-line bg-surface p-4 shadow-card">
          {!draft || !selected ? (
            <p className="text-sm text-ink-tertiary">{t('models.pickProvider')}</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('models.field.id')}>
                  <input
                    value={draft.id}
                    disabled
                    className="h-9 w-full rounded-lg border border-line bg-surface-muted px-2.5 font-mono text-sm text-ink-tertiary"
                  />
                </Field>
                <Field label={t('models.field.name')}>
                  <input
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    className="h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent"
                  />
                </Field>
                <Field label={t('models.field.baseUrl')}>
                  <input
                    value={draft.baseUrl}
                    onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                    placeholder="https://api.example.com/v1"
                    className="h-9 w-full rounded-lg border border-line bg-surface px-2.5 font-mono text-sm text-ink outline-none focus:border-accent"
                  />
                </Field>
                <Field label={t('models.field.api')}>
                  <select
                    value={draft.api}
                    onChange={(event) => setDraft({ ...draft, api: event.target.value })}
                    className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent"
                  >
                    {API_KINDS.map((kind) => (
                      <option key={kind.id} value={kind.id}>
                        {kind.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="flex flex-wrap items-end gap-2">
                <Field label={t('models.field.key')} className="min-w-56 flex-1">
                  <input
                    type="password"
                    value={keyInput}
                    onChange={(event) => setKeyInput(event.target.value)}
                    placeholder={selected.hasKey ? '••••••••（已保存，留空则不改动）' : 'sk-...'}
                    className="h-9 w-full rounded-lg border border-line bg-surface px-2.5 font-mono text-sm text-ink outline-none focus:border-accent"
                  />
                </Field>
                <button
                  type="button"
                  onClick={() => void models.setKey(draft.id, keyInput)}
                  className="flex h-9 items-center gap-1.5 rounded-lg border border-line px-2.5 text-sm text-ink-secondary hover:border-accent hover:text-accent"
                >
                  <KeyRound className="size-3.5" />
                  {t('common.save')}
                </button>
                <button
                  type="button"
                  onClick={() => void models.saveProvider(draft)}
                  className="h-9 rounded-lg border border-line px-2.5 text-sm text-ink-secondary hover:border-accent hover:text-accent"
                >
                  {t('models.saveProvider')}
                </button>
                <button
                  type="button"
                  onClick={async () => setTestResult(await models.test(draft.id))}
                  className="h-9 rounded-lg border border-line px-2.5 text-sm text-ink-secondary hover:border-accent hover:text-accent"
                >
                  {t('models.test')}
                </button>
                <button
                  type="button"
                  onClick={() => void models.refreshModels(draft.id)}
                  className="flex h-9 items-center gap-1.5 rounded-lg border border-line px-2.5 text-sm text-ink-secondary hover:border-accent hover:text-accent"
                >
                  <RefreshCw className="size-3.5" />
                  {t('models.refresh')}
                </button>
                {selected.isCustom ? (
                  <button
                    type="button"
                    onClick={() => {
                      void models.removeProvider(draft.id);
                      setSelectedId(null);
                    }}
                    className="flex h-9 items-center gap-1.5 rounded-lg border border-danger/40 px-2.5 text-sm text-danger hover:bg-danger/10"
                  >
                    <Trash2 className="size-3.5" />
                    {t('models.remove')}
                  </button>
                ) : null}
              </div>

              {testResult ? (
                <p
                  className={`rounded-lg px-2.5 py-2 text-2xs ${
                    testResult.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
                  }`}
                >
                  {testResult.ok ? '✓ ' : '✕ '}
                  {testResult.message}
                  {testResult.durationMs ? ` · ${testResult.durationMs}ms` : ''}
                </p>
              ) : null}

              <CapabilityBlock
                title={t('models.capability.chat')}
                hint={t('models.capability.chatHint')}
                models={models.modelsOf(selected, 'chat')}
                activeRef={models.defaults.llm}
                providerId={selected.id}
                onSelect={(modelId) =>
                  void models.setDefault('llm', modelId ? { providerId: selected.id, modelId } : null)
                }
                emptyHint={t('models.emptyModels')}
              />

              <CapabilityBlock
                title={t('models.capability.image')}
                hint={t('models.capability.imageHint')}
                models={models.modelsOf(selected, 'image')}
                activeRef={models.defaults.image}
                providerId={selected.id}
                onSelect={(modelId) =>
                  void models.setDefault('image', modelId ? { providerId: selected.id, modelId } : null)
                }
                emptyHint={t('models.emptyImageModels')}
              />

              <div className="rounded-lg border border-dashed border-line-strong px-3 py-2.5">
                <div className="flex items-center gap-2 text-sm font-medium text-ink-secondary">
                  <Video className="size-4" />
                  {t('models.capability.video')}
                </div>
                <p className="mt-1 text-2xs leading-relaxed text-ink-tertiary">
                  {t('models.capability.videoHint')}
                </p>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function CapabilityBlock({
  title,
  hint,
  models,
  activeRef,
  providerId,
  onSelect,
  emptyHint,
}: {
  title: string;
  hint: string;
  models: readonly { id: string; name: string }[];
  activeRef: { providerId: string; modelId: string } | null;
  providerId: string;
  onSelect: (modelId: string | null) => void;
  emptyHint: string;
}) {
  const { t } = useTranslation();
  const active = activeRef?.providerId === providerId ? activeRef.modelId : null;

  return (
    <div className="rounded-lg border border-line px-3 py-2.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink">{title}</span>
        {active ? (
          <span className="flex items-center gap-1 text-2xs text-success">
            <Check className="size-3" />
            {t('models.inUse')}
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 text-2xs text-ink-quaternary">{hint}</p>

      {models.length === 0 ? (
        <p className="mt-2 text-2xs text-ink-tertiary">{emptyHint}</p>
      ) : (
        <div className="mt-2 max-h-44 space-y-1 overflow-y-auto">
          {models.map((model) => (
            <label
              key={model.id}
              className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs ${
                active === model.id ? 'bg-accent-soft text-accent-ink' : 'text-ink-secondary hover:bg-surface-hover'
              }`}
            >
              <input
                type="radio"
                checked={active === model.id}
                onChange={() => onSelect(model.id)}
                className="accent-[var(--accent)]"
              />
              <span className="truncate font-mono">{model.id}</span>
            </label>
          ))}
        </div>
      )}

      {active ? (
        <button
          type="button"
          onClick={() => onSelect(null)}
          className="mt-1 text-2xs text-ink-tertiary hover:text-danger"
        >
          {t('models.clearDefault')}
        </button>
      ) : null}
    </div>
  );
}

function Field({
  label,
  children,
  className = '',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-2xs font-medium text-ink-secondary">{label}</span>
      {children}
    </label>
  );
}
