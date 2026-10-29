import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompanyDatabase } from '../data/companyDatabase';
import { openCompanyDatabase } from '../data/companyDatabase';
import { OrgService } from './orgService';

/**
 * The three invariants the org chart now depends on, against a real SQLite file.
 *
 * Each test names the failure it prevents:
 *
 * 1. a second live position would make the same person appear twice in `list()`;
 * 2. a second head — or a head that is only stored on `department` — would split the
 *    org chart from its own headcount;
 * 3. a broken reporting line is a *permission* bug, because `subordinatesOf` decides
 *    who may decompose tasks.
 */

let dir: string;
let db: CompanyDatabase;
let org: OrgService;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-org-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  org = new OrgService(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function team() {
  const department = org.createDepartment({ name: '工程部' });
  const boss = org.hire({ name: '沈聿', role: '技术总监', departmentId: department.id, isHead: true });
  const manager = org.hire({
    name: '李雷',
    role: '交付经理',
    departmentId: department.id,
    reportsToEmployeeId: boss.id,
  });
  const worker = org.hire({
    name: '韩梅梅',
    role: '前端工程师',
    departmentId: department.id,
    reportsToEmployeeId: manager.id,
  });
  return { department, boss, manager, worker };
}

function positionRow(employeeId: string) {
  return db
    .prepare('SELECT id, reports_to_employee_id, is_head FROM position WHERE employee_id = ? AND deleted_at IS NULL')
    .get(employeeId) as { id: string; reports_to_employee_id: string | null; is_head: number } | undefined;
}

describe('one live position per employee', () => {
  it('rejects a second live position at the schema level', () => {
    const { department, worker } = team();
    const now = Date.now();

    expect(() =>
      db
        .prepare(
          `INSERT INTO position (id, employee_id, department_id, title, is_head, created_at, updated_at)
           VALUES ('pos-shadow', ?, ?, '影子职位', 0, ?, ?)`,
        )
        .run(worker.id, department.id, now, now),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('keeps the old row as history when an employee transfers', () => {
    const { department, worker } = team();
    const other = org.createDepartment({ name: '市场部' });

    org.transfer(worker.id, other.id);

    const rows = db
      .prepare('SELECT department_id, deleted_at FROM position WHERE employee_id = ? ORDER BY created_at')
      .all(worker.id) as { department_id: string; deleted_at: number | null }[];
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.deleted_at === null).map((row) => row.department_id)).toEqual([other.id]);
    expect(rows.some((row) => row.department_id === department.id && row.deleted_at !== null)).toBe(true);
  });
});

describe('one head per department', () => {
  it('replaces the incumbent when a new head is hired', () => {
    const department = org.createDepartment({ name: '工程部' });
    const first = org.hire({ name: '甲', role: '总监', departmentId: department.id, isHead: true });
    const second = org.hire({ name: '乙', role: '总监', departmentId: department.id, isHead: true });

    const node = org.list().find((entry) => entry.id === department.id)!;
    expect(node.headEmployeeId).toBe(second.id);
    expect(node.members.filter((member) => member.isHead).map((member) => member.id)).toEqual([second.id]);

    expect(() =>
      db
        .prepare('UPDATE position SET is_head = 1 WHERE employee_id = ? AND deleted_at IS NULL')
        .run(first.id),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('stops writing the legacy department.head_employee_id column', () => {
    const { department, boss } = team();
    const row = db
      .prepare('SELECT head_employee_id FROM department WHERE id = ?')
      .get(department.id) as { head_employee_id: string | null };

    expect(boss.isHead).toBe(true);
    expect(row.head_employee_id).toBeNull();
  });

  it('appoints the head createDepartment was given', () => {
    const { department: from, boss } = team();
    const created = org.createDepartment({ name: '财务部', headEmployeeId: boss.id });

    expect(created.headEmployeeId).toBe(boss.id);
    expect(created.members.find((member) => member.id === boss.id)?.isHead).toBe(true);
    // Moving the head out leaves the old department without one, rather than with a
    // head who is not in it (the bug the old column caused).
    expect(org.list().find((node) => node.id === from.id)?.headEmployeeId).toBeUndefined();
  });

  it('derives the head from the position, so a transfer cannot leave a ghost', () => {
    const { department, boss } = team();
    const other = org.createDepartment({ name: '市场部' });

    org.transfer(boss.id, other.id);

    const old = org.list().find((node) => node.id === department.id)!;
    expect(old.headEmployeeId).toBeUndefined();
    expect(old.members.some((member) => member.isHead)).toBe(false);
    expect(old.members).toHaveLength(2);
  });

  it('keeps the flag when a transfer stays in the same department', () => {
    const { department, boss } = team();
    org.transfer(boss.id, department.id);
    expect(org.list().find((node) => node.id === department.id)?.headEmployeeId).toBe(boss.id);
  });

  it('clears the head when they leave the company', () => {
    const { department, boss } = team();
    org.personnel({ employeeId: boss.id, action: 'terminate' });
    expect(org.list().find((node) => node.id === department.id)?.headEmployeeId).toBeUndefined();
  });
});

describe('reporting lines', () => {
  it('rejects an id that does not exist', () => {
    const { worker } = team();

    expect(org.everyone().find((member) => member.id === worker.id)?.reportsToEmployeeId).toBeDefined();
    expect(() =>
      org.personnel({ employeeId: worker.id, action: 'set-manager', reportsToEmployeeId: 'agent-ghost' }),
    ).toThrow('汇报对象不在岗');
    expect(() =>
      org.hire({
        name: '新人',
        role: '工程师',
        departmentId: org.list()[0]!.id,
        reportsToEmployeeId: 'agent-ghost',
      }),
    ).toThrow('汇报对象不在岗');
  });

  it('rejects a reporting line to a terminated employee', () => {
    const { department, manager, worker } = team();
    org.personnel({ employeeId: manager.id, action: 'terminate' });

    expect(() =>
      org.personnel({ employeeId: worker.id, action: 'set-manager', reportsToEmployeeId: manager.id }),
    ).toThrow('汇报对象不在岗');
    expect(org.list().find((node) => node.id === department.id)).toBeDefined();
  });

  it('rejects reporting to yourself', () => {
    const { worker } = team();
    expect(() =>
      org.personnel({ employeeId: worker.id, action: 'set-manager', reportsToEmployeeId: worker.id }),
    ).toThrow('不能把自己设为汇报对象');
  });

  it('rejects a cycle that would make two people each other’s manager', () => {
    const { boss, worker } = team();
    expect(() =>
      org.personnel({ employeeId: boss.id, action: 'set-manager', reportsToEmployeeId: worker.id }),
    ).toThrow('汇报线不能成环');

    // The refused write must not have partially applied.
    expect(positionRow(boss.id)?.reports_to_employee_id).toBeNull();
  });

  it('enforces the reports_to foreign key in the schema', () => {
    const { worker } = team();
    expect(() =>
      db
        .prepare(
          'UPDATE position SET reports_to_employee_id = ? WHERE employee_id = ? AND deleted_at IS NULL',
        )
        .run('agent-ghost', worker.id),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('hands direct reports to the departing manager’s manager', () => {
    const { boss, manager, worker } = team();

    org.personnel({ employeeId: manager.id, action: 'terminate' });

    expect(org.everyone().find((member) => member.id === worker.id)?.reportsToEmployeeId).toBe(boss.id);
    expect(org.subordinatesOf(boss.id).map((member) => member.id)).toContain(worker.id);
  });

  it('clears the line when the departing manager had no manager of their own', () => {
    const { boss, manager, worker } = team();

    org.personnel({ employeeId: boss.id, action: 'terminate' });
    // The manager of `boss` was nobody; both reports must not point at a ghost.
    expect(org.everyone().find((member) => member.id === manager.id)?.reportsToEmployeeId).toBeUndefined();
    expect(org.everyone().find((member) => member.id === worker.id)?.reportsToEmployeeId).toBeDefined();
  });
});

/**
 * The employment record itself: when someone joined, when they left, and what a move
 * must not silently rewrite. These are the facts an HR page is asked for first.
 */
describe('employment record', () => {
  const employeeRow = (id: string) =>
    db
      .prepare('SELECT status, department_id, terminated_at, hired_at FROM employee WHERE id = ?')
      .get(id) as {
      status: string;
      department_id: string | null;
      terminated_at: number | null;
      hired_at: number;
    };

  const seat = (id: string) =>
    db
      .prepare(
        `SELECT department_id, title, reports_to_employee_id FROM position
          WHERE employee_id = ? AND deleted_at IS NULL`,
      )
      .get(id) as
      | { department_id: string; title: string; reports_to_employee_id: string | null }
      | undefined;

  it('stamps the leaving time and stops occupying a department', () => {
    const { department, worker } = team();

    org.personnel({ employeeId: worker.id, action: 'terminate' });

    const row = employeeRow(worker.id);
    expect(row.status).toBe('terminated');
    expect(row.terminated_at).toBeGreaterThanOrEqual(row.hired_at);
    expect(row.department_id).toBeNull();
    // The seat is closed, so the org chart no longer lists them.
    expect(seat(worker.id)).toBeUndefined();
    expect(org.list().find((node) => node.id === department.id)!.members.map((m) => m.id)).not.toContain(
      worker.id,
    );
    expect(org.everyone().find((member) => member.id === worker.id)?.terminatedAt).toBe(row.terminated_at);
  });

  it('clears the leaving time when someone is reinstated', () => {
    const { worker } = team();

    org.personnel({ employeeId: worker.id, action: 'terminate' });
    org.personnel({ employeeId: worker.id, action: 'reinstate' });

    const row = employeeRow(worker.id);
    expect(row.status).toBe('active');
    expect(row.terminated_at).toBeNull();
    expect(row.department_id).not.toBeNull();
    expect(org.everyone().find((member) => member.id === worker.id)?.terminatedAt).toBeUndefined();
  });

  it('keeps the seat title across a transfer', () => {
    const department = org.createDepartment({ name: '工程部' });
    const person = org.hire({
      name: '甲',
      role: '前端工程师',
      title: '高级前端工程师',
      departmentId: department.id,
    });
    const other = org.createDepartment({ name: '平台部' });

    org.transfer(person.id, other.id);

    // `employee.role` is the job family; the seat title is a separate fact and a move
    // must not reset it.
    expect(seat(person.id)?.title).toBe('高级前端工程师');
  });

  it('keeps the reporting line when a transfer does not name a new manager', () => {
    const { manager, worker } = team();
    const other = org.createDepartment({ name: '市场部' });

    // Exactly what a board drag-and-drop does: two arguments, no manager.
    org.transfer(worker.id, other.id);

    expect(seat(worker.id)?.reports_to_employee_id).toBe(manager.id);
  });

  it('clears the reporting line when asked to, with an empty id', () => {
    const { worker } = team();
    const other = org.createDepartment({ name: '市场部' });

    org.transfer(worker.id, other.id, '');

    expect(seat(worker.id)?.reports_to_employee_id).toBeNull();
  });

  it('restores department, seat title and manager on reinstatement', () => {
    const { manager, worker } = team();
    const before = seat(worker.id)!;

    org.personnel({ employeeId: worker.id, action: 'terminate' });
    org.personnel({ employeeId: worker.id, action: 'reinstate' });

    const after = seat(worker.id)!;
    expect(after.department_id).toBe(before.department_id);
    expect(after.title).toBe(before.title);
    expect(after.reports_to_employee_id).toBe(manager.id);
  });

  it('does not leave an empty department behind when the head is not on staff', () => {
    expect(() => org.createDepartment({ name: '空壳部', headEmployeeId: 'agent-ghost' })).toThrow(
      '指定的负责人不在岗',
    );
    expect(org.list().some((node) => node.name === '空壳部')).toBe(false);
  });

  it('enforces department name uniqueness in the schema, not just in the service', () => {
    const department = org.createDepartment({ name: '工程部', code: 'EN-01' });
    const now = Date.now();
    const insert = (id: string, name: string, code: string) =>
      db
        .prepare(
          `INSERT INTO department (id, name, code, description, color, created_at, updated_at)
           VALUES (?, ?, ?, '', '#000000', ?, ?)`,
        )
        .run(id, name, code, now, now);

    expect(department.name).toBe('工程部');
    // Case and padding are not a way around it: the index is on LOWER(TRIM(name)).
    expect(() => insert('dept-dup', ' 工程部 ', '')).toThrow(/UNIQUE constraint failed/);
    expect(() => insert('dept-dup2', '市场部', 'en-01')).toThrow(/UNIQUE constraint failed/);
    // A second department without a code is fine: '' does not participate.
    expect(() => insert('dept-ok', '市场部', '')).not.toThrow();
  });
});

/**
 * The department tree: `parent_id` was a declared-but-dead column until v13, so these
 * cover the three things that make it real — it nests, it cannot loop, and a subtree
 * is what "focus this department" means.
 */
describe('department tree', () => {
  function tree() {
    const company = org.createDepartment({ name: '研发中心' });
    const frontend = org.createDepartment({ name: '前端组', parentId: company.id });
    const backend = org.createDepartment({ name: '后端组', parentId: company.id });
    return { company, frontend, backend };
  }

  const parentOf = (id: string) =>
    (db.prepare('SELECT parent_id FROM department WHERE id = ?').get(id) as { parent_id: string | null })
      .parent_id;

  it('nests a department under its parent and reports it', () => {
    const { company, frontend } = tree();

    expect(parentOf(frontend.id)).toBe(company.id);
    expect(org.list().find((node) => node.id === frontend.id)?.parentId).toBe(company.id);
    expect(org.list().find((node) => node.id === company.id)?.parentId).toBeUndefined();
  });

  it('enforces the parent foreign key in the schema', () => {
    const { frontend } = tree();
    expect(() =>
      db.prepare('UPDATE department SET parent_id = ? WHERE id = ?').run('dept-ghost', frontend.id),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('refuses a department as its own parent', () => {
    const { company } = tree();
    expect(() => org.updateDepartment({ id: company.id, parentId: company.id })).toThrow(
      '不能把部门挂到自己下面',
    );
  });

  it('refuses a parent that would close a loop', () => {
    const { company, frontend } = tree();

    expect(() => org.updateDepartment({ id: company.id, parentId: frontend.id })).toThrow(
      '部门层级不能成环',
    );
    // The refused write must not have partially applied.
    expect(parentOf(company.id)).toBeNull();
  });

  it('moves a department to the top level with an explicit null', () => {
    const { company, frontend } = tree();

    // `undefined` leaves the parent alone; `null` is the deliberate "make it a root".
    org.updateDepartment({ id: frontend.id, name: '前端组' });
    expect(parentOf(frontend.id)).toBe(company.id);

    org.updateDepartment({ id: frontend.id, parentId: null });
    expect(parentOf(frontend.id)).toBeNull();
  });

  it('renames and re-codes, still refusing duplicates', () => {
    const { company, backend } = tree();

    const renamed = org.updateDepartment({ id: backend.id, name: '服务端组', code: 'be-02' });
    expect(renamed.name).toBe('服务端组');
    expect(renamed.code).toBe('BE-02');
    // The parent is untouched by a rename.
    expect(renamed.parentId).toBe(company.id);

    expect(() => org.updateDepartment({ id: backend.id, name: '研发中心' })).toThrow('部门名称已存在');
  });

  it('keeps sibling order and appends new departments at the end', () => {
    const { company } = tree();
    const ops = org.createDepartment({ name: '运维组', parentId: company.id });

    const order = org
      .list()
      .filter((node) => node.parentId === company.id)
      .map((node) => node.name);
    expect(order).toEqual(['前端组', '后端组', '运维组']);

    org.updateDepartment({ id: ops.id, sortOrder: 0 });
    expect(
      org
        .list()
        .filter((node) => node.parentId === company.id)
        .map((node) => node.name),
    ).toEqual(['运维组', '前端组', '后端组']);
  });

  it('refuses to archive a department that still holds people or children', () => {
    const { company, frontend } = tree();
    org.hire({ name: '李雷', role: '工程师', departmentId: frontend.id });

    expect(() => org.archiveDepartment(company.id)).toThrow(/下级部门/);
    expect(() => org.archiveDepartment(frontend.id)).toThrow(/在岗员工/);
    // Nothing was archived by the refusals.
    expect(org.list()).toHaveLength(3);
  });

  it('archives an empty leaf department without touching history', () => {
    const { frontend } = tree();

    org.archiveDepartment(frontend.id);

    expect(org.list().some((node) => node.id === frontend.id)).toBe(false);
    // Soft delete: the row is still there, so an old position can still be explained.
    const row = db.prepare('SELECT deleted_at FROM department WHERE id = ?').get(frontend.id) as {
      deleted_at: number | null;
    };
    expect(row.deleted_at).toBeGreaterThan(0);
  });
});

/**
 * 岗位是公司级职务（测试工程师、产品经理、CFO），编制才是部门的事。
 *
 * The two used to be one row, which made "测试工程师" a different job in every
 * department. Here the shared definition and the per-department plan are tested
 * separately, because that is the distinction the model has to keep.
 */
describe('jobs and headcount', () => {
  function dept(name = '工程部') {
    return org.createDepartment({ name });
  }

  it('defines a job once for the whole company', () => {
    const department = dept();
    const job = org.createJob({ title: '测试工程师', level: 'P5' });
    org.setJobSeat({ jobId: job.id, departmentId: department.id, headcount: 2 });

    const [stored] = org.jobs();
    expect(stored).toMatchObject({ title: '测试工程师', headcount: 2, filled: 0 });
    expect(stored?.seats).toEqual([
      expect.objectContaining({ departmentId: department.id, departmentName: '工程部', headcount: 2 }),
    ]);

    // The same title cannot be redefined: that is how "测试工程师 / QA / 测试" split.
    expect(() => org.createJob({ title: ' 测试工程师 ' })).toThrow('公司里已有岗位');
  });

  it('shares one job across departments while each keeps its own cap', () => {
    const engineering = dept();
    const quality = dept('质量部');
    const job = org.createJob({ title: '测试工程师' });
    org.setJobSeat({ jobId: job.id, departmentId: engineering.id, headcount: 1 });
    org.setJobSeat({ jobId: job.id, departmentId: quality.id, headcount: 2 });

    org.hire({ name: '甲', role: '工程师', departmentId: engineering.id, jobId: job.id });
    org.hire({ name: '乙', role: '工程师', departmentId: quality.id, jobId: job.id });

    const stored = org.jobs().find((entry) => entry.id === job.id)!;
    expect(stored.filled).toBe(2);
    expect(stored.headcount).toBe(3);
    expect(stored.seats.map((seat) => [seat.departmentName, seat.filled, seat.headcount])).toEqual([
      ['工程部', 1, 1],
      ['质量部', 1, 2],
    ]);

    // 工程部 is full, 质量部 still has room: the cap is per department, not global.
    expect(() =>
      org.hire({ name: '丙', role: '工程师', departmentId: engineering.id, jobId: job.id }),
    ).toThrow(/编制已满（1\/1）/);
    expect(() =>
      org.hire({ name: '丁', role: '工程师', departmentId: quality.id, jobId: job.id }),
    ).not.toThrow();
  });

  it('lets a department hire without a planned seat, and reports it as unplanned', () => {
    const department = dept();
    const job = org.createJob({ title: 'CFO' });

    // No department_job row means "not planned", not "not allowed" — small companies
    // hire first and write the plan later.
    const hired = org.hire({ name: '甲', role: '财务', departmentId: department.id, jobId: job.id });
    expect(hired.jobId).toBe(job.id);
    expect(org.jobs(department.id)[0]?.filled).toBe(1);
    expect(org.jobs(department.id)[0]?.headcount).toBe(0);
  });

  it('refuses the hire that would exceed the cap, leaving nothing behind', () => {
    const department = dept();
    const job = org.createJob({ title: '前端工程师' });
    org.setJobSeat({ jobId: job.id, departmentId: department.id, headcount: 1 });

    org.hire({ name: '甲', role: '工程师', departmentId: department.id, jobId: job.id });

    expect(() =>
      org.hire({ name: '乙', role: '工程师', departmentId: department.id, jobId: job.id }),
    ).toThrow(/编制已满（1\/1）/);
    expect(org.list().flatMap((node) => node.members)).toHaveLength(1);
  });

  it('inherits the job title, level, skills and model when the hire does not name them', () => {
    const department = dept();
    const job = org.createJob({
      title: '测试工程师',
      level: 'P6',
      description: '对每个交付写一条能失败的检查，再让它通过。',
      skills: [' Playwright ', 'SQL', 'sql', ''],
      model: 'job-default',
      modelRef: { providerId: 'prov-a', modelId: 'model-a' },
    });
    org.setJobSeat({ jobId: job.id, departmentId: department.id, headcount: 1 });

    expect(job.skills).toEqual(['Playwright', 'SQL']);
    expect(job.model).toBe('job-default');
    expect(job.modelRef).toEqual({ providerId: 'prov-a', modelId: 'model-a' });

    const hired = org.hire({ name: '甲', role: '随便写的', departmentId: department.id, jobId: job.id });
    expect(hired.role).toBe('测试工程师');
    expect(hired.title).toBe('测试工程师');
    expect(hired.level).toBe('P6');
    expect(hired.skills).toEqual(['Playwright', 'SQL']);
    expect(hired.model).toBe('job-default');
    expect(hired.modelRef).toEqual({ providerId: 'prov-a', modelId: 'model-a' });
  });

  it('keeps its own seat when re-seated in the same department at full headcount', () => {
    const department = dept();
    const job = org.createJob({ title: '前端工程师' });
    org.setJobSeat({ jobId: job.id, departmentId: department.id, headcount: 1 });
    const hired = org.hire({ name: '甲', role: '工程师', departmentId: department.id, jobId: job.id });

    // A single-seat plan is "full" of this very person; moving them within the same
    // department must not read that as "no room left".
    const moved = org.transfer(hired.id, department.id);

    expect(moved.jobId).toBe(job.id);
    expect(org.jobs(department.id)[0]!.filled).toBe(1);
  });

  it('keeps the job when someone moves to another department', () => {
    const department = dept();
    const other = dept('市场部');
    const job = org.createJob({ title: '测试工程师' });
    const hired = org.hire({ name: '甲', role: '工程师', departmentId: department.id, jobId: job.id });

    const moved = org.transfer(hired.id, other.id);

    // 职务 is company-wide: moving desks does not change what the person does. The new
    // department simply has no plan for it yet.
    expect(moved.jobId).toBe(job.id);
    expect(moved.title).toBe('测试工程师');
  });

  it('refuses to shrink a department cap below the people already seated there', () => {
    const department = dept();
    const job = org.createJob({ title: '前端工程师' });
    org.setJobSeat({ jobId: job.id, departmentId: department.id, headcount: 2 });
    org.hire({ name: '甲', role: '工程师', departmentId: department.id, jobId: job.id });
    org.hire({ name: '乙', role: '工程师', departmentId: department.id, jobId: job.id });

    expect(() =>
      org.setJobSeat({ jobId: job.id, departmentId: department.id, headcount: 1 }),
    ).toThrow(/编制不能小于在岗人数（当前 2 人）/);
    expect(org.jobs(department.id)[0]!.headcount).toBe(2);
  });

  it('refuses to archive a job that still has people in it', () => {
    const department = dept();
    const job = org.createJob({ title: '前端工程师' });
    org.hire({ name: '甲', role: '工程师', departmentId: department.id, jobId: job.id });

    expect(() => org.archiveJob(job.id)).toThrow(/还有 1 人在岗/);
    expect(org.jobs()).toHaveLength(1);
  });

  it('drops the department plan when the job is archived', () => {
    const department = dept();
    const job = org.createJob({ title: '前端工程师' });
    org.setJobSeat({ jobId: job.id, departmentId: department.id, headcount: 2 });

    org.archiveJob(job.id);

    expect(org.jobs()).toHaveLength(0);
    expect(org.jobs(department.id)).toHaveLength(0);
  });

  it('never rewrites a live employee when the job changes', () => {
    const department = dept();
    const job = org.createJob({ title: '测试工程师', skills: ['Playwright'], model: 'job-first' });
    const hired = org.hire({ name: '甲', role: '工程师', departmentId: department.id, jobId: job.id });

    org.updateJob({ id: job.id, skills: ['SQL'], model: 'job-second' });

    // Someone may have tuned their own stack; a job edit must not undo it.
    const unchanged = org.list().flatMap((node) => node.members).find((entry) => entry.id === hired.id)!;
    expect(unchanged.skills).toEqual(['Playwright']);
    expect(unchanged.model).toBe('job-first');
  });

  it('pushes the job onto its occupants only when asked to sync', () => {
    const department = dept();
    const job = org.createJob({ title: '测试工程师', skills: ['Playwright'], model: 'job-first' });
    org.setJobSeat({ jobId: job.id, departmentId: department.id, headcount: 2 });
    const first = org.hire({ name: '甲', role: '工程师', departmentId: department.id, jobId: job.id });
    org.hire({ name: '乙', role: '工程师', departmentId: department.id, jobId: job.id });

    org.updateJob({ id: job.id, skills: ['SQL', 'Playwright'], model: 'job-second', modelRef: null });
    expect(org.syncJob(job.id)).toBe(2);

    const member = org
      .list()
      .flatMap((node) => node.members)
      .find((entry) => entry.id === first.id)!;
    expect(member.skills).toEqual(['SQL', 'Playwright']);
    expect(member.model).toBe('job-second');
    expect(member.modelRef).toBeUndefined();
  });

  it('clears a job default with an explicit null', () => {
    const job = org.createJob({
      title: '测试工程师',
      modelRef: { providerId: 'prov-a', modelId: 'model-a' },
    });

    // Omitted = keep; null = back to "inherit the company default".
    org.updateJob({ id: job.id, description: '只改职责' });
    expect(org.jobs()[0]!.modelRef).toEqual({ providerId: 'prov-a', modelId: 'model-a' });

    org.updateJob({ id: job.id, modelRef: null });
    expect(org.jobs()[0]!.modelRef).toBeUndefined();
  });
});

/**
 * The HR timeline. `position` can say "they moved"; only an event can say when, who
 * decided, and why — which is what a personnel page is actually asked.
 */
describe('employment events', () => {
  const kinds = (employeeId: string) => org.events(employeeId).map((event) => event.kind);

  it('records the hire with the seat it filled', () => {
    const department = org.createDepartment({ name: '工程部' });
    const hired = org.hire({ name: '甲', role: '工程师', departmentId: department.id, title: '高级工程师' });

    const [event] = org.events(hired.id);
    expect(event?.kind).toBe('hired');
    expect(event?.toDepartmentId).toBe(department.id);
    expect(event?.toTitle).toBe('高级工程师');
    expect(event?.actor).toBe('boss');
  });

  it('records a move with both ends', () => {
    const { department, worker } = team();
    const other = org.createDepartment({ name: '市场部' });

    org.transfer(worker.id, other.id);

    const [event] = org.events(worker.id);
    expect(event?.kind).toBe('transferred');
    expect(event?.fromDepartmentId).toBe(department.id);
    expect(event?.toDepartmentId).toBe(other.id);
  });

  it('does not record a no-op re-seat in the same department', () => {
    const { worker } = team();
    const before = org.events(worker.id).length;

    org.personnel({ employeeId: worker.id, action: 'set-manager', reportsToEmployeeId: '' });

    expect(org.events(worker.id)).toHaveLength(before);
  });

  it('records leaving, and the head seat it closes', () => {
    const { boss } = team();

    org.fire(boss.id);

    // Newest first: leaving closes the head seat, then the employment itself.
    expect(kinds(boss.id).slice(0, 2)).toEqual(['head_removed', 'terminated']);
    const [removed, terminated] = org.events(boss.id);
    expect(removed?.reason).toBe('离职');
    expect(terminated?.fromDepartmentId).toBeDefined();
  });

  it('records reinstatement as one fact, not a transfer from nowhere', () => {
    const { worker } = team();

    org.fire(worker.id);
    org.personnel({ employeeId: worker.id, action: 'reinstate' });

    const latest = org.events(worker.id)[0]!;
    expect(latest.kind).toBe('reinstated');
    expect(latest.fromDepartmentId).toBeDefined();
    // No spurious `transferred` in between.
    expect(kinds(worker.id).filter((kind) => kind === 'transferred')).toHaveLength(0);
  });

  it('records placing someone from the talent pool as a move', () => {
    const { worker } = team();
    const other = org.createDepartment({ name: '市场部' });
    org.transfer(worker.id, other.id);
    const before = org.events(worker.id).length;

    // `place` is what the talent pool calls: not a reinstatement, just a move.
    org.place(worker.id, org.list()[0]!.id);

    expect(org.events(worker.id)).toHaveLength(before + 1);
    expect(org.events(worker.id)[0]?.kind).toBe('transferred');
  });

  it('records a promotion with the old level', () => {
    const { worker } = team();

    org.personnel({ employeeId: worker.id, action: 'promote', level: 'P6', title: '资深前端', reason: '年度评审' });

    const [event] = org.events(worker.id);
    expect(event?.kind).toBe('promoted');
    expect(event?.fromLevel).toBe('P5');
    expect(event?.toLevel).toBe('P6');
    expect(event?.fromTitle).toBe('前端工程师');
    expect(event?.toTitle).toBe('资深前端');
    expect(event?.reason).toBe('年度评审');
    expect(org.everyone().find((member) => member.id === worker.id)?.level).toBe('P6');
  });

  it('does not record a promotion that changes nothing', () => {
    const { worker } = team();
    const before = org.events(worker.id).length;

    org.personnel({ employeeId: worker.id, action: 'promote', level: 'P5' });

    expect(org.events(worker.id)).toHaveLength(before);
  });

  it('records both halves of a head change', () => {
    const { department, boss, worker } = team();

    org.appointHead(department.id, worker.id);

    const node = org.list().find((entry) => entry.id === department.id)!;
    expect(node.headEmployeeId).toBe(worker.id);
    expect(org.events(worker.id)[0]?.kind).toBe('head_appointed');
    expect(org.events(boss.id)[0]?.kind).toBe('head_removed');

    // And clearing it leaves the department headless, still on the record.
    org.appointHead(department.id, null);
    expect(org.list().find((entry) => entry.id === department.id)?.headEmployeeId).toBeUndefined();
    expect(org.events(worker.id)[0]?.kind).toBe('head_removed');
  });

  it('refuses to appoint someone who is not seated in that department', () => {
    const { worker } = team();
    const other = org.createDepartment({ name: '市场部' });

    expect(() => org.appointHead(other.id, worker.id)).toThrow(/必须在该部门在岗/);
  });

  it('keeps events after the employee leaves, as an audit trail', () => {
    const { worker } = team();
    org.personnel({ employeeId: worker.id, action: 'terminate' });

    // The seat is gone, the employee row is terminated, but the history is not.
    expect(org.events(worker.id).length).toBeGreaterThanOrEqual(2);
    expect(org.everyone().find((member) => member.id === worker.id)?.status).toBe('terminated');
  });
});

/** Probation: a date on the employee row, and a confirmation that closes it. */
describe('probation', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('stores the end date from the hire, and no date when there is no probation', () => {
    const department = org.createDepartment({ name: '工程部' });
    const temp = org.hire({ name: '甲', role: '工程师', departmentId: department.id, probationDays: 90 });
    const permanent = org.hire({ name: '乙', role: '工程师', departmentId: department.id });

    expect(temp.probationEndsAt).toBeDefined();
    // ~90 days ahead: the exact millisecond is the hire's clock, not a fixed constant.
    expect(temp.probationEndsAt! - temp.hiredAt).toBe(90 * DAY);
    expect(permanent.probationEndsAt).toBeUndefined();
  });

  it('rejects a negative probation length instead of silently treating it as none', () => {
    const department = org.createDepartment({ name: '工程部' });
    expect(() =>
      org.hire({ name: '甲', role: '工程师', departmentId: department.id, probationDays: -1 }),
    ).toThrow('试用期天数不合法');
  });

  it('clears the date on confirmation and records the event', () => {
    const department = org.createDepartment({ name: '工程部' });
    const temp = org.hire({ name: '甲', role: '工程师', departmentId: department.id, probationDays: 30 });

    org.personnel({ employeeId: temp.id, action: 'confirm' });

    const after = org.everyone().find((member) => member.id === temp.id)!;
    expect(after.probationEndsAt).toBeUndefined();
    const [event] = org.events(temp.id);
    expect(event?.kind).toBe('confirmed');
    expect(event?.reason).toContain('试用期至');
  });

  it('refuses to confirm someone who already left', () => {
    const department = org.createDepartment({ name: '工程部' });
    const temp = org.hire({ name: '甲', role: '工程师', departmentId: department.id, probationDays: 30 });
    org.fire(temp.id);

    expect(() => org.personnel({ employeeId: temp.id, action: 'confirm' })).toThrow('该员工不在岗');
  });
});

/** Performance reviews: the evidence a promotion decision stands on. */
describe('evaluations', () => {
  it('records a review and reads it back newest first', () => {
    const { worker } = team();

    org.addEvaluation({ employeeId: worker.id, kind: 'probation', scoreOverall: 4, summary: '上手很快' });
    org.addEvaluation({
      employeeId: worker.id,
      kind: 'periodic',
      periodKey: '2026-Q3',
      scoreOverall: 4.5,
      scoreQuality: 5,
      scoreSpeed: 4,
      scoreCost: 3,
      summary: '交付稳定，成本略高',
    });

    const rows = org.evaluations(worker.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe('periodic');
    expect(rows[0]?.periodKey).toBe('2026-Q3');
    expect(rows[0]?.scoreQuality).toBe(5);
    expect(rows[0]?.scoreCost).toBe(3);
    expect(rows[1]?.kind).toBe('probation');
    // Unset dimensions stay absent rather than becoming 0, which would read as "scored 0".
    expect(rows[1]?.scoreQuality).toBeUndefined();
  });

  it('refuses a score outside 1–5 with a readable message', () => {
    const { worker } = team();

    expect(() => org.addEvaluation({ employeeId: worker.id, scoreOverall: 0 })).toThrow('总评分必须在 1–5 之间');
    expect(() => org.addEvaluation({ employeeId: worker.id, scoreOverall: 6 })).toThrow('总评分必须在 1–5 之间');
    expect(() =>
      org.addEvaluation({ employeeId: worker.id, scoreOverall: 4, scoreQuality: 9 }),
    ).toThrow('质量评分必须在 1–5 之间');
    expect(org.evaluations(worker.id)).toHaveLength(0);
  });

  it('reviews someone who has left (exit interview), not just active staff', () => {
    const { worker } = team();
    org.fire(worker.id);

    org.addEvaluation({ employeeId: worker.id, kind: 'exit', scoreOverall: 3, summary: '交接完整' });

    expect(org.evaluations(worker.id)).toHaveLength(1);
  });
});

/** The acting head covers a seat; it is deliberately not the head seat. */
describe('acting head', () => {
  it('covers a vacant seat without becoming the head', () => {
    const { department, worker } = team();
    org.appointHead(department.id, null);

    org.appointActingHead(department.id, worker.id);

    const node = org.list().find((entry) => entry.id === department.id)!;
    expect(node.headEmployeeId).toBeUndefined();
    expect(node.actingHeadEmployeeId).toBe(worker.id);
    expect(node.members.find((member) => member.id === worker.id)?.isHead).toBe(false);
    expect(node.members.find((member) => member.id === worker.id)?.isActingHead).toBe(true);
  });

  it('steps aside when a formal head is appointed', () => {
    const { department, boss, worker } = team();
    // A vacant seat: the acting head covers it until someone is appointed.
    org.appointHead(department.id, null);
    org.appointActingHead(department.id, worker.id);

    org.appointHead(department.id, boss.id);

    const node = org.list().find((entry) => entry.id === department.id)!;
    expect(node.headEmployeeId).toBe(boss.id);
    expect(node.actingHeadEmployeeId).toBeUndefined();
  });

  it('can cover a head who is away, without replacing them', () => {
    const { department, boss, worker } = team();

    // The head is on leave, not removed: both flags are live, and `is_head` still
    // decides who is formally accountable.
    org.appointActingHead(department.id, worker.id);

    const node = org.list().find((entry) => entry.id === department.id)!;
    expect(node.headEmployeeId).toBe(boss.id);
    expect(node.actingHeadEmployeeId).toBe(worker.id);
  });

  it('refuses the head themselves and anyone outside the department', () => {
    const { department, boss, worker } = team();
    const other = org.createDepartment({ name: '市场部' });

    expect(() => org.appointActingHead(department.id, boss.id)).toThrow('负责人本人不需要再设为代理负责人');
    expect(() => org.appointActingHead(other.id, worker.id)).toThrow(/必须在该部门在岗/);
  });

  it('survives a re-seat inside the same department', () => {
    const { department, worker } = team();
    org.appointActingHead(department.id, worker.id);

    org.transfer(worker.id, department.id);

    expect(org.list().find((entry) => entry.id === department.id)?.actingHeadEmployeeId).toBe(worker.id);
  });

  it('ends when the acting head leaves the company', () => {
    const { department, worker } = team();
    org.appointActingHead(department.id, worker.id);

    org.fire(worker.id);

    expect(org.list().find((entry) => entry.id === department.id)?.actingHeadEmployeeId).toBeUndefined();
  });
});


describe('employee model & tool policy', () => {
  it('updates the charter in place and rejects an unknown employee', () => {
    const { worker } = team();

    org.setPersona(worker.id, '先给结论，再给证据。');

    expect(org.everyone().find((entry) => entry.id === worker.id)?.persona).toBe('先给结论，再给证据。');
    org.setPersona(worker.id, '');
    expect(org.everyone().find((entry) => entry.id === worker.id)?.persona).toBe('');
    expect(() => org.setPersona('agent-missing', 'x')).toThrow('员工不存在');
  });

  it('persists the model picked during hiring', () => {
    const { department } = team();

    const hired = org.hire({
      name: '新同事',
      role: '工程师',
      departmentId: department.id,
      model: 'Claude Sonnet 4.5',
      modelRef: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
    });

    expect(hired.modelRef).toEqual({ providerId: 'anthropic', modelId: 'claude-sonnet-4-5' });
    expect(hired.model).toBe('Claude Sonnet 4.5');
    expect(org.modelRefOf(hired.id)).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    });
  });

  it('defaults to inheriting the company model when hiring without a ref', () => {
    const { department } = team();

    const hired = org.hire({ name: '乙', role: '工程师', departmentId: department.id });

    expect(hired.modelRef).toBeUndefined();
    expect(org.modelRefOf(hired.id)).toBeUndefined();
  });

  it('stores a structured model ref and keeps the display label in step', () => {
    const { worker } = team();

    org.setStack(worker.id, {
      model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
      modelLabel: 'Claude Sonnet 4.5',
    });

    const member = org.everyone().find((entry) => entry.id === worker.id)!;
    expect(member.modelRef).toEqual({ providerId: 'anthropic', modelId: 'claude-sonnet-4-5' });
    expect(member.model).toBe('Claude Sonnet 4.5');
    expect(org.modelRefOf(worker.id)).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    });
  });

  it('clears the override back to "inherit the company default"', () => {
    const { worker } = team();
    org.setStack(worker.id, {
      model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
      modelLabel: 'Claude Sonnet 4.5',
    });

    org.setStack(worker.id, { model: null });

    expect(org.modelRefOf(worker.id)).toBeUndefined();
    expect(org.everyone().find((entry) => entry.id === worker.id)?.model).toBe('');
  });

  it('normalizes a tool policy on write and degrades bad JSON on read', () => {
    const { worker } = team();
    org.setStack(worker.id, {
      policy: {
        disabledExtensions: ['opc.image', 'opc.image'],
        disabledTools: ['bash', ''],
      },
    });

    expect(org.toolPolicyOf(worker.id)).toEqual({
      disabledExtensions: ['opc.image'],
      disabledTools: ['bash'],
    });

    db.prepare('UPDATE employee SET tool_policy = ? WHERE id = ?').run('{broken', worker.id);
    expect(org.toolPolicyOf(worker.id)).toEqual({ disabledExtensions: [], disabledTools: [] });
  });
});
