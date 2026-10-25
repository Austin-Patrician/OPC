import { useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProviderDraft } from '@opc/shared/domain';
import { buttonClass, Field, SelectField, TextField } from '../kit';

/**
 * "添加 Provider" modal: id, display name, base URL and the pi API kind.
 * The API list comes from pi's catalog (14 kinds), not from a hard-coded pair.
 */
export function AddProviderDialog({
  apiKinds,
  onClose,
  onCreate,
}: {
  apiKinds: readonly string[];
  onClose: () => void;
  onCreate: (draft: ProviderDraft) => void;
}) {
  const { t } = useTranslation();
  const [id, setId] = useState(`custom-${Date.now().toString(36)}`);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [api, setApi] = useState(apiKinds[0] ?? 'openai-completions');

  const valid = name.trim().length > 0 && id.trim().length > 0 && baseUrl.trim().length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          onCreate({ id: id.trim(), name: name.trim(), baseUrl: baseUrl.trim(), api, isCustom: true });
          onClose();
        }}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-line bg-surface shadow-popover"
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-base-plus font-semibold text-ink">{t('settings.llm.addProvider')}</h2>
          <button type="button" onClick={onClose} aria-label={t('common.close')}>
            <X className="size-4 text-ink-tertiary hover:text-ink" />
          </button>
        </header>

        <div className="space-y-3 px-4 py-3">
          <Field label={t('models.field.name')}>
            <TextField ariaLabel={t('models.field.name')} value={name} onChange={setName} placeholder="My relay" />
          </Field>
          <Field label={t('models.field.id')} hint={t('settings.llm.idHint')}>
            <TextField ariaLabel={t('models.field.id')} value={id} onChange={setId} mono />
          </Field>
          <Field label={t('models.field.baseUrl')} hint={t('settings.llm.baseUrlHint')}>
            <TextField
              ariaLabel={t('models.field.baseUrl')}
              value={baseUrl}
              onChange={setBaseUrl}
              placeholder="https://api.example.com/v1"
              mono
            />
          </Field>
          <Field label={t('models.field.api')} hint={t('settings.llm.apiHint', { count: apiKinds.length })}>
            <SelectField ariaLabel={t('models.field.api')} value={api} onChange={setApi}>
              {apiKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </SelectField>
          </Field>
        </div>

        <footer className="flex justify-end gap-2 border-t border-line bg-surface-muted px-4 py-3">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={!valid} className={buttonClass.primary}>
            {t('settings.llm.createProvider')}
          </button>
        </footer>
      </form>
    </div>
  );
}
