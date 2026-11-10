import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/cn';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export type SelectSize = 'compact' | 'default' | 'large';

export interface SelectProps {
  options: readonly SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  size?: SelectSize;
  searchable?: boolean | 'auto';
  testId?: string;
}

interface MenuPosition {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

export function getSelectMenuPosition(
  rect: Pick<DOMRect, 'left' | 'top' | 'bottom' | 'width'>,
  viewportWidth: number,
  viewportHeight: number,
): MenuPosition {
  const width = Math.min(rect.width, Math.max(0, viewportWidth - VIEWPORT_GUTTER * 2));
  const left = Math.min(
    Math.max(VIEWPORT_GUTTER, rect.left),
    Math.max(VIEWPORT_GUTTER, viewportWidth - width - VIEWPORT_GUTTER),
  );
  const below = Math.max(0, viewportHeight - rect.bottom - VIEWPORT_GUTTER - MENU_GAP);
  const above = Math.max(0, rect.top - VIEWPORT_GUTTER - MENU_GAP);
  const placeAbove = below < 180 && above > below;
  return {
    left,
    width,
    maxHeight: Math.min(MENU_MAX_HEIGHT, placeAbove ? above : below),
    ...(placeAbove
      ? { bottom: viewportHeight - rect.top + MENU_GAP }
      : { top: rect.bottom + MENU_GAP }),
  };
}

export function nextSelectIndex(current: number, delta: number, optionCount: number) {
  return optionCount === 0 ? -1 : (current + delta + optionCount) % optionCount;
}

const VIEWPORT_GUTTER = 8;
const MENU_GAP = 4;
const MENU_MAX_HEIGHT = 320;
const SEARCH_THRESHOLD = 10;

export function shouldShowSelectSearch(optionCount: number, searchable: SelectProps['searchable'] = 'auto') {
  return searchable === true || (searchable !== false && optionCount >= SEARCH_THRESHOLD);
}

export function filterSelectOptions(options: readonly SelectOption[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return needle ? options.filter((option) => option.label.toLocaleLowerCase().includes(needle)) : options;
}

export function Select({
  options,
  value,
  defaultValue,
  onValueChange,
  ariaLabel,
  disabled = false,
  className,
  size = 'default',
  searchable = 'auto',
  testId,
}: SelectProps) {
  const { t } = useTranslation();
  const generatedId = useId();
  const listboxId = `select-listbox-${generatedId}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const activeOptionRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef('');
  const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isControlled = value !== undefined;
  const [internalValue, setInternalValue] = useState(defaultValue ?? '');
  const selectedValue = isControlled ? value : internalValue;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const hasSearch = shouldShowSelectSearch(options.length, searchable);
  const visibleOptions = useMemo(() => filterSelectOptions(options, query), [options, query]);
  const selectedOption = options.find((option) => option.value === selectedValue);
  const enabledOptions = visibleOptions.filter((option) => !option.disabled);
  const activeOption = enabledOptions[activeIndex];

  const close = (restoreFocus = true) => {
    setOpen(false);
    setQuery('');
    setActiveIndex(-1);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const moveFocusFromSearch = (backwards: boolean) => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const focusable = Array.from(document.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    )).filter((element) =>
      !menuRef.current?.contains(element) && element.getClientRects().length > 0,
    );
    const index = focusable.indexOf(trigger);
    const target = focusable[index + (backwards ? -1 : 1)] ?? trigger;
    close(false);
    requestAnimationFrame(() => target.focus());
  };

  const choose = (option: SelectOption) => {
    if (option.disabled) return;
    if (!isControlled) setInternalValue(option.value);
    onValueChange?.(option.value);
    close();
  };

  const updatePosition = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setPosition(getSelectMenuPosition(rect, document.documentElement.clientWidth, window.innerHeight));
  };

  const openMenu = (direction: 'first' | 'last' = 'first') => {
    if (disabled || open) return;
    setQuery('');
    const selectedIndex = options.findIndex((option) => option.value === selectedValue && !option.disabled);
    setActiveIndex(
      direction === 'last'
        ? Math.max(0, options.filter((option) => !option.disabled).length - 1)
        : selectedIndex >= 0
          ? options.slice(0, selectedIndex).filter((option) => !option.disabled).length
          : 0,
    );
    updatePosition();
    setOpen(true);
  };

  const moveActive = (delta: number) => {
    if (enabledOptions.length === 0) return;
    setActiveIndex((current) => nextSelectIndex(current, delta, enabledOptions.length));
  };

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    const onViewportChange = () => updatePosition();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(onViewportChange);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
      observer?.disconnect();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (hasSearch) searchRef.current?.focus();
  }, [open, hasSearch]);

  useEffect(() => {
    if (activeIndex >= enabledOptions.length) setActiveIndex(Math.max(0, enabledOptions.length - 1));
  }, [activeIndex, enabledOptions.length]);

  useEffect(() => {
    activeOptionRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, query, open]);

  useEffect(() => () => {
    if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
  }, []);

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(Math.max(0, enabledOptions.length - 1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (activeOption) choose(activeOption);
    } else if (event.key === 'Tab') {
      close(false);
    } else if (!hasSearch && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typeaheadRef.current += event.key.toLocaleLowerCase();
      const match = enabledOptions.findIndex((option) => option.label.toLocaleLowerCase().startsWith(typeaheadRef.current));
      if (match >= 0) setActiveIndex(match);
      if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
      typeaheadTimerRef.current = setTimeout(() => { typeaheadRef.current = ''; }, 700);
    }
  };

  const triggerSizes: Record<SelectSize, string> = {
    compact: 'h-6 px-1.5 text-2xs',
    default: 'h-[30px] px-2.5 text-sm',
    large: 'h-9 px-2.5 text-sm',
  };

  const menu = open && position && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            left: position.left,
            width: position.width,
            maxHeight: position.maxHeight,
            ...(position.top !== undefined ? { top: position.top } : { bottom: position.bottom }),
          }}
          className="z-[60] flex flex-col overflow-hidden rounded-md border border-line bg-surface py-1 shadow-popover outline-none"
        >
          {hasSearch ? (
            <div className="flex shrink-0 items-center gap-2 border-b border-line px-2.5 py-1.5">
              <Search className="size-3.5 shrink-0 text-ink-quaternary" />
              <input
                ref={searchRef}
                role="combobox"
                aria-label={t('common.search')}
                aria-autocomplete="list"
                aria-expanded="true"
                aria-controls={listboxId}
                aria-activedescendant={activeOption ? `${listboxId}-option-${activeIndex}` : undefined}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End' || event.key === 'Enter') {
                    onListKeyDown(event);
                  } else if (event.key === 'Tab') {
                    event.preventDefault();
                    moveFocusFromSearch(event.shiftKey);
                  }
                }}
                placeholder={t('common.search')}
                className="h-6 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-quaternary"
              />
            </div>
          ) : null}
          <div
            ref={listboxRef}
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            aria-activedescendant={activeOption ? `${listboxId}-option-${activeIndex}` : undefined}
            onKeyDown={onListKeyDown}
            tabIndex={-1}
            className="min-h-0 overflow-y-auto py-0.5 outline-none"
          >
            {visibleOptions.map((option) => {
              const enabledIndex = enabledOptions.findIndex((entry) => entry.value === option.value);
              const selected = option.value === selectedValue;
              const active = enabledIndex === activeIndex;
              return (
                <div
                  key={option.value}
                  ref={active ? activeOptionRef : undefined}
                  id={`${listboxId}-option-${enabledIndex}`}
                  role="option"
                  aria-selected={selected}
                  title={option.label}
                  onMouseMove={() => { if (enabledIndex >= 0) setActiveIndex(enabledIndex); }}
                  onClick={() => choose(option)}
                  aria-disabled={option.disabled || undefined}
                  className={cn(
                    'flex h-8 w-full items-center gap-2 px-2.5 text-left text-sm transition-colors',
                    active || selected ? 'bg-surface-hover text-ink' : 'text-ink-secondary',
                    option.disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-surface-hover hover:text-ink',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {selected ? <Check className="size-3.5 shrink-0 text-accent" /> : null}
                </div>
              );
            })}
            {visibleOptions.length === 0 ? (
              <p className="px-3 py-3 text-center text-xs text-ink-tertiary">{t('common.noOptions')}</p>
            ) : null}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role={hasSearch ? undefined : 'combobox'}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && !hasSearch && activeOption ? `${listboxId}-option-${activeIndex}` : undefined}
        disabled={disabled}
        data-testid={testId}
        onClick={() => open ? close(false) : openMenu()}
        onKeyDown={(event) => {
          if (open) {
            onListKeyDown(event);
            return;
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            openMenu();
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu('last');
          }
        }}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-md border border-line bg-surface text-left text-ink outline-none transition-[border-color,box-shadow,background-color] hover:border-line-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/15 disabled:cursor-not-allowed disabled:opacity-45',
          triggerSizes[size],
          className,
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate', !selectedOption && 'text-ink-tertiary')}>
          {selectedOption?.label ?? ''}
        </span>
        <ChevronDown className={cn('size-3.5 shrink-0 text-ink-quaternary transition-transform', open && 'rotate-180')} />
      </button>
      {menu}
    </>
  );
}
