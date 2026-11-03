import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openCompanyDatabase } from './companyDatabase';
import { SCHEMA_VERSION } from './schema';

/**
 * 拿一份**真实的**旧库（这台机器上跑过的那份 company.db）验最后一次迁移。
 *
 * 为什么单开一个用例：迁移的假想数据和真实数据不是一回事——真实库里有手改过的
 * 作用域、有 'boss' 的验收记录、有几十条记忆。这个用例只在能找到那份库时运行，
 * 找不到就跳过（CI 上本来就没有）。**它只读副本**：原库一个字节都不碰。
 */
const REAL_DB = path.join(
  process.env.APPDATA ?? '',
  'OPC Agent 工作台',
  'company.db',
);

function copyRealDatabase(): string | null {
  const dir = mkdtempSync(path.join(tmpdir(), 'opc-v33-'));
  const target = path.join(dir, 'company.db');
  try {
    copyFileSync(REAL_DB, target);
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  return target;
}

const copy = copyRealDatabase();

describe.skipIf(copy === null)('对真实旧库的升级', () => {
  it('把记忆/事实/归属列/称呼/资料字段一起改完，一条数据都不丢', () => {
    const before = new Database(copy!, { readonly: true });
    const tableNames = (
      before.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);
    const countOf = (table: string): number => {
      const name = tableNames.includes(table) ? table : table === 'memory' ? 'employee_memory' : 'org_fact';
      if (!tableNames.includes(name)) return 0;
      return (before.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n;
    };
    // 这份库可能已经被升级过（开发机上跑过应用）。那样 before 就是"已经改完"的形状，
    // 断言仍然成立，只是它验的是"幂等"而不是"改名"。
    const beforeMemory = countOf('memory');
    const beforeFacts = countOf('fact');
    const beforeTasks = countOf('task');
    before.close();

    const db = openCompanyDatabase(copy!);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);

    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
    expect(tables).toContain('memory');
    expect(tables).toContain('fact');
    expect(tables).not.toContain('employee_memory');
    expect(tables).not.toContain('org_fact');

    // 行数不变：改名不是重建。
    expect((db.prepare('SELECT COUNT(*) AS n FROM memory').get() as { n: number }).n).toBe(beforeMemory);
    expect((db.prepare('SELECT COUNT(*) AS n FROM fact').get() as { n: number }).n).toBe(beforeFacts);
    expect((db.prepare('SELECT COUNT(*) AS n FROM task').get() as { n: number }).n).toBe(beforeTasks);

    // 作用域与称呼都收敛了。
    const scopes = (
      db.prepare('SELECT DISTINCT scope_type AS s FROM memory').all() as { s: string }[]
    ).map((row) => row.s);
    expect(scopes.every((scope) => scope === 'personal' || scope === 'thread')).toBe(true);
    const factScopes = (
      db.prepare('SELECT DISTINCT scope_type AS s FROM fact').all() as { s: string }[]
    ).map((row) => row.s);
    expect(factScopes.every((scope) => scope === 'global' || scope === 'thread')).toBe(true);

    expect(columns('worker')).toContain('owner_id');
    const users = db.prepare('SELECT id FROM app_user').all() as { id: string }[];
    expect(users).toEqual([{ id: 'user' }]);
    const reviewers = (
      db.prepare('SELECT DISTINCT reviewer AS r FROM acceptance').all() as { r: string }[]
    ).map((row) => row.r);
    expect(reviewers.every((value) => value === 'auto' || value === 'system' || value === 'user')).toBe(
      true,
    );

    // V34：资料字段也换词了（`industry` → `domain`，`profile.vision` → `profile.goal`）。
    expect(columns('company')).toContain('domain');
    expect(columns('company')).not.toContain('industry');
    const settingKeys = (
      db.prepare("SELECT key FROM app_setting WHERE key LIKE 'profile.%'").all() as { key: string }[]
    ).map((row) => row.key);
    expect(settingKeys).not.toContain('profile.vision');

    db.close();
    rmSync(path.dirname(copy!), { recursive: true, force: true });
  });
});
