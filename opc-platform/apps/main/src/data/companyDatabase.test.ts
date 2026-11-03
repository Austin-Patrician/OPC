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

  it('moves pre-existing classifier-only custom providers to the Decision page', () => {
    const file = `/tmp/opc-legacy-scope-${Date.now()}.db`;
    const db = openCompanyDatabase(file);
    const insert = db.prepare(
      `INSERT INTO model_provider (id, name, base_url, api, is_custom, models, created_at, updated_at)
       VALUES (?, ?, 'https://relay.test/v1', 'openai-completions', ?, ?, 0, 0)`,
    );
    // Written by the build before `scope` existed: everything defaulted to 'llm'.
    insert.run('custom-classifier', 'Jev relay', 1, JSON.stringify([{ id: 'jev', capability: 'classifier' }]));
    insert.run('custom-chat', 'Chat relay', 1, JSON.stringify([{ id: 'gpt', capability: 'chat' }]));
    insert.run('custom-empty', 'Empty relay', 1, '[]');
    insert.run('typesafe', 'TypeSafe', 0, JSON.stringify([{ id: 'jev-latest', capability: 'classifier' }]));
    db.pragma('user_version = 21');
    db.close();

    const upgraded = openCompanyDatabase(file);
    const scopes = Object.fromEntries(
      (
        upgraded.prepare('SELECT id, scope FROM model_provider').all() as {
          id: string;
          scope: string;
        }[]
      ).map((row) => [row.id, row.scope]),
    );
    expect(scopes).toEqual({
      'custom-classifier': 'decision',
      'custom-chat': 'llm',
      'custom-empty': 'llm',
      // Built-ins serve both pages; they must never be hidden from the LLM table.
      typesafe: 'llm',
    });
    upgraded.close();
  });
});

/**
 * 老库里的任务归属于一个人，新库归属于一个执行体。
 *
 * 这条升级路径没有别的用例覆盖，而它一旦错就是"打开应用就崩"——所以造一个
 * 旧形状的库（`employee_id` + 指向 employee 的外键），再打开，然后确认三件事：
 * 列名换了、行还在、外键没了。
 */
describe('retireOrgOwnership', () => {
  it('把任务与记忆的归属列从 employee_id 换成 owner_id，并保留既有行', () => {
    const file = `/tmp/opc-legacy-owner-${Date.now()}.db`;

    // 先建一个"老"库：把当前库的两列改回旧名字，再塞一行。
    const fresh = openCompanyDatabase(file);
    fresh.exec('ALTER TABLE task RENAME COLUMN owner_id TO employee_id');
    fresh.exec('ALTER TABLE task RENAME COLUMN owner_name TO employee_name');
    fresh.exec('ALTER TABLE employee_memory RENAME COLUMN owner_id TO employee_id');
    fresh.exec(`
      INSERT INTO task (id, title, brief, deliverable_spec, employee_id, employee_name,
                        is_review, depth, est_tokens, acceptance_command, acceptance_template,
                        status, workspace_rel_path, attempts, tokens_used, cost_usd,
                        created_at, updated_at)
      VALUES ('task-old', '旧活', 'b', 'd', 'emp-1', '李雷', 0, 0, 100, '[]', 'http-ok',
              'accepted', 'w', 1, 7, 0.5, 1, 2);
    `);
    fresh.close();

    const db = openCompanyDatabase(file);
    const taskColumns = (db.prepare('PRAGMA table_info(task)').all() as { name: string }[]).map(
      (row) => row.name,
    );
    const memoryColumns = (
      db.prepare('PRAGMA table_info(employee_memory)').all() as { name: string }[]
    ).map((row) => row.name);

    expect(taskColumns).toContain('owner_id');
    expect(taskColumns).not.toContain('employee_id');
    expect(memoryColumns).toContain('owner_id');
    expect(memoryColumns).not.toContain('employee_id');

    // 行还在：升级不是重建。
    const row = db.prepare("SELECT owner_id, owner_name, tokens_used FROM task WHERE id = 'task-old'").get() as
      | { owner_id: string; owner_name: string; tokens_used: number }
      | undefined;
    expect(row).toEqual({ owner_id: 'emp-1', owner_name: '李雷', tokens_used: 7 });

    // 外键没了：`employee` 这张表要消失。
    const sql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task'").get() as {
        sql: string;
      }
    ).sql;
    expect(sql).not.toContain('REFERENCES employee');
    db.close();
  });
});
