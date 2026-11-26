import { useEffect, useState } from 'react';
import { Check, Copy, LoaderCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';

interface TextPreviewViewerProps {
  docUrl: string;
  ext: string;
}

const MARKDOWN_EXTS = new Set(['.md', '.markdown']);

export default function TextPreviewViewer({ docUrl, ext }: TextPreviewViewerProps) {
  const { t } = useTranslation();
  const isMarkdown = MARKDOWN_EXTS.has(ext.toLowerCase());
  const [renderedMd, setRenderedMd] = useState(isMarkdown);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setRenderedMd(isMarkdown);
  }, [isMarkdown]);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setLoading(true);
    setError(null);

    void fetch(docUrl, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((value) => {
        if (alive) setText(value);
      })
      .catch((caught: unknown) => {
        if (!alive || controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [docUrl]);

  const copyAll = async () => {
    if (!text) return;
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-ink-tertiary">
        <LoaderCircle size={16} className="animate-spin" />
        <span>{t('docPreview.loading')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-danger">
        {error}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-line bg-surface-muted/50 px-3 text-xs">
        <div className="flex items-center gap-1.5">
          {isMarkdown ? (
            <>
              <button
                type="button"
                onClick={() => setRenderedMd(true)}
                className={`rounded px-2 py-0.5 text-[11px] font-medium transition ${
                  renderedMd ? 'bg-surface text-ink shadow-card' : 'text-ink-tertiary hover:text-ink'
                }`}
              >
                {t('docPreview.renderedView')}
              </button>
              <button
                type="button"
                onClick={() => setRenderedMd(false)}
                className={`rounded px-2 py-0.5 text-[11px] font-medium transition ${
                  !renderedMd ? 'bg-surface text-ink shadow-card' : 'text-ink-tertiary hover:text-ink'
                }`}
              >
                {t('docPreview.sourceView')}
              </button>
            </>
          ) : (
            <span className="font-mono text-[11px] text-ink-tertiary">
              {ext ? ext.slice(1).toUpperCase() : 'TEXT'}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void copyAll()}
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-ink-secondary transition hover:bg-surface-hover hover:text-ink"
        >
          {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          <span>{copied ? t('chat.codeCopied') : t('chat.copyCode')}</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-5">
        {renderedMd ? (
          <article className="prose prose-sm mx-auto max-w-3xl text-sm leading-relaxed text-ink [&_a]:text-accent-ink [&_code]:rounded [&_code]:bg-surface-muted [&_code]:px-1 [&_code]:py-0.5 [&_h1]:mb-3 [&_h1]:text-lg [&_h1]:font-bold [&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-[var(--code-bg)] [&_pre]:p-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:px-2.5 [&_td]:py-1.5 [&_th]:border [&_th]:border-line [&_th]:bg-surface-muted [&_th]:px-2.5 [&_th]:py-1.5 [&_ul]:list-disc [&_ul]:pl-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </article>
        ) : (
          <pre className="mx-auto max-w-5xl font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-words text-ink select-text">
            {text}
          </pre>
        )}
      </div>
    </div>
  );
}
