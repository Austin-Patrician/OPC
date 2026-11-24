/**
 * Bounded LRU cache backed by Map insertion order.
 * Used to keep media proxy URLs, natural image aspect ratios, and rendered
 * Mermaid SVGs across Virtuoso row unmount/remount cycles without leaking memory.
 */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    if (!Number.isFinite(maxSize) || maxSize <= 0) {
      throw new RangeError('LruCache maxSize must be a positive finite number');
    }
    this.maxSize = Math.floor(maxSize);
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxSize) {
      const oldestKey = this.entries.keys().next().value as K;
      this.entries.delete(oldestKey);
    }
    this.entries.set(key, value);
  }

  clear(): void {
    this.entries.clear();
  }
}

export const mediaUrlCache = new LruCache<string, string>(200);
export const imageAspectCache = new LruCache<string, number>(200);
export const mermaidSvgCache = new LruCache<string, string>(100);
