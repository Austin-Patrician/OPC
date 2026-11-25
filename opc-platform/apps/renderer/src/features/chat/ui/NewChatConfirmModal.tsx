import { useEffect, useState } from 'react';
import { LoaderCircle, Sparkles, SquarePen, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RouterContextStats } from '@opc/shared/domain';

interface NewChatConfirmModalProps {
  onClose: () => void;
}

export function NewChatConfirmModal({ onClose }: NewChatConfirmModalProps) {
  const { t } = useTranslation();
  const [reflectMemory, setReflectMemory] = useState(true);
  const [abortRunningTasks, setAbortRunningTasks] = useState(true);
  const [runningCount, setRunningCount] = useState(0);
  const [contextStats, setContextStats] = useState<RouterContextStats | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, submitting]);

  useEffect(() => {
    let active = true;
    void window.opc?.chat
      .getContextStats()
      .then((stats) => {
        if (active) setContextStats(stats);
      })
      .catch(() => undefined);

    void window.opc?.work
      .listTasks(25)
      .then((tasks) => {
        if (!active) return;
        const count = tasks.filter(
          (task) => task.status === 'running' || task.status === 'open',
        ).length;
        setRunningCount(count);
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  const handleConfirm = async () => {
    if (submitting) return;
    setError('');
    setSubmitting(true);
    try {
      const bridge = window.opc;
      if (!bridge) throw new Error(t('chat.newChat.failed'));
      const result = await bridge.chat.resetContext({
        clearHistory: true,
        reflectMemory,
        abortRunningTasks,
      });
      if (!result.ok) {
        throw new Error(result.reason || t('chat.newChat.failed'));
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const ratioPercent = contextStats
    ? Math.min(100, Math.max(0, Math.round(contextStats.usageRatio * 100)))
    : 0;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/35 px-4 py-8 backdrop-blur-[3px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-chat-modal-title"
        className="buddy-search-modal buddy-search-enter w-full max-w-[440px] overflow-hidden rounded-2xl border border-line bg-surface text-ink shadow-popover"
      >
        <div className="flex items-start gap-3 px-5 pt-5 pb-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
            <SquarePen size={18} strokeWidth={1.9} />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="new-chat-modal-title"
              className="text-[15px] font-semibold tracking-tight text-ink"
            >
              {t('chat.newChat.title')}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
              {t('chat.newChat.description')}
            </p>
          </div>
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-ink-tertiary transition hover:bg-surface-hover hover:text-ink disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 px-5 pb-4">
          <div className="rounded-xl border border-line bg-surface-muted/70 px-3.5 py-2.5 text-[12px] leading-relaxed text-ink-secondary">
            <div className="flex items-center gap-1.5 font-medium text-ink">
              <Sparkles size={13} className="shrink-0 text-accent-ink" />
              <span>{t('chat.newChat.memoryKeptTitle')}</span>
            </div>
            <p className="mt-1 text-[11.5px] text-ink-tertiary">
              {t('chat.newChat.memoryKeptNote')}
            </p>
            {contextStats && contextStats.entryCount > 0 ? (
              <p className="mt-1.5 font-mono text-[11px] text-ink-quaternary">
                {t('chat.newChat.contextSummary', {
                  entries: contextStats.entryCount,
                  percent: ratioPercent,
                })}
              </p>
            ) : null}
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-line/80 px-3.5 py-2.5 transition hover:border-line-strong hover:bg-surface-muted/40 select-none">
            <input
              type="checkbox"
              checked={reflectMemory}
              disabled={submitting}
              onChange={(event) => setReflectMemory(event.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 accent-accent"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] font-medium text-ink">
                {t('chat.newChat.reflectMemoryLabel')}
              </span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-tertiary">
                {t('chat.newChat.reflectMemoryHint')}
              </span>
            </span>
          </label>

          {runningCount > 0 ? (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-warning/35 bg-warning/5 px-3.5 py-2.5 transition select-none">
              <input
                type="checkbox"
                checked={abortRunningTasks}
                disabled={submitting}
                onChange={(event) => setAbortRunningTasks(event.target.checked)}
                className="mt-0.5 size-3.5 shrink-0 accent-accent"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] font-medium text-ink">
                  {t('chat.newChat.abortRunningLabel', { count: runningCount })}
                </span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-tertiary">
                  {t('chat.newChat.abortRunningHint')}
                </span>
              </span>
            </label>
          ) : null}

          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line bg-surface-muted/45 px-5 py-3">
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            className="h-8 rounded-lg border border-line bg-surface px-3.5 text-xs font-medium text-ink-secondary transition hover:border-line-strong hover:bg-surface-hover hover:text-ink disabled:opacity-40"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void handleConfirm()}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--primary-btn-bg)] px-3.5 text-xs font-medium text-[var(--primary-btn-text)] transition hover:bg-[var(--primary-btn-hover)] disabled:opacity-60"
          >
            {submitting ? <LoaderCircle size={13} className="animate-spin" /> : null}
            <span>{submitting ? t('chat.newChat.confirming') : t('chat.newChat.confirm')}</span>
          </button>
        </footer>
      </section>
    </div>
  );
}
