import { useState, type FormEvent, type ReactNode } from 'react';
import { X, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CreateTaskResult } from '@opc/shared/domain';
import { Select } from '@/shared/ui/Select';

export interface DispatchDraft {
  title: string;
  brief: string;
  deliverableSpec: string;
  assigneeId: string;
  estTokens: number;
  acceptanceCommand: string[];
  acceptanceTemplate: 'http-ok' | 'image-200';
}

/** 谁可以被派活：一个执行体。 */
export interface DispatchCandidate {
  id: string;
  name: string;
  role: string;
}

interface DispatchTaskDialogProps {
  agents: readonly DispatchCandidate[];
  defaultAssigneeId: string;
  onSubmit: (draft: DispatchDraft) => Promise<CreateTaskResult>;
  onClose: () => void;
}

/**
 * The "派活" form from the design: deliverable + acceptance + estimate are all
 * required, because a task without them cannot be graded.
 *
 * The acceptance command is system-owned (a checker outside the workspace), so
 * it is shown read-only rather than editable by the employee.
 */
export function DispatchTaskDialog({
  agents,
  defaultAssigneeId,
  onSubmit,
  onClose,
}: DispatchTaskDialogProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [deliverableSpec, setDeliverableSpec] = useState('');
  const [assigneeId, setAssigneeId] = useState(defaultAssigneeId);
  const [estTokens, setEstTokens] = useState(6000);
  const [template, setTemplate] = useState<'http-ok' | 'image-200'>('http-ok');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Client-side pre-check is UX only; the main process is the authority.

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || !title.trim() || !deliverableSpec.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onSubmit({
        title: title.trim(),
        brief: brief.trim(),
        deliverableSpec: deliverableSpec.trim(),
        assigneeId,
        estTokens,
        acceptanceCommand: ['node', '{checks}/verify.mjs'],
        acceptanceTemplate: template,
      });

      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-line bg-surface shadow-popover"
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="flex items-center gap-2 text-base-plus font-semibold text-ink">
            <Zap className="size-4 text-accent" />
            {t('task.dispatch')}
          </h2>
          <button type="button" onClick={onClose} aria-label={t('common.close')}>
            <X className="size-4 text-ink-tertiary hover:text-ink" />
          </button>
        </header>

        <div className="space-y-3 px-4 py-3">
          <Field label={t('task.field.title')}>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t('task.placeholder.title')}
              required
              className="h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-ink outline-none placeholder:text-ink-quaternary focus:border-accent"
            />
          </Field>

          <Field label={t('task.field.brief')}>
            <textarea
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              rows={2}
              placeholder={t('task.placeholder.brief')}
              className="w-full resize-none rounded-lg border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none placeholder:text-ink-quaternary focus:border-accent"
            />
          </Field>

          <Field label={t('task.field.deliverable')}>
            <input
              value={deliverableSpec}
              onChange={(event) => setDeliverableSpec(event.target.value)}
              placeholder={t('task.placeholder.deliverable')}
              required
              className="h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-ink outline-none placeholder:text-ink-quaternary focus:border-accent"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t('task.field.assignee')}>
              <Select
                ariaLabel={t('task.field.assignee')}
                value={assigneeId}
                onValueChange={setAssigneeId}
                size="large"
                options={agents.map((agent) => ({ value: agent.id, label: `${agent.name} · ${agent.role}` }))}
              />
            </Field>

            <Field label={t('task.field.tokens')}>
              <input
                type="number"
                min={500}
                step={500}
                value={estTokens}
                onChange={(event) => setEstTokens(Number(event.target.value))}
                className="h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent"
              />
            </Field>
          </div>

          <div className="rounded-lg bg-surface-muted px-2.5 py-2">
            <div className="flex items-center justify-between">
              <span className="text-2xs font-medium text-ink-secondary">{t('task.acceptance')}</span>
              <Select
                ariaLabel={t('task.acceptance')}
                value={template}
                onValueChange={(next) => setTemplate(next as 'http-ok' | 'image-200')}
                size="compact"
                className="w-auto max-w-40"
                options={[
                  { value: 'http-ok', label: t('task.template.httpOk') },
                  { value: 'image-200', label: t('task.template.image200') },
                ]}
              />
            </div>
            <p className="mt-1 text-3xs leading-relaxed text-ink-quaternary">
              {template === 'image-200' ? t('task.template.imageHint') : t('task.acceptanceHint')}
            </p>
          </div>


          {error ? (
            <p className="rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-2 text-2xs text-danger">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex justify-end gap-2 border-t border-line bg-surface-muted px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-ink-secondary hover:text-ink"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {submitting ? t('task.running') : t('task.submit')}
          </button>
        </footer>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-2xs font-medium text-ink-secondary">{label}</span>
      {children}
    </label>
  );
}
