import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  applySqliteMigrations,
  SQLITE_MIGRATIONS,
  SqliteStorage,
  type SqliteDatabase,
  type SqliteExecutor,
  type SqliteValue,
} from '@earendil-works/pi-durable/storage/sqlite';

/**
 * Electron's CJS resolver does not honor chord's ESM-only `./sqlite/node` export.
 * Keep the tiny Node SQLite adapter here so the main process can open durable storage
 * without importing that subpath. The API follows chord's SqliteDatabase contract.
 */
class RouterSqliteDatabase implements SqliteDatabase {
  private readonly statements = new Map<string, StatementSync>();
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private closed = false;

  constructor(private readonly database: DatabaseSync) {}

  exec(sql: string): Promise<void> {
    return this.runOperation(() => this.database.exec(sql));
  }

  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.runOperation(() => { this.statement(sql).run(...params); });
  }

  runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
    return this.runOperation(() => Number(this.statement(sql).run(...params).changes));
  }

  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.runOperation(() => this.statement(sql).get(...params) as T | undefined);
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.runOperation(() => this.statement(sql).all(...params) as T[]);
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.runAsync(async () => {
      this.database.exec('BEGIN IMMEDIATE');
      let active = true;
      const transaction: SqliteExecutor = {
        exec: async (sql) => { this.assertTransaction(active); this.database.exec(sql); },
        run: async (sql, ...params) => { this.assertTransaction(active); this.statement(sql).run(...params); },
        runCounted: async (sql, ...params) => {
          this.assertTransaction(active);
          return Number(this.statement(sql).run(...params).changes);
        },
        get: async <R extends object>(sql: string, ...params: SqliteValue[]) => {
          this.assertTransaction(active);
          return this.statement(sql).get(...params) as R | undefined;
        },
        all: async <R extends object>(sql: string, ...params: SqliteValue[]) => {
          this.assertTransaction(active);
          return this.statement(sql).all(...params) as R[];
        },
      };
      try {
        const result = await callback(transaction);
        active = false;
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        active = false;
        try {
          this.database.exec('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'SQLite transaction failed and rollback failed');
        }
        throw error;
      }
    });
  }

  close(): Promise<void> {
    return this.runOperation(() => {
      if (this.closed) return;
      this.closed = true;
      this.statements.clear();
      try {
        this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        this.database.close();
      }
    });
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database.prepare(sql);
      this.statements.set(sql, statement);
      if (this.statements.size > 256) this.statements.delete(this.statements.keys().next().value!);
    }
    return statement;
  }

  private assertTransaction(active: boolean): void {
    if (!active) throw new Error('SQLite transaction handle is no longer active');
  }

  private runOperation<T>(operation: () => T): Promise<T> {
    if (this.pending > 0) return this.enqueue(operation);
    try {
      return Promise.resolve(operation());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private runAsync<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending > 0) return this.enqueue(operation);
    this.pending++;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    this.tail = barrier;
    let started: Promise<T>;
    try {
      started = operation();
    } catch (error) {
      started = Promise.reject(error);
    }
    return started.finally(() => {
      this.pending--;
      release();
    });
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    this.pending++;
    const result = this.tail.then(operation);
    const settled = result.finally(() => { this.pending--; });
    this.tail = settled.then(() => undefined, () => undefined);
    return settled;
  }
}

/**
 * Open Router's durable store after repairing its global ID allocator. Root conversations
 * reserve ID 1, so keep the allocator above that ID and every ID already persisted.
 */
export async function openRouterStorage(file: string): Promise<SqliteStorage> {
  if (file !== ':memory:') await mkdir(dirname(file), { recursive: true });
  const database = new RouterSqliteDatabase(new DatabaseSync(file, { timeout: 5_000 }));
  try {
    await database.exec('PRAGMA journal_mode = WAL');
    await database.exec('PRAGMA synchronous = NORMAL');
    await applySqliteMigrations(database, SQLITE_MIGRATIONS);
    await database.run(
      `UPDATE durable_metadata
       SET next_id = MAX(
         CAST(next_id AS INTEGER),
         COALESCE((SELECT MAX(id) + 1 FROM record_ids), 2),
         2
       )
       WHERE singleton = 1`,
    );
    return await SqliteStorage.open(database);
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
}
