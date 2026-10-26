import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { COMPANY_ID, DEFAULT_COMPANY_SETTINGS, MIGRATIONS, SCHEMA_VERSION } from './schema';

/**
 * The business database (§2.1: one company.db per installation).
 *
 * Everything that is not the agent's private transcript lives here: org, tasks,
 * budgets, messages, shared facts and personal memory. It is opened once by the
 * main process and handed to the services — this module never resolves a user path
 * itself, because `packages/*` must stay free of Electron (§2.2).
 */
export type CompanyDatabase = Database.Database;

/** Rows in `company` are seeded on create, so probes can count them. */
export interface SqliteProbe {
  sqliteVersion: string;
  journalMode: string;
  companyRows: number;
  integrity: string;
}

export function openCompanyDatabase(file: string): CompanyDatabase {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  applyPragmas(db);
  migrate(db);
  return db;
}

export function probeSqlite(db: CompanyDatabase): SqliteProbe {
  const { v: sqliteVersion } = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
  const journalMode = String(db.pragma('journal_mode', { simple: true }));
  const { n: companyRows } = db.prepare('SELECT COUNT(*) AS n FROM company').get() as { n: number };
  // quick_check is fast and never throws on corruption: it reports it.
  const integrity = String(db.pragma('quick_check', { simple: true }));
  return { sqliteVersion, journalMode, companyRows, integrity };
}

/**
 * §4.1 pragmas. They are per-connection, so they run on every open — a connection
 * that forgot `foreign_keys` would silently accept orphan rows.
 */
function applyPragmas(db: CompanyDatabase): void {
  // WAL needs a real file; :memory: reports "memory" and that is fine.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -64000');
  db.pragma('temp_store = MEMORY');
}

/**
 * Upgrade in place: `user_version` is the only migration state, so a half-applied
 * step rolls back instead of leaving a schema nobody can read.
 */
function migrate(db: CompanyDatabase): void {
  const current = Number(db.pragma('user_version', { simple: true }) ?? 0);
  if (current < SCHEMA_VERSION) {
    db.exec('BEGIN');
    try {
      for (let step = current; step < SCHEMA_VERSION; step += 1) {
        const sql = MIGRATIONS[step];
        if (!sql) throw new Error(`缺少迁移步骤 ${step + 1}`);
        for (const statement of splitStatements(sql)) db.exec(statement);
      }
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  ensureCompanyRow(db);
}

/** `db.exec` accepts many statements, but splitting keeps one failure attributable. */
function splitStatements(sql: string): string[] {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function ensureCompanyRow(db: CompanyDatabase): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO company (id, name, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(COMPANY_ID, '我的公司', JSON.stringify(DEFAULT_COMPANY_SETTINGS), now, now);
}
