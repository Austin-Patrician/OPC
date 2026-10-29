import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrgService } from '../org/orgService';
import { MemoryService } from '../memory/memoryService';
import { MarketService } from '../market/marketService';
import { CompanyService } from '../company/companyService';
import { BudgetRepository } from './budgetRepository';
import { openCompanyDatabase, probeSqlite, type CompanyDatabase } from './companyDatabase';
import { SCHEMA_VERSION } from './schema';
import { TaskRepository, taskWorkspaceRelPath } from './taskRepository';

/**
 * The data layer against a real SQLite file.
 *
 * These are not unit tests of SQL strings: they open company.db, migrate it, and
 * drive the exact call sequences the services use. A schema column that drifted
 * from a query shows up here, and nowhere else short of launching Electron.
 */
let dir: string;
let db: CompanyDatabase;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-data-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function hireTeam(org: OrgService) {
  const department = org.createDepartment({ name: '工程部', code: 'EN-01' });
  const manager = org.hire({
    name: '沈聿',
    role: '技术负责人',
    departmentId: department.id,
    isHead: true,
  });
  const worker = org.hire({
    name: '李雷',
    role: '全栈工程师',
    departmentId: department.id,
    reportsToEmployeeId: manager.id,
  });
  return { department, manager, worker };
}

describe('company.db', () => {
  it('applies the §4.1 pragmas and seeds one company row', () => {
    const probe = probeSqlite(db);
    expect(probe.integrity).toBe('ok');
    expect(probe.companyRows).toBe(1);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('is idempotent across reopen', () => {
    db.close();
    db = openCompanyDatabase(path.join(dir, 'company.db'));
    expect(probeSqlite(db).companyRows).toBe(1);
  });

  it('upgrades an existing database in place instead of wiping it', () => {
    // Simulate a v1 install: the v2 tables do not exist yet and user_version says 1.
    db.exec('DROP TABLE inbox_item; DROP TABLE wake_quota; DROP TABLE guard_event; DROP TABLE relationship;');
    // A database from before v14 had no job table at all; the current one is global-
    // shaped, so dropping it is what "wind back" actually means here.
    db.exec('DROP TABLE IF EXISTS department_job; DROP TABLE IF EXISTS job;');
    db.pragma('user_version = 1');
    db.exec("INSERT INTO department (id, name, code, description, color, created_at, updated_at) VALUES ('dept-keep', '老部门', 'OLD', '', '#000', 1, 1)");
    db.close();

    db = openCompanyDatabase(path.join(dir, 'company.db'));
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);

    expect(tables).toContain('inbox_item');
    expect(tables).toContain('relationship');
    // The point of migrating rather than recreating: existing rows survive.
    expect(db.prepare("SELECT name FROM department WHERE id = 'dept-keep'").get()).toBeDefined();
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
  });

  it('repairs org rows that violate the v11 invariants before adding the constraints', () => {
    const org = new OrgService(db);
    const department = org.createDepartment({ name: '工程部' });
    const person = org.hire({ name: '李雷', role: '工程师', departmentId: department.id });
    org.hire({ name: '沈聿', role: '技术总监', departmentId: department.id, isHead: true });

    // A v10 database could hold both of these: the unique index was per
    // (employee, department), and reports_to had no foreign key at all.
    const now = Date.now();
    db.exec('DROP INDEX IF EXISTS idx_pos_employee');
    db.prepare(
      `INSERT INTO position (id, employee_id, department_id, title, is_head, created_at, updated_at)
       VALUES ('pos-stale', ?, ?, '旧岗', 0, ?, ?)`,
    ).run(person.id, department.id, now - 1_000, now);

    db.pragma('foreign_keys = OFF');
    db.prepare(
      "UPDATE position SET reports_to_employee_id = 'agent-ghost' WHERE employee_id = ? AND deleted_at IS NULL",
    ).run(person.id);
    db.pragma('foreign_keys = ON');

    // A database from before v14 had no job table at all; the current one is global-
    // shaped, so dropping it is what "wind back" actually means here.
    db.exec('DROP TABLE IF EXISTS department_job; DROP TABLE IF EXISTS job;');
    db.pragma('user_version = 10');
    db.close();
    db = openCompanyDatabase(path.join(dir, 'company.db'));

    const live = db
      .prepare('SELECT id, reports_to_employee_id FROM position WHERE employee_id = ? AND deleted_at IS NULL')
      .all(person.id) as { id: string; reports_to_employee_id: string | null }[];
    expect(live).toHaveLength(1);
    expect(live[0]!.reports_to_employee_id).toBeNull();
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);

    // The repaired data now satisfies the constraint the migration installed.
    expect(() =>
      db
        .prepare(
          `INSERT INTO position (id, employee_id, department_id, title, is_head, created_at, updated_at)
           VALUES ('pos-again', ?, ?, '再来一岗', 0, ?, ?)`,
        )
        .run(person.id, department.id, now, now),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('keeps a v10 head-only department as the position flag when upgrading', () => {
    // Old builds recorded the head only on `department.head_employee_id`. Dropping
    // that column's values without migrating them would leave every department
    // headless on the first launch of v11.
    const org = new OrgService(db);
    const department = org.createDepartment({ name: '工程部' });
    const person = org.hire({ name: '沈聿', role: '技术总监', departmentId: department.id });

    db.exec('DROP INDEX IF EXISTS idx_pos_head');
    db.exec('UPDATE position SET is_head = 0');
    db.prepare('UPDATE department SET head_employee_id = ? WHERE id = ?').run(person.id, department.id);
    // A database from before v14 had no job table at all; the current one is global-
    // shaped, so dropping it is what "wind back" actually means here.
    db.exec('DROP TABLE IF EXISTS department_job; DROP TABLE IF EXISTS job;');
    db.pragma('user_version = 10');
    db.close();

    db = openCompanyDatabase(path.join(dir, 'company.db'));
    const node = new OrgService(db).list().find((entry) => entry.id === department.id)!;
    expect(node.headEmployeeId).toBe(person.id);
    expect(node.members.find((member) => member.id === person.id)?.isHead).toBe(true);
  });

  it('deduplicates department names and backfills leaving times when upgrading to v12', () => {
    const org = new OrgService(db);
    const kept = org.createDepartment({ name: '工程部', code: 'EN-01' });
    const person = org.hire({ name: '李雷', role: '工程师', departmentId: kept.id });

    // A pre-v12 build only checked duplicates inside the service, so a template import
    // or a second window could leave two departments with the same name and code.
    // Drop the indexes to get that database back.
    db.exec('DROP INDEX IF EXISTS idx_dept_name; DROP INDEX IF EXISTS idx_dept_code;');
    const now = Date.now();
    db.prepare(
      `INSERT INTO department (id, name, code, description, color, created_at, updated_at)
       VALUES ('dept-dup', '工程部', 'EN-01', '', '#111111', ?, ?)`,
    ).run(now, now);
    // And "terminated" was a status with no timestamp at all.
    db.prepare("UPDATE employee SET status = 'terminated' WHERE id = ?").run(person.id);

    // A database from before v14 had no job table at all; the current one is global-
    // shaped, so dropping it is what "wind back" actually means here.
    db.exec('DROP TABLE IF EXISTS department_job; DROP TABLE IF EXISTS job;');
    db.pragma('user_version = 11');
    db.close();
    db = openCompanyDatabase(path.join(dir, 'company.db'));

    // The upgrade must not fail on the duplicates, and must keep every row.
    const rows = db
      .prepare('SELECT id, name, code FROM department WHERE deleted_at IS NULL ORDER BY created_at, id')
      .all() as { id: string; name: string; code: string }[];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.name.toUpperCase())).size).toBe(2);
    expect(new Set(rows.map((row) => row.code.toUpperCase())).size).toBe(2);
    expect(rows.filter((row) => row.name === '工程部')).toHaveLength(1);

    const employee = db
      .prepare('SELECT terminated_at, department_id FROM employee WHERE id = ?')
      .get(person.id) as { terminated_at: number | null; department_id: string | null };
    expect(employee.terminated_at).toBeGreaterThan(0);
    expect(employee.department_id).toBeNull();

    // From now on the index, not the service, is what refuses a duplicate.
    expect(() =>
      db
        .prepare(
          `INSERT INTO department (id, name, code, description, color, created_at, updated_at)
           VALUES ('dept-late', '工程部', '', '', '#222222', ?, ?)`,
        )
        .run(now, now),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('gives department.parent_id its foreign key and repairs bad parents when upgrading to v13', () => {
    const org = new OrgService(db);
    const root = org.createDepartment({ name: '研发中心' });
    const child = org.createDepartment({ name: '前端组' });
    const other = org.createDepartment({ name: '市场部' });
    // A pre-v13 build had the column but no constraint and no service code that wrote
    // it, so anything could be in there: a dangling id, a self-reference, or a cycle.
    // Put the table back in that shape (no FK, no indexes) and seed the bad rows.
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE department');
    db.exec(`
      CREATE TABLE department (
        id                TEXT PRIMARY KEY,
        company_id        TEXT NOT NULL DEFAULT 'company-local',
        name              TEXT NOT NULL,
        code              TEXT NOT NULL DEFAULT '',
        description       TEXT NOT NULL DEFAULT '',
        color             TEXT NOT NULL,
        head_employee_id  TEXT,
        parent_id         TEXT,
        sort_order        INTEGER NOT NULL DEFAULT 0,
        deleted_at        INTEGER,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO department (id, name, code, description, color, parent_id, created_at, updated_at)
       VALUES (?, ?, '', '', '#000000', ?, ?, ?)`,
    );
    insert.run(root.id, '研发中心', 'dept-ghost', now, now);
    insert.run(child.id, '前端组', child.id, now, now);
    insert.run(other.id, '市场部', other.id, now, now);
    db.pragma('foreign_keys = ON');
    // A database from before v14 had no job table at all; the current one is global-
    // shaped, so dropping it is what "wind back" actually means here.
    db.exec('DROP TABLE IF EXISTS department_job; DROP TABLE IF EXISTS job;');
    db.pragma('user_version = 12');
    db.close();

    db = openCompanyDatabase(path.join(dir, 'company.db'));

    const parents = db
      .prepare('SELECT id, parent_id FROM department ORDER BY created_at, id')
      .all() as { id: string; parent_id: string | null }[];
    // Every bad edge is detached, and no row is lost.
    expect(parents).toHaveLength(3);
    expect(parents.every((row) => row.parent_id === null)).toBe(true);

    // The constraint the repair installed now refuses a dangling parent.
    expect(() =>
      db.prepare('UPDATE department SET parent_id = ? WHERE id = ?').run('dept-ghost', root.id),
    ).toThrow(/FOREIGN KEY constraint failed/);

    // And the tree is usable again from the service side.
    const reopened = new OrgService(db);
    reopened.updateDepartment({ id: child.id, parentId: root.id });
    expect(reopened.list().find((node) => node.id === child.id)?.parentId).toBe(root.id);
  });

  it('adds jobs, headcount and the event log to an existing database', () => {
    const org = new OrgService(db);
    const department = org.createDepartment({ name: '工程部' });
    const person = org.hire({ name: '李雷', role: '工程师', departmentId: department.id });
    // A v13 database has neither table nor column: drop them and wind the version back.
    db.exec('DROP INDEX IF EXISTS idx_pos_job;');
    db.exec('DROP TABLE IF EXISTS job; DROP TABLE IF EXISTS employment_event;');
    db.exec('ALTER TABLE position DROP COLUMN job_id;');
    // A database from before v14 had no job table at all; the current one is global-
    // shaped, so dropping it is what "wind back" actually means here.
    db.exec('DROP TABLE IF EXISTS department_job; DROP TABLE IF EXISTS job;');
    db.pragma('user_version = 13');
    db.close();

    db = openCompanyDatabase(path.join(dir, 'company.db'));

    // The employee survived the upgrade, and the new tables exist and work.
    const upgraded = new OrgService(db);
    expect(upgraded.everyone().find((member) => member.id === person.id)?.name).toBe('李雷');

    const job = upgraded.createJob({ title: '前端工程师' });
    upgraded.setJobSeat({ jobId: job.id, departmentId: department.id, headcount: 1 });
    const hired = upgraded.hire({ name: '甲', role: '工程师', departmentId: department.id, jobId: job.id });
    expect(hired.jobId).toBe(job.id);
    expect(upgraded.events(hired.id)[0]?.kind).toBe('hired');
    expect(() =>
      upgraded.hire({ name: '乙', role: '工程师', departmentId: department.id, jobId: job.id }),
    ).toThrow(/编制已满/);
  });

  it('turns per-department jobs into one company-wide job with per-department caps', () => {
    const org = new OrgService(db);
    const engineering = org.createDepartment({ name: '工程部' });
    const quality = org.createDepartment({ name: '质量部' });
    const job = org.createJob({ title: '测试工程师', description: '写能失败的检查。' });
    org.setJobSeat({ jobId: job.id, departmentId: engineering.id, headcount: 2 });
    const hired = org.hire({ name: '甲', role: '工程师', departmentId: engineering.id, jobId: job.id });

    // Rebuild the v20 shape: `job` was a per-department row with its own headcount, and
    // two departments could each have their own "测试工程师".
    db.exec('DROP TABLE department_job;');
    db.exec('DROP INDEX IF EXISTS idx_job_title; DROP INDEX IF EXISTS idx_job_live;');
    db.exec('ALTER TABLE job ADD COLUMN department_id TEXT;');
    db.exec('ALTER TABLE job ADD COLUMN headcount INTEGER NOT NULL DEFAULT 1;');
    db.prepare('UPDATE job SET department_id = ?, headcount = 2 WHERE id = ?').run(
      engineering.id,
      job.id,
    );
    db.prepare(
      `INSERT INTO job (id, title, level, description, skills, model, model_ref, deleted_at,
                        created_at, updated_at, department_id, headcount)
       VALUES ('job-qa-legacy', ' 测试工程师 ', 'P5', '', '[]', '', '', NULL, ?, ?, ?, 3)`,
    ).run(job.id, Date.now(), quality.id);
    db.pragma('user_version = 20');
    db.close();

    db = openCompanyDatabase(path.join(dir, 'company.db'));

    const upgraded = new OrgService(db);
    const jobs = upgraded.jobs();
    // Same title in two departments is one job now; the duplicate row is gone and the
    // surviving one is the older (the seat already points at it).
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: job.id, title: '测试工程师', description: '写能失败的检查。' });
    expect(jobs[0]?.headcount).toBe(5);
    expect(
      jobs[0]?.seats.map((seat) => [seat.departmentName, seat.headcount]).sort(),
    ).toEqual([
      ['工程部', 2],
      ['质量部', 3],
    ]);

    // The live seat survived the merge and still explains itself.
    expect(upgraded.everyone().find((member) => member.id === hired.id)?.jobId).toBe(job.id);
  });

  it('adds evaluations, probation and the confirmed event to an existing database', () => {
    const org = new OrgService(db);
    const department = org.createDepartment({ name: '工程部' });
    const person = org.hire({ name: '李雷', role: '工程师', departmentId: department.id });

    // Wind the database back to the v14 shape: no evaluation table, no probation
    // column, no acting-head flag, and an event CHECK that does not know `confirmed`.
    db.exec('DROP TABLE IF EXISTS evaluation;');
    db.exec('ALTER TABLE employee DROP COLUMN probation_ends_at;');
    db.exec('DROP INDEX IF EXISTS idx_pos_acting_head;');
    db.exec('ALTER TABLE position DROP COLUMN is_acting_head;');
    db.exec('ALTER TABLE assignment DROP COLUMN reports_to_employee_id;');
    db.exec('DROP INDEX IF EXISTS idx_event_employee; DROP INDEX IF EXISTS idx_event_recent;');
    db.exec('DROP TABLE employment_event;');
    db.exec(`
      CREATE TABLE employment_event (
        id                 TEXT PRIMARY KEY,
        employee_id        TEXT NOT NULL,
        kind               TEXT NOT NULL
                           CHECK (kind IN ('hired','transferred','promoted','head_appointed',
                                           'head_removed','terminated','reinstated')),
        from_department_id TEXT,
        to_department_id   TEXT,
        from_title         TEXT,
        to_title           TEXT,
        from_level         TEXT,
        to_level           TEXT,
        actor              TEXT NOT NULL DEFAULT 'boss',
        reason             TEXT NOT NULL DEFAULT '',
        at                 INTEGER NOT NULL,
        created_at         INTEGER NOT NULL,
        FOREIGN KEY (employee_id) REFERENCES employee(id)
      );
    `);
    db.exec('DROP TABLE IF EXISTS department_job;');
    db.pragma('user_version = 14');
    db.close();

    db = openCompanyDatabase(path.join(dir, 'company.db'));

    const upgraded = new OrgService(db);
    // The employee and their seat survived; probation simply reads as "none".
    const kept = upgraded.everyone().find((member) => member.id === person.id)!;
    expect(kept.name).toBe('李雷');
    expect(kept.probationEndsAt).toBeUndefined();

    // Probation, confirmation and reviews work on the upgraded schema…
    const temp = upgraded.hire({
      name: '甲',
      role: '工程师',
      departmentId: department.id,
      probationDays: 30,
    });
    expect(temp.probationEndsAt).toBeGreaterThan(temp.hiredAt);
    upgraded.personnel({ employeeId: temp.id, action: 'confirm' });
    expect(upgraded.events(temp.id)[0]?.kind).toBe('confirmed');

    const review = upgraded.addEvaluation({
      employeeId: temp.id,
      kind: 'probation',
      scoreOverall: 4,
      summary: '通过',
    });
    expect(review.scoreOverall).toBe(4);

    // …and so does the acting head.
    upgraded.appointActingHead(department.id, temp.id);
    expect(upgraded.list().find((node) => node.id === department.id)?.actingHeadEmployeeId).toBe(temp.id);
  });

  it('adds the interview and package tables to an existing database', async () => {
    const org = new OrgService(db);
    const department = org.createDepartment({ name: '工程部' });
    org.hire({ name: '李雷', role: '工程师', departmentId: department.id });

    // Wind back to v15: the two recruitment tables do not exist yet.
    db.exec('DROP TABLE IF EXISTS interview; DROP TABLE IF EXISTS employee_package;');
    db.exec('DROP TABLE IF EXISTS department_job;');
    db.pragma('user_version = 15');
    db.close();

    db = openCompanyDatabase(path.join(dir, 'company.db'));

    const upgraded = new OrgService(db);
    const market = new MarketService(db, upgraded);
    expect(upgraded.everyone().map((member) => member.name)).toContain('李雷');

    // A trial run works on the upgraded schema, including the SET NULL foreign key.
    const [candidate] = market.importJson(
      JSON.stringify({ agents: [{ name: '周航', role: '前端工程师' }] }),
      'test.json',
    );
    market.runTrial = async () => ({ text: 'ok', tokens: 5, costUsd: 0.001 });
    const interview = market.createInterview(candidate!.id, '任务');
    await market.runInterview(interview.id);
    const { employeeId } = market.decideInterview({
      interviewId: interview.id,
      decision: 'hire',
      departmentId: department.id,
    });
    expect(employeeId).toBeDefined();
    // Deleting the candidate nulls the reference instead of blocking the delete.
    expect(market.interviews()[0]?.candidateId).toBeUndefined();

    // And so does an export.
    const record = await market.exportPackage({
      kind: 'company',
      name: '全公司',
      filePath: path.join(dir, 'pkg.json'),
    });
    expect(record.members.length).toBeGreaterThan(0);
  });

  it('merges duplicated relationship edges when upgrading to v17', () => {
    const org = new OrgService(db);
    const department = org.createDepartment({ name: '工程部' });
    const manager = org.hire({ name: '沈聿', role: '技术负责人', departmentId: department.id });
    const report = org.hire({
      name: '李雷',
      role: '工程师',
      departmentId: department.id,
      reportsToEmployeeId: manager.id,
    });

    // A pre-v17 build keyed the edge on (from, to, kind). A reorg followed by another
    // message therefore left two edges for the same direction, and the rate limiter —
    // which reads by pair — could land on either one. Recreate that shape.
    db.exec('DROP TABLE relationship;');
    db.exec(`
      CREATE TABLE relationship (
        id                  TEXT PRIMARY KEY,
        company_id          TEXT NOT NULL DEFAULT 'company-local',
        from_employee_id    TEXT NOT NULL,
        to_employee_id      TEXT NOT NULL,
        kind                TEXT NOT NULL CHECK (kind IN ('colleague','manager','report','collaborator')),
        strength            REAL NOT NULL DEFAULT 0.5,
        interaction_count   INTEGER NOT NULL DEFAULT 0,
        last_interaction_at INTEGER,
        window_started_at   INTEGER,
        window_count        INTEGER NOT NULL DEFAULT 0,
        note                TEXT,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_rel_pair ON relationship(from_employee_id, to_employee_id, kind);
    `);
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO relationship (id, company_id, from_employee_id, to_employee_id, kind, strength,
                                 interaction_count, last_interaction_at, window_started_at, window_count,
                                 created_at, updated_at)
       VALUES (?, 'company-local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('rel-a', report.id, manager.id, 'manager', 0.7, 4, now - 1000, now - 500, 2, now - 2000, now);
    insert.run('rel-b', report.id, manager.id, 'colleague', 0.9, 3, now, now, 1, now - 1000, now);
    db.pragma('user_version = 16');
    db.close();

    db = openCompanyDatabase(path.join(dir, 'company.db'));

    const rows = db
      .prepare('SELECT * FROM relationship WHERE from_employee_id = ? AND to_employee_id = ?')
      .all(report.id, manager.id) as {
      strength: number;
      interaction_count: number;
      window_started_at: number;
      window_count: number;
    }[];
    // One edge per direction, with the history preserved rather than dropped.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.interaction_count).toBe(7);
    expect(rows[0]?.strength).toBeCloseTo(0.9);
    // The window comes from the most recent row, not a sum of stale ones.
    expect(rows[0]?.window_started_at).toBe(now);
    expect(rows[0]?.window_count).toBe(1);

    // The new key is the pair itself: a second insert is a conflict, not a new row.
    expect(() =>
      db
        .prepare(
          `INSERT INTO relationship (id, company_id, from_employee_id, to_employee_id, strength,
                                     interaction_count, window_count, created_at, updated_at)
           VALUES ('rel-dup', 'company-local', ?, ?, 0.5, 0, 0, ?, ?)`,
        )
        .run(report.id, manager.id, now, now),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('turns the stored boss name and portrait into a single user row when upgrading to v18', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    // A v17 build kept the boss in `app_setting`, next to presentation preferences.
    db.exec('DROP TABLE IF EXISTS app_user;');
    db.prepare(
      "INSERT INTO app_setting (key, value, updated_at) VALUES ('profile.bossName', '阿星', 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run();
    db.prepare(
      "INSERT INTO app_setting (key, value, updated_at) VALUES ('profile.bossAvatar', ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(png);
    db.pragma('user_version = 17');
    db.close();

    db = openCompanyDatabase(path.join(dir, 'company.db'));

    const rows = db.prepare('SELECT id, name, avatar FROM app_user').all() as {
      id: string;
      name: string;
      avatar: string;
    }[];
    // Exactly one human, carrying the name and portrait that were already there.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ id: 'boss', name: '阿星', avatar: png });

    // And the profile reads from the row, not from the old setting.
    expect(new CompanyService(db).get().bossName).toBe('阿星');

    // The legacy rows are left in place on purpose, so a one-version rollback renders.
    const legacy = db
      .prepare("SELECT value FROM app_setting WHERE key = 'profile.bossName'")
      .get() as { value: string };
    expect(legacy.value).toBe('阿星');
  });
});

describe('org + budget', () => {
  it('hires an employee together with a position and a budget', () => {
    const org = new OrgService(db);
    const { manager, worker } = hireTeam(org);

    expect(org.subordinatesOf(manager.id).map((member) => member.id)).toEqual([worker.id]);
    expect(new BudgetRepository(db).find('employee', worker.id)).toBeDefined();
    expect(new BudgetRepository(db).find('company', 'company-local')).toBeDefined();
  });
});

describe('TaskRepository', () => {
  function setup() {
    const org = new OrgService(db);
    const { manager, worker } = hireTeam(org);
    const repository = new TaskRepository(db);
    repository.seedEmployees([
      {
        id: worker.id,
        name: '李雷',
        role: '全栈工程师',
        level: 'P5',
        departmentId: worker.departmentId,
        model: '',
        status: 'online',
        skills: ['Node.js'],
        briefMd: '用最小依赖实现',
      },
    ]);
    return { org, manager, worker, repository };
  }

  function createTask(repository: TaskRepository, assigneeId: string, id = `task-${Math.random()}`) {
    return repository.createTask(
      {
        title: '返回 ok 的 HTTP 服务',
        brief: '用 node 内置 http',
        deliverableSpec: 'server.js 返回 ok',
        assigneeId,
        estTokens: 1000,
        acceptanceCommand: ['node', '{checks}/verify.mjs'],
        acceptanceTemplate: 'http-ok',
      },
      taskWorkspaceRelPath(id),
      id,
    );
  }

  it('records an artifact with its hash and reads it back with the task', () => {
    const { worker, repository } = setup();
    const task = createTask(repository, worker.id);
    const workspace = path.join(dir, 'workspace', task.workspaceRelPath);
    mkdirSync(workspace, { recursive: true });
    const file = path.join(workspace, 'server.js');
    writeFileSync(file, 'console.log("ok")\n');

    repository.addArtifact(task.id, 'server.js', file);
    repository.addStep(task.id, '第 1 次尝试');
    repository.addAcceptance(task.id, {
      verdict: 'pass',
      reason: '退出码 0',
      evidence: {
        command: ['node', 'checks/verify.mjs'],
        exitCode: 0,
        stdoutTail: 'ok',
        stderrTail: '',
        durationMs: 12,
      },
    });

    const stored = repository.getTask(task.id);
    expect(stored?.artifacts).toHaveLength(1);
    expect(stored?.artifacts[0]?.sha256).toHaveLength(64);
    expect(stored?.acceptance?.verdict).toBe('pass');
    expect(stored?.attempts).toBe(1);
    expect(stored?.steps.map((step) => step.text)).toEqual(['第 1 次尝试']);
    expect(stored?.persona).toBe('用最小依赖实现');
  });

  it('reads the seat responsibilities live, next to the personal charter', () => {
    const org = new OrgService(db);
    const department = org.createDepartment({ name: '工程部' });
    const job = org.createJob({
      title: '测试工程师',
      description: '每个交付都要有一条能失败的检查。',
    });
    const worker = org.hire({
      name: '甲',
      role: '工程师',
      departmentId: department.id,
      jobId: job.id,
      persona: '先给结论，再给证据。',
    });
    const repository = new TaskRepository(db);
    const task = createTask(repository, worker.id);

    // The prompt needs both: the job says what this seat owes, the persona says how
    // this particular person works. Neither is copied at hire time.
    expect(task.jobDescription).toBe('每个交付都要有一条能失败的检查。');
    expect(task.persona).toBe('先给结论，再给证据。');

    // Live join: editing the template reaches the very next task load.
    org.updateJob({ id: job.id, description: '只交付可复现的结果。' });
    expect(repository.getTask(task.id)?.jobDescription).toBe('只交付可复现的结果。');
  });

  it('links a manager sign-off and counts it as a review', () => {
    const { worker, manager, repository } = setup();
    const task = createTask(repository, worker.id);
    const reviewId = 'task-review';
    repository.createTask(
      {
        title: `验收：${task.title}`,
        brief: '判定是否达标',
        deliverableSpec: 'verdict.json',
        assigneeId: manager.id,
        estTokens: 500,
        acceptanceCommand: ['node', '{checks}/verify.mjs'],
        acceptanceTemplate: 'review-verdict',
      },
      taskWorkspaceRelPath(reviewId),
      reviewId,
    );

    repository.markAsReview(reviewId, task.id);
    expect(repository.getTask(reviewId)?.isReview).toBe(true);
    expect(repository.listReviews(task.id).map((entry) => entry.id)).toEqual([reviewId]);
  });

  it('exposes exactly the tasks a restarted process must reconcile', () => {
    const { worker, repository } = setup();
    const open = createTask(repository, worker.id, 'task-open');
    const running = createTask(repository, worker.id, 'task-running');
    repository.setStatus(running.id, 'running', { startedAt: Date.now(), error: null });

    expect(repository.listPending().map((task) => task.id).sort()).toEqual(
      [open.id, running.id].sort(),
    );
    expect(repository.listRunning().map((task) => task.id)).toEqual([running.id]);
  });

  it('refuses work for an employee who is no longer active', () => {
    const { worker, org, repository } = setup();
    org.fire(worker.id);

    expect(() => createTask(repository, worker.id)).toThrow(/不在岗/);
  });
});

describe('BudgetRepository', () => {
  function setup() {
    const org = new OrgService(db);
    const { worker } = hireTeam(org);
    const repository = new TaskRepository(db);
    repository.seedEmployees([
      {
        id: worker.id,
        name: '李雷',
        role: '全栈工程师',
        level: 'P5',
        departmentId: worker.departmentId,
        model: '',
        status: 'online',
        skills: [],
        briefMd: '',
      },
    ]);
    return { repository, budgets: new BudgetRepository(db), worker };
  }

  it('reserves, then settles real usage into a ledger', () => {
    const { repository, budgets, worker } = setup();
    const task = repository.createTask(
      {
        title: 't',
        brief: 'b',
        deliverableSpec: 'd',
        assigneeId: worker.id,
        estTokens: 1000,
        acceptanceCommand: [],
        acceptanceTemplate: 'http-ok',
      },
      taskWorkspaceRelPath('task-budget'),
      'task-budget',
    );

    budgets.reserve({
      budgets: [budgets.find('employee', worker.id)!],
      taskId: task.id,
      employeeId: worker.id,
      tokens: 1000,
      expiresAt: Date.now() + 60_000,
    });
    expect(budgets.find('employee', worker.id)?.reservedTokens).toBe(1000);

    budgets.settle(task.id, 400, 0.5);
    const settled = budgets.find('employee', worker.id);
    expect(settled?.reservedTokens).toBe(0);
    expect(settled?.usedTokens).toBe(400);

    const ledger = db
      .prepare('SELECT kind, tokens FROM budget_ledger WHERE task_id = ? ORDER BY rowid')
      .all(task.id);
    expect(ledger).toEqual([
      { kind: 'reserve', tokens: 1000 },
      { kind: 'settle', tokens: 400 },
    ]);
  });

  it('reclaims reservations whose task no longer exists', () => {
    const { budgets, worker } = setup();
    budgets.reserve({
      budgets: [budgets.find('employee', worker.id)!],
      taskId: 'task-ghost',
      employeeId: worker.id,
      tokens: 77,
      expiresAt: Date.now() + 60_000,
    });

    expect(budgets.releaseOrphans(() => false)).toBe(1);
    expect(budgets.find('employee', worker.id)?.reservedTokens).toBe(0);
  });
});

describe('MemoryService', () => {
  it('never returns another project\'s memory', async () => {
    const org = new OrgService(db);
    const { worker } = hireTeam(org);
    const memory = new MemoryService(db);

    await memory.remember({
      employeeId: worker.id,
      kind: 'experience',
      content: '上线前先跑一遍冒烟脚本，避免端口冲突',
      scope: { type: 'personal' },
      sourceType: 'task',
    });

    const personal = await memory.retrieve({
      employeeId: worker.id,
      query: '冒烟脚本',
      scopes: [{ type: 'personal' }],
      limit: 3,
    });
    expect(personal).toHaveLength(1);

    const foreignProject = await memory.retrieve({
      employeeId: worker.id,
      query: '冒烟脚本',
      scopes: [{ type: 'project', id: 'proj-someone-else' }],
      limit: 3,
    });
    expect(foreignProject).toHaveLength(0);
  });
});
