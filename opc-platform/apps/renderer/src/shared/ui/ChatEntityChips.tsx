import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import {
  Check,
  Copy,
  Folder,
  Mail,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getFileIcon } from '@/shared/file-icon/file-icons';
import { copyTextToClipboard } from '@/shared/lib/clipboard';
import {
  normalizeExternalUrl,
  type FilePathEntityMeta,
} from '@/shared/lib/chatEntities';
import { cn } from '@/shared/lib/cn';
import { SiteFavicon } from './SiteFavicon';

/**
 * Shared accessible copy state with live announcement differentiation across rapid re-clicks.
 */
export function useCopyFeedback(copiedText: string, failedText: string) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [announcement, setAnnouncement] = useState('');
  const timerRef = useRef<number | null>(null);
  const lastAnnouncedRef = useRef('');

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const triggerCopy = useCallback(
    async (value: string) => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      const ok = await copyTextToClipboard(value);
      setState(ok ? 'copied' : 'failed');
      let message = ok ? copiedText : failedText;
      if (message === lastAnnouncedRef.current) message += '\u00A0';
      lastAnnouncedRef.current = message;
      setAnnouncement('');
      window.requestAnimationFrame(() => setAnnouncement(message));
      timerRef.current = window.setTimeout(() => {
        setState('idle');
        setAnnouncement('');
        timerRef.current = null;
      }, 1800);
    },
    [copiedText, failedText],
  );

  return { state, announcement, triggerCopy };
}

function openExternalSafely(event: MouseEvent<HTMLAnchorElement>, href: string): void {
  const openExternal = window.opc?.app?.openExternal;
  if (!openExternal) return;
  event.preventDefault();
  void openExternal(href);
}

function InlineCopyControl({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const { state, announcement, triggerCopy } = useCopyFeedback(
    t('chat.entity.copied'),
    t('chat.entity.copyFailed'),
  );

  return (
    <span className="inline-flex shrink-0 items-center">
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void triggerCopy(value);
        }}
        data-copied={state === 'copied' ? '' : undefined}
        data-failed={state === 'failed' ? '' : undefined}
        aria-label={label}
        title={state === 'copied' ? t('chat.entity.copied') : label}
        className={cn(
          'inline-flex size-5 items-center justify-center rounded text-ink-tertiary transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
          className,
        )}
      >
        {state === 'copied' ? (
          <Check className="size-3 text-success" aria-hidden="true" />
        ) : (
          <Copy className="size-3" aria-hidden="true" />
        )}
      </button>
      <span className="sr-only" role="status">
        {announcement}
      </span>
    </span>
  );
}

/** Styled inline URL badge with site favicon, routing clicks through Electron's external opener. */
export function ChatUrlChip({
  href,
  rawText,
  children,
}: {
  href: string;
  rawText?: string;
  children?: ReactNode;
}) {
  const meta = normalizeExternalUrl(href);
  const childStr = typeof children === 'string' ? children : undefined;
  const isAutolink =
    !childStr || childStr === href || childStr === rawText || childStr === meta?.raw;

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => openExternalSafely(event, href)}
      title={href}
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-line/85 bg-surface-muted/55 px-1.5 py-px align-baseline text-[0.92em] leading-[1.45] break-all text-accent-ink transition-colors hover:border-accent/45 hover:bg-accent-soft/40 hover:text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
    >
      <SiteFavicon href={href} domain={meta?.domain} />
      {isAutolink && meta ? (
        <span className="min-w-0 truncate">
          <span className="font-medium">{meta.domain}</span>
          {meta.displayPath ? (
            <span className="text-ink-tertiary">{meta.displayPath}</span>
          ) : null}
        </span>
      ) : (
        <span className="min-w-0">{children ?? href}</span>
      )}
    </a>
  );
}

/** Styled inline email chip with click-to-compose (`mailto:`) and 1-click email copy. */
export function ChatEmailChip({
  email,
  href,
  children,
}: {
  email: string;
  href?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const targetHref = href ?? `mailto:${email}`;
  const customChildren =
    children && typeof children === 'string' && children !== email && children !== targetHref
      ? children
      : null;

  return (
    <span className="inline-flex max-w-full items-center gap-0.5 rounded-md border border-sky-500/25 bg-sky-500/[0.08] py-px pr-0.5 pl-1.5 align-baseline text-[0.92em] leading-[1.45] text-sky-700 transition-colors hover:border-sky-500/45 hover:bg-sky-500/14 [[data-theme='dark']_&]:text-sky-300">
      <a
        href={targetHref}
        onClick={(event) => openExternalSafely(event, targetHref)}
        title={t('chat.entity.composeEmail', { email })}
        className="inline-flex min-w-0 items-center gap-1 break-all hover:underline focus-visible:outline-none focus-visible:underline"
      >
        <Mail className="size-3 shrink-0 opacity-85" aria-hidden="true" />
        <span>{customChildren ?? email}</span>
      </a>
      <InlineCopyControl
        value={email}
        label={t('chat.entity.copyEmail')}
        className="text-sky-700/75 hover:text-sky-900 [[data-theme='dark']_&]:text-sky-300/80 [[data-theme='dark']_&]:hover:text-sky-100"
      />
    </span>
  );
}

/**
 * Interactive inline file/folder path chip:
 * click directly to open (falling back to reveal-in-folder for blocked executables or Alt/Option+click).
 */
export function ChatFilePathChip({
  file,
  children,
}: {
  file: FilePathEntityMeta;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState<{ text: string; tone: 'error' | 'success' } | null>(null);
  const timerRef = useRef<number | null>(null);
  const hasDesktopBridge = Boolean(
    window.opc?.app?.openLocalPath || window.opc?.app?.revealLocalPath,
  );

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const showTransientFeedback = (text: string, tone: 'error' | 'success' = 'error') => {
    setFeedback({ text, tone });
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setFeedback(null);
      timerRef.current = null;
    }, tone === 'success' ? 1800 : 3200);
  };

  const handleClick = async (event: MouseEvent<HTMLButtonElement>) => {
    if (window.getSelection()?.toString().trim()) return;
    event.preventDefault();
    event.stopPropagation();

    const openLocalPath = window.opc?.app?.openLocalPath;
    const revealLocalPath = window.opc?.app?.revealLocalPath;

    try {
      if (event.altKey && revealLocalPath) {
        const revealed = await revealLocalPath(file.path);
        if (!revealed.ok && revealed.error) showTransientFeedback(revealed.error, 'error');
        return;
      }

      if (openLocalPath) {
        const res = await openLocalPath(file.path);
        if (!res.ok && res.blockedExecutable && revealLocalPath) {
          const revealed = await revealLocalPath(file.path);
          if (!revealed.ok && revealed.error) showTransientFeedback(revealed.error, 'error');
          return;
        }
        if (!res.ok && res.error) showTransientFeedback(res.error, 'error');
        return;
      }

      if (revealLocalPath) {
        const revealed = await revealLocalPath(file.path);
        if (!revealed.ok && revealed.error) showTransientFeedback(revealed.error, 'error');
        return;
      }

      const copied = await copyTextToClipboard(file.path);
      showTransientFeedback(
        copied ? t('chat.entity.pathCopied') : t('chat.entity.copyFailed'),
        copied ? 'success' : 'error',
      );
    } catch (error) {
      showTransientFeedback(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const displayLabel =
    typeof children === 'string'
      ? children.trim() || file.raw
      : (children ?? file.raw);

  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1 align-baseline">
      <button
        type="button"
        onClick={(event) => void handleClick(event)}
        title={
          hasDesktopBridge
            ? `${file.path} — ${t('chat.entity.clickToOpenPath')}`
            : `${file.path} — ${t('chat.entity.clickToCopyPath')}`
        }
        className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-line bg-[var(--inline-code-bg)] px-1.5 py-px text-left font-mono text-[0.86em] leading-[1.45] text-ink select-text transition-colors hover:border-accent/45 hover:bg-accent-soft/35 hover:text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
          {file.isDirectory ? (
            <Folder
              className="size-3.5 text-amber-600 [[data-theme='dark']_&]:text-amber-400"
              aria-hidden="true"
            />
          ) : (
            <span
              className="inline-flex size-3.5 items-center justify-center [&_svg]:size-3.5"
              dangerouslySetInnerHTML={{ __html: getFileIcon(file.ext, file.fileName) }}
              aria-hidden="true"
            />
          )}
        </span>
        <span className="min-w-0 break-all">{displayLabel}</span>
      </button>

      {feedback ? (
        <span
          className={cn(
            'font-sans text-[11px] font-medium',
            feedback.tone === 'success' ? 'text-success' : 'text-danger',
          )}
          role="status"
        >
          {feedback.text}
        </span>
      ) : null}
    </span>
  );
}
