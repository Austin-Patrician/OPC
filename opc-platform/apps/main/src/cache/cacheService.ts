import { MemoryCache, type MemoryEntry } from './memoryCache';
import { SqliteCacheStore, type StoreNamespaceStats } from './sqliteCacheStore';
import type {
  CacheHit,
  CacheLoadOptions,
  CacheOptions,
  CacheService,
  CacheServiceOptions,
  CacheStat,
  CacheStats,
} from './types';

/**
 * The service: composes an always-on memory tier with an opt-in disk tier.
 *
 * Deliberately generic — nothing here knows what an employee or an OCR page is.
 * Two ways to use it, and the difference matters:
 *
 * ```ts
 * // 1. Expensive *external* data: let it expire, keep it across restarts.
 * const models = await cache.getOrLoad('model.catalog', providerId, fetchModels, {
 *   ttlMs: 24 * 60 * 60 * 1000,
 *   staleMs: 7 * 24 * 60 * 60 * 1000,
 *   persist: true,
 *   tags: ['model.catalog'],
 * });
 *
 * // 2. Data this process owns: no TTL, memory only, explicit invalidation.
 * const roster = await cache.getOrLoad('org.roster', 'all', loadRoster, { tags: ['org'] });
 * cache.invalidateTag('org'); // after a hire / fire / transfer
 * ```
 *
 * The second form is safe only because the writer and the invalidator are the same
 * process. It is *not* a substitute for a query: a value that changes on every
 * write (counters, running totals) belongs behind a short TTL or not in here at all.
 */

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MEMORY_MAX_BYTES = 64 * 1024 * 1024;
/** Evicting to exactly the budget would evict again on the very next write. */
const LOW_WATER = 0.8;
const DEFAULT_VERSION = 'v1';

interface Counters {
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  errors: number;
}

const emptyCounters = (): Counters => ({ hits: 0, misses: 0, writes: 0, evictions: 0, errors: 0 });

export function createCacheService(options: CacheServiceOptions = {}): CacheService {
  return new LocalCacheService(options);
}

class LocalCacheService implements CacheService {
  private readonly memory = new MemoryCache();
  private readonly counters = new Map<string, Counters>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly memoryMaxBytes: number;
  private readonly namespaceMaxBytes: Readonly<Record<string, number>>;
  private readonly version: string;
  private readonly directory: string | undefined;
  private readonly onError: ((error: unknown, context: string) => void) | undefined;

  private store: SqliteCacheStore | null = null;
  /** A store that cannot be opened is not retried on every call. */
  private storeUnavailable = false;
  /** Failures with no namespace to attribute them to (open, checkpoint, evict). */
  private unattributedErrors = 0;

  constructor(options: CacheServiceOptions) {
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.memoryMaxBytes = options.memoryMaxBytes ?? DEFAULT_MEMORY_MAX_BYTES;
    this.namespaceMaxBytes = options.namespaceMaxBytes ?? {};
    this.version = options.version ?? DEFAULT_VERSION;
    this.directory = options.directory;
    this.onError = options.onError;
  }

  get<T>(namespace: string, key: string): CacheHit<T> | undefined {
    assertAddress(namespace, key);
    const now = this.now();
    const counters = this.countersFor(namespace);

    const entry = this.memory.get(namespace, key, now) ?? this.hydrate(namespace, key, now);
    if (!entry) {
      counters.misses += 1;
      return undefined;
    }

    if (entry.expiresAt !== null && now >= entry.expiresAt) {
      // Past the stale window (or there was none): what is stored is not a value
      // any caller may see, so it is a miss even though the bytes are still here.
      if (entry.staleUntil === null || now >= entry.staleUntil) {
        this.drop(namespace, key);
        counters.misses += 1;
        return undefined;
      }
      counters.hits += 1;
      return { value: entry.value as T, stale: true, ageMs: now - entry.createdAt };
    }

    counters.hits += 1;
    return { value: entry.value as T, stale: false, ageMs: now - entry.createdAt };
  }

  async getOrLoad<T>(
    namespace: string,
    key: string,
    load: () => Promise<T>,
    options: CacheLoadOptions = {},
  ): Promise<T> {
    assertAddress(namespace, key);
    const hit = this.get<T>(namespace, key);
    if (hit && !hit.stale) return hit.value;

    if (hit) {
      // Stale-while-revalidate: the caller gets an answer now, the refresh is the
      // loader's problem. A failure here has nowhere to be thrown.
      this.refresh(namespace, key, load, options).catch((error: unknown) => {
        options.onRefreshError?.(error);
      });
      return hit.value;
    }

    return this.refresh(namespace, key, load, options);
  }

  set<T>(namespace: string, key: string, value: T, options: CacheOptions = {}): void {
    assertAddress(namespace, key);
    const now = this.now();
    const ttl = options.ttlMs ?? 0;
    const stale = options.staleMs ?? 0;
    const expiresAt = ttl > 0 ? now + ttl : null;
    const staleUntil = expiresAt !== null && stale > 0 ? expiresAt + stale : null;

    // JSON is the contract: it is what makes a memory hit and a disk hit the same
    // value, and what makes "drop it at any time" true.
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError(`cache value is not JSON-serializable: ${namespace}/${key}`);
    }

    const transient = options.persist !== true;
    const entry: MemoryEntry = {
      value,
      bytes: Buffer.byteLength(serialized, 'utf8'),
      createdAt: now,
      expiresAt,
      staleUntil,
      tags: options.tags ?? [],
      persist: !transient,
      lastUsedAt: now,
    };

    const previous = this.memory.get(namespace, key, now);
    this.memory.set(namespace, key, entry);
    this.countersFor(namespace).writes += 1;

    const store = this.backend();
    if (store && !transient) {
      this.guard('cache.write', namespace, () =>
        store.write(namespace, key, {
          value: serialized,
          bytes: entry.bytes,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
          staleUntil: entry.staleUntil,
          lastUsedAt: entry.lastUsedAt,
          tags: entry.tags,
        }),
      );
    } else if (store && previous?.persist) {
      // The value used to live on disk. A memory-only write must not leave the old
      // copy behind, or the next restart resurrects data the caller replaced.
      this.guard('cache.demote', namespace, () => store.delete(namespace, key));
    }

    this.enforceBudgets(namespace);
  }

  delete(namespace: string, key: string): boolean {
    assertAddress(namespace, key);
    const inMemory = this.memory.delete(namespace, key);
    const store = this.backend();
    const onDisk = store
      ? (this.guard('cache.delete', namespace, () => store.delete(namespace, key)) ?? false)
      : false;
    return inMemory || onDisk;
  }

  invalidateTag(tag: string): number {
    if (tag === '') throw new TypeError('cache tag must not be empty');
    const inMemory = this.memory.deleteTag(tag);
    const store = this.backend();
    const onDisk = store ? (this.guard('cache.invalidateTag', null, () => store.deleteTag(tag)) ?? 0) : 0;
    return Math.max(inMemory, onDisk);
  }

  clear(namespace?: string): number {
    const store = this.backend();
    if (namespace === undefined) {
      const inMemory = this.memory.clear();
      const onDisk = store ? (this.guard('cache.clear', null, () => store.clear()) ?? 0) : 0;
      return Math.max(inMemory, onDisk);
    }
    const inMemory = this.memory.deleteNamespace(namespace);
    const onDisk = store ? (this.guard('cache.clear', namespace, () => store.deleteNamespace(namespace)) ?? 0) : 0;
    return Math.max(inMemory, onDisk);
  }

  stats(): CacheStats {
    // Deliberately does not open the store: asking for numbers must not create a
    // 256 MB file on an install that never asked for persistence.
    const disk: Map<string, StoreNamespaceStats> = this.store
      ? (this.guard('cache.stats', null, () => this.store?.statsByNamespace()) ?? new Map())
      : new Map();

    const names = new Set<string>([...this.memory.namespaces(), ...disk.keys(), ...this.counters.keys()]);
    const namespaces = [...names].sort().map((namespace) => {
      const counters = this.countersFor(namespace);
      const diskStats = disk.get(namespace);
      return {
        namespace,
        entries: diskStats?.entries ?? this.memory.countOf(namespace),
        bytes: diskStats?.bytes ?? this.memory.bytesOf(namespace),
        hits: counters.hits,
        misses: counters.misses,
        writes: counters.writes,
        evictions: counters.evictions,
        errors: counters.errors,
      } satisfies CacheStat;
    });

    return {
      namespaces,
      errors: this.unattributedErrors + namespaces.reduce((sum, entry) => sum + entry.errors, 0),
    };
  }

  close(): void {
    this.store?.close();
    this.store = null;
    this.inflight.clear();
  }

  private refresh<T>(
    namespace: string,
    key: string,
    load: () => Promise<T>,
    options: CacheLoadOptions,
  ): Promise<T> {
    const address = `${namespace}\u0000${key}`;
    const existing = this.inflight.get(address) as Promise<T> | undefined;
    // Single-flight is not an optimisation here: for a paid call it is the
    // difference between one request and one request per concurrent reader.
    if (existing) return existing;

    const promise = (async () => {
      try {
        const value = await load();
        this.set(namespace, key, value, options);
        return value;
      } finally {
        this.inflight.delete(address);
      }
    })();

    this.inflight.set(address, promise);
    return promise;
  }

  private hydrate(namespace: string, key: string, now: number): MemoryEntry | undefined {
    const store = this.backend();
    if (!store) return undefined;

    const stored = this.guard('cache.read', namespace, () => store.read(namespace, key));
    if (!stored) return undefined;

    let value: unknown;
    try {
      value = JSON.parse(stored.value);
    } catch (error) {
      this.report(error, 'cache.read', namespace);
      this.guard('cache.read.corrupt', namespace, () => store.delete(namespace, key));
      return undefined;
    }

    const entry: MemoryEntry = {
      value,
      bytes: stored.bytes,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt,
      staleUntil: stored.staleUntil,
      tags: stored.tags,
      persist: true,
      lastUsedAt: now,
    };
    this.memory.set(namespace, key, entry);
    // Recency is flushed in batches; a read must not cost a write.
    this.guard('cache.touch', namespace, () => store.touch(namespace, key, now));
    return entry;
  }

  private enforceBudgets(namespace: string): void {
    if (this.memory.bytesOf() > this.memoryMaxBytes) {
      const evicted = this.memory.evictTo(Math.floor(this.memoryMaxBytes * LOW_WATER));
      this.countersFor(namespace).evictions += evicted;
    }

    // Memory-only workloads must not open cache.db just to check a budget.
    const store = this.store;
    if (!store) return;

    const namespaceBudget = this.namespaceMaxBytes[namespace];
    if (namespaceBudget !== undefined) {
      const evicted = this.guard('cache.evict.namespace', namespace, () =>
        store.evict(namespace, namespaceBudget),
      );
      if (evicted) this.countersFor(namespace).evictions += evicted;
    }
    if (store.bytesOf() > this.maxBytes) {
      this.guard('cache.evict', null, () => store.evict(null, this.maxBytes));
    }
  }

  private drop(namespace: string, key: string): void {
    this.memory.delete(namespace, key);
    const store = this.store;
    if (store) this.guard('cache.drop', namespace, () => store.delete(namespace, key));
  }

  private backend(): SqliteCacheStore | null {
    if (this.directory === undefined || this.storeUnavailable) return null;
    if (this.store) return this.store;

    try {
      this.store = new SqliteCacheStore(this.directory, this.version, (error, context) =>
        this.report(error, context, null),
      );
      this.store.pruneExpired(this.now());
      return this.store;
    } catch (error) {
      this.storeUnavailable = true;
      this.report(error, 'cache.open', null);
      return null;
    }
  }

  /** Disk failures must degrade to a miss, never to a thrown cache read. */
  private guard<T>(context: string, namespace: string | null, run: () => T): T | undefined {
    try {
      return run();
    } catch (error) {
      this.report(error, context, namespace);
      return undefined;
    }
  }

  private report(error: unknown, context: string, namespace: string | null): void {
    if (namespace === null) this.unattributedErrors += 1;
    else this.countersFor(namespace).errors += 1;
    this.onError?.(error, context);
  }

  private countersFor(namespace: string): Counters {
    const existing = this.counters.get(namespace);
    if (existing) return existing;
    const created = emptyCounters();
    this.counters.set(namespace, created);
    return created;
  }
}

function assertAddress(namespace: string, key: string): void {
  if (typeof namespace !== 'string' || namespace === '') {
    throw new TypeError('cache namespace must be a non-empty string');
  }
  if (typeof key !== 'string' || key === '') {
    throw new TypeError('cache key must be a non-empty string');
  }
  // The memory tier joins namespace and key with NUL to form its map key; allowing
  // it inside either part would let two different addresses collide.
  if (namespace.includes('\u0000') || key.includes('\u0000')) {
    throw new TypeError('cache namespace and key must not contain NUL');
  }
}
