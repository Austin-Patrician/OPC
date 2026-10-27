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
