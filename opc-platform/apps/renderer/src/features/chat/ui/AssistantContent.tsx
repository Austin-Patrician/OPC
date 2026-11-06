import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import mermaid from 'mermaid';
import embed from 'vega-embed';
import type { ChatContentBlock } from '@opc/shared/domain';
import { containsExternalVegaDataUrl } from '../lib/vegaSpec';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });

export function AssistantContent({ blocks }: { blocks: readonly ChatContentBlock[] }) {
  return <div className="opc-assistant-content space-y-3">{blocks.map((block, index) => <ContentBlock key={index} block={block} />)}</div>;
}

function ContentBlock({ block }: { block: ChatContentBlock }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    if (block.type === 'markdown') return;
    let active = true;
    if (!window.opc) { setError(true); return; }
    const request = block.source.type === 'url'
      ? window.opc.chatMedia.register({ kind: block.type, url: block.source.url })
      : window.opc.chatMedia.register({ kind: block.type, taskId: block.source.taskId, relPath: block.source.relPath });
    request.then((result) => { if (active && result.ok && result.url) setSrc(result.url); else if (active) setError(true); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [block]);
  if (block.type === 'markdown') return <Markdown text={block.text} />;
  if (error) return <div className="text-sm text-ink-tertiary">媒体加载失败{block.alt ? `：${block.alt}` : ''}</div>;
  if (!src) return <div className="h-10 animate-pulse rounded-lg bg-ink/5" />;
  if (block.type === 'image') return <><button type="button" className="block max-w-full cursor-zoom-in" onClick={() => setZoom(true)}><img src={src} alt={block.alt ?? ''} loading="lazy" className="max-h-[28rem] max-w-full rounded-lg object-contain" /></button>{zoom && <div className="fixed inset-0 z-[100] flex cursor-zoom-out items-center justify-center bg-black/85 p-8" onClick={() => setZoom(false)}><img src={src} alt={block.alt ?? ''} className="max-h-full max-w-full object-contain" /></div>}</>;
  if (block.type === 'video') return <video controls preload="metadata" className="max-h-[28rem] max-w-full rounded-lg" src={src}>{block.title}</video>;
  return <audio controls preload="none" className="max-w-full" src={src}>{block.title}</audio>;
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
    pre: ({ children }) => <pre className="my-3 max-w-full overflow-x-auto rounded-lg bg-[#f3f5f4] p-3 text-[0.86em]">{children}</pre>,
    table: ({ children }) => <div className="my-3 max-w-full overflow-x-auto"><table className="border-collapse text-sm">{children}</table></div>,
    th: ({ children }) => <th className="border border-ink/15 bg-ink/5 px-2 py-1 text-left">{children}</th>,
    td: ({ children }) => <td className="border border-ink/15 px-2 py-1">{children}</td>,
    blockquote: ({ children }) => <blockquote className="border-l-2 border-ink/20 pl-3 text-ink-secondary">{children}</blockquote>,
  }}>{text}</ReactMarkdown>;
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

