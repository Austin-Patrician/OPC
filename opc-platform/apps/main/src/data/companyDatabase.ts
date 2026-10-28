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
  repairAcceptanceTemplateConstraint(db);
  repairBudgetScopeConstraint(db);
  repairLegacyColumns(db);
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
 * Widens `task.acceptance_template` to include `node-test`.
 *
 * SQLite cannot alter a CHECK constraint, so the table is rebuilt: copy the DDL from
 * `sqlite_master`, rename it, swap the CHECK clause, copy the rows, drop the old
 * table, rename, then recreate the indexes the drop took with it.
 *
 * It runs *before* `migrate()` and outside its transaction on purpose: PRAGMA
 * foreign_keys is a no-op inside a transaction, and the child tables referencing
 * `task` would otherwise block the drop. Idempotent: it does nothing once the
 * constraint already mentions the new template.
 */
export function repairAcceptanceTemplateConstraint(db: CompanyDatabase): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task'")
    .get() as { sql: string } | undefined;
  if (!row?.sql) return false;
  if (!row.sql.includes("'review-verdict'")) return false;
  if (row.sql.includes("'node-test'")) return false;

  const indexes = (
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task' AND sql IS NOT NULL")
      .all() as { name: string; sql: string }[]
  ).filter((index) => !/^sqlite_autoindex/.test(index.name));

  const rebuilt = row.sql
    .replace(/^CREATE TABLE\s+["']?task["']?/i, 'CREATE TABLE task_rebuild')
    .replace(
      "'http-ok','image-200','review-verdict'",
      "'http-ok','node-test','image-200','review-verdict'",
    );
  if (!rebuilt.includes("'node-test'")) {
    // A hand-edited schema we do not recognise: leave it alone rather than guess.
    return false;
  }

  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(rebuilt);
    db.exec('INSERT INTO task_rebuild SELECT * FROM task');
    db.exec('DROP TABLE task');
    db.exec('ALTER TABLE task_rebuild RENAME TO task');
    for (const index of indexes) db.exec(index.sql);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`重建 task 表以放宽 acceptance_template 约束失败：${String(error)}`, { cause: error });
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return true;
}

/**
 * Widens `budget.scope` to include `project` and `department`.
 *
 * `budget` allowed only (`company`, `employee`) in early builds. `CREATE TABLE IF
 * NOT EXISTS` keeps that CHECK on upgraded installs, so `ensureProjectBudget` dies
 * with "CHECK constraint failed" the first time a project is charged — even though
 * the current schema has accepted all four scopes since v1.
 *
 * Same constraining trick as the task repair above: SQLite cannot alter a CHECK, so
 * rebuild outside the migration transaction with FKs off. Idempotent.
 */
export function repairBudgetScopeConstraint(db: CompanyDatabase): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'budget'")
    .get() as { sql: string } | undefined;
  if (!row?.sql) return false;

  const scopes = ['company', 'employee', 'project', 'department'];
  const scopeCheck = /CHECK\s*\(\s*scope\s+IN\s*\([^)]*\)\s*\)/i.exec(row.sql);
  if (!scopeCheck) return false;
  if (scopes.every((scope) => scopeCheck[0].includes(`'${scope}'`))) return false;

  const indexes = (
    db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'budget' AND sql IS NOT NULL",
      )
      .all() as { name: string; sql: string }[]
  ).filter((index) => !/^sqlite_autoindex/.test(index.name));

  const rebuilt = row.sql
    .replace(/^CREATE TABLE\s+["']?budget["']?/i, 'CREATE TABLE budget_rebuild')
    .replace(
      scopeCheck[0],
      `CHECK (scope IN (${scopes.map((scope) => `'${scope}'`).join(',')}))`,
    );
  if (!rebuilt.includes("'project'") || !rebuilt.includes("'department'")) {
    // A hand-edited schema we do not recognise: leave it alone rather than guess.
    return false;
  }

  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(rebuilt);
    db.exec('INSERT INTO budget_rebuild SELECT * FROM budget');
    db.exec('DROP TABLE budget');
    db.exec('ALTER TABLE budget_rebuild RENAME TO budget');
    for (const index of indexes) db.exec(index.sql);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`重建 budget 表以允许 project/department 预算失败：${String(error)}`, { cause: error });
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return true;
}

/**
 * Columns that older builds created without, but that current indexes and views
 * expect. `CREATE TABLE IF NOT EXISTS` silently keeps the old shape, so a
 * migration that adds only an index on `company_id` fails with
 * "no such column: company_id" and rolls the whole step back — every launch.
 *
 * Adding the column first makes the migration re-runnable on upgraded installs.
 * Each entry is (table, column, definition); a missing table is skipped.
 */
interface ColumnSpec {
  name: string;
  definition: string;
}

/** Reads `CREATE TABLE IF NOT EXISTS x (…);` blocks out of a migration script. */
function declaredTables(sql: string): { table: string; columns: ColumnSpec[] }[] {
  const tables: { table: string; columns: ColumnSpec[] }[] = [];
  const tablePattern = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g;
  let match: RegExpExecArray | null;
  while ((match = tablePattern.exec(sql)) !== null) {
    const [, table, body] = match;
    const columns: ColumnSpec[] = [];
    for (const rawLine of (body ?? '').split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line || line.startsWith('--')) continue;
      // Table-level constraints are not columns.
      if (/^(CONSTRAINT|FOREIGN KEY|PRIMARY KEY|UNIQUE|CHECK)\b/i.test(line)) continue;
      const columnMatch = /^(\w+)\s+(.+)$/.exec(line);
      if (!columnMatch) continue;
      const [, name, rest] = columnMatch;
      // A column cannot be added as PRIMARY KEY, and NOT NULL needs a default.
      if (/PRIMARY KEY/i.test(rest ?? '')) continue;
      // FK clauses and inline CHECKs are not portable through ALTER TABLE ADD COLUMN.
      const definition = (rest ?? '')
        .replace(/\s+REFERENCES\s+\w+\s*\([^)]*\)/gi, '')
        .replace(/\s+CHECK\s*\((?:[^()]|\([^()]*\))*\)/gi, '')
        // A CHECK whose body itself contains parentheses survives the pass above.
        .replace(/\s+CHECK\s*\(.*$/i, '')
        .replace(/\bNOT NULL\b/i, (value) => (/DEFAULT/i.test(rest ?? '') ? value : ''))
        .replace(/\s+/g, ' ')
        .trim();
      columns.push({ name: name!, definition });
    }
    tables.push({ table: table!, columns });
  }
  return tables;
}

/**
 * Columns the current schema assumes but an older install may not have.
 *
 * `CREATE TABLE IF NOT EXISTS` keeps the old shape, so a migration that adds only
 * an index on a new column fails with "no such column" and rolls the whole step
 * back — every launch, forever (this crashed the app on upgrade). Instead of a
 * hand-maintained patch list, every column declared in the initial migration is
 * diffed against the live table and added when missing.
 */
/**
 * Tables whose column set changed shape during development (`est_tokens` → `tokens`,
 * extra NOT NULL columns). Adding columns cannot remove a NOT NULL, so these are
 * rebuilt: create the current shape, copy whatever columns both sides share, swap.
 * Only tables that are pure derived state are safe to rebuild this way.
 */
const REBUILDABLE = new Set(['budget_reservation', 'budget_ledger']);

export function repairLegacyColumns(db: CompanyDatabase): string[] {
  const repaired: string[] = [];
  const rebuilt: string[] = [];

  // Columns added by later migrations (`ALTER TABLE … ADD COLUMN …`) are applied
  // here first, idempotently. A migration that blindly ALTERs fails on any database
  // that already has the column — which is every database this app has upgraded.
  const addColumn = /ALTER TABLE (\w+) ADD COLUMN (\w+) ([^;]+);/g;
  for (const sql of MIGRATIONS.slice(1)) {
    let match: RegExpExecArray | null;
    while ((match = addColumn.exec(sql)) !== null) {
      const [, table, column, definition] = match;
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
      if (!exists) continue;
      const present = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (present.some((entry) => entry.name === column)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      repaired.push(`${table}.${column}`);
    }
  }

  for (const { table, columns } of declaredTables(MIGRATIONS[0] ?? '')) {
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (!exists) continue;
    const present = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((entry) => entry.name),
    );
    const declared = new Set(columns.map((column) => column.name));
    const extraRequired = (
      db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[]
    ).filter((column) => !declared.has(column.name) && column.notnull === 1 && column.dflt_value === null);

    if (REBUILDABLE.has(table) && extraRequired.length > 0) {
      rebuilt.push(table);
      db.transaction(() => {
        db.exec(`ALTER TABLE ${table} RENAME TO ${table}__old`);
        for (const statement of splitStatements(MIGRATIONS[0] ?? '')) {
          if (statement.toUpperCase().includes(`CREATE TABLE IF NOT EXISTS ${table.toUpperCase()}`)) {
            db.exec(statement);
          }
        }
        const shared = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
          .map((column) => column.name)
          .filter((name) => present.has(name));
        if (shared.length > 0) {
          db.exec(
            `INSERT INTO ${table} (${shared.join(', ')}) SELECT ${shared.join(', ')} FROM ${table}__old`,
          );
        }
        db.exec(`DROP TABLE ${table}__old`);
      })();
      continue;
    }

    for (const column of columns) {
      if (present.has(column.name)) continue;
      const statement = `ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.definition}`;
      try {
        db.exec(statement);
      } catch (error) {
        throw new Error(`${(error as Error).message} :: ${statement}`, { cause: error });
      }
      repaired.push(`${table}.${column.name}`);
    }
  }
  return [...repaired, ...rebuilt.map((table) => `rebuilt:${table}`)];
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
        for (const statement of splitStatements(sql)) {
          try {
            db.exec(statement);
          } catch (error) {
            // `repairLegacyColumns` may already have added this column; a migration
            // must be a no-op then, not a rollback of the whole step.
            if (/duplicate column name/i.test(String(error))) continue;
            throw error;
          }
        }
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
