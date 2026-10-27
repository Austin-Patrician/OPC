import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OrgService } from '../org/orgService';
import { MemoryService } from '../memory/memoryService';
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
    db.pragma('user_version = 10');
    db.close();

    db = openCompanyDatabase(path.join(dir, 'company.db'));
    const node = new OrgService(db).list().find((entry) => entry.id === department.id)!;
    expect(node.headEmployeeId).toBe(person.id);
    expect(node.members.find((member) => member.id === person.id)?.isHead).toBe(true);
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
