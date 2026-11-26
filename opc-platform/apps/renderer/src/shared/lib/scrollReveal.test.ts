import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SCROLLING_ATTR,
  SCROLL_REVEAL_IDLE_MS,
  installScrollReveal,
  type ScrollDocumentLike,
} from './scrollReveal';

function createFakeElement() {
  let scrollAttrCount = 0;
  const attrs = new Map<string, string>();
  return {
    nodeType: 1,
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
      if (name === SCROLLING_ATTR) scrollAttrCount += 1;
    },
    removeAttribute(name: string) {
      attrs.delete(name);
    },
    getAttribute(name: string) {
      return attrs.get(name) ?? null;
    },
    get writeCount() {
      return scrollAttrCount;
    },
  };
}

function createFakeDocument(scrollingElement = createFakeElement()) {
  let listener: ((event: { target: unknown }) => void) | null = null;
  let capturedOptions: AddEventListenerOptions | undefined;

  const doc: ScrollDocumentLike & {
    emitScroll: (target: unknown) => void;
    hasListener: () => boolean;
    capturedOptions: () => AddEventListenerOptions | undefined;
  } = {
    scrollingElement: scrollingElement as unknown as Element,
    addEventListener(type, fn, options) {
      if (type !== 'scroll') return;
      listener = fn;
      capturedOptions = options;
    },
    removeEventListener(type, fn) {
      if (type === 'scroll' && listener === fn) listener = null;
    },
    emitScroll(target: unknown) {
      listener?.({ target });
    },
    hasListener() {
      return listener !== null;
    },
    capturedOptions() {
      return capturedOptions;
    },
  };

  return doc;
}

describe('installScrollReveal', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers a passive capturing scroll listener and cleans up on dispose', () => {
    vi.useFakeTimers();
    const doc = createFakeDocument();
    const el = createFakeElement();
    const dispose = installScrollReveal(doc, 900);

    expect(doc.hasListener()).toBe(true);
    expect(doc.capturedOptions()).toEqual({ capture: true, passive: true });

    doc.emitScroll(el);
    expect(el.getAttribute(SCROLLING_ATTR)).toBe('true');

    dispose();
    expect(doc.hasListener()).toBe(false);
    expect(el.getAttribute(SCROLLING_ATTR)).toBeNull();
  });

  it('writes data-scrolling only once during continuous scrolling and clears after idle timeout', () => {
    vi.useFakeTimers();
    const doc = createFakeDocument();
    const el = createFakeElement();
    const dispose = installScrollReveal(doc, SCROLL_REVEAL_IDLE_MS);

    doc.emitScroll(el);
    vi.advanceTimersByTime(400);
    doc.emitScroll(el);
    vi.advanceTimersByTime(400);
    doc.emitScroll(el);

    expect(el.writeCount).toBe(1);
    expect(el.getAttribute(SCROLLING_ATTR)).toBe('true');

    vi.advanceTimersByTime(SCROLL_REVEAL_IDLE_MS - 1);
    expect(el.getAttribute(SCROLLING_ATTR)).toBe('true');

    vi.advanceTimersByTime(1);
    expect(el.getAttribute(SCROLLING_ATTR)).toBeNull();

    // Next scroll session writes once again cleanly.
    doc.emitScroll(el);
    expect(el.getAttribute(SCROLLING_ATTR)).toBe('true');
    expect(el.writeCount).toBe(2);

    dispose();
  });

  it('tracks independent timers per scrollable container', () => {
    vi.useFakeTimers();
    const doc = createFakeDocument();
    const first = createFakeElement();
    const second = createFakeElement();
    const dispose = installScrollReveal(doc, 500);

    doc.emitScroll(first);
    vi.advanceTimersByTime(300);
    doc.emitScroll(second);

    vi.advanceTimersByTime(200);
    expect(first.getAttribute(SCROLLING_ATTR)).toBeNull();
    expect(second.getAttribute(SCROLLING_ATTR)).toBe('true');

    vi.advanceTimersByTime(300);
    expect(second.getAttribute(SCROLLING_ATTR)).toBeNull();

    dispose();
  });

  it('maps document scroll targets to scrollingElement and ignores non-element targets', () => {
    vi.useFakeTimers();
    const root = createFakeElement();
    const doc = createFakeDocument(root);
    const dispose = installScrollReveal(doc, 500);

    doc.emitScroll({ nodeType: 9 });
    expect(root.getAttribute(SCROLLING_ATTR)).toBe('true');

    // Text nodes / null / window-like targets without element interface are ignored safely.
    expect(() => {
      doc.emitScroll(null);
      doc.emitScroll({ nodeType: 3 });
      doc.emitScroll({});
    }).not.toThrow();

    vi.advanceTimersByTime(500);
    expect(root.getAttribute(SCROLLING_ATTR)).toBeNull();

    dispose();
  });
});
