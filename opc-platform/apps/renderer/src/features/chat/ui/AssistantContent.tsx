import { isValidElement, memo, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { Check, Copy, Download, RotateCcw, Send } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useTranslation } from 'react-i18next';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import mermaid from 'mermaid';
import embed from 'vega-embed';
import type { ChatContentBlock } from '@opc/shared/domain';
import { getFileIcon } from '@/shared/file-icon/file-icons';
import { imageAspectCache, mediaUrlCache, mermaidSvgCache } from '../lib/renderCache';
import { containsExternalVegaDataUrl } from '../lib/vegaSpec';

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });

type MarkdownComponents = ComponentProps<typeof ReactMarkdown>['components'];

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS_FULL = [rehypeKatex, rehypeHighlight];
const REHYPE_PLUGINS_STREAMING = [rehypeKatex];

const BASE_MARKDOWN_COMPONENTS: MarkdownComponents = {
  a: ({ href, children, ...props }) => <a href={safeLink(href)} target="_blank" rel="noreferrer noopener" className="break-all text-accent-ink underline decoration-accent/35 underline-offset-2 hover:text-accent" {...props}>{children}</a>,
  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="my-3.5 max-w-full overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full border-collapse text-[13.5px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-line bg-surface-muted/70 px-3.5 py-2 text-left text-[12px] font-semibold text-ink-secondary">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-t border-line/70 px-3.5 py-2.5 align-top text-ink">
      {children}
    </td>
  ),
  blockquote: ({ children }) => <blockquote>{children}</blockquote>,
};

const MARKDOWN_COMPONENTS_FULL: MarkdownComponents = {
  ...BASE_MARKDOWN_COMPONENTS,
  code: ({ className, children, ...props }) => {
    const value = String(children).replace(/\n$/, '');
    if (/language-mermaid/.test(className ?? '')) return <Mermaid source={value} />;
    if (/language-vega-lite/.test(className ?? '') || /language-vegalite/.test(className ?? '')) return <VegaLite source={value} />;
    return <code className={className} {...props}>{children}</code>;
  },
};

const MARKDOWN_COMPONENTS_STREAMING: MarkdownComponents = {
  ...BASE_MARKDOWN_COMPONENTS,
  code: ({ className, children, ...props }) => <code className={className} {...props}>{children}</code>,
};

function getMediaCacheKey(block: ChatContentBlock): string | null {
  if (block.type !== 'image' && block.type !== 'video' && block.type !== 'audio') return null;
  return block.source.type === 'url'
    ? `${block.type}:url:${block.source.url}`
    : `${block.type}:artifact:${block.source.taskId}:${block.source.relPath}`;
}

export const AssistantContent = memo(function AssistantContent({
  blocks,
  streaming = false,
}: {
  blocks: readonly ChatContentBlock[];
  streaming?: boolean;
}) {
  return (
    <div className="opc-assistant-content min-w-0 max-w-full overflow-hidden break-words space-y-3">
      {blocks.map((block, index) => {
        // Action cards have local submitting/resolved state. A positional key
        // lets React reuse that state for a different card after one is removed,
        // which can make a newly restored approval look unclickable.
        const key = block.type === 'approval' || block.type === 'workflow'
          ? `${block.type}:${block.reportId}`
          : `${block.type}:${index}`;
        const isTailStreaming = streaming && index === blocks.length - 1;
        return <ContentBlock key={key} block={block} streaming={isTailStreaming} />;
      })}
    </div>
  );
});

const ContentBlock = memo(function ContentBlock({
  block,
  streaming = false,
}: {
  block: ChatContentBlock;
  streaming?: boolean;
}) {
  const mediaCacheKey = getMediaCacheKey(block);
  const [src, setSrc] = useState<string | null>(() => mediaCacheKey ? (mediaUrlCache.get(mediaCacheKey) ?? null) : null);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [approvalState, setApprovalState] = useState<'pending' | 'allowed' | 'denied'>(
    block.type === 'approval' ? block.state : 'pending',
  );
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const approvalBlockState = block.type === 'approval' ? block.state : undefined;
  useEffect(() => {
    // A stale pending snapshot may arrive after the click has already been
    // accepted locally. Never move an action card back to pending; a new card
    // gets a new reportId/key and therefore a fresh component state.
    if (approvalBlockState && approvalBlockState !== 'pending') setApprovalState(approvalBlockState);
  }, [approvalBlockState]);
  useEffect(() => {
    if (block.type === 'markdown' || block.type === 'file' || block.type === 'approval' || block.type === 'workflow') return;
    if (mediaCacheKey) {
      const cached = mediaUrlCache.get(mediaCacheKey);
      if (cached) {
        setSrc(cached);
        setError(false);
        return;
      }
    }
    setSrc(null);
    setError(false);
    let active = true;
    const bridge = window.opc;
    if (!bridge) { setError(true); return; }
    const request = block.source.type === 'url'
      ? bridge.chatMedia.register({ kind: block.type, url: block.source.url })
      : bridge.chatMedia.register({ kind: block.type, taskId: block.source.taskId, relPath: block.source.relPath });
    request.then((result) => {
      if (!active) return;
      if (result.ok && result.url) {
        if (mediaCacheKey) mediaUrlCache.set(mediaCacheKey, result.url);
        setSrc(result.url);
      } else {
        setError(true);
      }
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [block, mediaCacheKey]);
  if (block.type === 'approval') {
    const answer = async (allow: boolean) => {
      if (approvalState !== 'pending' || approvalSubmitting) return;
      setApprovalError(null);
      setApprovalSubmitting(true);
      try {
        const bridge = window.opc;
        if (!bridge) throw new Error('桌面桥接不可用');
        await bridge.threads.answer({
          reportId: block.reportId,
          text: allow ? '允许' : '不允许，请换一种方案',
          allow,
        });
        // The main process normally pushes a snapshot that removes the card.
        // Hide it immediately as well: an old card can still be mounted while
        // the IPC snapshot is in flight, and approvals are idempotent after a
        // restart. Keeping the local state tied only to the push made a valid
        // click look like it did nothing.
        setApprovalState(allow ? 'allowed' : 'denied');
      } catch (error) {
        setApprovalError(error instanceof Error ? error.message : String(error));
      } finally {
        setApprovalSubmitting(false);
      }
    };
    // The main process removes a resolved approval block from the transcript.
    // This guard also prevents a stale snapshot or the local post-submit state
    // from briefly rendering an "已允许/已拒绝" card.
    if (approvalState !== 'pending') return null;
    return (
      <section className="buddy-approval relative my-1.5 w-full max-w-[41.25rem] overflow-hidden rounded-2xl border border-line bg-surface text-sm text-ink shadow-card transition-[border-color,box-shadow,transform] duration-200 motion-safe:animate-[buddy-approval-in_.24s_ease-out]">
        <div className="flex items-start gap-3.5 px-4 py-4 sm:px-5">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] font-semibold tracking-[.12em] text-warning uppercase">
              <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
              <span>工具权限</span>
              <span className="font-mono font-normal tracking-normal text-ink-tertiary normal-case">{block.tool}</span>
            </div>
            <h3 className="text-[14px] leading-5 font-semibold tracking-[-.01em] text-ink">{block.title.replace(/^要你点头：/, '')}</h3>
            <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-[1.65] text-ink-secondary">{block.body.split('\n').slice(0, 2).join('\n')}</p>
            {block.browser?.url ? <p className="mt-2 break-all rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-[11.5px] text-ink-secondary">{block.browser.url}</p> : null}
            {block.browser?.preview ? <p className="mt-2 break-all rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-[11.5px] text-ink-secondary">{block.browser.preview}</p> : null}
            {block.desktop?.appId ? <p className="mt-2 break-all rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-[11.5px] text-ink-secondary">{block.desktop.appId}{block.desktop.windowId ? ` · ${block.desktop.windowId}` : ''}{block.desktop.preview ? `\n${block.desktop.preview}` : ''}</p> : null}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-line bg-surface-muted/35 px-4 py-3 sm:px-5">
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-ink-tertiary">仅对当前任务生效</span>
            {block.browser?.sessionId ? <button type="button" disabled={approvalSubmitting} onClick={() => { void window.opc?.browser.show(block.taskId); }} className="text-[11px] font-medium text-accent-ink underline decoration-accent/40 underline-offset-2 hover:text-accent">查看浏览器</button> : null}
            {block.desktop?.appId ? <button type="button" disabled={approvalSubmitting} onClick={() => { void window.opc?.desktop.show(block.taskId); }} className="text-[11px] font-medium text-accent-ink underline decoration-accent/40 underline-offset-2 hover:text-accent">查看桌面</button> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" disabled={approvalSubmitting} onClick={() => void answer(false)} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50">拒绝</button>
            <button type="button" disabled={approvalSubmitting} onClick={() => void answer(true)} className="inline-flex items-center rounded-lg bg-[var(--primary-btn-bg)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--primary-btn-text)] transition-[background,transform] hover:bg-[var(--primary-btn-hover)] active:scale-[.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50">允许</button>
          </div>
        </div>
        {approvalError ? <p role="alert" className="border-t border-danger/25 bg-danger/5 px-5 py-2 text-[11px] text-danger">{approvalError}</p> : null}
      </section>
    );
  }
  if (block.type === 'workflow') return <WorkflowCard block={block} />;
  if (block.type === 'markdown') return <Markdown text={block.text} streaming={streaming} />;
  if (block.type === 'file') return <FileBlock block={block} />;
  if (error) return <div className="text-sm text-ink-tertiary">媒体加载失败{block.alt ? `：${block.alt}` : ''}</div>;
  if (!src) return <div className="h-10 animate-pulse rounded-lg bg-ink/5" />;
  if (block.type === 'image') {
    const cachedAspect = mediaCacheKey ? imageAspectCache.get(mediaCacheKey) : undefined;
    return (
      <>
        <button type="button" className="block max-w-full cursor-zoom-in" onClick={() => setZoom(true)}>
          <img
            src={src}
            alt={block.alt ?? ''}
            style={cachedAspect ? { aspectRatio: String(cachedAspect) } : undefined}
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget;
              if (naturalWidth > 0 && naturalHeight > 0 && mediaCacheKey) {
                imageAspectCache.set(mediaCacheKey, naturalWidth / naturalHeight);
              }
            }}
            className="max-h-[28rem] max-w-full rounded-lg object-contain"
          />
        </button>
        {zoom && <div className="fixed inset-0 z-[100] flex cursor-zoom-out items-center justify-center bg-black/85 p-8" onClick={() => setZoom(false)}><img src={src} alt={block.alt ?? ''} className="max-h-full max-w-full object-contain" /></div>}
      </>
    );
  }
  if (block.type === 'video') return <video controls preload="metadata" className="max-h-[28rem] max-w-full rounded-lg" src={src}>{block.title}</video>;
  return <audio controls preload="none" className="max-w-full" src={src}>{block.title}</audio>;
});

const FileBlock = memo(function FileBlock({ block }: { block: Extract<ChatContentBlock, { type: 'file' }> }) {
  const { t } = useTranslation();
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const sourceName = block.name ?? block.source.relPath;
  const fileName = sourceName.split(/[\\/]/).pop() || sourceName;
  const extension = fileName.includes('.') ? fileName.split('.').pop() : undefined;

  const save = async () => {
    setMessage(null);
    setFailed(false);
    try {
      const bridge = window.opc;
      if (!bridge) throw new Error(t('chat.artifact.bridgeUnavailable'));
      const result = await bridge.artifacts.saveAs(block.source.taskId, block.source.relPath);
      if (result.ok) {
        setMessage(t('chat.artifact.saved'));
        return;
      }
      setFailed(true);
      setMessage(result.error ?? t('chat.artifact.saveFailed'));
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="flex w-full max-w-[18rem] items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2 shadow-card">
      <span
        className="flex h-7 w-[26px] shrink-0 items-center justify-center overflow-hidden [&_svg]:size-full"
        dangerouslySetInnerHTML={{ __html: getFileIcon(extension, fileName) }}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] leading-tight font-semibold text-ink" title={block.source.relPath}>
          {fileName}
        </div>
        <div
          className={`truncate text-[10px] leading-tight ${failed ? 'text-danger' : 'text-ink-tertiary'}`}
          title={message ?? block.title ?? block.source.relPath}
          aria-live="polite"
        >
          {message ?? block.title ?? block.source.relPath}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void save()}
        aria-label={t('chat.artifact.save')}
        title={t('chat.artifact.save')}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-tertiary transition-colors hover:bg-surface-hover hover:text-ink"
      >
        <Download className="size-3.5" />
      </button>
    </div>
  );
});

function WorkflowCard({ block }: { block: Extract<ChatContentBlock, { type: 'workflow' }> }) {
  const [text, setText] = useState('');
  const [otherSelected, setOtherSelected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resolved, setResolved] = useState(block.state === 'resolved');

  useEffect(() => {
    // Resolution is monotonic. An older pending snapshot must not resurrect a
    // card that the user has already resolved.
    if (block.state === 'resolved') setResolved(true);
  }, [block.state]);

  const resolve = async (action: 'answer' | 'approve' | 'rework' | 'other') => {
    if (submitting) return;
    if (action === 'other') {
      setOtherSelected(true);
      return;
    }
    if (block.kind === 'question' && !text.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      const bridge = window.opc;
      if (!bridge) throw new Error('桌面桥接不可用');
      if (block.kind === 'question') {
        await bridge.threads.answer({ reportId: block.reportId, text: text.trim() });
      } else {
        await bridge.threads.decide({
          reportId: block.reportId,
          threadId: block.threadId,
          decision: action === 'rework' ? 'rework' : 'approve',
          ...(text.trim() ? { note: text.trim() } : {}),
        });
      }
      // Do not wait for the asynchronous chat snapshot to make a successful
      // decision visible. This also handles a card restored from an older
      // transcript whose report was already settled.
      setResolved(true);
      setText('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  if (resolved) return null;

  return (
    <section className="buddy-approval relative my-1.5 w-full max-w-[41.25rem] overflow-hidden rounded-2xl border border-line bg-surface text-sm text-ink shadow-card transition-[border-color,box-shadow,transform] duration-200 motion-safe:animate-[buddy-approval-in_.24s_ease-out]">
      <div className="flex items-start gap-3.5 px-4 py-4 sm:px-5">
        <div className="min-w-0 flex-1">
          <div className={`mb-1 flex items-center gap-1.5 text-[10px] font-semibold tracking-[.12em] uppercase ${block.kind === 'question' ? 'text-ink-tertiary' : 'text-warning'}`}>
            {block.kind === 'question' ? null : <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />}
            {block.kind === 'question' ? '需要回复' : '等待确认'}
          </div>
          <h3 className="text-[14px] leading-5 font-semibold tracking-[-.01em] text-ink">{block.title}</h3>
          <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-[1.65] text-ink-secondary">{block.body}</p>
        </div>
      </div>
      <div className="border-t border-line bg-surface-muted/35 px-4 py-3 sm:px-5">
          {block.kind === 'question' ? (
            <div className="relative">
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={2}
                placeholder="写下回复…"
                className="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 pr-11 text-[12.5px] leading-5 text-ink outline-none transition-colors placeholder:text-ink-quaternary focus:border-line-strong"
              />
              <button
                type="button"
                aria-label="发送回复"
                title="发送回复"
                disabled={!text.trim() || submitting}
                onClick={() => void resolve('answer')}
                className="absolute right-1.5 bottom-1.5 inline-flex size-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
              >
                <Send className="size-3.5" strokeWidth={1.8} />
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-col items-stretch gap-1.5">
                <button type="button" disabled={submitting} onClick={() => void resolve('rework')} className="inline-flex w-full items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-left text-[12px] font-medium text-ink-secondary transition-colors hover:border-line-strong hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"><RotateCcw className="size-3.5" strokeWidth={1.8} />返工</button>
                <button type="button" disabled={submitting} onClick={() => void resolve('approve')} className="inline-flex w-full items-center gap-1.5 rounded-lg bg-[var(--primary-btn-bg)] px-3.5 py-1.5 text-left text-[12px] font-medium text-[var(--primary-btn-text)] transition-[background,transform] hover:bg-[var(--primary-btn-hover)] active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50"><Check className="size-3.5" strokeWidth={2} />认可</button>
                <button
                  type="button"
                  aria-pressed={otherSelected}
                  disabled={submitting}
                  onClick={() => void resolve('other')}
                  className={`box-border inline-flex min-h-9 w-full items-center justify-between overflow-hidden rounded-lg border px-3 py-1.5 text-left text-[12px] font-medium transition-[border-color,background,box-shadow,color] ${otherSelected
                    ? 'border-accent/50 bg-accent-soft text-accent-ink ring-1 ring-inset ring-accent/25'
                    : 'border-line bg-surface text-ink-secondary hover:border-line-strong hover:bg-surface-hover hover:text-ink'}`}
                >
                  <span>其他</span>
                  {otherSelected ? <Check className="size-3.5 text-accent-ink" strokeWidth={2.2} aria-hidden="true" /> : null}
                </button>
              </div>
              {otherSelected ? (
                <div className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-accent-ink">
                  <Check className="size-3.5" strokeWidth={2} aria-hidden="true" />
                  <span>已选择其他方案，请补充返工建议</span>
                </div>
              ) : null}
              {otherSelected ? (
                <div className="relative mt-2">
                  <input
                    autoFocus
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                      event.preventDefault();
                      if (text.trim()) void resolve('rework');
                    }}
                    placeholder="补充返工建议"
                    className="w-full rounded-lg border border-line bg-surface px-3 py-2 pr-10 text-[12.5px] leading-5 text-ink outline-none transition-colors placeholder:text-ink-quaternary focus:border-line-strong"
                  />
                  <button type="button" aria-label="提交建议" title="提交建议" disabled={!text.trim()} onClick={() => void resolve('rework')} className="absolute top-1/2 right-1.5 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"><Send className="size-3.5" strokeWidth={1.8} /></button>
                </div>
              ) : null}
            </>
          )}
      </div>
      {error ? <p role="alert" className="border-t border-danger/25 bg-danger/5 px-5 py-2 text-[11px] text-danger">{error}</p> : null}
    </section>
  );
}

const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={streaming ? REHYPE_PLUGINS_STREAMING : REHYPE_PLUGINS_FULL}
      components={streaming ? MARKDOWN_COMPONENTS_STREAMING : MARKDOWN_COMPONENTS_FULL}
    >
      {text}
    </ReactMarkdown>
  );
});

const CodeBlock = memo(function CodeBlock({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const source = textFromNode(children).replace(/\n$/, '');
  const language = extractCodeLanguage(children);

  const copy = async () => {
    if (!source) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(source);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = source;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copiedByFallback = document.execCommand('copy');
        textarea.remove();
        if (!copiedByFallback) throw new Error('copy failed');
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="my-3.5 overflow-hidden rounded-xl border border-line bg-[var(--code-bg)]">
      <div className="flex items-center justify-between border-b border-line bg-[var(--code-header-bg)] px-3.5 py-1.5">
        <span className="font-mono text-[11px] font-medium text-ink-tertiary">{language}</span>
        {source ? (
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={t(copied ? 'chat.codeCopied' : 'chat.copyCode')}
            title={t(copied ? 'chat.codeCopied' : 'chat.copyCode')}
            className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-ink-tertiary transition hover:bg-surface-hover hover:text-ink"
          >
            {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        ) : null}
      </div>
      <pre tabIndex={0} className="chat-scrollbar-reveal m-0 max-w-full overflow-x-auto bg-transparent px-3.5 py-3 font-mono text-[13px] leading-[1.65] text-ink">
        {children}
      </pre>
    </div>
  );
});

function extractCodeLanguage(node: ReactNode): string {
  if (isValidElement(node)) {
    const props = node.props as { className?: string };
    const match = /language-([a-z0-9_+-]+)/i.exec(props.className ?? '');
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
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return textFromNode(props.children);
  }
  return '';
}

/**
 * Markdown images use the same main-process media gate as explicit image blocks.
 * Keeping the renderer from assigning the remote URL directly also means CSP and
 * the renderer never become an accidental second network client.
 */
const MarkdownImage = memo(function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const cacheKey = src ? `md-image:${src}` : null;
  const [proxied, setProxied] = useState<string | null>(() => cacheKey ? (mediaUrlCache.get(cacheKey) ?? null) : null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!src || !cacheKey) {
      setProxied(null);
      setFailed(true);
      return;
    }
    const cached = mediaUrlCache.get(cacheKey);
    if (cached) {
      setProxied(cached);
      return;
    }
    setProxied(null);
    let parsed: URL;
    try {
      parsed = new URL(src);
    } catch {
      setFailed(true);
      return;
    }
    if (parsed.protocol !== 'https:') {
      setFailed(true);
      return;
    }
    if (!window.opc) {
      setFailed(true);
      return;
    }
    let active = true;
    window.opc.chatMedia.register({ kind: 'image', url: parsed.href })
      .then((result) => {
        if (!active) return;
        if (result.ok && result.url) {
          mediaUrlCache.set(cacheKey, result.url);
          setProxied(result.url);
        } else {
          setFailed(true);
        }
      })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [cacheKey, src]);

  if (failed) {
    return src
      ? <a href={safeLink(src)} target="_blank" rel="noreferrer noopener" className="break-all text-accent-ink underline underline-offset-2">{alt || src}</a>
      : <span className="text-ink-tertiary">图片加载失败</span>;
  }
  if (!proxied) return <div className="h-20 w-32 animate-pulse rounded-lg bg-ink/5" aria-label={alt ?? '加载图片'} />;
  const cachedAspect = cacheKey ? imageAspectCache.get(cacheKey) : undefined;
  return (
    <img
      src={proxied}
      alt={alt ?? ''}
      style={cachedAspect ? { aspectRatio: String(cachedAspect) } : undefined}
      onLoad={(event) => {
        const { naturalWidth, naturalHeight } = event.currentTarget;
        if (naturalWidth > 0 && naturalHeight > 0 && cacheKey) {
          imageAspectCache.set(cacheKey, naturalWidth / naturalHeight);
        }
      }}
      className="max-h-96 max-w-full rounded-lg"
    />
  );
});

function safeLink(href?: string) {
  if (!href) return undefined;
  try { const url = new URL(href); return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? href : undefined; } catch { return undefined; }
}

const Mermaid = memo(function Mermaid({ source }: { source: string }) {
  const [svg, setSvg] = useState(() => mermaidSvgCache.get(source) ?? '');
  const [failed, setFailed] = useState(false);
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
    mermaid.render(`m-${crypto.randomUUID()}`, source)
      .then((result) => {
        mermaidSvgCache.set(source, result.svg);
        if (active) setSvg(result.svg);
      })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [source]);
  return failed ? <pre className="overflow-x-auto rounded bg-ink/5 p-3 text-sm">{source}</pre> : svg ? <div className="my-3 overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="my-3 h-20 animate-pulse rounded bg-ink/5" />;
});

const VegaLite = memo(function VegaLite({ source }: { source: string }) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!node) return;
    let active = true;
    try {
      const spec = JSON.parse(source);
      if (containsExternalVegaDataUrl(spec)) throw new Error('external data blocked');
      void embed(node, spec, { actions: false, renderer: 'svg' }).catch(() => { if (active) setFailed(true); });
    } catch { setFailed(true); }
    return () => { active = false; node.replaceChildren(); };
  }, [node, source]);
  return failed ? <pre className="overflow-x-auto rounded bg-ink/5 p-3 text-sm">{source}</pre> : <div ref={setNode} className="my-3 max-w-full overflow-x-auto" />;
});

