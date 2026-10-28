import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The L1 tier: one `cache.db`, separate from `company.db` on purpose.
 *
 * Cached data is disposable, and disposal must not touch the business database:
 * no shared WAL, no shared VACUUM, no shared backup. Everything here can be
 * deleted with `rm -rf` and the app still works.
 *
 * Shape is a plain key/value table plus a tag index, so invalidation is a SQL
 * statement rather than a scan over JSON blobs.
 */

export interface StoreEntry {
  readonly value: string;
  readonly bytes: number;
  readonly createdAt: number;
  readonly expiresAt: number | null;
  readonly staleUntil: number | null;
  readonly lastUsedAt: number;
  readonly tags: readonly string[];
}

export interface StoreNamespaceStats {
  readonly entries: number;
  readonly bytes: number;
}

interface Statement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface EntryRow {
  value: string;
  bytes: number;
  created_at: number;
  expires_at: number | null;
  stale_until: number | null;
  last_used_at: number;
}

const FILE_NAME = 'cache.db';
const EVICT_BATCH = 200;
const WRITE_BATCH = 200;
/** Leaves headroom so the next write does not immediately evict again. */
const EVICT_TO = 0.8;

/**
 * `auto_vacuum` and `journal_mode` are per-database properties: they must be set
 * before the first table exists, otherwise changing them later needs a full
 * `VACUUM` (measured: setting it after the fact silently does nothing).
 */
const DDL = `
CREATE TABLE IF NOT EXISTS cache_entry (
  namespace    TEXT NOT NULL,
  key          TEXT NOT NULL,
  version      TEXT NOT NULL,
  value        TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  stale_until  INTEGER,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS cache_tag (
  tag       TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key       TEXT NOT NULL,
  PRIMARY KEY (tag, namespace, key),
  FOREIGN KEY (namespace, key) REFERENCES cache_entry(namespace, key) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS cache_lru ON cache_entry(last_used_at);
CREATE INDEX IF NOT EXISTS cache_expiry ON cache_entry(expires_at) WHERE expires_at IS NOT NULL;
`;

export class SqliteCacheStore {
  readonly location: string;

  private readonly db: Database.Database;
  private readonly statements = new Map<string, Statement>();
  /** Recency is buffered: a write per read costs 4.5x a read (measured). */
  private readonly touches = new Map<string, { namespace: string; key: string; at: number }>();
  private bytes: number;

  constructor(
    directory: string,
    private readonly version: string,
    private readonly onError?: (error: unknown, context: string) => void,
  ) {
    fs.mkdirSync(directory, { recursive: true });
    this.location = path.join(directory, FILE_NAME);
    this.db = this.openOrRecover();
    this.bytes = this.measureBytes();

    // A different storage generation means the serialized shape may differ; dropping
    // is cheaper and safer than migrating data nobody needs.
    this.statement('DELETE FROM cache_entry WHERE version <> ?').run(this.version);
    this.bytes = this.measureBytes();
  }

  read(namespace: string, key: string): StoreEntry | undefined {
    const row = this.statement(
      'SELECT value, bytes, created_at, expires_at, stale_until, last_used_at FROM cache_entry WHERE namespace = ? AND key = ?',
    ).get(namespace, key) as EntryRow | undefined;
    if (!row) return undefined;

    const tags = (this.statement('SELECT tag FROM cache_tag WHERE namespace = ? AND key = ?').all(
      namespace,
      key,
    ) as { tag: string }[]).map((row) => row.tag);

    return {
      value: row.value,
      bytes: row.bytes,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      staleUntil: row.stale_until,
      lastUsedAt: row.last_used_at,
      tags,
    };
  }

  write(namespace: string, key: string, entry: StoreEntry): void {
    const previous = this.statement('SELECT bytes FROM cache_entry WHERE namespace = ? AND key = ?').get(
      namespace,
      key,
    ) as { bytes: number } | undefined;

    const write = this.db.transaction(() => {
      this.statement(
        `INSERT INTO cache_entry (namespace, key, version, value, bytes, created_at, expires_at, stale_until, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(namespace, key) DO UPDATE SET
           version = excluded.version, value = excluded.value, bytes = excluded.bytes,
           created_at = excluded.created_at, expires_at = excluded.expires_at,
           stale_until = excluded.stale_until, last_used_at = excluded.last_used_at`,
      ).run(
        namespace,
        key,
        this.version,
        entry.value,
        entry.bytes,
        entry.createdAt,
        entry.expiresAt,
        entry.staleUntil,
        entry.lastUsedAt,
      );

      // Tags are replaced wholesale: a value can be re-tagged without leaving the
      // old tag pointing at rows it no longer describes.
      this.statement('DELETE FROM cache_tag WHERE namespace = ? AND key = ?').run(namespace, key);
      const insertTag = this.statement('INSERT OR IGNORE INTO cache_tag (tag, namespace, key) VALUES (?, ?, ?)');
      for (const tag of entry.tags) insertTag.run(tag, namespace, key);
    });

    write();
    this.bytes += entry.bytes - (previous?.bytes ?? 0);
    this.touches.delete(`${namespace}\u0000${key}`);
  }

  delete(namespace: string, key: string): boolean {
    const row = this.statement('SELECT bytes FROM cache_entry WHERE namespace = ? AND key = ?').get(
      namespace,
      key,
    ) as { bytes: number } | undefined;
    if (!row) return false;
    this.statement('DELETE FROM cache_entry WHERE namespace = ? AND key = ?').run(namespace, key);
    this.bytes -= row.bytes;
    return true;
  }

  deleteNamespace(namespace: string): number {
    const bytes = this.bytesOf(namespace);
    const { changes } = this.statement('DELETE FROM cache_entry WHERE namespace = ?').run(namespace);
    this.bytes -= bytes;
    return changes;
  }

  deleteTag(tag: string): number {
    const rows = this.statement('SELECT namespace, key FROM cache_tag WHERE tag = ?').all(tag) as {
      namespace: string;
      key: string;
    }[];
    if (rows.length === 0) return 0;

    const remove = this.db.transaction(() => {
      for (const row of rows) this.statement('DELETE FROM cache_entry WHERE namespace = ? AND key = ?').run(
        row.namespace,
        row.key,
      );
    });
    remove();
    this.bytes = this.measureBytes();
    return rows.length;
  }

  clear(): number {
    const { changes } = this.statement('DELETE FROM cache_entry').run();
    this.bytes = 0;
    return changes;
  }

  /** Buffer a read timestamp; `flushTouches` applies them in one transaction. */
  touch(namespace: string, key: string, at: number): void {
    this.touches.set(`${namespace}\u0000${key}`, { namespace, key, at });
    if (this.touches.size >= WRITE_BATCH) this.flushTouches();
  }

  flushTouches(): void {
    if (this.touches.size === 0) return;
    const pending = [...this.touches.values()];
    this.touches.clear();

    const flush = this.db.transaction(() => {
      const update = this.statement('UPDATE cache_entry SET last_used_at = ? WHERE namespace = ? AND key = ?');
      for (const { namespace, key, at } of pending) update.run(at, namespace, key);
    });
    try {
      flush();
    } catch (error) {
      this.onError?.(error, 'cache.flushTouches');
    }
  }

  /**
   * Evicts least-recently-used rows until the budget is met.
   *
   * Eviction drops to 80% of the budget so a burst of writes pays for one pass, not
   * one per write.
   */
  evict(namespace: string | null, budget: number): number {
    this.flushTouches();
    let current = namespace ? this.bytesOf(namespace) : this.bytes;
    if (current <= budget) return 0;
    const target = Math.floor(budget * EVICT_TO);

    let removed = 0;
    while (current > target) {
      const rows = (namespace
        ? this.statement(
            'SELECT namespace, key, bytes FROM cache_entry WHERE namespace = ? ORDER BY last_used_at LIMIT ?',
          ).all(namespace, EVICT_BATCH)
        : this.statement('SELECT namespace, key, bytes FROM cache_entry ORDER BY last_used_at LIMIT ?').all(
            EVICT_BATCH,
          )) as { namespace: string; key: string; bytes: number }[];
      if (rows.length === 0) break;

      const before = current;
      const remove = this.db.transaction(() => {
        for (const row of rows) {
          // A batch can overshoot the target by 200x; stop as soon as it is met.
          if (current <= target) break;
          this.statement('DELETE FROM cache_entry WHERE namespace = ? AND key = ?').run(row.namespace, row.key);
          current -= row.bytes;
          removed += 1;
        }
      });
      remove();

      if (current >= before) break; // Defensive: never spin on a no-op delete.
    }

    this.bytes = this.measureBytes();
    return removed;
  }

  /** Drops rows nobody could legally read any more. */
  pruneExpired(now: number): number {
    const { changes } = this.statement(
      `DELETE FROM cache_entry
        WHERE COALESCE(stale_until, expires_at) IS NOT NULL
          AND COALESCE(stale_until, expires_at) <= ?`,
    ).run(now);
    if (changes > 0) this.bytes = this.measureBytes();
    return changes;
  }

  statsByNamespace(): Map<string, StoreNamespaceStats> {
    const rows = this.statement(
      'SELECT namespace, COUNT(*) AS entries, COALESCE(SUM(bytes), 0) AS bytes FROM cache_entry GROUP BY namespace',
    ).all() as { namespace: string; entries: number; bytes: number }[];
    return new Map(rows.map((row) => [row.namespace, { entries: row.entries, bytes: row.bytes }]));
  }

  bytesOf(namespace?: string): number {
    if (!namespace) return this.bytes;
    const row = this.statement('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM cache_entry WHERE namespace = ?').get(
      namespace,
    ) as { bytes: number };
    return row.bytes;
  }

  close(): void {
    this.flushTouches();
    try {
      // Leaves an empty WAL behind instead of one that grows across runs.
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (error) {
      this.onError?.(error, 'cache.checkpoint');
    }
    this.db.close();
  }

  private openOrRecover(): Database.Database {
    try {
      return this.open();
    } catch (error) {
      // A cache is disposable: quarantine the file and start clean instead of
      // failing every read on this install for the rest of its life.
      try {
        fs.renameSync(this.location, `${this.location}.corrupt-${Date.now()}`);
      } catch {
        /* nothing to quarantine */
      }
      for (const suffix of ['-wal', '-shm']) {
        try {
          fs.rmSync(`${this.location}${suffix}`, { force: true });
        } catch {
          /* best effort */
        }
      }
      this.onError?.(error, 'cache.db 无法读取，已重建');
      return this.open();
    }
  }

  private open(): Database.Database {
    const db = new Database(this.location);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 3000');
      db.pragma('temp_store = MEMORY');
      db.pragma('auto_vacuum = INCREMENTAL');

      // quick_check reports corruption instead of throwing; a corrupt cache is a
      // cache miss, not a crash.
      const check = String(db.pragma('quick_check', { simple: true }));
      if (check !== 'ok') throw new Error(`cache.db quick_check: ${check}`);

      db.exec(DDL);
      return db;
    } catch (error) {
      try {
        db.close();
      } catch {
        /* already unusable */
      }
      throw error;
    }
  }

  private measureBytes(): number {
    const row = this.statement('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM cache_entry').get() as {
      bytes: number;
    };
    return row.bytes;
  }

  private statement(sql: string): Statement {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const prepared = this.db.prepare(sql) as Statement;
    this.statements.set(sql, prepared);
    return prepared;
  }
}
