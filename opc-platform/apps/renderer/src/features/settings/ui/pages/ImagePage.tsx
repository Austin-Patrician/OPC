import { useMemo, useState } from 'react';
import { Check, Plus, Search, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProviderConfig } from '@opc/shared/domain';
import { useModels } from '@/features/models/model/useModels';
import { ProviderMark } from '@/shared/ui/ProviderMark';
import { vendorProviderId } from '@/shared/providers/visuals';
import { cn } from '@/shared/lib/cn';
import { buttonClass, KeyTag, PageHeader, Section, SelectField, StatusBadge, TextField } from '../kit';
import { AddProviderDialog } from './AddProviderDialog';

/** Protocols an image model can speak. */
const IMAGE_PROTOCOLS = ['openai-images', 'openrouter-images'] as const;

/**
 * Settings → 模型 → Image, same two-pane shape as LLM:
 * providers on the left, that provider's image models on the right (scrollable),
 * plus a compact generator and an "add model" row with its protocol.
 */
export function ImagePage({ onOpenLlmProvider }: { onOpenLlmProvider?: (providerId: string) => void }) {
  const { t } = useTranslation();
  const models = useModels();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>('');
  const [addOpen, setAddOpen] = useState(false);
  const [newModelId, setNewModelId] = useState('');
  const [newProtocol, setNewProtocol] = useState<string>(IMAGE_PROTOCOLS[0]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ url: string; bytes: number; model: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const providersWithImages = useMemo(
    () =>
      models.providers
        .map((provider) => ({
          provider,
          images: provider.models.filter((model) => model.capability === 'image'),
        }))
        .filter((entry) => entry.images.length > 0),
    [models.providers],
  );

  const selected =
    providersWithImages.find((entry) => entry.provider.id === selectedId) ?? providersWithImages[0];
  const needle = query.trim().toLowerCase();
  const visibleProviders = providersWithImages.filter(
    (entry) =>
      !needle ||
      entry.provider.id.includes(needle) ||
      entry.provider.name.toLowerCase().includes(needle) ||
      entry.images.some((model) => model.id.toLowerCase().includes(needle)),
  );

  const generate = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.opc!.images.generate({ prompt });
      if (result.ok && result.dataUrl) {
        setPreview({ url: result.dataUrl, bytes: result.bytes ?? 0, model: result.model ?? '' });
      } else {
        setError(result.error ?? t('settings.image.generateFailed'));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const addModel = async (provider: ProviderConfig) => {
    if (!newModelId.trim()) return;
    await models.setModels(provider.id, [
      ...provider.models,
      { id: newModelId.trim(), name: newModelId.trim(), capability: 'image', api: newProtocol },
    ]);
    setNewModelId('');
  };

  return (
    <>
      <PageHeader
        crumbs={[t('settings.group.models'), 'Image']}
        title={t('settings.image.title')}
        description={t('settings.image.descProvider')}
        actions={
          <button type="button" data-testid="add-provider" onClick={() => setAddOpen(true)} className={buttonClass.secondary}>
            <Plus className="size-3.5" />
            {t('settings.llm.addProvider')}
          </button>
        }
      />

      {/* One global default: it drives both the generator and the agent tool. */}
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
              const [providerId = '', modelId = ''] = next.split('::');
              void models.setDefault('image', providerId && modelId ? { providerId, modelId } : null);
            }}
          >
            <option value="">{t('settings.image.noDefault')}</option>
            {providersWithImages.map(({ provider, images }) => (
              <optgroup key={provider.id} label={provider.name}>
                {images.map((model) => (
                  <option key={model.id} value={`${provider.id}::${model.id}`}>
                    {model.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </SelectField>
        </div>
      </div>

      <Section title={t('settings.image.providersTitle')} description={t('settings.image.providersDesc')}>
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
              {visibleProviders.map(({ provider, images }) => {
                const active = provider.id === selected?.provider.id;
                return (
                  <button
                    key={provider.id}
                    type="button"
                    data-testid="provider-row"
                    onClick={() => setSelectedId(provider.id)}
                    className={cn(
                      'flex h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors',
                      active ? 'bg-surface-active' : 'hover:bg-ink/5',
                    )}
                  >
                    <ProviderMark providerId={provider.id} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm-plus font-medium text-ink">{provider.name}</span>
                      <span className="block truncate font-mono text-2xs text-ink-tertiary">
                        {images.length} models
                      </span>
                    </span>
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: provider.hasKey ? 'var(--success)' : 'var(--text-quaternary)' }}
                    />
                  </button>
                );
              })}
              {visibleProviders.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-ink-tertiary">{t('settings.image.emptyProvider')}</p>
              ) : null}
            </nav>
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            {!selected ? (
              <p className="p-6 text-sm text-ink-tertiary">{t('settings.image.emptyProvider')}</p>
            ) : (
              <>
                <div className="flex items-start gap-3 border-b border-line px-5 py-4">
                  <ProviderMark providerId={selected.provider.id} size="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-lg font-bold text-ink">{selected.provider.name}</h4>
                      <StatusBadge
                        tone={selected.provider.hasKey ? 'green' : 'amber'}
                        label={
                          selected.provider.hasKey ? t('settings.llm.keyReady') : t('settings.llm.unconfigured')
                        }
                      />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <KeyTag>{selected.provider.baseUrl || '—'}</KeyTag>
                      {onOpenLlmProvider ? (
                        <button
                          type="button"
                          onClick={() => onOpenLlmProvider(selected.provider.id)}
                          className="text-xs text-accent-ink hover:text-accent"
                        >
                          {t('settings.image.viewInLlm')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="space-y-4 px-5 py-4">
                  <div className="rounded-lg border border-line px-3 py-2.5">
                    <div className="mb-2 text-sm font-medium text-ink-secondary">{t('settings.image.generateTitle')}</div>
                    <textarea
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      rows={2}
                      placeholder={t('settings.image.promptPlaceholder')}
                      className="w-full resize-none rounded-lg border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-accent"
                    />
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        data-testid="image-generate"
                        onClick={() => void generate()}
                        disabled={busy || !prompt.trim()}
                        className={cn(buttonClass.primary, 'disabled:opacity-50')}
                      >
                        {busy ? t('settings.image.generating') : t('settings.image.generate')}
                      </button>
                      <span className="font-mono text-2xs text-ink-quaternary">
                        {models.defaults.image
                          ? `${models.defaults.image.providerId}/${models.defaults.image.modelId}`
                          : t('settings.image.pickModelFirst')}
                      </span>
                    </div>
                    {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
                    {preview ? (
                      <figure className="mt-2 space-y-1">
                        <img src={preview.url} alt={prompt} className="max-h-48 rounded-lg border border-line object-contain" />
                        <figcaption className="font-mono text-2xs text-ink-quaternary">
                          {preview.model} · {preview.bytes} B
                        </figcaption>
                      </figure>
                    ) : null}
                  </div>

                  <div>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-sm font-medium text-ink-secondary">{t('settings.image.modelsTitle')}</span>
                      <KeyTag>{t('settings.image.protocols', { list: IMAGE_PROTOCOLS.join(' / ') })}</KeyTag>
                    </div>
                    <div className="max-h-[22rem] overflow-y-auto rounded-lg border border-line">
                      <table className="w-full table-fixed border-collapse text-sm">
                        <thead className="sticky top-0 bg-surface-muted">
                          <tr className="text-2xs text-ink-tertiary">
                            <th className="px-3 py-1.5 text-left font-medium">{t('settings.llm.col.name')}</th>
                            <th className="w-[8.5rem] px-2 py-1.5 text-left font-medium">{t('settings.image.protocol')}</th>
                            <th className="w-[6rem] px-2 py-1.5 text-right font-medium">{t('settings.llm.col.default')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selected.images.map((model) => {
                            const isDefault =
                              models.defaults.image?.providerId === selected.provider.id &&
                              models.defaults.image?.modelId === model.id;
                            return (
                              <tr key={model.id} data-testid="image-model-row" className="border-t border-line">
                                <td className="px-3 py-1.5">
                                  <div className="flex items-center gap-2">
                                    <ProviderMark
                                      providerId={vendorProviderId(
                                        model.id.includes('/') ? (model.id.split('/')[0] ?? selected.provider.id) : selected.provider.id,
                                      )}
                                      size="sm"
                                    />
                                    <span className="min-w-0">
                                      <span className="block truncate text-sm-plus text-ink">{model.name}</span>
                                      <span className="block truncate font-mono text-2xs text-ink-tertiary">{model.id}</span>
                                    </span>
                                  </div>
                                </td>
                                <td className="px-2 py-1.5 font-mono text-2xs text-ink-tertiary">
                                  {model.api ?? 'openai-images'}
                                </td>
                                <td className="px-2 py-1.5 text-right">
                                  {isDefault ? (
                                    <span className="inline-flex items-center gap-1 text-xs font-medium text-accent-ink">
                                      <Check className="size-3" />
                                      {t('settings.image.current')}
                                    </span>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        void models.setDefault('image', { providerId: selected.provider.id, modelId: model.id })
                                      }
                                      className="text-xs text-accent-ink hover:text-accent"
                                    >
                                      {t('settings.image.setDefault')}
                                    </button>
                                  )}
                                </td>
                                <td className="px-2 py-1.5 text-right">
                                  <button
                                    type="button"
                                    aria-label={t('models.remove')}
                                    onClick={() =>
                                      void models.setModels(
                                        selected.provider.id,
                                        selected.provider.models.filter((entry) => entry.id !== model.id),
                                      )
                                    }
                                    className="text-ink-quaternary hover:text-danger"
                                  >
                                    <Trash2 className="size-3" />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <div className="min-w-[12rem] flex-1">
                        <TextField
                          ariaLabel={t('settings.image.addModel')}
                          value={newModelId}
                          onChange={setNewModelId}
                          placeholder={t('settings.image.addModelPlaceholder')}
                          mono
                        />
                      </div>
                      <SelectField
                        ariaLabel={t('settings.image.protocol')}
                        value={newProtocol}
                        onChange={setNewProtocol}
                        className="w-[10.5rem]"
                      >
                        {IMAGE_PROTOCOLS.map((protocol) => (
                          <option key={protocol} value={protocol}>
                            {protocol}
                          </option>
                        ))}
                      </SelectField>
                      <button
                        type="button"
                        disabled={!newModelId.trim()}
                        onClick={() => void addModel(selected.provider)}
                        className={cn(buttonClass.secondary, 'disabled:opacity-50')}
                      >
                        <Plus className="size-3.5" />
                        {t('settings.image.addModel')}
                      </button>
                    </div>
                    <p className="mt-1.5 text-xs text-ink-tertiary">{t('settings.image.protocolHint')}</p>
                  </div>
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
            setSelectedId(draft.id);
          }}
        />
      ) : null}
    </>
  );
}
