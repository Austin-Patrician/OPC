import { useMemo, useState } from 'react';
import { Archive, ArchiveRestore, BellOff, MoreHorizontal, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Conversation } from '@/entities/conversation/model/types';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { cn } from '@/shared/lib/cn';

interface SessionListProps {
  conversations: readonly Conversation[];
  activeId?: string;
  onSelect: (conversationId: string) => void;
  onArchive: (conversationId: string) => void;
  onRestore: (conversationId: string) => void;
}

/**
 * 276px conversation column. Filtering is local and O(n) over a small list.
 *
 * The header is search only: starting a thread lives in the title bar's `+`
 * (direct or department group) and in the org chart, so this column stays a
 * plain index of what already exists.
 */
export function SessionList({
  conversations,
  activeId,
  onSelect,
  onArchive,
  onRestore,
}: SessionListProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const [archivedOpen, setArchivedOpen] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter(
      (conversation) =>
        conversation.title.toLowerCase().includes(needle) ||
        conversation.lastMessage.toLowerCase().includes(needle),
    );
  }, [conversations, query]);

  // Archived conversations keep their history but stay out of the way; searching
  // still reaches them, so nothing becomes unreachable.
  const activeRows = useMemo(() => filtered.filter((conversation) => !conversation.archivedAt), [filtered]);
  const archived = useMemo(() => filtered.filter((conversation) => conversation.archivedAt), [filtered]);
  const showArchived = archivedOpen || (query.trim().length > 0 && archived.length > 0);

  const [rowMenu, setRowMenu] = useState<string | null>(null);

  const renderRow = (conversation: Conversation) => {
    const isActive = conversation.id === activeId;
    const archivedRow = Boolean(conversation.archivedAt);
    return (
      <div key={conversation.id} className="group/row relative">
      <button
          type="button"
          onClick={() => onSelect(conversation.id)}
          className={cn(
            'flex w-full items-center rounded-lg px-2.5 py-[0.5625rem] text-left transition-colors',
            isActive ? 'bg-surface-active' : 'hover:bg-surface-hover',
          )}
        >
          <Avatar name={conversation.title} src={conversation.avatarUrl} size="md" />

          <span className="ml-2.5 min-w-0 flex-1">
            <span className="flex items-center justify-between gap-1">
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate text-md leading-snug font-medium text-ink">
                  {conversation.title}
                </span>
                {conversation.status && conversation.status !== 'open' ? (
                  <span
                    title={t(`chat.lifecycle.${conversation.status}`)}
                    className={cn(
                      'shrink-0 rounded px-1 py-px text-[0.5625rem] leading-none font-medium',
                      conversation.status === 'escalated'
                        ? 'bg-danger/12 text-danger'
                        : 'bg-ink/5 text-ink-tertiary',
                    )}
                  >
                    {t(`chat.lifecycle.${conversation.status}`)}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs-plus leading-none text-ink-quaternary">
                {conversation.timestamp}
              </span>
            </span>

            <span className="mt-1 flex items-center justify-between gap-1">
              <span className="truncate text-sm-plus leading-snug text-ink-tertiary">
                {conversation.lastMessageHighlight ? (
                  <span className="mr-0.5 text-danger">{conversation.lastMessageHighlight}</span>
                ) : null}
                {conversation.lastMessage}
              </span>

              {conversation.unreadCount ? (
                <span className="flex h-4 min-w-[1.125rem] shrink-0 items-center justify-center rounded-full bg-ink-quaternary px-1.5 text-2xs leading-none font-medium text-white">
                  {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
                </span>
              ) : conversation.muted ? (
                <BellOff className="size-[0.8125rem] shrink-0 text-ink-quaternary" strokeWidth={1.7} />
              ) : null}
            </span>
          </span>
        </button>

        <button
          type="button"
          data-testid="session-menu"
          aria-label={t('sessions.more')}
          aria-expanded={rowMenu === conversation.id}
          onClick={(event) => {
            event.stopPropagation();
            setRowMenu((current) => (current === conversation.id ? null : conversation.id));
          }}
          className="absolute top-2 right-2 hidden size-6 items-center justify-center rounded-md bg-surface/90 text-ink-tertiary shadow-card group-hover/row:flex"
        >
          <MoreHorizontal className="size-3.5" />
        </button>

        {rowMenu === conversation.id ? (
          <div className="absolute top-8 right-2 z-10 w-28 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-modal">
            <button
              type="button"
              data-testid={archivedRow ? 'session-restore' : 'session-archive'}
              onClick={(event) => {
                event.stopPropagation();
                setRowMenu(null);
                if (archivedRow) onRestore(conversation.id);
                else onArchive(conversation.id);
              }}
              className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-ink-secondary hover:bg-surface-hover"
            >
              {archivedRow ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
              {archivedRow ? t('sessions.restore') : t('sessions.archive')}
            </button>
          </div>
        ) : null}
      </div>
      );
  };

  return (
    <section className="relative flex w-sidebar shrink-0 flex-col border-r border-line bg-sidebar select-none surface-blur">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2.5">
        <div className="flex h-[1.875rem] flex-1 items-center gap-1.5 rounded-[6px] bg-surface-muted px-2.5 focus-within:bg-surface focus-within:ring-1 focus-within:ring-accent">
          <Search className="size-3.5 shrink-0 text-ink-quaternary" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('sessions.searchPlaceholder')}
            aria-label={t('sessions.searchPlaceholder')}
            className="w-full bg-transparent text-base text-ink outline-none placeholder:text-ink-quaternary"
          />
        </div>
      </div>

      <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-ink-quaternary">{t('sessions.empty')}</p>
        ) : null}

        {activeRows.map((conversation) => renderRow(conversation))}

        {archived.length > 0 ? (
          <div className="mt-1">
            <button
              type="button"
              data-testid="archived-toggle"
              aria-expanded={showArchived}
              onClick={() => setArchivedOpen((open) => !open)}
              className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-2xs text-ink-quaternary transition-colors hover:bg-surface-hover hover:text-ink-tertiary"
            >
              <span aria-hidden className="text-3xs">{showArchived ? '▾' : '▸'}</span>
              {t('sessions.archived')}
              <span className="font-mono">{archived.length}</span>
            </button>
            {showArchived
              ? archived.map((conversation) => renderRow(conversation))
              : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

