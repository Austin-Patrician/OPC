import { useState, type FormEvent, type ReactNode } from 'react';
import { X, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Agent, Budget, CreateTaskResult } from '@opc/shared/domain';

export interface DispatchDraft {
  title: string;
  brief: string;
  deliverableSpec: string;
  assigneeId: string;
  estTokens: number;
  acceptanceCommand: string[];
  acceptanceTemplate: 'http-ok' | 'image-200';
}

interface DispatchTaskDialogProps {
  agents: readonly Agent[];
  defaultAssigneeId: string;
  budgetFor: (employeeId: string) => Budget | undefined;
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
  budgetFor,
  onSubmit,
  onClose,
}: DispatchTaskDialogProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('写一个 hello world HTTP 服务');
  const [brief, setBrief] = useState(
    '用 Node 内置 http 模块实现：GET / 返回纯文本 ok；监听 process.env.PORT（默认 3000）；不引入依赖。',
  );
  const [deliverableSpec, setDeliverableSpec] = useState(
    'server.js：可直接 `node server.js` 启动，GET / 返回 "ok"',
  );
  const [assigneeId, setAssigneeId] = useState(defaultAssigneeId);
  const [estTokens, setEstTokens] = useState(6000);
  const [template, setTemplate] = useState<'http-ok' | 'image-200'>('http-ok');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const budget = budgetFor(assigneeId);
  // Client-side pre-check is UX only; the main process is the authority.
  const insufficient = budget ? budget.availableTokens < estTokens || budget.isStopped : false;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || !title.trim() || !deliverableSpec.trim() || insufficient) return;
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
              required
              className="h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent"
            />
          </Field>

          <Field label={t('task.field.brief')}>
            <textarea
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              rows={2}
              className="w-full resize-none rounded-lg border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none focus:border-accent"
            />
          </Field>

          <Field label={t('task.field.deliverable')}>
            <input
              value={deliverableSpec}
              onChange={(event) => setDeliverableSpec(event.target.value)}
              required
              className="h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t('task.field.assignee')}>
              <select
                value={assigneeId}
                onChange={(event) => setAssigneeId(event.target.value)}
                className="h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent"
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} · {agent.role}
                  </option>
                ))}
              </select>
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
              <select
                aria-label={t('task.acceptance')}
                value={template}
                onChange={(event) => setTemplate(event.target.value as 'http-ok' | 'image-200')}
                className="h-6 rounded border border-line bg-surface px-1.5 text-2xs text-ink outline-none focus:border-accent"
              >
                <option value="http-ok">{t('task.template.httpOk')}</option>
                <option value="image-200">{t('task.template.image200')}</option>
              </select>
            </div>
            <p className="mt-1 text-3xs leading-relaxed text-ink-quaternary">
              {template === 'image-200' ? t('task.template.imageHint') : t('task.acceptanceHint')}
            </p>
          </div>

          {budget ? (
            <div
              className={`rounded-lg px-2.5 py-2 text-2xs ${
                budget.isStopped
                  ? 'bg-danger/10 text-danger'
                  : insufficient
                    ? 'bg-warning/10 text-warning'
                    : 'bg-surface-muted text-ink-secondary'
              }`}
            >
              <div className="flex items-center justify-between">
                <span>{t('budget.employee')}</span>
                <span className="font-mono">
                  {budget.usedTokens.toLocaleString()} / {budget.limitTokens.toLocaleString()}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span>{t('budget.available')}</span>
                <span className="font-mono">{budget.availableTokens.toLocaleString()}</span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span>{t('budget.impact', { tokens: estTokens.toLocaleString() })}</span>
                <span className="font-mono">
                  {(budget.availableTokens - estTokens).toLocaleString()}
                </span>
              </div>
            </div>
          ) : null}

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
            disabled={submitting || insufficient}
            title={insufficient ? t('budget.blockedHint') : undefined}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {submitting ? t('task.running') : insufficient ? t('budget.blocked') : t('task.submit')}
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
