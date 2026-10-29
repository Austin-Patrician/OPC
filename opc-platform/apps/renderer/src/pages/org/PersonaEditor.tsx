import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, Pencil, X } from 'lucide-react';

/**
 * 岗位职责（persona）的编辑区。
 *
 * It is stored on the employee row and injected into the agent's next task and
 * next 1v1 reply, so the editor saves through the bridge instead of local state.
 * Kept as a standalone component because other entry points (bulk provisioning,
 * candidate conversion) need the same editor.
 */
export function PersonaEditor({
  persona,
  onSave,
}: {
  persona: string;
  onSave: (persona: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(persona);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // A save or a transfer refreshes the member; when not editing, follow the row.
  useEffect(() => {
    if (!editing) setDraft(persona);
  }, [persona, editing]);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const start = () => {
    setDraft(persona);
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    if (saving) return;
    setEditing(false);
    setError(null);
    setDraft(persona);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft.trim());
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="border-t border-line px-5 py-4">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h4 className="min-w-0 truncate text-2xs font-semibold text-ink-tertiary">{t('org.personaTitle')}</h4>
        {editing ? (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              data-testid="persona-cancel"
              disabled={saving}
              onClick={cancel}
              className="flex h-6 items-center gap-1 rounded-md px-1.5 text-3xs text-ink-tertiary transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-40"
            >
              <X className="size-3" aria-hidden />
              {t('common.cancel')}
            </button>
            <button
              type="button"
              data-testid="persona-save"
              disabled={saving}
              onClick={() => void save()}
              className="flex h-6 items-center gap-1 rounded-md bg-accent px-2 text-3xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-60"
            >
              {saving ? (
                <Loader2 className="size-3 animate-spin" aria-hidden />
              ) : (
                <Check className="size-3" aria-hidden />
              )}
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            data-testid="persona-edit"
            onClick={start}
            className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-3xs text-ink-tertiary transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <Pencil className="size-3" aria-hidden />
            {t('common.edit')}
          </button>
        )}
      </div>

      {editing ? (
        <>
          <textarea
            ref={textareaRef}
            data-testid="persona-input"
            rows={6}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                cancel();
              }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void save();
              }
            }}
            placeholder={t('org.personaHint')}
            className="w-full resize-y rounded-lg border border-line bg-surface px-2.5 py-2 font-mono text-2xs leading-relaxed text-ink outline-none focus:border-accent"
          />
          <p className="mt-1 text-3xs leading-relaxed text-ink-quaternary">
            {t('org.personaEditHint')}
          </p>
        </>
      ) : persona ? (
        <pre className="max-h-48 overflow-y-auto rounded-lg border border-line bg-surface-muted p-3 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-ink-secondary select-text">
          {persona}
        </pre>
      ) : (
        <p className="text-2xs text-ink-quaternary">{t('org.personaEmpty')}</p>
      )}

      {error ? <p className="mt-1.5 text-3xs text-danger">{error}</p> : null}
    </section>
  );
}
