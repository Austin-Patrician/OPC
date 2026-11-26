import {
  createContext,
  memo,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Check,
  ChevronsUpDown,
  Code2,
  Copy,
  Download,
  Eye,
  Info,
  Lightbulb,
  Maximize2,
  ShieldAlert,
  Sparkles,
  Table2,
  WrapText,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import mermaid from 'mermaid';
import { useTranslation } from 'react-i18next';
import { downloadTextFile } from '@/shared/lib/clipboard';
import {
  classifyInlineEntity,
  extractEmailFromMailto,
  parseFilePathEntity,
} from '@/shared/lib/chatEntities';
import { cn } from '@/shared/lib/cn';
import {
  ChatEmailChip,
  ChatFilePathChip,
  ChatUrlChip,
  useCopyFeedback,
} from '@/shared/ui/ChatEntityChips';
import { decodeFileHref, type MarkdownCalloutKind } from '../lib/remarkChatEntities';
import { mermaidSvgCache } from '../lib/renderCache';

/** Lets `components.code` reliably distinguish `<pre><code>` blocks from inline `<code>`. */
export const InsidePreContext = createContext(false);

const CODE_EXTENSION_MAP: Record<string, string> = {
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  javascript: 'js',
  js: 'js',
  jsx: 'jsx',
  python: 'py',
  py: 'py',
  json: 'json',
  sql: 'sql',
  bash: 'sh',
  sh: 'sh',
  shell: 'sh',
  zsh: 'sh',
  powershell: 'ps1',
  ps1: 'ps1',
  yaml: 'yml',
  yml: 'yml',
  html: 'html',
  css: 'css',
  scss: 'scss',
  rust: 'rs',
  rs: 'rs',
  go: 'go',
  java: 'java',
  cpp: 'cpp',
  c: 'c',
  markdown: 'md',
  md: 'md',
  xml: 'xml',
  toml: 'toml',
};

const COLLAPSE_LINE_THRESHOLD = 26;

function extractCodeLanguage(node: ReactNode): string {
  if (typeof node === 'object' && node !== null && 'props' in node) {
    const props = (node as { props?: { className?: string } }).props;
    const match = /language-([a-z0-9_+-]+)/i.exec(props?.className ?? '');
    if (match?.[1]) return match[1].toLowerCase();
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = extractCodeLanguage(child);
      if (found !== 'code') return found;
    }
  }
  return 'code';
}

function textFromNode(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join('');
  if (typeof node === 'object' && node !== null && 'props' in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return textFromNode(props?.children);
  }
  return '';
}

function safeFallbackHref(href?: string): string | undefined {
  if (!href) return undefined;
  if (href.startsWith('#') || href.startsWith('/')) return href;
  try {
    const url = new URL(href);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? href : undefined;
  } catch {
    return undefined;
  }
}

/** Smart anchor renderer: routes file paths, emails, and URLs to rich interactive chips. */
export function MarkdownAnchor({
  href,
  children,
  ...props
}: ComponentProps<'a'>) {
  if (href) {
    const decodedLocal = decodeFileHref(href);
    if (decodedLocal) {
      const meta = parseFilePathEntity(decodedLocal);
      if (meta) return <ChatFilePathChip file={meta}>{children}</ChatFilePathChip>;
    }
    if (/^file:\/\//i.test(href)) {
      const meta = parseFilePathEntity(href);
      if (meta) return <ChatFilePathChip file={meta}>{children}</ChatFilePathChip>;
    }
    const email = extractEmailFromMailto(href);
    if (email) {
      return (
        <ChatEmailChip email={email} href={href}>
          {children}
        </ChatEmailChip>
      );
    }
    if (/^https?:\/\//i.test(href)) {
      return <ChatUrlChip href={href}>{children}</ChatUrlChip>;
    }
  }

  return (
    <a
      href={safeFallbackHref(href)}
      target="_blank"
      rel="noreferrer noopener"
      className="break-all text-accent-ink underline decoration-accent/35 underline-offset-2 hover:text-accent"
      {...props}
    >
      {children}
    </a>
  );
}

/**
 * Enhances inline `:not(pre) > code` spans when they contain an email, URL, or file path,
 * leaving genuine `<pre><code>` blocks and ordinary code identifiers untouched.
 */
export function MarkdownInlineCode({
  className,
  children,
  ...props
}: ComponentProps<'code'>) {
  const insidePre = useContext(InsidePreContext);
  if (!insidePre) {
    const raw =
      typeof children === 'string'
        ? children
        : Array.isArray(children) && children.every((item) => typeof item === 'string')
          ? children.join('')
          : null;
    if (raw !== null) {
      const entity = classifyInlineEntity(raw);
      if (entity?.type === 'email') {
        return (
          <ChatEmailChip email={entity.email} href={entity.href}>
            {raw}
          </ChatEmailChip>
        );
      }
      if (entity?.type === 'url') {
        return (
          <ChatUrlChip href={entity.href} rawText={raw}>
            {raw}
          </ChatUrlChip>
        );
      }
      if (entity?.type === 'file') {
        return <ChatFilePathChip file={entity}>{raw}</ChatFilePathChip>;
      }
    }
  }

  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

/** Code block with language badge, line count, wrap toggle, collapse toggle, download, and copy. */
export const CodeBlock = memo(function CodeBlock({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [wrapped, setWrapped] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const source = textFromNode(children).replace(/\n$/, '');
  const language = extractCodeLanguage(children);
  const lineCount = source ? source.split('\n').length : 0;
  const collapsible = lineCount > COLLAPSE_LINE_THRESHOLD;
  const { state: copyState, announcement, triggerCopy } = useCopyFeedback(
    t('chat.codeCopied'),
    t('chat.entity.copyFailed'),
  );

  const downloadSnippet = () => {
    if (!source) return;
    const ext = CODE_EXTENSION_MAP[language] ?? 'txt';
    downloadTextFile(source, `snippet.${ext}`);
  };

  return (
    <div className="my-3.5 overflow-hidden rounded-xl border border-line bg-[var(--code-bg)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-[var(--code-header-bg)] px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] font-medium text-ink-tertiary">{language}</span>
          {lineCount > 0 ? (
            <span className="text-[11px] tabular-nums text-ink-quaternary">
              {t('chat.codeLines', { count: lineCount })}
            </span>
          ) : null}
        </div>
        {source ? (
          <div className="flex items-center gap-1">
            {collapsible ? (
              <button
                type="button"
                onClick={() => setCollapsed((prev) => !prev)}
                aria-expanded={!collapsed}
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-ink-tertiary transition hover:bg-surface-hover hover:text-ink"
              >
                <ChevronsUpDown className="size-3" aria-hidden="true" />
                <span>
                  {collapsed
                    ? t('chat.expandCode', { count: lineCount })
                    : t('chat.collapseCode')}
                </span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setWrapped((prev) => !prev)}
              aria-pressed={wrapped}
              title={t(wrapped ? 'chat.unwrapCode' : 'chat.wrapCode')}
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition hover:bg-surface-hover hover:text-ink',
                wrapped ? 'bg-surface-active text-ink' : 'text-ink-tertiary',
              )}
            >
              <WrapText className="size-3" aria-hidden="true" />
              <span>{t(wrapped ? 'chat.unwrapCode' : 'chat.wrapCode')}</span>
            </button>
            <button
              type="button"
              onClick={downloadSnippet}
              aria-label={t('chat.downloadCode')}
              title={t('chat.downloadCode')}
              className="inline-flex items-center justify-center rounded-md p-1 text-ink-tertiary transition hover:bg-surface-hover hover:text-ink"
            >
              <Download className="size-3" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => void triggerCopy(source)}
              data-copied={copyState === 'copied' ? '' : undefined}
              aria-label={t(copyState === 'copied' ? 'chat.codeCopied' : 'chat.copyCode')}
              title={t(copyState === 'copied' ? 'chat.codeCopied' : 'chat.copyCode')}
              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-ink-tertiary transition hover:bg-surface-hover hover:text-ink"
            >
              {copyState === 'copied' ? (
                <Check className="size-3 text-success" aria-hidden="true" />
              ) : (
                <Copy className="size-3" aria-hidden="true" />
              )}
              <span>{t(copyState === 'copied' ? 'chat.entity.copied' : 'chat.copyCode')}</span>
            </button>
            <span className="sr-only" role="status">
              {announcement}
            </span>
          </div>
        ) : null}
      </div>

      <div className={cn('relative', collapsed && 'max-h-44 overflow-hidden')}>
        <InsidePreContext.Provider value={true}>
          <pre
            tabIndex={0}
            className={cn(
              'm-0 max-w-full bg-transparent px-3.5 py-3 font-mono text-[13px] leading-[1.65] text-ink',
              wrapped ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto whitespace-pre',
            )}
          >
            {children}
          </pre>
        </InsidePreContext.Provider>
        {collapsed ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[var(--code-bg)] to-transparent"
          />
        ) : null}
      </div>
    </div>
  );
});

function readRenderedTableRows(table: HTMLTableElement | null): string[][] {
  if (!table) return [];
  const rows: string[][] = [];
  for (const row of table.rows) {
    const cells: string[] = [];
    for (const cell of row.cells) {
      cells.push((cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim());
    }
    rows.push(cells);
  }
  return rows;
}

function escapeCsvCell(text: string): string {
  const formulaSafe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${formulaSafe.replaceAll('"', '""')}"`;
}

/** Accessible Markdown table container with TSV Excel-ready copy and UTF-8 BOM CSV export. */
export function MarkdownTable({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const tableRef = useRef<HTMLTableElement>(null);
  const { state: copyState, announcement, triggerCopy } = useCopyFeedback(
    t('chat.tableCopied'),
    t('chat.entity.copyFailed'),
  );

  const copyTsv = () => {
    const rows = readRenderedTableRows(tableRef.current);
    if (rows.length === 0) return;
    const tsv = rows.map((row) => row.map((cell) => cell.replaceAll('\t', ' ')).join('\t')).join('\n');
    void triggerCopy(tsv);
  };

  const exportCsv = () => {
    const rows = readRenderedTableRows(tableRef.current);
    if (rows.length === 0) return;
    const csv = rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n');
    downloadTextFile(`\uFEFF${csv}`, 'table-export.csv', 'text/csv;charset=utf-8');
  };

  return (
    <div className="my-3.5 max-w-full overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-muted/45 px-3 py-1.5 text-[11px] text-ink-tertiary">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <Table2 className="size-3.5 text-ink-quaternary" aria-hidden="true" />
          <span>{t('chat.tableLabel')}</span>
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copyTsv}
            data-copied={copyState === 'copied' ? '' : undefined}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium text-ink-tertiary transition hover:bg-surface-hover hover:text-ink"
          >
            {copyState === 'copied' ? (
              <Check className="size-3 text-success" aria-hidden="true" />
            ) : (
              <Copy className="size-3" aria-hidden="true" />
            )}
            <span>{t(copyState === 'copied' ? 'chat.tableCopied' : 'chat.copyTable')}</span>
          </button>
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium text-ink-tertiary transition hover:bg-surface-hover hover:text-ink"
          >
            <Download className="size-3" aria-hidden="true" />
            <span>{t('chat.exportCsv')}</span>
          </button>
          <span className="sr-only" role="status">
            {announcement}
          </span>
        </div>
      </div>
      <div
        tabIndex={0}
        role="region"
        aria-label={t('chat.tableRegion')}
        className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
      >
        <table ref={tableRef} className="w-full border-collapse text-[13.5px]">
          {children}
        </table>
      </div>
    </div>
  );
}

const CALLOUT_STYLES: Record<
  MarkdownCalloutKind,
  { Icon: typeof Info; wrapClass: string; titleClass: string }
> = {
  note: {
    Icon: Info,
    wrapClass:
      "border-sky-500/30 bg-sky-500/[0.06] [[data-theme='dark']_&]:border-sky-400/30",
    titleClass: "text-sky-700 [[data-theme='dark']_&]:text-sky-300",
  },
  tip: {
    Icon: Lightbulb,
    wrapClass: 'border-success/30 bg-success/[0.06]',
    titleClass: 'text-success',
  },
  important: {
    Icon: Sparkles,
    wrapClass:
      "border-violet-500/30 bg-violet-500/[0.06] [[data-theme='dark']_&]:border-violet-400/30",
    titleClass: "text-violet-700 [[data-theme='dark']_&]:text-violet-300",
  },
  warning: {
    Icon: AlertTriangle,
    wrapClass: 'border-warning/35 bg-warning/[0.07]',
    titleClass: 'text-warning',
  },
  caution: {
    Icon: ShieldAlert,
    wrapClass: 'border-danger/35 bg-danger/[0.07]',
    titleClass: 'text-danger',
  },
};

export function MarkdownBlockquote({
  children,
  ...props
}: ComponentProps<'blockquote'> & { 'data-callout'?: string }) {
  const { t } = useTranslation();
  const rawKind = props['data-callout'];
  if (rawKind && rawKind in CALLOUT_STYLES) {
    const kind = rawKind as MarkdownCalloutKind;
    const style = CALLOUT_STYLES[kind];
    const Icon = style.Icon;
    return (
      <div
        className={cn(
          'my-3.5 rounded-xl border px-4 py-3 text-[0.95em] leading-relaxed text-ink',
          style.wrapClass,
        )}
      >
        <div
          className={cn(
            'mb-1.5 flex items-center gap-1.5 text-xs font-semibold',
            style.titleClass,
          )}
        >
          <Icon className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{t(`chat.callout.${kind}`)}</span>
        </div>
        <div className="space-y-1.5 [&>p]:my-1">{children}</div>
      </div>
    );
  }
  return <blockquote>{children}</blockquote>;
}

/** Interactive Mermaid diagram with chart/source toggle, SVG export, copy, and native modal zoom. */
export const MermaidBlock = memo(function MermaidBlock({ source }: { source: string }) {
  const { t } = useTranslation();
  const [svg, setSvg] = useState(() => mermaidSvgCache.get(source) ?? '');
  const [failed, setFailed] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const pressedOutsideRef = useRef(false);
  const { state: copyState, announcement, triggerCopy } = useCopyFeedback(
    t('chat.codeCopied'),
    t('chat.entity.copyFailed'),
  );

  useEffect(() => {
    const cached = mermaidSvgCache.get(source);
    if (cached) {
      setSvg(cached);
      setFailed(false);
      return undefined;
    }
    let active = true;
    setSvg('');
    setFailed(false);
    mermaid
      .render(`m-${crypto.randomUUID()}`, source)
      .then((result) => {
        mermaidSvgCache.set(source, result.svg);
        if (active) setSvg(result.svg);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [source]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (modalOpen) {
      setZoom(1);
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [modalOpen]);

  if (failed) {
    return (
      <pre className="my-3 overflow-x-auto rounded-xl border border-line bg-[var(--code-bg)] p-3 font-mono text-sm">
        {source}
      </pre>
    );
  }
  if (!svg) return <div className="my-3 h-24 animate-pulse rounded-xl bg-ink/5" />;

  const downloadSvg = () => {
    downloadTextFile(svg, 'diagram.svg', 'image/svg+xml;charset=utf-8');
  };

  const isPointerOutside = (clientX: number, clientY: number, el: HTMLDialogElement) => {
    const r = el.getBoundingClientRect();
    return clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom;
  };

  return (
    <div className="my-3.5 overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-muted/45 px-3 py-1.5 text-[11px] text-ink-tertiary">
        <span className="font-mono font-medium">mermaid</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowSource((prev) => !prev)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium text-ink-tertiary transition hover:bg-surface-hover hover:text-ink"
          >
            {showSource ? (
              <>
                <Eye className="size-3" aria-hidden="true" />
                <span>{t('chat.mermaidChart')}</span>
              </>
            ) : (
              <>
                <Code2 className="size-3" aria-hidden="true" />
                <span>{t('chat.mermaidSource')}</span>
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            aria-label={t('chat.mermaidZoom')}
            title={t('chat.mermaidZoom')}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium text-ink-tertiary transition hover:bg-surface-hover hover:text-ink"
          >
            <Maximize2 className="size-3" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={downloadSvg}
            aria-label={t('chat.mermaidDownloadSvg')}
            title={t('chat.mermaidDownloadSvg')}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium text-ink-tertiary transition hover:bg-surface-hover hover:text-ink"
          >
            <Download className="size-3" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void triggerCopy(source)}
            aria-label={t(copyState === 'copied' ? 'chat.codeCopied' : 'chat.copyCode')}
            title={t(copyState === 'copied' ? 'chat.codeCopied' : 'chat.copyCode')}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium text-ink-tertiary transition hover:bg-surface-hover hover:text-ink"
          >
            {copyState === 'copied' ? (
              <Check className="size-3 text-success" aria-hidden="true" />
            ) : (
              <Copy className="size-3" aria-hidden="true" />
            )}
          </button>
          <span className="sr-only" role="status">
            {announcement}
          </span>
        </div>
      </div>

      {showSource ? (
        <pre className="m-0 max-w-full overflow-x-auto bg-[var(--code-bg)] px-3.5 py-3 font-mono text-[13px] leading-[1.65] text-ink">
          {source}
        </pre>
      ) : (
        <div
          className="overflow-x-auto p-3.5 [&>svg]:mx-auto [&>svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}

      {typeof document !== 'undefined'
        ? createPortal(
            <dialog
              ref={dialogRef}
              aria-labelledby={titleId}
              {...({ closedby: 'any' } as Record<string, string>)}
              onClose={() => setModalOpen(false)}
              onPointerDown={(event) => {
                if (dialogRef.current) {
                  pressedOutsideRef.current = isPointerOutside(
                    event.clientX,
                    event.clientY,
                    dialogRef.current,
                  );
                }
              }}
              onPointerUp={(event) => {
                if (
                  pressedOutsideRef.current &&
                  dialogRef.current &&
                  isPointerOutside(event.clientX, event.clientY, dialogRef.current)
                ) {
                  setModalOpen(false);
                }
                pressedOutsideRef.current = false;
              }}
              className="opc-native-dialog m-auto max-h-[88vh] w-[min(92vw,70rem)] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-line bg-surface p-0 text-ink shadow-popover open:flex"
            >
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
                <h1 id={titleId} className="m-0 text-sm-plus font-semibold text-ink">
                  {t('chat.mermaidZoom')}
                </h1>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
                    aria-label={t('chat.zoomOut')}
                    title={t('chat.zoomOut')}
                    className="rounded-md border border-line p-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink"
                  >
                    <ZoomOut className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setZoom(1)}
                    title={t('chat.zoomReset')}
                    className="min-w-12 rounded-md border border-line px-2 py-1 font-mono text-xs tabular-nums text-ink-secondary hover:bg-surface-hover hover:text-ink"
                  >
                    {Math.round(zoom * 100)}%
                  </button>
                  <button
                    type="button"
                    onClick={() => setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))}
                    aria-label={t('chat.zoomIn')}
                    title={t('chat.zoomIn')}
                    className="rounded-md border border-line p-1.5 text-ink-secondary hover:bg-surface-hover hover:text-ink"
                  >
                    <ZoomIn className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={downloadSvg}
                    aria-label={t('chat.mermaidDownloadSvg')}
                    title={t('chat.mermaidDownloadSvg')}
                    className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink-secondary hover:bg-surface-hover hover:text-ink"
                  >
                    <Download className="size-3.5" />
                    <span>SVG</span>
                  </button>
                  <form method="dialog">
                    <button
                      type="submit"
                      aria-label={t('chat.mermaidClose')}
                      title={t('chat.mermaidClose')}
                      className="rounded-md p-1.5 text-ink-tertiary hover:bg-surface-hover hover:text-ink"
                    >
                      <X className="size-4" />
                    </button>
                  </form>
                </div>
              </div>
              <div className="flex-1 overflow-auto bg-panel p-6">
                <div
                  style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
                  className="mx-auto w-fit transition-transform duration-150"
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              </div>
            </dialog>,
            document.body,
          )
        : null}
    </div>
  );
});
