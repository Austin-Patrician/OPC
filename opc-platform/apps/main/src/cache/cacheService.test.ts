import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCacheService } from './index';

/**
 * The contract this suite protects is not "bytes come back". It is the three
 * properties a cache must have before business code is allowed to depend on it:
 *
 * 1. A miss is always legal — every read can say undefined, and callers reload.
 * 2. Expiry is the caller's policy, never the store's guess.
 * 3. A broken or missing disk never turns into a thrown read.
 */

const directories: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-cache-'));
  directories.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Lets the stale-while-revalidate branch run its loader. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('memory tier', () => {
  it('serves a value without calling the loader twice', async () => {
    const cache = createCacheService();
    const load = vi.fn(async () => ({ name: '光年科技' }));

    const first = await cache.getOrLoad('company.profile', 'all', load);
    const second = await cache.getOrLoad('company.profile', 'all', load);

    expect(first).toEqual(second);
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.get('company.profile', 'all')?.stale).toBe(false);
  });

  it('reports age, so a caller can decide for itself whether a value is old', () => {
    let now = 1_000;
    const cache = createCacheService({ now: () => now });
    cache.set('ns', 'k', 'v');

    now = 4_500;
    expect(cache.get('ns', 'k')).toMatchObject({ value: 'v', stale: false, ageMs: 3_500 });
  });

  it('treats an expired value as a miss and reloads it', async () => {
    let now = 0;
    const cache = createCacheService({ now: () => now });
    const load = vi.fn(async () => `loaded-${load.mock.calls.length}`);

    expect(await cache.getOrLoad('ns', 'k', load, { ttlMs: 1_000 })).toBe('loaded-1');
    now = 999;
    expect(await cache.getOrLoad('ns', 'k', load, { ttlMs: 1_000 })).toBe('loaded-1');
    now = 1_000;
    expect(await cache.getOrLoad('ns', 'k', load, { ttlMs: 1_000 })).toBe('loaded-2');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('serves stale inside the stale window and refreshes behind the caller', async () => {
    let now = 0;
    const cache = createCacheService({ now: () => now });
    cache.set('ns', 'k', 'old', { ttlMs: 100, staleMs: 1_000 });

    now = 200;
    let release: (value: string) => void = () => undefined;
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    expect(await cache.getOrLoad('ns', 'k', load, { ttlMs: 100, staleMs: 1_000 })).toBe('old');
    expect(cache.get('ns', 'k')).toMatchObject({ value: 'old', stale: true });

    release('new');
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.get('ns', 'k')?.value).toBe('new');
  });

  it('stops serving a value once the stale window has passed', () => {
    let now = 0;
    const cache = createCacheService({ now: () => now });
    cache.set('ns', 'k', 'old', { ttlMs: 100, staleMs: 500 });

    now = 599;
    expect(cache.get('ns', 'k')?.stale).toBe(true);
    now = 600;
    expect(cache.get('ns', 'k')).toBeUndefined();
  });

  it('does not cache a failed load', async () => {
    const cache = createCacheService();
    const load = vi.fn().mockRejectedValueOnce(new Error('upstream 502')).mockResolvedValueOnce('ok');

    await expect(cache.getOrLoad('ns', 'k', load)).rejects.toThrow('upstream 502');
    await expect(cache.getOrLoad('ns', 'k', load)).resolves.toBe('ok');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one load between concurrent readers', async () => {
    const cache = createCacheService();
    let calls = 0;
    const load = async () => {
      calls += 1;
      await settle();
      return 'v';
    };

    const [a, b, c] = await Promise.all([
      cache.getOrLoad('ns', 'k', load),
      cache.getOrLoad('ns', 'k', load),
      cache.getOrLoad('ns', 'k', load),
    ]);

    expect([a, b, c]).toEqual(['v', 'v', 'v']);
    expect(calls).toBe(1);
  });

  it('invalidates by tag without touching unrelated entries', () => {
    const cache = createCacheService();
    cache.set('org.roster', 'all', 'roster', { tags: ['org'] });
    cache.set('org.departments', 'all', 'departments', { tags: ['org'] });
    cache.set('model.catalog', 'provider-a', 'models');

    expect(cache.invalidateTag('org')).toBe(2);
    expect(cache.get('org.roster', 'all')).toBeUndefined();
    expect(cache.get('org.departments', 'all')).toBeUndefined();
    expect(cache.get('model.catalog', 'provider-a')?.value).toBe('models');
  });

  it('clears one namespace or everything', () => {
    const cache = createCacheService();
    cache.set('a', '1', 1);
    cache.set('b', '1', 2);

    expect(cache.clear('a')).toBe(1);
    expect(cache.get('a', '1')).toBeUndefined();
    expect(cache.get('b', '1')?.value).toBe(2);

    expect(cache.clear()).toBe(1);
    expect(cache.get('b', '1')).toBeUndefined();
  });

  it('evicts least-recently-used entries when the memory budget is exceeded', () => {
    let now = 0;
    // Five ~102-byte values against a 500-byte budget: the fifth write pushes it
    // over, and eviction runs down to the 80% low-water mark.
    const cache = createCacheService({ now: () => now, memoryMaxBytes: 500 });
    const value = 'x'.repeat(100);

    cache.set('ns', 'a', value);
    now = 1;
    cache.set('ns', 'b', value);
    now = 2;
    cache.set('ns', 'c', value);
    now = 3;
    cache.set('ns', 'd', value);

    // Reading `a` makes it the most recently used, so it must survive.
    now = 4;
    expect(cache.get('ns', 'a')).toBeDefined();

    now = 5;
    cache.set('ns', 'e', value);

    expect(cache.get('ns', 'a')).toBeDefined();
    expect(cache.get('ns', 'e')).toBeDefined();
    expect(cache.get('ns', 'b')).toBeUndefined();
    expect(cache.get('ns', 'c')).toBeUndefined();
  });

  it('rejects values JSON cannot carry', () => {
    const cache = createCacheService();
    expect(() => cache.set('ns', 'k', undefined)).toThrow(TypeError);
    expect(() => cache.set('ns', 'k', { loop: undefined as unknown })).not.toThrow();
  });

  it('rejects an empty namespace or key', () => {
    const cache = createCacheService();
    expect(() => cache.get('', 'k')).toThrow(TypeError);
    expect(() => cache.get('ns', '')).toThrow(TypeError);
  });
});

describe('disk tier', () => {
  it('survives a restart when the write asked for persistence', () => {
    const dir = tempDir();
    const first = createCacheService({ directory: dir });
    first.set('model.catalog', 'p1', [{ id: 'gpt-x' }], { persist: true, ttlMs: 60_000, tags: ['models'] });
    first.close();

    const second = createCacheService({ directory: dir });
    expect(second.get('model.catalog', 'p1')?.value).toEqual([{ id: 'gpt-x' }]);
    second.close();
  });

  it('keeps a memory-only write from resurrecting the old disk copy', () => {
    const dir = tempDir();
    const first = createCacheService({ directory: dir });
    first.set('org.roster', 'all', 'disk', { persist: true });
    first.set('org.roster', 'all', 'memory');
    first.close();

    const second = createCacheService({ directory: dir });
    expect(second.get('org.roster', 'all')).toBeUndefined();
    second.close();
  });

  it('drops everything when the storage version changes', () => {
    const dir = tempDir();
    const first = createCacheService({ directory: dir, version: 'v1' });
    first.set('ns', 'k', 'v1-value', { persist: true });
    first.close();

    const second = createCacheService({ directory: dir, version: 'v2' });
    expect(second.get('ns', 'k')).toBeUndefined();
    second.close();
  });

  it('honours expiry across a restart', () => {
    const dir = tempDir();
    let now = 0;
    const first = createCacheService({ directory: dir, now: () => now });
    first.set('ns', 'k', 'v', { persist: true, ttlMs: 100 });
    first.close();

    now = 50;
    const fresh = createCacheService({ directory: dir, now: () => now });
    expect(fresh.get('ns', 'k')?.value).toBe('v');
    fresh.close();

    now = 1_000;
    const expired = createCacheService({ directory: dir, now: () => now });
    expect(expired.get('ns', 'k')).toBeUndefined();
    expired.close();
  });

  it('evicts least-recently-used rows when the disk budget is exceeded', () => {
    const dir = tempDir();
    let now = 0;
    // Four ~110-byte values against a 400-byte budget.
    const cache = createCacheService({ directory: dir, now: () => now, maxBytes: 400 });
    const value = { body: 'x'.repeat(100) };

    cache.set('ns', 'oldest', value, { persist: true });
    now = 1;
    cache.set('ns', 'second', value, { persist: true });
    now = 2;
    cache.set('ns', 'third', value, { persist: true });
    now = 3;
    cache.set('ns', 'newest', value, { persist: true });
    cache.close();

    const reopened = createCacheService({ directory: dir });
    expect(reopened.get('ns', 'oldest')).toBeUndefined();
    expect(reopened.get('ns', 'second')).toBeUndefined();
    expect(reopened.get('ns', 'newest')?.value).toEqual(value);
    reopened.close();
  });

  it('invalidates a tag on disk, including across a restart', () => {
    const dir = tempDir();
    const first = createCacheService({ directory: dir });
    first.set('org.roster', 'all', 'roster', { persist: true, tags: ['org'] });
    first.set('org.departments', 'all', 'departments', { persist: true, tags: ['org'] });
    first.set('model.catalog', 'p1', 'models', { persist: true, tags: ['models'] });
    first.close();

    const second = createCacheService({ directory: dir });
    expect(second.invalidateTag('org')).toBe(2);
    second.close();

    const third = createCacheService({ directory: dir });
    expect(third.get('org.roster', 'all')).toBeUndefined();
    expect(third.get('org.departments', 'all')).toBeUndefined();
    expect(third.get('model.catalog', 'p1')?.value).toBe('models');
    third.close();
  });

  it('keeps one namespace inside its own disk budget', () => {
    const dir = tempDir();
    const cache = createCacheService({
      directory: dir,
      namespaceMaxBytes: { 'ocr.text': 250 },
    });
    const value = { text: 'x'.repeat(100) };

    cache.set('ocr.text', 'a', value, { persist: true });
    cache.set('ocr.text', 'b', value, { persist: true });
    cache.set('ocr.text', 'c', value, { persist: true });
    cache.set('model.catalog', 'p1', value, { persist: true });
    cache.close();

    // The budget is a *disk* budget: the memory tier has its own cap, so only a
    // fresh process can observe what survived.
    const reopened = createCacheService({ directory: dir });
    expect(reopened.get('ocr.text', 'a')).toBeUndefined();
    expect(reopened.get('ocr.text', 'c')?.value).toEqual(value);
    expect(reopened.get('model.catalog', 'p1')?.value).toEqual(value);
    reopened.close();
  });

  it('rebuilds a corrupt cache.db instead of failing every read', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'cache.db'), 'this is not a sqlite database');
    const onError = vi.fn();

    const cache = createCacheService({ directory: dir, onError });
    cache.set('ns', 'k', 'v', { persist: true });

    expect(cache.get('ns', 'k')?.value).toBe('v');
    expect(onError).toHaveBeenCalled();
    expect(fs.readdirSync(dir).some((name) => name.startsWith('cache.db.corrupt-'))).toBe(true);
    cache.close();
  });

  it('reports bytes and entry counts per namespace', () => {
    const cache = createCacheService({ directory: tempDir() });
    cache.set('model.catalog', 'p1', { a: 1 }, { persist: true });
    cache.set('org.roster', 'all', 'roster');
    cache.get('model.catalog', 'p1');
    cache.get('model.catalog', 'missing');

    const stats = cache.stats();
    const models = stats.namespaces.find((entry) => entry.namespace === 'model.catalog');
    expect(models).toMatchObject({ entries: 1, hits: 1, misses: 1, writes: 1 });
    expect(models?.bytes).toBeGreaterThan(0);
    expect(stats.errors).toBe(0);
    cache.close();
  });

  it('degrades to a miss when the cache directory cannot be used', () => {
    const dir = path.join(tempDir(), 'file-not-a-directory');
    fs.writeFileSync(dir, '');
    const onError = vi.fn();

    const cache = createCacheService({ directory: dir, onError });
    expect(() => cache.set('ns', 'k', 'v', { persist: true })).not.toThrow();
    expect(cache.get('ns', 'k')?.value).toBe('v'); // still served from memory
    cache.close();
  });
});
