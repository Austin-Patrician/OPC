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
  repairLegacyColumns(db);
  repairDepartmentParentConstraint(db);
  repairEmploymentEventKindConstraint(db);
  migrate(db);
  // 改名迁移已经跑完，才谈得上"旧列是不是多余"。
  dropRenamedColumns(db);
  // After the steps: a fresh database only gets its `job` table inside V14, and the
  // reshape below has to see whatever shape that left behind.
  repairJobCatalogue(db);
  repairOwnershipColumns(db);
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

/**
 * 后来被改名掉的列。
 *
 * 两段重放逻辑（历史上每条 `ADD COLUMN`、以及 V1 里声明的列）的前提都是
 * "这一列不存在"——改名正好制造了这个前提。不拦住的话，旧列会在每次打开数据库时
 * 重新长出来：`worker.employee_id` 那样，`company.industry` 也一样。
 *
 * 已经被之前的版本加回来的旧列，这里顺手删掉：只在同一张表已经有新列时动手，
 * `DROP COLUMN` 失败（旧版 SQLite / 列仍被索引引用）就保持原样，不影响启动。
 */
const RENAMED_COLUMNS: readonly { table: string; from: string; to: string }[] = [
  { table: 'worker', from: 'employee_id', to: 'owner_id' },
  { table: 'consolidation_run', from: 'employee_id', to: 'owner_id' },
  { table: 'company', from: 'industry', to: 'domain' },
];

/** `table.from` → 改名后的列名。 */
const RENAMED_FROM = new Map(
  RENAMED_COLUMNS.map(({ table, from, to }) => [`${table}.${from}`, { table, to }]),
);

function hasColumn(db: CompanyDatabase, table: string, column: string): boolean {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) return false;
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
    (entry) => entry.name === column,
  );
}

/**
 * 重放 `ADD COLUMN` 前要不要跳过这一列。
 *
 * 改名后的库（新列已经在）不该再把旧列加回来；改名前的库（新列还没有）仍然需要
 * 旧列，否则历史迁移里的 `RENAME COLUMN` 会报"没有这一列"。
 */
function isRetiredAlreadyRenamed(db: CompanyDatabase, table: string, column: string): boolean {
  const renamed = RENAMED_FROM.get(`${table}.${column}`);
  if (!renamed) return false;
  return hasColumn(db, renamed.table, renamed.to);
}

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
      const [, table = '', column = '', definition = ''] = match;
      // 后来被**改名**掉的列不该在这里复活：这段代码会把历史上每一条 ADD COLUMN
      // 重放一遍，而重放的前提是"没有这一列"——改名正好制造了这个前提。
      // 但如果新列也还没有（这是在跑改名之前的历史迁移），旧列仍然要补上。
      if (isRetiredAlreadyRenamed(db, table, column)) continue;
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
      if (isRetiredAlreadyRenamed(db, table, column.name)) continue;
      const statement = `ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.definition}`;
      try {
        db.exec(statement);
      } catch (error) {
        throw new Error(`${(error as Error).message} :: ${statement}`, { cause: error });
      }
      repaired.push(`${table}.${column.name}`);
    }
  }

  // 改名后被旧版重放逻辑加回来的旧列，由 `dropRenamedColumns` 在迁移之后删掉：
  // 这里只负责"该补的列补上、不该补的列不补"。
  return [...repaired, ...rebuilt.map((table) => `rebuilt:${table}`)];
}

/**
 * 删掉"改名之后又被旧版重放逻辑加回来"的旧列。
 *
 * 只在同一张表已经有新列时动手；`DROP COLUMN` 失败（旧版 SQLite / 列仍被索引
 * 引用）就保持原样——多一个空列比启动失败好。
 */
export function dropRenamedColumns(db: CompanyDatabase): string[] {
  const dropped: string[] = [];
  for (const { table, from, to } of RENAMED_COLUMNS) {
    if (!hasColumn(db, table, from) || !hasColumn(db, table, to)) continue;
    try {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${from}`);
      dropped.push(`${table}.${from}`);
    } catch {
      // 见上。
    }
  }
  return dropped;
}

/**
 * 岗位从"部门里的一个坑"变成可复用的职务模板（V21）。
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
  ).run(COMPANY_ID, '我的工作台', JSON.stringify(DEFAULT_COMPANY_SETTINGS), now, now);
}


/**
 * 老库里的任务归属于一个人，新库里归属于一个执行体。
 *
 * `task.employee_id → owner_id`、`memory.employee_id → owner_id`，
 * 两张表都重建一次：列名改掉，指向 `employee` 的外键一并去掉——那个表要没了。
 * 手法和上面几个 repair 一样（外键关掉、迁移事务外、幂等），因为 SQLite 改不了列名
 * 与约束。
 *
 * 值的语义在重建时已经变了：`owner_id` 里存的是 worker id。老库里的行存的是
 * employee id，按它查不到 worker——那些行会显示"未知执行体"，但不会让升级失败。
 * 这是有意的：宁可让旧数据显示不全，也不要在迁移里猜一个 worker 出来。
 */
/** 任务表的新形状：归属是执行体，没有指向 employee / project_group 的外键。 */
const TASK_WITH_OWNER = `
CREATE TABLE task_rebuild (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  brief               TEXT NOT NULL DEFAULT '',
  deliverable_spec    TEXT NOT NULL DEFAULT '',
  contract_json       TEXT,
  owner_id            TEXT NOT NULL,
  owner_name          TEXT NOT NULL DEFAULT '',
  parent_task_id      TEXT,
  review_of_task_id   TEXT,
  is_review           INTEGER NOT NULL DEFAULT 0,
  depth               INTEGER NOT NULL DEFAULT 0,
  est_tokens          INTEGER NOT NULL DEFAULT 0,
  acceptance_command  TEXT NOT NULL DEFAULT '[]',
  acceptance_template TEXT NOT NULL DEFAULT 'http-ok'
                      CHECK (acceptance_template IN ('http-ok','node-test','image-200','review-verdict')),
  status              TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','running','review','accepted','delivered',
                                        'rejected','failed','cancelled')),
  workspace_rel_path  TEXT NOT NULL,
  durable_task_id     TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  tokens_used         INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL NOT NULL DEFAULT 0,
  error               TEXT,
  answer              TEXT,
  error_kind          TEXT,
  started_at          INTEGER,
  finished_at         INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  issue_key           TEXT,
  priority            TEXT,
  labels              TEXT NOT NULL DEFAULT '[]',
  due_at              INTEGER,
  thread_id           TEXT REFERENCES thread(id) ON DELETE SET NULL,
  worker_id           TEXT REFERENCES worker(id) ON DELETE SET NULL,
  -- 指向 task 而不是 task_rebuild：建好之后这张表会被改名成 task，届时自引用成立。
  FOREIGN KEY (parent_task_id) REFERENCES task(id),
  FOREIGN KEY (review_of_task_id) REFERENCES task(id)
)`;

/**
 * 老库里的任务/记忆归属于「一个人」，新库归属于「一个执行体」。
 *
 * 这条升级路径没有别的用例覆盖，而它一旦错就是"打开应用就崩"——所以造一个旧形状的
 * 库（`employee_id` + 指向 employee 的外键），再打开，然后确认三件事：列名换了、
 * 行还在、外键没了。
 *
 * 名字里的 org 已经去掉：它修的是**归属列**，不是组织。V33 之后记忆表叫 `memory`，
 * 但这张重建只在迁移**之前**跑（那时表还叫 `memory`），所以 SQL 保持旧名字。
 */
export function repairOwnershipColumns(db: CompanyDatabase): void {
  const columns = (table: string): string[] => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.map((row) => row.name);
  };

  const taskColumns = columns('task');
  if (taskColumns.includes('employee_id')) {
    const indexes = (
      db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task' AND sql IS NOT NULL")
        .all() as { name: string; sql: string }[]
    ).filter(
      // 指向已被删掉那一列（project_group）的索引不再有意义，重建表时一起丢掉。
      (index) => !/^sqlite_autoindex/.test(index.name) && !/project_group_id/.test(index.sql),
    );

    const carried = [
      'id', 'title', 'brief', 'deliverable_spec', 'contract_json', 'parent_task_id', 'review_of_task_id',
      'is_review', 'depth', 'est_tokens', 'acceptance_command', 'acceptance_template',
      'status', 'workspace_rel_path', 'durable_task_id', 'attempts', 'tokens_used',
      'cost_usd', 'error', 'answer', 'error_kind', 'started_at', 'finished_at', 'created_at', 'updated_at',
      'issue_key', 'priority', 'labels', 'due_at', 'thread_id', 'worker_id',
    ].filter((name) => taskColumns.includes(name));
    const extra = carried.join(', ');

    db.pragma('foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      db.exec(TASK_WITH_OWNER);
      db.exec(
        `INSERT INTO task_rebuild (owner_id, owner_name, ${extra})
         SELECT employee_id, employee_name, ${extra} FROM task`,
      );
      db.exec('DROP TABLE task');
      db.exec('ALTER TABLE task_rebuild RENAME TO task');
      for (const index of indexes) db.exec(index.sql.replace(/\bemployee_id\b/g, 'owner_id'));
      db.exec('DROP INDEX IF EXISTS idx_task_employee');
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`重建 task 表以改用 owner_id 失败：${String(error)}`, { cause: error });
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }

  // 记忆表只需要改列名：约束与索引都不是这次的关注点，而重建会丢掉默认值。
  // 两种形状都要认：迁移之前表还叫 `employee_memory`，之后叫 `memory`；
  // 它们都可能是被手工改回旧列名的库。
  for (const table of ['employee_memory', 'memory']) {
    if (columns(table).includes('employee_id')) {
      db.exec(`ALTER TABLE ${table} RENAME COLUMN employee_id TO owner_id`);
    }
  }
}
