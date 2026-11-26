export const SCROLLING_ATTR = 'data-scrolling';
export const SCROLL_REVEAL_IDLE_MS = 900;

const ELEMENT_NODE = 1;
const DOCUMENT_NODE = 9;

export interface ScrollableElementLike {
  nodeType?: number;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface ScrollDocumentLike {
  scrollingElement?: Element | null;
  documentElement?: Element | null;
  addEventListener(
    type: 'scroll',
    listener: (event: { target: unknown }) => void,
    options: AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: 'scroll',
    listener: (event: { target: unknown }) => void,
    options: EventListenerOptions,
  ): void;
}

function resolveScrollTarget(
  target: unknown,
  doc: ScrollDocumentLike,
): ScrollableElementLike | null {
  if (!target || typeof target !== 'object') return null;
  const candidate = target as Partial<ScrollableElementLike>;
  if (candidate.nodeType === DOCUMENT_NODE) {
    const root = doc.scrollingElement ?? doc.documentElement;
    return root && typeof root.setAttribute === 'function' ? root : null;
  }
  if (
    candidate.nodeType === ELEMENT_NODE &&
    typeof candidate.setAttribute === 'function' &&
    typeof candidate.removeAttribute === 'function'
  ) {
    return candidate as ScrollableElementLike;
  }
  return null;
}

/**
 * Installs a single capture-phase `scroll` listener on `doc` that marks only
 * the actively scrolling container with `data-scrolling="true"` and clears the
 * attribute after `idleMs` of inactivity.
 *
 * Using one capturing listener + `WeakMap` timers keeps idle overhead at zero,
 * avoids pinning detached elements in memory, and touches the DOM only on
 * idle <-> active transitions rather than on every scroll frame.
 */
export function installScrollReveal(
  doc: ScrollDocumentLike | undefined = typeof document !== 'undefined' ? document : undefined,
  idleMs = SCROLL_REVEAL_IDLE_MS,
): () => void {
  if (!doc) return () => {};

  const timers = new WeakMap<ScrollableElementLike, ReturnType<typeof setTimeout>>();
  const active = new Set<ScrollableElementLike>();

  const onScroll = (event: { target: unknown }) => {
    const target = resolveScrollTarget(event.target, doc);
    if (!target) return;

    const prevTimer = timers.get(target);
    if (prevTimer !== undefined) {
      clearTimeout(prevTimer);
    } else {
      // Only mutate the DOM when transitioning into scrolling so rapid wheel/drag frames skip attribute writes.
      target.setAttribute(SCROLLING_ATTR, 'true');
      active.add(target);
    }

    const nextTimer = setTimeout(() => {
      timers.delete(target);
      active.delete(target);
      target.removeAttribute(SCROLLING_ATTR);
    }, idleMs);
    timers.set(target, nextTimer);
  };

  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });

  return () => {
    doc.removeEventListener('scroll', onScroll, { capture: true });
    for (const target of active) {
      const timer = timers.get(target);
      if (timer !== undefined) clearTimeout(timer);
      timers.delete(target);
      target.removeAttribute(SCROLLING_ATTR);
    }
    active.clear();
  };
}
