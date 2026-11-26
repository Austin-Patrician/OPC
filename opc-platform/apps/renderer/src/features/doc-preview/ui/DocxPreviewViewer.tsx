import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { renderAsync } from 'docx-preview';
import { useTranslation } from 'react-i18next';

interface DocxPreviewViewerProps {
  docUrl: string;
  zoom: number;
}

function revokeBlobImages(container: HTMLElement): void {
  const images = container.querySelectorAll('img[src^="blob:"]');
  for (const img of images) {
    const src = img.getAttribute('src');
    if (src) URL.revokeObjectURL(src);
  }
}

export default function DocxPreviewViewer({ docUrl, zoom }: DocxPreviewViewerProps) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const controller = new AbortController();
    let alive = true;
    setLoading(true);
    setError(null);
    revokeBlobImages(host);
    host.replaceChildren();

    void fetch(docUrl, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then(async (buffer) => {
        if (!alive) return;
        await renderAsync(buffer, host, undefined, {
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          useBase64URL: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
        });
      })
      .catch((caught: unknown) => {
        if (!alive || controller.signal.aborted) return;
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message || t('docPreview.loadFailed'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
      controller.abort();
      revokeBlobImages(host);
      host.replaceChildren();
    };
  }, [docUrl, t]);

  return (
    <div className="relative h-full min-h-0 w-full overflow-auto bg-surface-muted/75 px-4 py-5">
      {loading ? (
        <div className="flex h-full items-center justify-center gap-2 text-xs text-ink-tertiary">
          <LoaderCircle size={16} className="animate-spin" />
          <span>{t('docPreview.loading')}</span>
        </div>
      ) : null}

      {error ? (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs text-danger">
          {error}
        </div>
      ) : null}

      <div
        className="mx-auto w-fit origin-top"
        style={{ zoom }}
      >
        <div
          ref={hostRef}
          className="opc-docx-stage subpixel-antialiased text-neutral-900 [&_.docx-wrapper]:bg-transparent [&_.docx-wrapper]:p-0 [&_.docx-wrapper>section.docx]:mx-auto [&_.docx-wrapper>section.docx]:mb-4 [&_.docx-wrapper>section.docx]:shadow-card"
          style={{
            WebkitFontSmoothing: 'subpixel-antialiased',
            fontFamily:
              "'Microsoft YaHei', 'PingFang SC', 'SimSun', 'Noto Sans SC Variable', 'Inter Variable', sans-serif",
          }}
        />
      </div>
    </div>
  );
}
