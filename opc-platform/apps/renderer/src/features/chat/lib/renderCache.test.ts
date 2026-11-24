import { describe, expect, it } from 'vitest';
import { LruCache } from './renderCache';

describe('LruCache', () => {
  it('命中读写并在访问后刷新最近使用顺序，超出容量时淘汰最久未使用的条目', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);

    // Touch 'a' so 'b' becomes the least recently used entry.
    expect(cache.get('a')).toBe(1);

    cache.set('c', 3);
    expect(cache.size).toBe(2);
    expect(cache.has('b')).toBe(false);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);

    cache.clear();
    expect(cache.size).toBe(0);
  });
});
