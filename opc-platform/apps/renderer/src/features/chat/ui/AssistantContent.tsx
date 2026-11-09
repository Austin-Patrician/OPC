import { isValidElement, useEffect, useState, type ReactNode } from 'react';
import { Check, Copy, Download, RotateCcw, Send, ShieldCheck, X } from 'lucide-react';
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
import { containsExternalVegaDataUrl } from '../lib/vegaSpec';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });

export function AssistantContent({ blocks }: { blocks: readonly ChatContentBlock[] }) {
  return (
    <div className="opc-assistant-content min-w-0 max-w-full overflow-hidden break-words space-y-3">
      {blocks.map((block, index) => {
        // Action cards have local submitting/resolved state. A positional key
        // lets React reuse that state for a different card after one is removed,
        // which can make a newly restored approval look unclickable.
        const key = block.type === 'approval' || block.type === 'workflow'
          ? `${block.type}:${block.reportId}`
          : block.type === 'ontologyApproval'
            ? `${block.type}:${block.commandId}`
          : `${block.type}:${index}`;
        return <ContentBlock key={key} block={block} />;
      })}
    </div>
  );
}

function ContentBlock({ block }: { block: ChatContentBlock }) {
  const [src, setSrc] = useState<string | null>(null);
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
    if (block.type === 'markdown' || block.type === 'file' || block.type === 'approval' || block.type === 'workflow' || block.type === 'ontologyApproval') return;
    let active = true;
    const bridge = window.opc;
    if (!bridge) { setError(true); return; }
    const request = block.source.type === 'url'
      ? bridge.chatMedia.register({ kind: block.type, url: block.source.url })
      : bridge.chatMedia.register({ kind: block.type, taskId: block.source.taskId, relPath: block.source.relPath });
    request.then((result) => { if (active && result.ok && result.url) setSrc(result.url); else if (active) setError(true); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [block]);
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
      <section className="buddy-approval relative my-1 w-full max-w-[41.25rem] overflow-hidden rounded-[14px] border border-[#e8e7df] bg-[#fffefa] text-sm text-[#29372f] shadow-[0_2px_10px_rgba(37,48,40,.035)] transition-[border-color,box-shadow,transform] duration-200 motion-safe:animate-[buddy-approval-in_.24s_ease-out]">
        <div className="flex items-start gap-3.5 px-4 py-4 sm:px-5">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] font-semibold tracking-[.12em] text-[#a0783e] uppercase">
              <span className="size-1.5 rounded-full bg-[#b58b4d]" aria-hidden="true" />
              <span>工具权限</span>
              <span className="font-mono font-normal tracking-normal text-[#8b8d7b] normal-case">{block.tool}</span>
            </div>
            <h3 className="text-[14px] leading-5 font-semibold tracking-[-.01em] text-[#29372f]">{block.title.replace(/^要你点头：/, '')}</h3>
            <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-[1.65] text-[#70776f]">{block.body.split('\n').slice(0, 2).join('\n')}</p>
            {block.browser?.url ? <p className="mt-2 break-all rounded-md bg-[#f5f4ee] px-2.5 py-2 font-mono text-[11px] text-[#59635a]">{block.browser.url}</p> : null}
            {block.browser?.preview ? <p className="mt-2 break-all rounded-md bg-[#f5f4ee] px-2.5 py-2 font-mono text-[11px] text-[#59635a]">{block.browser.preview}</p> : null}
            {block.desktop?.appId ? <p className="mt-2 break-all rounded-md bg-[#f5f4ee] px-2.5 py-2 font-mono text-[11px] text-[#59635a]">{block.desktop.appId}{block.desktop.windowId ? ` · ${block.desktop.windowId}` : ''}{block.desktop.preview ? `\n${block.desktop.preview}` : ''}</p> : null}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-[#eeede6] px-4 py-3 sm:px-5">
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-[#96988e]">仅对当前任务生效</span>
            {block.browser?.sessionId ? <button type="button" disabled={approvalSubmitting} onClick={() => { void window.opc?.browser.show(block.taskId); }} className="text-[11px] font-medium text-[#536859] underline decoration-[#c4ccbd] underline-offset-2 hover:text-[#29372f]">查看浏览器</button> : null}
            {block.desktop?.appId ? <button type="button" disabled={approvalSubmitting} onClick={() => { void window.opc?.desktop.show(block.taskId); }} className="text-[11px] font-medium text-[#536859] underline decoration-[#c4ccbd] underline-offset-2 hover:text-[#29372f]">查看桌面</button> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
              <button type="button" disabled={approvalSubmitting} onClick={() => void answer(false)} className="rounded-md px-3 py-1.5 text-[12px] font-medium text-[#73776f] transition-colors hover:bg-[#f4f3ee] hover:text-[#343d35] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8d9a75] disabled:cursor-not-allowed disabled:opacity-50">拒绝</button>
              <button type="button" disabled={approvalSubmitting} onClick={() => void answer(true)} className="inline-flex items-center rounded-md bg-[#283b31] px-3.5 py-1.5 text-[12px] font-medium text-white transition-[background,transform] hover:bg-[#355443] active:scale-[.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8d9a75] disabled:cursor-not-allowed disabled:opacity-50">允许</button>
          </div>
        </div>
        {approvalError ? <p role="alert" className="border-t border-[#f0ddd8] px-5 py-2 text-[11px] text-[#a34d40]">{approvalError}</p> : null}
      </section>
    );
  }
  if (block.type === 'ontologyApproval') return <OntologyApprovalCard block={block} />;
  if (block.type === 'workflow') return <WorkflowCard block={block} />;
  if (block.type === 'markdown') return <Markdown text={block.text} />;
  if (block.type === 'file') return <FileBlock block={block} />;
  if (error) return <div className="text-sm text-ink-tertiary">媒体加载失败{block.alt ? `：${block.alt}` : ''}</div>;
  if (!src) return <div className="h-10 animate-pulse rounded-lg bg-ink/5" />;
  if (block.type === 'image') return <><button type="button" className="block max-w-full cursor-zoom-in" onClick={() => setZoom(true)}><img src={src} alt={block.alt ?? ''} loading="lazy" className="max-h-[28rem] max-w-full rounded-lg object-contain" /></button>{zoom && <div className="fixed inset-0 z-[100] flex cursor-zoom-out items-center justify-center bg-black/85 p-8" onClick={() => setZoom(false)}><img src={src} alt={block.alt ?? ''} className="max-h-full max-w-full object-contain" /></div>}</>;
  if (block.type === 'video') return <video controls preload="metadata" className="max-h-[28rem] max-w-full rounded-lg" src={src}>{block.title}</video>;
  return <audio controls preload="none" className="max-w-full" src={src}>{block.title}</audio>;
}

function FileBlock({ block }: { block: Extract<ChatContentBlock, { type: 'file' }> }) {
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
    <div className="flex w-full max-w-[18rem] items-center gap-2 rounded-xl border border-ink/10 bg-white/70 px-2.5 py-2">
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
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-tertiary transition-colors hover:bg-ink/5 hover:text-ink"
      >
        <Download className="size-3.5" />
      </button>
    </div>
  );
}

function OntologyApprovalCard({ block }: { block: Extract<ChatContentBlock, { type: 'ontologyApproval' }> }) {
  const [state, setState] = useState(block.state);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (block.state !== 'pending') setState(block.state);
  }, [block.state]);

  const decide = async (approved: boolean) => {
    if (state !== 'pending' || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const bridge = window.opc;
      if (!bridge) throw new Error('桌面桥接不可用');
      const result = await bridge.ontology.commandStatus(block.commandId, approved ? 'approved' : 'rejected');
      if (result && result.status === 'failed') throw new Error(result.error ?? '命令执行失败');
      setState(approved ? 'approved' : 'rejected');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  if (state !== 'pending') return null;
  return (
    <section className="buddy-approval relative my-1 w-full max-w-[41.25rem] overflow-hidden rounded-[14px] border border-[#e8e7df] bg-[#fffefa] text-sm text-[#29372f] shadow-[0_2px_10px_rgba(37,48,40,.035)] motion-safe:animate-[buddy-approval-in_.24s_ease-out]">
      <div className="flex items-start gap-3.5 px-4 py-4 sm:px-5">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[#a0783e]" strokeWidth={1.8} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] font-semibold tracking-[.12em] text-[#a0783e] uppercase">
            <span>需要确认</span>
            <span className="font-mono font-normal tracking-normal text-[#8b8d7b] normal-case">{block.action}</span>
          </div>
          <h3 className="text-[14px] leading-5 font-semibold tracking-[-.01em] text-[#29372f]">{block.title}</h3>
          <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-[1.65] text-[#70776f]">{block.body}</p>
          <p className="mt-2 text-[11px] text-[#96988e]">对象：{block.objectType}</p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-[#eeede6] px-4 py-3 sm:px-5">
        <button type="button" disabled={submitting} onClick={() => void decide(false)} className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium text-[#73776f] transition-colors hover:bg-[#f4f3ee] hover:text-[#343d35] disabled:cursor-not-allowed disabled:opacity-50"><X className="size-3.5" strokeWidth={1.8} />拒绝</button>
        <button type="button" disabled={submitting} onClick={() => void decide(true)} className="inline-flex items-center gap-1.5 rounded-md bg-[#283b31] px-3.5 py-1.5 text-[12px] font-medium text-white transition-[background,transform] hover:bg-[#355443] active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50"><Check className="size-3.5" strokeWidth={2} />允许</button>
      </div>
      {error ? <p role="alert" className="border-t border-[#f0ddd8] px-5 py-2 text-[11px] text-[#a34d40]">{error}</p> : null}
    </section>
  );
}

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
    <section className="buddy-approval relative my-1 w-full max-w-[41.25rem] overflow-hidden rounded-[14px] border border-[#e8e7df] bg-[#fffefa] text-sm text-[#29372f] shadow-[0_2px_10px_rgba(37,48,40,.035)] transition-[border-color,box-shadow,transform] duration-200 motion-safe:animate-[buddy-approval-in_.24s_ease-out]">
      <div className="flex items-start gap-3.5 px-4 py-4 sm:px-5">
        <div className="min-w-0 flex-1">
          <div className={`mb-1 flex items-center gap-1.5 text-[10px] font-semibold tracking-[.12em] uppercase ${block.kind === 'question' ? 'text-[#8b8d7b]' : 'text-[#a0783e]'}`}>
            {block.kind === 'question' ? null : <span className="size-1.5 rounded-full bg-[#b58b4d]" aria-hidden="true" />}
            {block.kind === 'question' ? '需要回复' : '等待确认'}
          </div>
          <h3 className="text-[14px] leading-5 font-semibold tracking-[-.01em] text-[#29372f]">{block.title}</h3>
          <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-[1.65] text-[#70776f]">{block.body}</p>
        </div>
      </div>
      <div className="border-t border-[#eeede6] px-4 py-3 sm:px-5">
          {block.kind === 'question' ? (
            <div className="relative">
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={2}
                placeholder="写下回复…"
                className="w-full resize-y rounded-md border border-[#e9e8df] bg-[#fbfaf6] px-3 py-2 pr-11 text-[12px] leading-5 text-[#29372f] outline-none transition-colors placeholder:text-[#a3a397] focus:border-[#87947b] focus:bg-white"
              />
              <button
                type="button"
                aria-label="发送回复"
                title="发送回复"
                disabled={!text.trim() || submitting}
                onClick={() => void resolve('answer')}
                className="absolute right-1.5 bottom-1.5 inline-flex size-7 items-center justify-center rounded-md text-[#526a59] transition-colors hover:bg-[#e9eee7] hover:text-[#283b31] disabled:cursor-not-allowed disabled:opacity-35"
              >
                <Send className="size-3.5" strokeWidth={1.8} />
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-col items-stretch gap-1.5">
                <button type="button" disabled={submitting} onClick={() => void resolve('rework')} className="inline-flex w-full items-center gap-1.5 rounded-md border border-[#e4e3da] bg-[#fbfaf6] px-3 py-1.5 text-left text-[12px] font-medium text-[#626b63] transition-colors hover:border-[#c8cbbd] hover:bg-[#f4f3ee] hover:text-[#343d35] disabled:cursor-not-allowed disabled:opacity-50"><RotateCcw className="size-3.5" strokeWidth={1.8} />返工</button>
                <button type="button" disabled={submitting} onClick={() => void resolve('approve')} className="inline-flex w-full items-center gap-1.5 rounded-md bg-[#283b31] px-3.5 py-1.5 text-left text-[12px] font-medium text-white transition-[background,transform] hover:bg-[#355443] active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50"><Check className="size-3.5" strokeWidth={2} />认可</button>
                <button
                  type="button"
                  aria-pressed={otherSelected}
                  disabled={submitting}
                  onClick={() => void resolve('other')}
                  className={`box-border inline-flex min-h-9 w-full items-center justify-between overflow-hidden rounded-md border px-3 py-1.5 text-left text-[12px] font-medium transition-[border-color,background,box-shadow,color] ${otherSelected
                    ? 'border-[#607765] bg-[#e8efe8] text-[#283b31] ring-1 ring-inset ring-[#b7c8b8]'
                    : 'border-[#e4e3da] bg-[#fbfaf6] text-[#626b63] hover:border-[#c8cbbd] hover:bg-[#f4f3ee] hover:text-[#343d35]'}`}
                >
                  <span>其他</span>
                  {otherSelected ? <Check className="size-3.5 text-[#4e6b56]" strokeWidth={2.2} aria-hidden="true" /> : null}
                </button>
              </div>
              {otherSelected ? (
                <div className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-[#607765]">
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
                    className="w-full rounded-md border border-[#e9e8df] bg-[#fbfaf6] px-3 py-2 pr-10 text-[12px] leading-5 text-[#29372f] outline-none transition-colors placeholder:text-[#a3a397] focus:border-[#87947b] focus:bg-white"
                  />
                  <button type="button" aria-label="提交建议" title="提交建议" disabled={!text.trim()} onClick={() => void resolve('rework')} className="absolute top-1/2 right-1.5 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-[#526a59] transition-colors hover:bg-[#e9eee7] hover:text-[#283b31] disabled:cursor-not-allowed disabled:opacity-35"><Send className="size-3.5" strokeWidth={1.8} /></button>
                </div>
              ) : null}
            </>
          )}
      </div>
      {error ? <p role="alert" className="border-t border-[#f0ddd8] px-5 py-2 text-[11px] text-[#a34d40]">{error}</p> : null}
    </section>
  );
}

function Markdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex, rehypeHighlight]} components={{
    a: ({ href, children, ...props }) => <a href={safeLink(href)} target="_blank" rel="noreferrer noopener" className="break-all text-accent-ink underline underline-offset-2" {...props}>{children}</a>,
    img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
    code: ({ className, children, ...props }) => {
      const value = String(children).replace(/\n$/, '');
      if (/language-mermaid/.test(className ?? '')) return <Mermaid source={value} />;
      if (/language-vega-lite/.test(className ?? '') || /language-vegalite/.test(className ?? '')) return <VegaLite source={value} />;
      return <code className={className} {...props}>{children}</code>;
    },
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    table: ({ children }) => <div className="my-3 max-w-full overflow-x-auto"><table className="border-collapse text-sm">{children}</table></div>,
    th: ({ children }) => <th className="border border-ink/15 bg-ink/5 px-2 py-1 text-left">{children}</th>,
    td: ({ children }) => <td className="border border-ink/15 px-2 py-1">{children}</td>,
    blockquote: ({ children }) => <blockquote className="border-l-2 border-ink/20 pl-3 text-ink-secondary">{children}</blockquote>,
  }}>{text}</ReactMarkdown>;
}

function CodeBlock({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const source = textFromNode(children).replace(/\n$/, '');

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
    <div className="group relative my-3">
      <pre className="max-w-full overflow-x-auto rounded-lg bg-[#f3f5f4] p-3 text-[0.86em]">{children}</pre>
      {source ? (
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={t(copied ? 'chat.codeCopied' : 'chat.copyCode')}
          title={t(copied ? 'chat.codeCopied' : 'chat.copyCode')}
          className="absolute top-2 right-2 inline-flex size-7 items-center justify-center rounded-md border border-black/10 bg-white/85 text-ink-tertiary shadow-sm backdrop-blur transition hover:bg-white hover:text-ink focus-visible:opacity-100"
        >
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </button>
      ) : null}
    </div>
  );
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
function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const [proxied, setProxied] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setProxied(null);
    setFailed(false);
    if (!src) {
      setFailed(true);
      return;
    }
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
        if (result.ok && result.url) setProxied(result.url);
        else setFailed(true);
      })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [src]);

  if (failed) {
    return src
      ? <a href={safeLink(src)} target="_blank" rel="noreferrer noopener" className="break-all text-accent-ink underline underline-offset-2">{alt || src}</a>
      : <span className="text-ink-tertiary">图片加载失败</span>;
  }
  if (!proxied) return <div className="h-20 w-32 animate-pulse rounded-lg bg-ink/5" aria-label={alt ?? '加载图片'} />;
  return <img src={proxied} alt={alt ?? ''} loading="lazy" className="max-h-96 max-w-full rounded-lg" />;
}

function safeLink(href?: string) {
  if (!href) return undefined;
  try { const url = new URL(href); return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? href : undefined; } catch { return undefined; }
}

function Mermaid({ source }: { source: string }) {
  const [svg, setSvg] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => { let active = true; mermaid.render(`m-${crypto.randomUUID()}`, source).then((result) => { if (active) setSvg(result.svg); }).catch(() => { if (active) setFailed(true); }); return () => { active = false; }; }, [source]);
  return failed ? <pre className="overflow-x-auto rounded bg-ink/5 p-3 text-sm">{source}</pre> : svg ? <div className="my-3 overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="my-3 h-20 animate-pulse rounded bg-ink/5" />;
}

function VegaLite({ source }: { source: string }) {
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
}

