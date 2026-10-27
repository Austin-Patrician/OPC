import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { Conversation } from '@/entities/conversation/model/types';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { cn } from '@/shared/lib/cn';

/** Enough to recognise the thread without turning the rail into a second list. */
const MAX_RESULTS = 6;

interface RailSearchProps {
  conversations: readonly Conversation[];
}

/**
 * Conversation search above the navigation items.
 *
 * The results panel is anchored to the input and floats over the body card, which
 * is why the rail's scroll container starts below this component: an `overflow`
 * ancestor would clip the panel. Keyboard-only operation mirrors a combobox —
 * arrows move, Enter opens, Escape clears — without stealing focus from the input.
 */
export function RailSearch({ conversations }: RailSearchProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const needle = query.trim().toLowerCase();

  const results = useMemo(() => {
    if (!needle) return [];
    return conversations
      .filter(
        (conversation) =>
          conversation.title.toLowerCase().includes(needle) ||
          conversation.lastMessage.toLowerCase().includes(needle),
      )
      .slice(0, MAX_RESULTS);
  }, [conversations, needle]);

  const showPanel = open && needle.length > 0;

  // Pointer-down rather than click, so the panel closes before a click lands on
  // whatever is underneath it.
  useEffect(() => {
    if (!showPanel) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [showPanel]);

  const choose = (conversation: Conversation) => {
    navigate(`/chat/${conversation.id}`);
    setQuery('');
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <div className="flex h-7 items-center gap-1.5 rounded-lg bg-ink/5 px-2 transition-colors focus-within:bg-surface focus-within:ring-1 focus-within:ring-accent">
        <Search className="size-3.5 shrink-0 text-ink-quaternary" aria-hidden />
        <input
          type="search"
          value={query}
          aria-label={t('nav.searchPlaceholder')}
          placeholder={t('nav.searchPlaceholder')}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setQuery('');
              setOpen(false);
              event.currentTarget.blur();
              return;
            }
            if (!showPanel) return;
            if (event.key === 'ArrowDown' && results.length > 0) {
              event.preventDefault();
              setActive((index) => (index + 1) % results.length);
            } else if (event.key === 'ArrowUp' && results.length > 0) {
              event.preventDefault();
              setActive((index) => (index - 1 + results.length) % results.length);
            } else if (event.key === 'Enter' && results[active]) {
              event.preventDefault();
              choose(results[active]);
            }
          }}
          className="w-full min-w-0 bg-transparent text-xs text-ink outline-none placeholder:text-ink-quaternary [&::-webkit-search-cancel-button]:hidden"
        />
      </div>

      {showPanel ? (
        <div
          data-testid="rail-search-results"
          className="absolute top-full left-0 z-50 mt-1.5 w-72 rounded-xl border border-line bg-surface p-1 shadow-popover"
        >
          {results.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-ink-quaternary">{t('sessions.empty')}</p>
          ) : (
            results.map((conversation, index) => (
              <button
                key={conversation.id}
                type="button"
                data-testid="rail-search-result"
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(conversation)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                  index === active ? 'bg-surface-hover' : 'hover:bg-surface-hover',
                )}
              >
                <Avatar name={conversation.title} src={conversation.avatarUrl} size="xs" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{conversation.title}</span>
                  <span className="block truncate text-2xs text-ink-tertiary">{conversation.lastMessage}</span>
                </span>
                {conversation.unreadCount ? (
                  <span className="shrink-0 rounded-full bg-danger px-1 text-[0.5625rem] leading-4 font-medium text-white">
                    {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
