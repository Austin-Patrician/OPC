import { useEffect, useRef, useState } from 'react';
import { Bot, CalendarDays, ChevronLeft, ChevronRight, LoaderCircle, MessageSquareText, Search, UserRound, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ChatSearchInput, ChatSearchResult } from '@opc/shared/ipc';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { BuddyMark } from '@/shared/ui/BuddyMark';
import { formatAppDate, formatAppTime } from '@/shared/lib/appTime';

const PAGE_SIZE = 4;

export function ChatSearchModal({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | 'mine' | 'assistant' | 'system' | 'date'>('all');
  const [dateFilterOpen, setDateFilterOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [results, setResults] = useState<ChatSearchResult[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const input: ChatSearchInput = {
        query,
        ...(category === 'mine' ? { senderId: 'user' } : {}),
        ...(category === 'assistant' ? { senderId: 'router' } : {}),
        ...(category === 'system' ? { kind: 'system' } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        offset: pageIndex * PAGE_SIZE,
        limit: PAGE_SIZE,
      };
      setLoading(true);
      setError('');
      void window.opc!.chat.searchMessages(input)
        .then((page) => {
          if (cancelled) return;
          setResults(page.results);
          setHasMore(page.hasMore);
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, query.trim() || category !== 'all' || from || to ? 220 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, category, from, to, pageIndex]);

  const openResult = (result: ChatSearchResult) => {
    onClose();
    navigate(`/chat/${result.conversationId}?message=${encodeURIComponent(result.message.id)}`);
  };

  const categories = [
    { id: 'all', label: t('chat.search.all'), icon: Search },
    { id: 'mine', label: t('chat.search.user'), icon: UserRound },
    { id: 'assistant', label: t('chat.search.assistant'), icon: Bot },
    { id: 'system', label: t('chat.search.system'), icon: MessageSquareText },
    { id: 'date', label: t('chat.search.date'), icon: CalendarDays },
  ] as const;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 px-4 py-8 backdrop-blur-[3px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-label={t('chat.search.title')} className="buddy-search-modal buddy-search-enter flex h-[min(460px,calc(100dvh-40px))] min-h-[300px] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-black/10 bg-surface text-ink shadow-[0_24px_80px_rgba(0,0,0,.24)]">
        <div className="shrink-0 px-3 pt-3">
          <div className="flex h-11 items-center gap-2.5 rounded-lg border border-black/10 bg-white/90 px-3 shadow-sm focus-within:border-black/20 focus-within:ring-2 focus-within:ring-black/[0.04]">
            <Search size={17} className="shrink-0 text-ink-tertiary" />
            <input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setPageIndex(0); }} placeholder={t('chat.search.placeholder')} className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-tertiary" />
            {loading ? <LoaderCircle size={16} className="animate-spin text-ink-tertiary" /> : null}
            <button type="button" className="flex size-7 items-center justify-center rounded-md text-ink-tertiary transition hover:bg-black/[0.06] hover:text-ink" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}><X size={16} /></button>
          </div>
        </div>
        <nav role="tablist" aria-label={t('chat.search.categories')} className="buddy-search-tabs mt-2 flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-black/[0.08] px-3">
          {categories.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" role="tab" aria-selected={category === id} onClick={() => {
              setCategory(id);
              setPageIndex(0);
              setDateFilterOpen(id === 'date' ? (open) => !open : false);
            }} className={`buddy-search-tab ${category === id ? 'buddy-search-tab-active' : ''}`}>
              <Icon size={14} strokeWidth={1.8} /><span>{label}</span>
            </button>
          ))}
        </nav>
        {dateFilterOpen ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-black/[0.08] bg-surface-muted px-4 py-2.5">
            <span className="text-xs text-ink-tertiary">{t('chat.search.dateRange')}</span>
            <label className="flex items-center gap-1 rounded-md border border-black/10 bg-white px-2 text-xs text-ink-tertiary"><input aria-label={t('chat.search.from')} type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPageIndex(0); }} className="min-w-0 bg-transparent py-1.5 text-ink" /></label>
            <span className="text-xs text-ink-quaternary">–</span>
            <label className="flex items-center gap-1 rounded-md border border-black/10 bg-white px-2 text-xs text-ink-tertiary"><input aria-label={t('chat.search.to')} type="date" value={to} onChange={(event) => { setTo(event.target.value); setPageIndex(0); }} className="min-w-0 bg-transparent py-1.5 text-ink" /></label>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-black/[0.04] bg-surface-muted/70">
          {error ? <p role="alert" className="px-5 py-8 text-center text-sm text-red-600">{error}</p> : null}
          {!error && !loading && results.length === 0 ? <p className="px-5 py-12 text-center text-sm text-ink-tertiary">{t('chat.search.noResults')}</p> : null}
          {results.map((result) => (
            <button key={`${result.conversationId}:${result.message.id}`} type="button" onClick={() => openResult(result)} className="group flex min-h-[76px] w-full items-start gap-3 overflow-hidden border-b border-black/[0.045] px-4 py-2.5 text-left transition-colors hover:bg-white/75 focus-visible:bg-white/80 focus-visible:outline-none">
              {result.message.senderId === 'router' ? <BuddyMark size="sm" /> : <Avatar name={result.message.senderName} src={result.message.senderAvatarUrl} size="sm" className="size-9" />}
              <span className="min-w-0 flex-1 pt-0.5">
                <span className="flex min-w-0 items-center gap-2 text-[11px] leading-4 text-ink-tertiary">
                  <span className="truncate font-medium text-ink-secondary">{result.message.senderName}</span>
                  <span className="truncate">{result.conversationTitle}</span>
                  <time className="ml-auto shrink-0 tabular-nums">{result.createdAt ? `${formatAppDate(result.createdAt, i18n.language)} ${formatAppTime(result.createdAt, i18n.language)}` : result.message.timestamp}</time>
                </span>
                <span className="mt-1 block overflow-hidden break-words text-[13px] leading-[1.5] text-ink" style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2 }}>{result.message.text || t(`chat.search.kind.${result.message.kind}`, { defaultValue: result.message.kind })}</span>
              </span>
            </button>
          ))}
        </div>
        <footer className="flex h-10 shrink-0 items-center justify-between border-t border-black/[0.08] bg-surface px-3 text-[11px] text-ink-tertiary">
          <span>{t('chat.search.page', { page: pageIndex + 1 })}</span>
          <span className="flex items-center gap-1">
            <button type="button" aria-label={t('chat.search.previousPage')} title={t('chat.search.previousPage')} disabled={pageIndex === 0 || loading} onClick={() => setPageIndex((page) => Math.max(0, page - 1))} className="flex size-7 items-center justify-center rounded-md transition hover:bg-surface-muted disabled:opacity-35"><ChevronLeft size={16} /></button>
            <button type="button" aria-label={t('chat.search.nextPage')} title={t('chat.search.nextPage')} disabled={!hasMore || loading} onClick={() => setPageIndex((page) => page + 1)} className="flex size-7 items-center justify-center rounded-md transition hover:bg-surface-muted disabled:opacity-35"><ChevronRight size={16} /></button>
          </span>
        </footer>
      </section>
    </div>
  );
}
