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
  repairDepartmentParentConstraint(db);
  repairEmploymentEventKindConstraint(db);
  migrate(db);
  // After the steps: a fresh database only gets its `job` table inside V14, and the
  // reshape below has to see whatever shape that left behind.
  repairJobCatalogue(db);
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
 * Gives `department.parent_id` its self-referencing foreign key.
 *
 * v1 declared the column but never constrained it, and `CREATE TABLE IF NOT EXISTS`
 * keeps that shape forever. A dangling parent id is silent: the department and
 * everything under it simply vanish from the chart. SQLite cannot add a foreign key
 * to an existing table, so the table is rebuilt — the same dance as the task/budget
 * repairs above, and for the same reason: `PRAGMA foreign_keys` is a no-op inside a
 * transaction, and `employee` / `position` / `project_group` all reference
 * `department`, so the drop has to happen with enforcement off.
 *
 * Data is repaired first (self-parent, missing parent, parent pointing at a deleted
 * department, and cycles). Without that the rebuilt table would refuse the copy and
 * every launch would fail to upgrade. Idempotent.
 */
export function repairDepartmentParentConstraint(db: CompanyDatabase): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'department'")
    .get() as { sql: string } | undefined;
  if (!row?.sql) return false;
  if (/REFERENCES\s+["']?department["']?\s*\(/i.test(row.sql)) return false;

  const rows = db.prepare('SELECT id, parent_id, deleted_at FROM department').all() as {
    id: string;
    parent_id: string | null;
    deleted_at: number | null;
  }[];
  const live = new Set(rows.filter((entry) => entry.deleted_at === null).map((entry) => entry.id));
  const parents = new Map<string, string | null>(rows.map((entry) => [entry.id, entry.parent_id]));

  const detach = db.prepare(
    'UPDATE department SET parent_id = NULL, updated_at = ? WHERE id = ?',
  );
  const now = Date.now();

  // A parent must exist, be alive, and not be the department itself.
  for (const entry of rows) {
    const parent = parents.get(entry.id) ?? null;
    if (parent !== null && (parent === entry.id || !live.has(parent))) {
      parents.set(entry.id, null);
      detach.run(now, entry.id);
    }
  }

  // Break cycles by detaching the edge that closes the loop.
  for (const entry of rows) {
    const seen = new Set<string>([entry.id]);
    let cursor = parents.get(entry.id) ?? null;
    while (cursor) {
      if (seen.has(cursor)) {
        parents.set(entry.id, null);
        detach.run(now, entry.id);
        break;
      }
      seen.add(cursor);
      cursor = parents.get(cursor) ?? null;
    }
  }

  const indexes = (
    db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'department' AND sql IS NOT NULL",
      )
      .all() as { name: string; sql: string }[]
  ).filter((index) => !/^sqlite_autoindex/.test(index.name));

  const renamed = row.sql.replace(/^CREATE TABLE\s+["']?department["']?/i, 'CREATE TABLE department_rebuild');
  const close = renamed.lastIndexOf(')');
  const rebuilt = `${renamed.slice(0, close)},\n  FOREIGN KEY (parent_id) REFERENCES department(id)\n${renamed.slice(close)}`;

  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(rebuilt);
    db.exec('INSERT INTO department_rebuild SELECT * FROM department');
    db.exec('DROP TABLE department');
    db.exec('ALTER TABLE department_rebuild RENAME TO department');
    for (const index of indexes) db.exec(index.sql);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`重建 department 表以给 parent_id 加外键失败：${String(error)}`, { cause: error });
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return true;
}

/**
 * Widens `employment_event.kind` to include `confirmed` (转正).
 *
 * Same SQLite limitation as the two repairs above: a CHECK cannot be altered, so the
 * table is rebuilt. Nothing references `employment_event`, so the drop is safe, but
 * `foreign_keys` is still turned off around it for the same reason the others do it —
 * the table has an outgoing foreign key to `employee` and a half-rebuilt table must
 * never be visible to the migrator.
 *
 * Idempotent: no-op once the constraint already lists `confirmed`.
 */
export function repairEmploymentEventKindConstraint(db: CompanyDatabase): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'employment_event'")
    .get() as { sql: string } | undefined;
  if (!row?.sql) return false;
  if (row.sql.includes("'confirmed'")) return false;

  const kindCheck = /CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)\s*\)/i.exec(row.sql);
  if (!kindCheck) return false;

  const kinds = ['hired', 'transferred', 'promoted', 'head_appointed', 'head_removed', 'terminated', 'reinstated', 'confirmed'];
  const rebuilt = row.sql
    .replace(/^CREATE TABLE\s+["']?employment_event["']?/i, 'CREATE TABLE employment_event_rebuild')
    .replace(kindCheck[0], `CHECK (kind IN (${kinds.map((kind) => `'${kind}'`).join(',')}))`);

  const indexes = (
    db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'employment_event' AND sql IS NOT NULL",
      )
      .all() as { name: string; sql: string }[]
  ).filter((index) => !/^sqlite_autoindex/.test(index.name));

  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(rebuilt);
    db.exec('INSERT INTO employment_event_rebuild SELECT * FROM employment_event');
    db.exec('DROP TABLE employment_event');
    db.exec('ALTER TABLE employment_event_rebuild RENAME TO employment_event');
    for (const index of indexes) db.exec(index.sql);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`重建 employment_event 表以加入 confirmed 事件失败：${String(error)}`, { cause: error });
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
 * 岗位从"部门里的一个坑"变成公司级职务（V21）。
 *
 * Written as a repair rather than a migration step because SQLite has no conditional
 * DDL: this has to run on a database whose `job` table still has `department_id` (old
 * shape) and be a no-op on one that already does not (new shape, or a re-open). The
 * shape is the condition, and TypeScript can look at it.
 *
 * Merge rule when the same title existed in several departments: the oldest row wins,
 * every live seat is pointed at it, and each department keeps its own headcount in
 * `department_job`. Nothing is deleted from `position`, so history still explains
 * itself.
 */
export function repairJobCatalogue(db: CompanyDatabase): string[] {
  const hasJob = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'job'").get();
  if (!hasJob) return [];

  const columns = (db.prepare('PRAGMA table_info(job)').all() as { name: string }[]).map(
    (column) => column.name,
  );
  db.exec(`CREATE TABLE IF NOT EXISTS department_job (
    department_id TEXT NOT NULL,
    job_id        TEXT NOT NULL,
    headcount     INTEGER NOT NULL DEFAULT 0 CHECK (headcount >= 0),
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (department_id, job_id),
    FOREIGN KEY (department_id) REFERENCES department(id)
  );
  CREATE INDEX IF NOT EXISTS idx_dept_job_job ON department_job(job_id);`);

  if (!columns.includes('department_id')) {
    // Already a company-wide catalogue; only the indexes may be missing (an older
    // build created the table before they existed).
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_job_title
               ON job(LOWER(TRIM(title))) WHERE deleted_at IS NULL;
             CREATE INDEX IF NOT EXISTS idx_job_live ON job(deleted_at);`);
    return [];
  }

  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS job_global');
    db.exec(`CREATE TABLE job_global (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      level       TEXT NOT NULL DEFAULT 'P5',
      description TEXT NOT NULL DEFAULT '',
      skills      TEXT NOT NULL DEFAULT '[]',
      model       TEXT NOT NULL DEFAULT '',
      model_ref   TEXT NOT NULL DEFAULT '',
      deleted_at  INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );`);

    // Every department's plan, keyed by title, before the duplicate rows go away.
    db.exec(`INSERT OR REPLACE INTO department_job
               (department_id, job_id, headcount, created_at, updated_at)
             SELECT j.department_id,
                    (SELECT j2.id FROM job j2
                      WHERE j2.deleted_at IS NULL
                        AND LOWER(TRIM(j2.title)) = LOWER(TRIM(j.title))
                      ORDER BY j2.created_at, j2.id LIMIT 1),
                    SUM(j.headcount), MIN(j.created_at), MAX(j.updated_at)
               FROM job j
              WHERE j.deleted_at IS NULL
              GROUP BY j.department_id, LOWER(TRIM(j.title));`);

    db.exec(`INSERT INTO job_global
               (id, title, level, description, skills, model, model_ref, deleted_at, created_at, updated_at)
             SELECT id, title, level, description, skills, model, model_ref, deleted_at, created_at, updated_at
               FROM job;`);

    // Live seats follow their title to the surviving row; seats on an archived job keep
    // pointing at it, because that row stays as history.
    db.exec(`UPDATE position SET job_id = (
               SELECT j2.id FROM job j2
                WHERE j2.deleted_at IS NULL
                  AND LOWER(TRIM(j2.title)) = (SELECT LOWER(TRIM(j3.title)) FROM job j3
                                                WHERE j3.id = position.job_id AND j3.deleted_at IS NULL)
                ORDER BY j2.created_at, j2.id LIMIT 1)
              WHERE job_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM job j3 WHERE j3.id = position.job_id AND j3.deleted_at IS NULL);`);

    db.exec(`DELETE FROM job_global
              WHERE deleted_at IS NULL
                AND EXISTS (
                  SELECT 1 FROM job j2
                   WHERE j2.deleted_at IS NULL
                     AND LOWER(TRIM(j2.title)) = LOWER(TRIM(job_global.title))
                     AND (j2.created_at < job_global.created_at
                          OR (j2.created_at = job_global.created_at AND j2.id < job_global.id))
                );`);

    db.exec('DROP INDEX IF EXISTS idx_job_dept_title;');
    db.exec('DROP INDEX IF EXISTS idx_job_dept;');
    db.exec('DROP TABLE job;');
    db.exec('ALTER TABLE job_global RENAME TO job;');
    db.exec(`CREATE UNIQUE INDEX idx_job_title ON job(LOWER(TRIM(title))) WHERE deleted_at IS NULL;
             CREATE INDEX idx_job_live ON job(deleted_at);`);
  })();

  return ['job:global'];
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
