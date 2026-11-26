import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TableVirtuoso, type TableComponents } from 'react-virtuoso';
import { LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SpreadsheetSheetMeta } from '@opc/shared/ipc';

const PAGE_SIZE = 500;
const MAX_VIEWED_ROWS = 20_000;

interface SpreadsheetPreviewViewerProps {
  sessionId: string;
}

function columnLabel(index: number): string {
  let n = index + 1;
  let label = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

const TABLE_COMPONENTS: TableComponents<string[]> = {
  Table: ({ style, ...props }) => (
    <table
      {...props}
      style={{ ...style, borderCollapse: 'separate', borderSpacing: 0 }}
      className="min-w-full text-left text-[12px] text-ink"
    />
  ),
  TableHead: (props) => <thead {...props} className="sticky top-0 z-10 bg-surface-muted" />,
  TableRow: (props) => (
    <tr {...props} className="hover:bg-surface-hover/50" />
  ),
};

export default function SpreadsheetPreviewViewer({ sessionId }: SpreadsheetPreviewViewerProps) {
  const { t } = useTranslation();
  const [sheets, setSheets] = useState<SpreadsheetSheetMeta[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [rows, setRows] = useState<string[][]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [colCount, setColCount] = useState(0);
  const [colWidths, setColWidths] = useState<number[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [truncatedCols, setTruncatedCols] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingMoreRef = useRef(false);
  const requestSeqRef = useRef(0);

  const loadSheet = useCallback(
    async (sheetIndex: number) => {
      const bridge = window.opc?.docPreview;
      if (!bridge) {
        setError(t('chat.artifact.bridgeUnavailable'));
        setLoading(false);
        return;
      }
      const seq = ++requestSeqRef.current;
      loadingMoreRef.current = false;
      setLoading(true);
      setError(null);
      setRows([]);

      try {
        const result = await bridge.readSpreadsheetPage({
          sessionId,
          sheetIndex,
          offset: 0,
          limit: PAGE_SIZE,
        });
        if (seq !== requestSeqRef.current) return;
        if (!result.ok) {
          setError(result.error ?? t('docPreview.loadFailed'));
          return;
        }
        setSheets(result.sheets ?? []);
        setActiveSheet(result.activeSheetIndex ?? sheetIndex);
        setRows(result.rows ?? []);
        setTotalRows(result.totalRows ?? result.rows?.length ?? 0);
        setColCount(Math.max(1, result.colCount ?? 0));
        setColWidths(result.colWidths ?? []);
        setHasMore(Boolean(result.hasMore) && (result.rows?.length ?? 0) < MAX_VIEWED_ROWS);
        setTruncatedCols(Boolean(result.truncatedCols));
      } catch (caught) {
        if (seq !== requestSeqRef.current) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (seq === requestSeqRef.current) setLoading(false);
      }
    },
    [sessionId, t],
  );

  useEffect(() => {
    void loadSheet(0);
  }, [loadSheet]);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMore || rows.length >= MAX_VIEWED_ROWS) return;
    const bridge = window.opc?.docPreview;
    if (!bridge) return;

    const seq = requestSeqRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const result = await bridge.readSpreadsheetPage({
        sessionId,
        sheetIndex: activeSheet,
        offset: rows.length,
        limit: PAGE_SIZE,
      });
      if (seq !== requestSeqRef.current) return;
      if (result.ok && result.rows?.length) {
        setRows((prev) => {
          const remainingBudget = MAX_VIEWED_ROWS - prev.length;
          const nextBatch = result.rows!.slice(0, Math.max(0, remainingBudget));
          return [...prev, ...nextBatch];
        });
        setColCount((prev) => Math.max(prev, result.colCount ?? 0));
        setHasMore(
          Boolean(result.hasMore) && rows.length + result.rows.length < MAX_VIEWED_ROWS,
        );
      } else {
        setHasMore(false);
      }
    } finally {
      if (seq === requestSeqRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [activeSheet, hasMore, rows.length, sessionId]);

  const columnIndices = useMemo(
    () => Array.from({ length: Math.max(1, colCount) }, (_, idx) => idx),
    [colCount],
  );

  const renderHeader = useCallback(
    () => (
      <tr>
        <th className="sticky left-0 z-20 w-12 min-w-12 border-b border-r border-line bg-surface-muted px-2 py-1.5 text-center font-mono text-[10.5px] font-medium text-ink-tertiary">
          #
        </th>
        {columnIndices.map((colIdx) => {
          const width = colWidths[colIdx] ?? 132;
          return (
            <th
              key={colIdx}
              style={{ minWidth: `${width}px`, maxWidth: '320px' }}
              className="border-b border-r border-line bg-surface-muted px-2.5 py-1.5 text-center font-mono text-[10.5px] font-medium text-ink-tertiary"
            >
              {columnLabel(colIdx)}
            </th>
          );
        })}
      </tr>
    ),
    [colWidths, columnIndices],
  );

  const renderRow = useCallback(
    (rowIndex: number, row: string[]) => (
      <>
        <td className="sticky left-0 z-[1] w-12 min-w-12 border-b border-r border-line/80 bg-surface-muted/85 px-2 py-1 text-center font-mono text-[10.5px] tabular-nums text-ink-tertiary">
          {rowIndex + 1}
        </td>
        {columnIndices.map((colIdx) => {
          const value = row[colIdx] ?? '';
          const width = colWidths[colIdx] ?? 132;
          return (
            <td
              key={colIdx}
              title={value}
              style={{ minWidth: `${width}px`, maxWidth: '320px' }}
              className={`max-w-[320px] truncate border-b border-r border-line/70 px-2.5 py-1 align-middle ${
                rowIndex === 0 ? 'bg-surface-muted/40 font-medium text-ink' : 'text-ink-secondary'
              }`}
            >
              {value}
            </td>
          );
        })}
      </>
    ),
    [colWidths, columnIndices],
  );

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
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line bg-surface-muted/50 px-3 py-1.5 text-[11px] text-ink-tertiary">
        <span className="font-mono tabular-nums">
          {t('docPreview.spreadsheetMeta', {
            loaded: rows.length.toLocaleString(),
            total: totalRows.toLocaleString(),
            cols: colCount,
          })}
        </span>
        {truncatedCols || rows.length >= MAX_VIEWED_ROWS ? (
          <span className="text-warning">{t('docPreview.spreadsheetTruncated')}</span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-ink-tertiary">
            {t('docPreview.emptySheet')}
          </div>
        ) : (
          <TableVirtuoso
            data={rows}
            components={TABLE_COMPONENTS}
            fixedHeaderContent={renderHeader}
            itemContent={renderRow}
            endReached={() => void loadMore()}
            overscan={20}
            className="h-full w-full"
          />
        )}
      </div>

      {loadingMore ? (
        <div className="flex shrink-0 items-center justify-center gap-1.5 border-t border-line bg-surface-muted/60 py-1 text-[11px] text-ink-tertiary">
          <LoaderCircle size={12} className="animate-spin" />
          <span>{t('docPreview.loadingMoreRows')}</span>
        </div>
      ) : null}

      {sheets.length > 0 ? (
        <div
          role="tablist"
          aria-label={t('docPreview.sheets')}
          className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-line bg-surface-muted/70 px-3 py-1.5"
        >
          {sheets.map((sheet) => {
            const active = sheet.index === activeSheet;
            return (
              <button
                key={`${sheet.index}-${sheet.name}`}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  if (sheet.index !== activeSheet) {
                    void loadSheet(sheet.index);
                  }
                }}
                className={`shrink-0 rounded-md px-2.5 py-1 text-[11.5px] font-medium transition ${
                  active
                    ? 'bg-surface text-ink shadow-card ring-1 ring-line'
                    : 'text-ink-tertiary hover:bg-surface-hover hover:text-ink-secondary'
                }`}
              >
                {sheet.name}
                <span className="ml-1.5 font-mono text-[10px] text-ink-quaternary">
                  {sheet.rowCount}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
