import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkTask as WorkTaskModel } from '@opc/shared/domain';
import type { TaskStatus, WorkTask } from '../model/types';
import { getWorkTransport } from '@/shared/api/workTransport';

const STATUS_STYLE: Record<TaskStatus, string> = {
  open: 'bg-ink/5 text-ink-tertiary',
  running: 'bg-accent-soft text-accent-ink',
  review: 'bg-amber/12 text-amber',
  accepted: 'bg-success/12 text-success',
  delivered: 'bg-success/20 text-success',
  rejected: 'bg-danger/12 text-danger',
  failed: 'bg-danger/12 text-danger',
  cancelled: 'bg-ink/5 text-ink-tertiary',
};

/**
 * Task card: the task's whole life in one object — status, who did it, what was
 * produced, and the acceptance evidence the system actually observed.
 */
export function TaskCard({ task }: { task: WorkTask }) {
  const { t } = useTranslation();
  const [decided, setDecided] = useState<WorkTaskModel | null>(null);
  const current = decided ?? task;
  const decide = async (decision: 'approve' | 'reject') => {
    const updated = await window.opc!.work.bossDecision(task.id, decision);
    setDecided(updated);
  };
  const evidence = task.acceptance?.evidence;
  const recentSteps = task.steps.slice(-4);

  return (
    <article
      className="w-full max-w-[30.625rem] rounded-[0.625rem] border border-line/60 bg-surface px-4 py-3 shadow-card"
      aria-label={t('task.card')}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <span
              className={`rounded px-1.5 py-0.5 text-2xs font-medium ${STATUS_STYLE[task.status]}`}
            >
              {t(`task.status.${task.status}`)}
            </span>
            <span className="truncate text-xs font-semibold text-ink">{task.title}</span>
          </div>
          <p className="text-2xs text-ink-tertiary">
            {t('task.assignee')}：{task.assigneeName} · {t('task.estTokens', { tokens: task.estTokens })}
            {task.attempts > 1 ? ` · ${t('task.attempts', { count: task.attempts })}` : ''}
            {task.tokensUsed > 0 ? ` · ${t('task.tokensUsed', { tokens: task.tokensUsed.toLocaleString() })}` : ''}
            {task.costUsd > 0 ? ` · $${task.costUsd.toFixed(4)}` : ''}
          </p>
        </div>
      </header>

      <p className="mt-2 rounded bg-surface-muted px-2 py-1.5 text-2xs leading-relaxed text-ink-secondary">
        <span className="text-ink-tertiary">{t('task.deliverable')}：</span>
        {task.deliverableSpec}
      </p>

      {recentSteps.length > 0 ? (
        <ol className="mt-2 space-y-1">
          {recentSteps.map((step, index) => (
            <li key={`${step.at}-${index}`} className="flex gap-2 text-2xs text-ink-secondary">
              <span aria-hidden className="mt-1 size-1 shrink-0 rounded-full bg-accent/60" />
              <span className="min-w-0 break-words">{step.text}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {task.artifacts.length > 0 ? (
        <ArtifactGrid taskId={task.id} artifacts={task.artifacts} />
      ) : null}

      {task.childCount > 0 ? <SubtaskTree parentId={task.id} count={task.childCount} /> : null}

      {current.status === 'accepted' ? (
        <div className="mt-2 flex items-center justify-end gap-2 border-t border-line pt-2 text-2xs">
          <span className="mr-auto text-ink-quaternary">{t('task.bossVerdict')}</span>
          <button
            type="button"
            data-testid="boss-reject"
            onClick={() => void decide('reject')}
            className="rounded px-2 py-0.5 text-ink-tertiary transition-colors hover:bg-danger/10 hover:text-danger"
          >
            {t('task.bossReject')}
          </button>
          <button
            type="button"
            data-testid="boss-approve"
            onClick={() => void decide('approve')}
            className="rounded px-2 py-0.5 text-accent transition-colors hover:bg-accent-soft"
          >
            {t('task.bossApprove')}
          </button>
        </div>
      ) : null}

      {current.acceptance && evidence ? (
        <div className="mt-2 border-t border-line pt-2">
          <div className="mb-1 flex items-center justify-between text-2xs">
            <span className="font-semibold text-ink-secondary">{t('task.evidence')}</span>
            <span className="text-ink-tertiary">
              {t('task.exitCode', { code: evidence.exitCode ?? 'null' })} · {evidence.durationMs}ms
            </span>
          </div>
          <pre className="max-h-28 overflow-auto rounded bg-surface-muted p-2 font-mono text-3xs leading-relaxed whitespace-pre-wrap text-ink-secondary select-text">
            {`$ ${evidence.command.join(' ')}\n${evidence.stdoutTail}${evidence.stderrTail ? `\n${evidence.stderrTail}` : ''}`}
          </pre>
        </div>
      ) : null}

      {task.error ? (
        <p className="mt-2 rounded bg-danger/10 px-2 py-1 text-2xs text-danger">{task.error}</p>
      ) : null}
    </article>
  );
}


const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

interface ArtifactInfo {
  id: string;
  relPath: string;
  bytes: number;
  sha256: string;
}

/**
 * Images in a grid (2–3 columns, capped height), everything else as chips.
 * Clicking a thumbnail opens a lightbox with a download button.
 */
function ArtifactGrid({ taskId, artifacts }: { taskId: string; artifacts: ArtifactInfo[] }) {
  const images = artifacts.filter((artifact) => IMAGE.test(artifact.relPath));
  const others = artifacts.filter((artifact) => !IMAGE.test(artifact.relPath));

  return (
    <div className="mt-2 space-y-1.5">
      {images.length > 0 ? (
        <div className={images.length === 1 ? 'flex' : 'grid grid-cols-2 gap-1.5 sm:grid-cols-3'}>
          {images.map((artifact) => (
            <ArtifactThumbnail key={artifact.id} taskId={taskId} artifact={artifact} />
          ))}
        </div>
      ) : null}
      {others.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {others.map((artifact) => (
            <span
              key={artifact.id}
              className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-3xs text-ink-secondary"
              title={artifact.sha256}
            >
              {artifact.relPath} · {artifact.bytes}B
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ArtifactThumbnail({ taskId, artifact }: { taskId: string; artifact: ArtifactInfo }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.opc?.artifacts.read(taskId, artifact.relPath).then((result) => {
      if (!alive) return;
      if (result.ok && result.dataUrl) setDataUrl(result.dataUrl);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [artifact.relPath, taskId]);

  return (
    <>
      <figure className="overflow-hidden rounded-lg border border-line bg-surface-muted">
        <button
          type="button"
          data-testid="artifact-thumbnail"
          onClick={() => dataUrl && setOpen(true)}
          className="block w-full cursor-zoom-in"
          title={artifact.relPath}
        >
          {dataUrl ? (
            <img
              src={dataUrl}
              alt={artifact.relPath}
              className="max-h-48 w-full object-contain transition-transform hover:scale-[1.02]"
            />
          ) : (
            <span className="flex h-20 items-center justify-center text-2xs text-ink-quaternary">
              {failed ? '缩略图不可用' : '…'}
            </span>
          )}
        </button>
        <figcaption className="truncate px-1.5 py-0.5 font-mono text-3xs text-ink-tertiary">
          {artifact.relPath} · {artifact.bytes}B
        </figcaption>
      </figure>

      {open && dataUrl ? (
        <ArtifactLightbox
          dataUrl={dataUrl}
          name={artifact.relPath}
          bytes={artifact.bytes}
          onDownload={() => void window.opc?.artifacts.saveAs(taskId, artifact.relPath)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** Full-size viewer. Esc or backdrop closes; download uses a native save dialog. */
function ArtifactLightbox({
  dataUrl,
  name,
  bytes,
  onDownload,
  onClose,
}: {
  dataUrl: string;
  name: string;
  bytes: number;
  onDownload: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      data-testid="artifact-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={name}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/70 p-6"
      onClick={onClose}
    >
      <img
        src={dataUrl}
        alt={name}
        className="max-h-[80vh] max-w-[90vw] rounded-lg bg-surface object-contain shadow-popover"
        onClick={(event) => event.stopPropagation()}
      />
      <div
        className="flex items-center gap-3 rounded-full bg-surface/95 px-4 py-1.5 text-xs text-ink shadow-card"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="font-mono">{name}</span>
        <span className="text-ink-quaternary">{bytes} B</span>
        <button
          type="button"
          onClick={onDownload}
          className="font-medium text-accent-ink hover:text-accent"
        >
          {t('task.download')}
        </button>
        <button type="button" onClick={onClose} className="text-ink-tertiary hover:text-ink">
          {t('common.close')}
        </button>
      </div>
    </div>
  );
}


/** Decomposition tree: children are ordinary tasks, shown nested under the parent. */
function SubtaskTree({ parentId, count }: { parentId: string; count: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<WorkTask[] | null>(null);

  useEffect(() => {
    if (!open || children) return;
    let alive = true;
    void getWorkTransport()
      .getSubtasks(parentId)
      .then((list) => {
        if (alive) setChildren([...list]);
      });
    return () => {
      alive = false;
    };
  }, [open, children, parentId]);

  return (
    <div className="mt-2 rounded-lg border border-line">
      <button
        type="button"
        data-testid="subtask-toggle"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-2.5 py-1.5 text-2xs text-ink-secondary"
      >
        <span>
          {t('task.subtasks', { count })} {open ? '▾' : '▸'}
        </span>
        {open && children ? (
          <span className="text-ink-quaternary">
            {children.filter((child) => child.status === 'accepted').length}/{children.length} {t('task.subtasksDone')}
          </span>
        ) : null}
      </button>

      {open ? (
        <ul className="border-t border-line">
          {(children ?? []).map((child) => (
            <li
              key={child.id}
              data-testid="subtask-row"
              className="flex items-center gap-2 border-t border-line px-2.5 py-1.5 first:border-t-0"
            >
              <span aria-hidden className="h-3 w-px bg-line-strong" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-2xs text-ink">{child.title}</span>
                <span className="block truncate text-3xs text-ink-quaternary">
                  {child.assigneeName} · depth {child.depth}
                </span>
              </span>
              <span
                className={
                  child.status === 'accepted'
                    ? 'text-3xs font-medium text-success'
                    : child.status === 'failed' || child.status === 'rejected'
                      ? 'text-3xs font-medium text-danger'
                      : 'text-3xs font-medium text-ink-tertiary'
                }
              >
                {t(`task.status.${child.status}`)}
              </span>
            </li>
          ))}
          {children && children.length === 0 ? (
            <li className="px-2.5 py-2 text-3xs text-ink-quaternary">{t('task.subtasksEmpty')}</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
