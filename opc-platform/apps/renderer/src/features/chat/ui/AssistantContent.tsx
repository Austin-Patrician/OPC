import { memo, useEffect, useId, useRef, useState, type ComponentProps } from 'react';
import { Check, Download, Eye, Maximize2, RefreshCw, RotateCcw, Send, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useTranslation } from 'react-i18next';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import mermaid from 'mermaid';
import embed from 'vega-embed';
import type { ApprovalPermitScope, ChatContentBlock } from '@opc/shared/domain';
import { getFileIcon } from '@/shared/file-icon/file-icons';
import { openDocPreview } from '@/shared/model/docPreviewStore';
import { imageAspectCache, mediaUrlCache } from '../lib/renderCache';
import { remarkChatEntities, transformMarkdownUrl } from '../lib/remarkChatEntities';
import { remarkGuardInlineMath } from '../lib/remarkGuardInlineMath';
import { containsExternalVegaDataUrl } from '../lib/vegaSpec';
import {
  CodeBlock,
  MarkdownAnchor,
  MarkdownBlockquote,
  MarkdownInlineCode,
  MarkdownTable,
  MermaidBlock,
} from './MarkdownBlocks';

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });

type MarkdownComponents = ComponentProps<typeof ReactMarkdown>['components'];
type RemarkPlugins = ComponentProps<typeof ReactMarkdown>['remarkPlugins'];
type RehypePlugins = ComponentProps<typeof ReactMarkdown>['rehypePlugins'];

const REMARK_PLUGINS: RemarkPlugins = [
  remarkGfm,
  remarkMath,
  remarkGuardInlineMath,
  remarkChatEntities,
];
const REHYPE_PLUGINS_FULL: RehypePlugins = [
  [rehypeKatex, { strict: 'ignore' }],
  rehypeHighlight,
];
const REHYPE_PLUGINS_STREAMING: RehypePlugins = [[rehypeKatex, { strict: 'ignore' }]];

const BASE_MARKDOWN_COMPONENTS: MarkdownComponents = {
  a: (props) => <MarkdownAnchor {...props} />,
  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
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
  blockquote: (props) => <MarkdownBlockquote {...props} />,
};

const MARKDOWN_COMPONENTS_FULL: MarkdownComponents = {
  ...BASE_MARKDOWN_COMPONENTS,
  code: ({ className, children, ...props }) => {
    const value = String(children).replace(/\n$/, '');
    if (/language-mermaid/.test(className ?? '')) return <MermaidBlock source={value} />;
    if (/language-vega-lite/.test(className ?? '') || /language-vegalite/.test(className ?? '')) return <VegaLite source={value} />;
    return <MarkdownInlineCode className={className} {...props}>{children}</MarkdownInlineCode>;
  },
};

const MARKDOWN_COMPONENTS_STREAMING: MarkdownComponents = {
  ...BASE_MARKDOWN_COMPONENTS,
  code: ({ className, children, ...props }) => (
    <MarkdownInlineCode className={className} {...props}>
      {children}
    </MarkdownInlineCode>
  ),
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
  onActionCardResolved,
}: {
  blocks: readonly ChatContentBlock[];
  streaming?: boolean;
  onActionCardResolved?: (reportId: string) => void;
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
        return (
          <ContentBlock
            key={key}
            block={block}
            streaming={isTailStreaming}
            onActionCardResolved={onActionCardResolved}
          />
        );
      })}
    </div>
  );
});

const ContentBlock = memo(function ContentBlock({
  block,
  streaming = false,
  onActionCardResolved,
}: {
  block: ChatContentBlock;
  streaming?: boolean;
  onActionCardResolved?: (reportId: string) => void;
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
  const [taskAutoAllow, setTaskAutoAllow] = useState(true);
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
    const isBrowserTakeover = block.browser?.action === 'takeover';
    const isDesktopTakeover = block.desktop?.action === 'takeover';
    const isTakeover = isBrowserTakeover || isDesktopTakeover;
    const answer = async (allow: boolean, explicitScope?: ApprovalPermitScope, customText?: string) => {
      if (approvalState !== 'pending' || approvalSubmitting) return;
      setApprovalError(null);
      setApprovalSubmitting(true);
      try {
        const bridge = window.opc;
        if (!bridge) throw new Error('桌面桥接不可用');
        const resolvedScope: ApprovalPermitScope | undefined = allow
          ? (isTakeover
              ? 'once'
              : block.shell
                ? (explicitScope ?? (taskAutoAllow ? 'task' : 'once'))
                : 'task')
          : undefined;
        await bridge.threads.answer({
          reportId: block.reportId,
          text: customText?.trim() || (allow ? '允许' : '不允许，请换一种方案'),
          allow,
          ...(resolvedScope ? { scope: resolvedScope } : {}),
        });
        // The main process normally pushes a snapshot that removes the card.
        // Hide it immediately as well: an old card can still be mounted while
        // the IPC snapshot is in flight, and approvals are idempotent after a
        // restart. Keeping the local state tied only to the push made a valid
        // click look like it did nothing.
        setApprovalState(allow ? 'allowed' : 'denied');
        onActionCardResolved?.(block.reportId);
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

    if (isTakeover) {
      return (
        <TakeoverCard
          block={block}
          mode={isDesktopTakeover ? 'desktop' : 'browser'}
          approvalSubmitting={approvalSubmitting}
          approvalError={approvalError}
          onAnswer={answer}
        />
      );
    }

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
            {block.shell ? (
              <div className="mt-2 space-y-1.5">
                <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink">
                  {block.shell.command}
                </pre>
                {block.shell.cwd ? (
                  <p className="break-all font-mono text-[11px] text-ink-tertiary">
                    工作区：{block.shell.cwd}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-[1.65] text-ink-secondary">{block.body.split('\n').slice(0, 2).join('\n')}</p>
            )}
            {block.browser?.url ? <p className="mt-2 break-all rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-[11.5px] text-ink-secondary">{block.browser.url}</p> : null}
            {block.browser?.preview ? <p className="mt-2 break-all rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-[11.5px] text-ink-secondary">{block.browser.preview}</p> : null}
            {block.desktop?.appId ? <p className="mt-2 break-all rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-[11.5px] text-ink-secondary">{block.desktop.appId}{block.desktop.windowId ? ` · ${block.desktop.windowId}` : ''}{block.desktop.preview ? `\n${block.desktop.preview}` : ''}</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-muted/35 px-4 py-3 sm:px-5">
          <div className="flex items-center gap-3">
            {block.shell ? (
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-secondary select-none">
                <input
                  type="checkbox"
                  checked={taskAutoAllow}
                  disabled={approvalSubmitting}
                  onChange={(event) => setTaskAutoAllow(event.target.checked)}
                  className="size-3.5 accent-accent"
                />
                <span>本任务内自动放行</span>
              </label>
            ) : (
              <span className="text-[11px] text-ink-tertiary">仅对当前任务生效</span>
            )}
            {block.browser?.sessionId ? <button type="button" disabled={approvalSubmitting} onClick={() => { void window.opc?.browser.show(block.taskId); }} className="text-[11px] font-medium text-accent-ink underline decoration-accent/40 underline-offset-2 hover:text-accent">查看浏览器</button> : null}
            {block.desktop?.appId ? <button type="button" disabled={approvalSubmitting} onClick={() => { void window.opc?.desktop.show(block.taskId); }} className="text-[11px] font-medium text-accent-ink underline decoration-accent/40 underline-offset-2 hover:text-accent">查看桌面</button> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" disabled={approvalSubmitting} onClick={() => void answer(false)} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50">拒绝</button>
            {block.shell ? (
              <button type="button" disabled={approvalSubmitting} onClick={() => void answer(true, 'always')} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50">允许并设为自动执行</button>
            ) : null}
            <button type="button" disabled={approvalSubmitting} onClick={() => void answer(true)} className="inline-flex items-center rounded-lg bg-[var(--primary-btn-bg)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--primary-btn-text)] transition-[background,transform] hover:bg-[var(--primary-btn-hover)] active:scale-[.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50">允许</button>
          </div>
        </div>
        {approvalError ? <p role="alert" className="border-t border-danger/25 bg-danger/5 px-5 py-2 text-[11px] text-danger">{approvalError}</p> : null}
      </section>
    );
  }
  if (block.type === 'workflow') return <WorkflowCard block={block} onActionCardResolved={onActionCardResolved} />;
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

type ApprovalBlock = Extract<ChatContentBlock, { type: 'approval' }>;

const TAKEOVER_KIND_LABELS: Record<string, string> = {
  login: '登录授权',
  captcha: '人机验证',
  registration: '账号注册',
  confirm: '人工确认',
  payment: '支付确认',
  other: '人工协助',
};

const TakeoverCard = memo(function TakeoverCard({
  block,
  mode,
  approvalSubmitting,
  approvalError,
  onAnswer,
}: {
  block: ApprovalBlock;
  mode: 'browser' | 'desktop';
  approvalSubmitting: boolean;
  approvalError: string | null;
  onAnswer: (allow: boolean, explicitScope?: ApprovalPermitScope, customText?: string) => Promise<void>;
}) {
  const isDesktop = mode === 'desktop';
  const [takeoverNote, setTakeoverNote] = useState('');
  const [previewArtifact, setPreviewArtifact] = useState<{ taskId: string; relPath: string } | null>(
    (isDesktop ? block.desktop?.screenshot : block.browser?.screenshot) ?? null,
  );
  const [currentTarget, setCurrentTarget] = useState<string | undefined>(
    isDesktop ? block.desktop?.appId : block.browser?.url,
  );
  const cacheKey = previewArtifact
    ? `image:artifact:${previewArtifact.taskId}:${previewArtifact.relPath}`
    : null;
  const [previewSrc, setPreviewSrc] = useState<string | null>(() =>
    cacheKey ? (mediaUrlCache.get(cacheKey) ?? null) : null,
  );
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const zoomDialogRef = useRef<HTMLDialogElement>(null);
  const dialogTitleId = useId();

  useEffect(() => {
    if (!previewArtifact) {
      setPreviewSrc(null);
      return undefined;
    }
    if (cacheKey) {
      const cached = mediaUrlCache.get(cacheKey);
      if (cached) {
        setPreviewSrc(cached);
        setPreviewError(null);
        return undefined;
      }
    }
    setPreviewSrc(null);
    setPreviewError(null);
    let active = true;
    const bridge = window.opc?.chatMedia;
    if (!bridge) {
      setPreviewError('当前环境暂不支持图片预览');
      return undefined;
    }
    void bridge
      .register({ kind: 'image', taskId: previewArtifact.taskId, relPath: previewArtifact.relPath })
      .then((result) => {
        if (!active) return;
        if (result.ok && result.url) {
          if (cacheKey) mediaUrlCache.set(cacheKey, result.url);
          setPreviewSrc(result.url);
          setPreviewError(null);
        } else {
          setPreviewError(result.error || '画面截图加载失败，可点击刷新重试');
        }
      })
      .catch(() => {
        if (active) setPreviewError('画面截图加载失败，可点击刷新重试');
      });
    return () => {
      active = false;
    };
  }, [cacheKey, previewArtifact]);

  useEffect(() => {
    const dialog = zoomDialogRef.current;
    if (!dialog) return;
    if (zoomOpen && !dialog.open) {
      dialog.showModal();
    } else if (!zoomOpen && dialog.open) {
      dialog.close();
    }
  }, [zoomOpen]);

  const refreshPreview = async () => {
    if (refreshing || approvalSubmitting) return;
    setRefreshing(true);
    setPreviewError(null);
    try {
      if (isDesktop) {
        const desktopBridge = window.opc?.desktop;
        if (!desktopBridge) return;
        const res = await desktopBridge.capturePreview(block.taskId, block.desktop?.appId);
        if (!res.ok || !res.relPath) {
          setPreviewError(res.error || '未能截取到当前桌面画面');
          return;
        }
        setPreviewArtifact({ taskId: res.taskId ?? block.taskId, relPath: res.relPath });
        if (res.appId) setCurrentTarget(res.appId);
      } else {
        const browserBridge = window.opc?.browser;
        if (!browserBridge) return;
        const res = await browserBridge.capturePreview(block.taskId, block.browser?.screenshotSelector);
        if (!res.ok || !res.relPath) {
          setPreviewError(res.error || '未能截取到当前浏览器画面');
          return;
        }
        setPreviewArtifact({ taskId: res.taskId ?? block.taskId, relPath: res.relPath });
        if (res.url) setCurrentTarget(res.url);
      }
    } catch (caught) {
      setPreviewError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRefreshing(false);
    }
  };

  const kind = (isDesktop ? block.desktop?.kind : block.browser?.kind) ?? 'other';
  const kindLabel = TAKEOVER_KIND_LABELS[kind] ?? '人工协助';
  const instructions = (isDesktop ? block.desktop?.instructions : block.browser?.instructions) || block.body;
  const hasPreviewArea = Boolean(previewArtifact || previewError);
  const titleText = block.title.replace(/^需要你接管(?:浏览器|桌面应用)：/, '');

  return (
    <section className="buddy-approval relative my-1.5 w-full max-w-[41.25rem] overflow-hidden rounded-2xl border border-accent/35 bg-surface text-sm text-ink shadow-card transition-[border-color,box-shadow,transform] duration-200 motion-safe:animate-[buddy-approval-in_.24s_ease-out]">
      <div className="flex items-start gap-3.5 px-4 py-4 sm:px-5">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-semibold tracking-[.12em] text-accent-ink uppercase">
            <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
            <span>{isDesktop ? '桌面人工接管' : '浏览器人工接管'}</span>
            <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] tracking-normal text-accent-ink normal-case">
              {kindLabel}
            </span>
          </div>
          <h3 className="text-[14px] leading-5 font-semibold tracking-[-.01em] text-ink">
            {titleText}
          </h3>
          <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-[1.65] text-ink-secondary">
            {instructions}
          </p>

          {hasPreviewArea ? (
            <div className="mt-2.5 overflow-hidden rounded-xl border border-line bg-surface-muted/40">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-1.5 text-[11px] text-ink-tertiary">
                <span>{isDesktop ? '当前应用画面预览 · 支持放大查看' : '当前页面预览 · 可直接扫码或点击放大'}</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={refreshing || approvalSubmitting}
                    onClick={() => void refreshPreview()}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RefreshCw className={`size-3 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
                    <span>{refreshing ? '刷新中…' : '刷新截图'}</span>
                  </button>
                  {previewSrc ? (
                    <button
                      type="button"
                      disabled={approvalSubmitting}
                      onClick={() => setZoomOpen(true)}
                      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent-ink transition-colors hover:bg-surface-hover hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Maximize2 className="size-3" aria-hidden="true" />
                      <span>放大</span>
                    </button>
                  ) : null}
                </div>
              </div>
              {previewError ? (
                <div className="px-3 py-3 text-[11.5px] text-danger">{previewError}</div>
              ) : previewSrc ? (
                <div className="flex justify-center bg-white/95 p-2.5">
                  <button
                    type="button"
                    onClick={() => setZoomOpen(true)}
                    className="group relative block max-w-full cursor-zoom-in rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    aria-label={isDesktop ? '放大查看桌面应用截图' : '放大查看浏览器页面截图'}
                  >
                    <img
                      src={previewSrc}
                      alt={isDesktop ? '当前桌面应用预览' : '当前浏览器页面预览（支持扫码）'}
                      className="max-h-[18rem] w-auto max-w-full rounded-md object-contain"
                    />
                  </button>
                </div>
              ) : (
                <div className="h-36 animate-pulse bg-surface-muted/60" />
              )}
            </div>
          ) : null}

          {currentTarget ? (
            <p className="mt-2 break-all rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-[11.5px] text-ink-secondary">
              {currentTarget}
            </p>
          ) : null}
          <input
            type="text"
            value={takeoverNote}
            disabled={approvalSubmitting}
            onChange={(event) => setTakeoverNote(event.target.value)}
            placeholder="可选附言（例如：已扫码登录 / 已完成确认）"
            className="mt-2.5 w-full rounded-lg border border-line bg-surface-muted px-3 py-1.5 text-[12px] text-ink placeholder:text-ink-quaternary outline-none focus:border-accent"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-muted/35 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={approvalSubmitting}
            onClick={() => {
              if (isDesktop) {
                void window.opc?.desktop.show(block.taskId);
              } else {
                void window.opc?.browser.show(block.taskId);
              }
            }}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-accent-ink transition-colors hover:bg-surface-hover hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isDesktop ? '聚焦目标应用' : '打开 / 聚焦浏览器'}
          </button>
          {!previewArtifact ? (
            <button
              type="button"
              disabled={refreshing || approvalSubmitting}
              onClick={() => void refreshPreview()}
              className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={`size-3 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{refreshing ? '截图中…' : '获取画面截图'}</span>
            </button>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={approvalSubmitting}
            onClick={() =>
              void onAnswer(
                false,
                undefined,
                takeoverNote.trim() || (isDesktop ? '用户取消桌面接管' : '用户取消浏览器接管'),
              )
            }
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={approvalSubmitting}
            onClick={() =>
              void onAnswer(
                true,
                'once',
                takeoverNote.trim() ||
                  (isDesktop ? '已在桌面应用中完成操作，请继续' : '已在真实浏览器中完成操作，请继续'),
              )
            }
            className="inline-flex items-center rounded-lg bg-[var(--primary-btn-bg)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--primary-btn-text)] transition-[background,transform] hover:bg-[var(--primary-btn-hover)] active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            我已完成，继续执行
          </button>
        </div>
      </div>
      {approvalError ? (
        <p role="alert" className="border-t border-danger/25 bg-danger/5 px-5 py-2 text-[11px] text-danger">
          {approvalError}
        </p>
      ) : null}

      <dialog
        ref={zoomDialogRef}
        aria-labelledby={dialogTitleId}
        onCancel={() => setZoomOpen(false)}
        onClose={() => setZoomOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setZoomOpen(false);
        }}
        className="opc-native-dialog m-auto max-h-[90vh] max-w-[92vw] overflow-hidden rounded-2xl border border-line bg-surface p-0 text-ink shadow-popover"
      >
        <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-2.5">
          <h4 id={dialogTitleId} className="text-xs font-medium text-ink-secondary">
            {isDesktop ? '当前桌面应用预览' : '当前浏览器页面预览（支持直接扫码）'}
          </h4>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={refreshing || approvalSubmitting}
              onClick={() => void refreshPreview()}
              className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-muted px-2 py-1 text-[11.5px] font-medium text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={`size-3 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>{refreshing ? '刷新中…' : '刷新截图'}</span>
            </button>
            <button
              type="button"
              onClick={() => setZoomOpen(false)}
              aria-label="关闭预览"
              className="inline-flex size-7 items-center justify-center rounded-md text-ink-tertiary hover:bg-surface-hover hover:text-ink"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="flex max-h-[calc(90vh-3.25rem)] items-center justify-center overflow-auto bg-white p-4">
          {previewSrc ? (
            <img
              src={previewSrc}
              alt={isDesktop ? '当前桌面应用大图预览' : '当前浏览器页面大图预览'}
              className="max-h-[78vh] w-auto max-w-full object-contain"
            />
          ) : null}
        </div>
      </dialog>
    </section>
  );
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

  const preview = () => {
    openDocPreview({
      source: {
        kind: 'artifact',
        taskId: block.source.taskId,
        relPath: block.source.relPath,
      },
      fileName,
    });
  };

  return (
    <div className="flex w-full max-w-[20rem] items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-2 shadow-card transition-colors hover:border-line-strong">
      <button
        type="button"
        onClick={preview}
        title={t('chat.artifact.preview')}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
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
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={preview}
          aria-label={t('chat.artifact.preview')}
          title={t('chat.artifact.preview')}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-tertiary transition-colors hover:bg-surface-hover hover:text-ink"
        >
          <Eye className="size-3.5" />
        </button>
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
    </div>
  );
});

function WorkflowCard({
  block,
  onActionCardResolved,
}: {
  block: Extract<ChatContentBlock, { type: 'workflow' }>;
  onActionCardResolved?: (reportId: string) => void;
}) {
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
      onActionCardResolved?.(block.reportId);
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
      urlTransform={transformMarkdownUrl}
      components={streaming ? MARKDOWN_COMPONENTS_STREAMING : MARKDOWN_COMPONENTS_FULL}
    >
      {text}
    </ReactMarkdown>
  );
});

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
      ? <MarkdownAnchor href={src}>{alt || src}</MarkdownAnchor>
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

