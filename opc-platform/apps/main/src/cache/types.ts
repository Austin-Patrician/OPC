/**
 * A place to put data that is expensive to (re)compute.
 *
 * The service knows nothing about the app's tables: a caller hands it a namespace,
 * a key and a JSON value, and gets the value back until it expires or is
 * invalidated. Two backends, one contract:
 *
 * - **L0 memory** (always on): per process, LRU-bounded, gone on quit.
 * - **L1 disk** (opt-in per write via `persist`): survives restarts, bounded by
 *   `maxBytes`, disposable at any moment.
 *
 * Three rules that keep this from becoming a second source of truth:
 *
 * 1. It never throws into the caller's path. A broken store degrades to a miss and
 *    is reported through `onError`.
 * 2. It never decides *when* the underlying data changed. Expiry is a policy the
 *    caller sets; invalidation is something the caller does (`delete` /
 *    `invalidateTag` / `clear`).
 * 3. Values are JSON. That is what makes memory and disk interchangeable — and
 *    what makes a cached value safe to drop at any time.
 *
 * The intended split in this app: derived *external* data (model lists, OCR text,
 * fetched pages) is persisted with a TTL; data this process itself writes (org
 * roster, company profile) is memory-only and invalidated on write.
 */

/** Per-entry policy. Everything here is optional; the default is "keep forever". */
export interface CacheOptions {
  /** Freshness window in ms. Omitted or <= 0 means "never expires". */
  readonly ttlMs?: number;
  /**
   * How long past `ttlMs` a value may still be served while a refresh runs.
   * Only `getOrLoad` uses this; `get` reports `stale: true`.
   */
  readonly staleMs?: number;
  /** Mirror this value to disk. Default false: memory only. */
  readonly persist?: boolean;
  /** Invalidation groups. `invalidateTag('org')` drops every entry carrying it. */
  readonly tags?: readonly string[];
}

/** What a cache read tells the caller. */
export interface CacheHit<T> {
  readonly value: T;
  /** Past `ttlMs` but inside `staleMs`: usable, and worth refreshing. */
  readonly stale: boolean;
  /** Milliseconds since the value was written (survives a restart for L1). */
  readonly ageMs: number;
}

/** `getOrLoad` options: the refresh failure of a stale hit has nowhere to throw. */
export interface CacheLoadOptions extends CacheOptions {
  /** Called when a background refresh of a stale value fails. */
  readonly onRefreshError?: (error: unknown) => void;
}

/** Observability: enough to answer "is this layer earning its disk". */
export interface CacheStat {
  readonly namespace: string;
  readonly entries: number;
  readonly bytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly writes: number;
  readonly evictions: number;
  readonly errors: number;
}

export interface CacheStats {
  readonly namespaces: CacheStat[];
  /** Failures outside any single namespace: open, checkpoint, global eviction. */
  readonly errors: number;
}

export interface CacheService {
  /** Synchronous by design: the disk backend is better-sqlite3. */
  get<T>(namespace: string, key: string): CacheHit<T> | undefined;
  /**
   * Read-through: returns a fresh hit, refreshes a stale one in the background, or
   * loads on a miss. Concurrent calls for the same key share one load.
   */
  getOrLoad<T>(
    namespace: string,
    key: string,
    load: () => Promise<T>,
    options?: CacheLoadOptions,
  ): Promise<T>;
  set<T>(namespace: string, key: string, value: T, options?: CacheOptions): void;
  /** Drops both tiers. Returns whether anything was removed. */
  delete(namespace: string, key: string): boolean;
  /** Drops every entry carrying `tag`. Returns the number of entries removed. */
  invalidateTag(tag: string): number;
  /** Drops one namespace, or everything when omitted. Returns entries removed. */
  clear(namespace?: string): number;
  stats(): CacheStats;
  /** Flushes pending LRU timestamps and closes the disk backend. */
  close(): void;
}

export interface CacheServiceOptions {
  /**
   * Where `cache.db` lives. Omitted means memory-only: the disk backend is never
   * opened, and `persist: true` writes are silently kept in memory.
   */
  readonly directory?: string;
  /**
   * Storage-format generation. Bump it to drop everything at once after a
   * serialization change, instead of writing a migration for disposable data.
   */
  readonly version?: string;
  /** Total disk budget in bytes. Default 256 MB. Evicts LRU at 80% when exceeded. */
  readonly maxBytes?: number;
  /**
   * In-memory budget in bytes. Default 64 MB. Deliberately smaller than the disk
   * budget: L0 is a speed tier, not a place to park data.
   */
  readonly memoryMaxBytes?: number;
  /**
   * Per-namespace **disk** budget. The memory tier has a single global cap, so an
   * eviction here can leave the value serving from memory until the process exits.
   */
  readonly namespaceMaxBytes?: Readonly<Record<string, number>>;
  /** Injected clock so TTL behaviour is testable without waiting. */
  readonly now?: () => number;
  /**
   * A cache must not take the app down, but silence hides bugs. The bootstrap
   * passes the app logger here.
   */
  readonly onError?: (error: unknown, context: string) => void;
}
