import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openCompanyDatabase } from './companyDatabase';

/**
 * Regression for the launch crash: an install created by an older build has tables
 * without `company_id`, so a migration that only adds an index on that column threw
 * "no such column: company_id" and rolled back — on every single launch.
 */
describe('opening an upgraded database', () => {
  it('repairs legacy tables instead of dying on the migration', () => {
    const file = `/tmp/opc-legacy-${Date.now()}.db`;
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE company (id TEXT PRIMARY KEY, name TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}',
                            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE department (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL DEFAULT '',
                               description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#0099FF',
                               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE employee (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
                             level TEXT NOT NULL DEFAULT 'P5', department_id TEXT NOT NULL DEFAULT '',
                             model TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
                             created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    `);
    legacy.close();

    const db = openCompanyDatabase(file);
    const departmentColumns = (db.prepare('PRAGMA table_info(department)').all() as { name: string }[]).map(
      (entry) => entry.name,
    );
    expect(departmentColumns).toContain('company_id');
    expect(Number(db.pragma('user_version', { simple: true }))).toBeGreaterThan(0);
    db.close();
  });

  it('widens a legacy budget scope CHECK to project and department', () => {
    const file = `/tmp/opc-legacy-budget-${Date.now()}.db`;
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE budget (
        id              TEXT PRIMARY KEY,
        scope           TEXT NOT NULL CHECK (scope IN ('company','employee')),
        scope_id        TEXT NOT NULL,
        period_key      TEXT NOT NULL,
        limit_tokens    INTEGER NOT NULL,
        used_tokens     INTEGER NOT NULL DEFAULT 0,
        reserved_tokens INTEGER NOT NULL DEFAULT 0,
        warn_at         REAL NOT NULL DEFAULT 0.8,
        hard_stop_at    REAL NOT NULL DEFAULT 1.0,
        is_stopped      INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_budget_scope ON budget(scope, scope_id, period_key);
    `);
    legacy.close();

    const db = openCompanyDatabase(file);
    const { sql } = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'budget'")
      .get() as { sql: string };
    expect(sql).toContain("'project'");
    expect(sql).toContain("'department'");
    expect(() =>
      db
        .prepare(
          `INSERT INTO budget (id, scope, scope_id, period_key, limit_tokens, used_tokens,
                               reserved_tokens, warn_at, hard_stop_at, is_stopped, created_at, updated_at)
           VALUES ('b1', 'project', 'p1', '2026-10', 1000, 0, 0, 0.8, 1.0, 0, 0, 0)`,
        )
        .run(),
    ).not.toThrow();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'budget'")
      .all() as { name: string }[];
    expect(indexes.map((index) => index.name)).toContain('idx_budget_scope');
    db.close();
  });
});
