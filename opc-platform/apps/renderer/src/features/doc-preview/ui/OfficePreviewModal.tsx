import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileWarning,
  LoaderCircle,
  PanelLeft,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DocPreviewKind, DocPreviewOpenResult } from '@opc/shared/ipc';
import { getFileIcon } from '@/shared/file-icon/file-icons';
import { useDocPreviewStore } from '@/shared/model/docPreviewStore';

const PdfPreviewViewer = lazy(() => import('./PdfPreviewViewer'));
const DocxPreviewViewer = lazy(() => import('./DocxPreviewViewer'));
const SpreadsheetPreviewViewer = lazy(() => import('./SpreadsheetPreviewViewer'));
const PptxPreviewViewer = lazy(() => import('./PptxPreviewViewer'));
const TextPreviewViewer = lazy(() => import('./TextPreviewViewer'));

const ZOOMABLE_KINDS: ReadonlySet<DocPreviewKind> = new Set(['pdf', 'docx', 'image']);
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;

function formatBytes(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function OfficePreviewModal() {
  const { t } = useTranslation();
  const request = useDocPreviewStore((state) => state.request);
  const closePreview = useDocPreviewStore((state) => state.closePreview);

  const [session, setSession] = useState<DocPreviewOpenResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [showThumbnails, setShowThumbnails] = useState(true);
  const [fitTrigger, setFitTrigger] = useState(0);
  const [pageState, setPageState] = useState<{ current: number; total: number } | null>(null);
  const [pageInput, setPageInput] = useState('1');
  const [jumpRequest, setJumpRequest] = useState<{ page: number; seq: number } | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const jumpSeqRef = useRef(0);

  const handlePageStateChange = useCallback(
    (next: { current: number; total: number } | null) => {
      setPageState(next);
      if (next) {
        setPageInput(String(next.current));
      }
    },
    [],
  );

  const triggerJumpToPage = useCallback(
    (target: number) => {
      if (!pageState || pageState.total <= 0) return;
      const clamped = Math.max(1, Math.min(pageState.total, Math.floor(target)));
      setPageInput(String(clamped));
      setJumpRequest({ page: clamped, seq: ++jumpSeqRef.current });
    },
    [pageState],
  );

  useEffect(() => {
    if (!request) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePreview();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closePreview, request]);

  useEffect(() => {
    let alive = true;
    const closeActiveSession = () => {
      const id = activeSessionIdRef.current;
      activeSessionIdRef.current = null;
      if (id) {
        void window.opc?.docPreview.closeSession(id);
      }
    };

    closeActiveSession();
    setSession(null);
    setZoom(1);
    setActionStatus(null);
    setShowThumbnails(true);
    setFitTrigger(0);
    setPageState(null);
    setPageInput('1');
    setJumpRequest(null);

    if (!request) {
      setLoading(false);
      return undefined;
    }

    const bridge = window.opc?.docPreview;
    if (!bridge) {
      setSession({ ok: false, error: t('chat.artifact.bridgeUnavailable') });
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    void bridge
      .openSession(request.source)
      .then((res) => {
        if (!alive) {
          if (res.sessionId) void bridge.closeSession(res.sessionId);
          return;
        }
        if (res.sessionId) activeSessionIdRef.current = res.sessionId;
        setSession(res);
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        setSession({
          ok: false,
          error: caught instanceof Error ? caught.message : String(caught),
        });
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
      closeActiveSession();
    };
  }, [request, t]);

  if (!request) return null;

  const fileName = session?.fileName ?? request.fileName;
  const extension = fileName.includes('.') ? fileName.split('.').pop() : undefined;
  const bytes = session?.bytes ?? request.bytes;
  const kind = session?.kind ?? 'unsupported';
  const activePreview = Boolean(session?.ok && session.docUrl && !session.tooLargeForInApp);
  const zoomable = Boolean(activePreview && ZOOMABLE_KINDS.has(kind));
  const isPdf = Boolean(activePreview && kind === 'pdf');
  const showPageControls = Boolean(activePreview && pageState && pageState.total > 0);

  const openExternal = async () => {
    setActionStatus(null);
    const res = await window.opc?.docPreview.openExternal(request.source);
    if (res && !res.ok && res.error) setActionStatus(res.error);
  };

  const saveAs = async () => {
    setActionStatus(null);
    const res = await window.opc?.docPreview.saveAs(request.source);
    if (res?.ok) setActionStatus(t('chat.artifact.saved'));
    else if (res?.error && res.error !== '已取消') setActionStatus(res.error);
  };

  return (
    <div
      data-testid="office-preview-modal"
      role="dialog"
      aria-modal="true"
      aria-label={fileName}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[3px] sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePreview();
      }}
    >
      <section className="flex h-[min(90dvh,880px)] w-[min(94vw,1160px)] flex-col overflow-hidden rounded-2xl border border-line bg-panel text-ink shadow-[0_28px_90px_rgba(0,0,0,.32)]">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-4">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {isPdf ? (
              <button
                type="button"
                onClick={() => setShowThumbnails((prev) => !prev)}
                aria-pressed={showThumbnails}
                aria-label={t('docPreview.toggleThumbnails')}
                title={t('docPreview.toggleThumbnails')}
                className={`inline-flex size-7 shrink-0 items-center justify-center rounded-lg border transition ${
                  showThumbnails
                    ? 'border-line bg-surface-muted text-ink'
                    : 'border-transparent text-ink-tertiary hover:bg-surface-hover hover:text-ink'
                }`}
              >
                <PanelLeft size={15} />
              </button>
            ) : null}

            <span
              className="flex size-6 shrink-0 items-center justify-center [&_svg]:size-full"
              dangerouslySetInnerHTML={{ __html: getFileIcon(extension, fileName) }}
              aria-hidden="true"
            />
            <h2 className="truncate text-[13px] font-semibold text-ink" title={fileName}>
              {fileName}
            </h2>
            {typeof bytes === 'number' ? (
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-tertiary">
                {formatBytes(bytes)}
              </span>
            ) : null}
            {actionStatus ? (
              <span className="truncate text-[11px] text-accent-ink">{actionStatus}</span>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {showPageControls && pageState ? (
              <>
                <div className="inline-flex items-center gap-1 text-ink-secondary">
                  {pageState.total > 1 ? (
                    <button
                      type="button"
                      disabled={pageState.current <= 1}
                      onClick={() => triggerJumpToPage(pageState.current - 1)}
                      aria-label={t('docPreview.prevPage')}
                      title={t('docPreview.prevPage')}
                      className="inline-flex size-6 items-center justify-center rounded text-ink-secondary transition hover:bg-surface-hover hover:text-ink disabled:opacity-35"
                    >
                      <ChevronLeft size={14} />
                    </button>
                  ) : null}
                  <form
                    className="inline-flex items-center gap-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const parsed = Number(pageInput);
                      if (Number.isFinite(parsed)) triggerJumpToPage(parsed);
                    }}
                  >
                    <input
                      type="text"
                      inputMode="numeric"
                      value={pageInput}
                      onChange={(event) => setPageInput(event.target.value)}
                      onFocus={(event) => event.currentTarget.select()}
                      onBlur={() => {
                        const parsed = Number(pageInput);
                        if (Number.isFinite(parsed) && parsed >= 1 && parsed <= pageState.total) {
                          if (Math.floor(parsed) !== pageState.current) {
                            triggerJumpToPage(parsed);
                          }
                        } else {
                          setPageInput(String(pageState.current));
                        }
                      }}
                      aria-label={t('docPreview.pageNumber')}
                      className="h-6 w-9 rounded border border-line bg-surface-muted px-1 text-center font-mono text-[11px] tabular-nums text-ink outline-none focus:border-accent"
                    />
                    <span className="font-mono text-[11px] tabular-nums text-ink-tertiary">
                      / {pageState.total}
                    </span>
                  </form>
                  {pageState.total > 1 ? (
                    <button
                      type="button"
                      disabled={pageState.current >= pageState.total}
                      onClick={() => triggerJumpToPage(pageState.current + 1)}
                      aria-label={t('docPreview.nextPage')}
                      title={t('docPreview.nextPage')}
                      className="inline-flex size-6 items-center justify-center rounded text-ink-secondary transition hover:bg-surface-hover hover:text-ink disabled:opacity-35"
                    >
                      <ChevronRight size={14} />
                    </button>
                  ) : null}
                </div>
                <span className="mx-0.5 h-4 w-px bg-line" aria-hidden="true" />
              </>
            ) : null}

            {zoomable ? (
              <>
                <div className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface-muted/60 px-1 py-0.5">
                  <button
                    type="button"
                    disabled={zoom <= MIN_ZOOM}
                    onClick={() => setZoom((z) => Math.max(MIN_ZOOM, Number((z - 0.15).toFixed(2))))}
                    title={t('docPreview.zoomOut')}
                    aria-label={t('docPreview.zoomOut')}
                    className="inline-flex size-6 items-center justify-center rounded text-ink-secondary transition hover:bg-surface-hover hover:text-ink disabled:opacity-40"
                  >
                    <ZoomOut size={13.5} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setZoom(1)}
                    title={t('docPreview.zoomReset')}
                    className="min-w-10 px-1 text-center font-mono text-[11px] tabular-nums text-ink-secondary hover:text-ink"
                  >
                    {Math.round(zoom * 100)}%
                  </button>
                  <button
                    type="button"
                    disabled={zoom >= MAX_ZOOM}
                    onClick={() => setZoom((z) => Math.min(MAX_ZOOM, Number((z + 0.15).toFixed(2))))}
                    title={t('docPreview.zoomIn')}
                    aria-label={t('docPreview.zoomIn')}
                    className="inline-flex size-6 items-center justify-center rounded text-ink-secondary transition hover:bg-surface-hover hover:text-ink disabled:opacity-40"
                  >
                    <ZoomIn size={13.5} />
                  </button>
                  {isPdf ? (
                    <>
                      <span className="mx-0.5 h-3.5 w-px bg-line" aria-hidden="true" />
                      <button
                        type="button"
                        onClick={() => setFitTrigger((n) => n + 1)}
                        title={t('docPreview.fitWidth')}
                        aria-label={t('docPreview.fitWidth')}
                        className="inline-flex size-6 items-center justify-center rounded text-ink-secondary transition hover:bg-surface-hover hover:text-ink"
                      >
                        <ArrowLeftRight size={13} />
                      </button>
                    </>
                  ) : null}
                </div>
                <span className="mx-0.5 h-4 w-px bg-line" aria-hidden="true" />
              </>
            ) : null}

            <button
              type="button"
              onClick={() => void openExternal()}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-[11.5px] font-medium text-ink-secondary transition hover:bg-surface-hover hover:text-ink"
            >
              <ExternalLink size={12.5} />
              <span>{t('docPreview.openExternal')}</span>
            </button>

            {session?.canSaveAs ? (
              <button
                type="button"
                onClick={() => void saveAs()}
                className="inline-flex h-7 items-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-[11.5px] font-medium text-ink-secondary transition hover:bg-surface-hover hover:text-ink"
              >
                <Download size={12.5} />
                <span>{t('chat.artifact.save')}</span>
              </button>
            ) : null}

            <button
              type="button"
              onClick={closePreview}
              aria-label={t('common.close')}
              title={t('common.close')}
              className="inline-flex size-7 items-center justify-center rounded-lg text-ink-tertiary transition hover:bg-surface-hover hover:text-ink"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-ink-tertiary">
              <LoaderCircle size={16} className="animate-spin" />
              <span>{t('docPreview.loading')}</span>
            </div>
          ) : !session?.ok ? (
            <FallbackView
              title={t('docPreview.loadFailed')}
              description={session?.error ?? t('docPreview.unavailable')}
              canSaveAs={false}
              onOpenExternal={() => void openExternal()}
              onSaveAs={() => void saveAs()}
            />
          ) : session.tooLargeForInApp ? (
            <FallbackView
              title={t('docPreview.tooLargeTitle')}
              description={t('docPreview.tooLargeDesc', {
                size: formatBytes(session.bytes),
              })}
              canSaveAs={Boolean(session.canSaveAs)}
              onOpenExternal={() => void openExternal()}
              onSaveAs={() => void saveAs()}
            />
          ) : session.kind === 'unsupported' || !session.docUrl || !session.sessionId ? (
            <FallbackView
              title={t('docPreview.unsupportedTitle')}
              description={session.error ?? t('docPreview.unsupportedDesc')}
              canSaveAs={Boolean(session.canSaveAs)}
              onOpenExternal={() => void openExternal()}
              onSaveAs={() => void saveAs()}
            />
          ) : session.kind === 'image' ? (
            <div className="flex h-full w-full items-center justify-center overflow-auto bg-surface-muted/75 p-6">
              <img
                src={session.docUrl}
                alt={fileName}
                style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
                className="max-h-full max-w-full rounded object-contain shadow-card transition-transform"
              />
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center gap-2 text-xs text-ink-tertiary">
                  <LoaderCircle size={16} className="animate-spin" />
                  <span>{t('docPreview.loadingEngine')}</span>
                </div>
              }
            >
              {session.kind === 'pdf' ? (
                <PdfPreviewViewer
                  docUrl={session.docUrl}
                  zoom={zoom}
                  showThumbnails={showThumbnails}
                  fitTrigger={fitTrigger}
                  requestedPage={jumpRequest}
                  onZoomChange={setZoom}
                  onPageStateChange={handlePageStateChange}
                />
              ) : session.kind === 'docx' ? (
                <DocxPreviewViewer docUrl={session.docUrl} zoom={zoom} />
              ) : session.kind === 'spreadsheet' ? (
                <SpreadsheetPreviewViewer sessionId={session.sessionId} />
              ) : session.kind === 'pptx' ? (
                <PptxPreviewViewer
                  docUrl={session.docUrl}
                  requestedPage={jumpRequest}
                  onPageStateChange={handlePageStateChange}
                />
              ) : (
                <TextPreviewViewer docUrl={session.docUrl} ext={session.ext ?? ''} />
              )}
            </Suspense>
          )}
        </div>
      </section>
    </div>
  );
}

function FallbackView({
  title,
  description,
  canSaveAs,
  onOpenExternal,
  onSaveAs,
}: {
  title: string;
  description: string;
  canSaveAs: boolean;
  onOpenExternal: () => void;
  onSaveAs: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl border border-line bg-surface-muted text-ink-tertiary">
        <FileWarning size={22} />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <p className="max-w-md text-xs leading-relaxed text-ink-tertiary">{description}</p>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenExternal}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary-btn-bg)] px-3.5 py-1.5 text-xs font-medium text-[var(--primary-btn-text)] transition hover:bg-[var(--primary-btn-hover)]"
        >
          <ExternalLink size={13.5} />
          <span>{t('docPreview.openExternal')}</span>
        </button>
        {canSaveAs ? (
          <button
            type="button"
            onClick={onSaveAs}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 py-1.5 text-xs font-medium text-ink-secondary transition hover:bg-surface-hover hover:text-ink"
          >
            <Download size={13.5} />
            <span>{t('chat.artifact.save')}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
