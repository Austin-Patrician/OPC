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
});
