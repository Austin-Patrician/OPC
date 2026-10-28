/**
 * The L0 tier: a bounded LRU over a Map.
 *
 * Kept separate from `CacheService` because it is the only part that has to be
 * fast and the only part that is always present. No timers, no promises, no I/O —
 * the service above composes it with the optional disk tier.
 */

export interface MemoryEntry {
  readonly value: unknown;
  readonly bytes: number;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly staleUntil: number | null;
  readonly tags: readonly string[];
  readonly persist: boolean;
  lastUsedAt: number;
}

const SEPARATOR = '\u0000';
const fullKey = (namespace: string, key: string): string => `${namespace}${SEPARATOR}${key}`;

export class MemoryCache {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly byNamespace = new Map<string, Set<string>>();
  private readonly byTag = new Map<string, Set<string>>();
  private totalBytes = 0;

  /** Reads bump recency, which is what makes eviction LRU rather than FIFO. */
  get(namespace: string, key: string, now: number): MemoryEntry | undefined {
    const entry = this.entries.get(fullKey(namespace, key));
    if (!entry) return undefined;
    entry.lastUsedAt = now;
    return entry;
  }

  set(namespace: string, key: string, entry: MemoryEntry): void {
    const id = fullKey(namespace, key);
    const previous = this.entries.get(id);
    if (previous) this.forget(namespace, id, previous);

    this.entries.set(id, entry);
    this.totalBytes += entry.bytes;
    this.bucket(this.byNamespace, namespace).add(id);
    for (const tag of entry.tags) this.bucket(this.byTag, tag).add(id);
  }

  delete(namespace: string, key: string): boolean {
    const id = fullKey(namespace, key);
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.forget(namespace, id, entry);
    return true;
  }

  deleteNamespace(namespace: string): number {
    const ids = this.byNamespace.get(namespace);
    if (!ids) return 0;
    let removed = 0;
    for (const id of [...ids]) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      this.forget(namespace, id, entry);
      removed += 1;
    }
    return removed;
  }

  deleteTag(tag: string): number {
    const ids = this.byTag.get(tag);
    if (!ids) return 0;
    let removed = 0;
    for (const id of [...ids]) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      // Namespace is the part before the separator; ids are unique across the map.
      const namespace = id.slice(0, id.indexOf(SEPARATOR));
      this.forget(namespace, id, entry);
      removed += 1;
    }
    this.byTag.delete(tag);
    return removed;
  }

  clear(): number {
    const removed = this.entries.size;
    this.entries.clear();
    this.byNamespace.clear();
    this.byTag.clear();
    this.totalBytes = 0;
    return removed;
  }

  /**
   * Drops least-recently-used entries until `bytes <= target`.
   *
   * Eviction happens in one pass to a low-water mark, so a burst of writes costs
   * one sort rather than one sort per write.
   */
  evictTo(target: number): number {
    if (this.totalBytes <= target) return 0;

    const oldestFirst = [...this.entries.entries()]
      .map(([id, entry]) => ({ id, at: entry.lastUsedAt }))
      .sort((a, b) => a.at - b.at);

    let bytes = this.totalBytes;
    let removed = 0;
    for (const { id } of oldestFirst) {
      if (bytes <= target) break;
      const entry = this.entries.get(id);
      if (!entry) continue;
      const owner = id.slice(0, id.indexOf(SEPARATOR));
      this.forget(owner, id, entry);
      bytes -= entry.bytes;
      removed += 1;
    }
    return removed;
  }

  namespaces(): string[] {
    return [...this.byNamespace.keys()];
  }

  bytesOf(namespace?: string): number {
    if (!namespace) return this.totalBytes;
    let bytes = 0;
    for (const id of this.byNamespace.get(namespace) ?? []) bytes += this.entries.get(id)?.bytes ?? 0;
    return bytes;
  }

  countOf(namespace?: string): number {
    if (!namespace) return this.entries.size;
    return this.byNamespace.get(namespace)?.size ?? 0;
  }

  private forget(namespace: string, id: string, entry: MemoryEntry): void {
    this.entries.delete(id);
    this.totalBytes -= entry.bytes;

    const nsBucket = this.byNamespace.get(namespace);
    nsBucket?.delete(id);
    if (nsBucket?.size === 0) this.byNamespace.delete(namespace);

    for (const tag of entry.tags) {
      const tagBucket = this.byTag.get(tag);
      tagBucket?.delete(id);
      if (tagBucket?.size === 0) this.byTag.delete(tag);
    }
  }

  private bucket(map: Map<string, Set<string>>, name: string): Set<string> {
    const existing = map.get(name);
    if (existing) return existing;
    const created = new Set<string>();
    map.set(name, created);
    return created;
  }
}
