import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppPaths } from '../env';
import { OrgService } from '../org/orgService';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { WorkService } from './workService';

/**
 * The 「技能与工具」 page must describe the runtime, not a hand-written list.
 * These tests pin the contract: capabilities are read from the same registry the
 * worker installs, so a conditional extension appears exactly when it is usable.
 */
let dir: string;
let db: CompanyDatabase;
let paths: AppPaths;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-capabilities-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  paths = {
    userData: dir,
    database: path.join(dir, 'company.db'),
    agentsDir: path.join(dir, 'agents'),
    artifactsDir: path.join(dir, 'artifacts'),
    workspaceDir: path.join(dir, 'workspace'),
    logsDir: path.join(dir, 'logs'),
    probeDir: path.join(dir, 'probe'),
    cacheDir: path.join(dir, 'cache'),
  };
  for (const target of [paths.agentsDir, paths.artifactsDir, paths.workspaceDir, paths.logsDir]) {
    mkdirSync(target, { recursive: true });
  }
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function workWith(org: OrgService): WorkService {
  return new WorkService({
    db,
    paths,
    agents: [],
    upsertTaskCard: () => undefined,
    org,
  });
}

describe('WorkService.capabilities', () => {
  it('lists the base extensions and coding tools every agent really gets', async () => {
    const org = new OrgService(db);
    const department = org.createDepartment({ name: '工程部', code: 'EN-01' });
    const employee = org.hire({
      name: '林澈',
      role: '前端工程师',
      departmentId: department.id,
      skills: ['React', '可访问性'],
    });

    const catalog = await workWith(org).capabilities();
    const agent = catalog.agents.find((entry) => entry.employeeId === employee.id)!;

    expect(agent.extensions.map((extension) => extension.name)).toEqual([
      'opc.work',
      'coding-tools',
      'opc.sandbox',
      'opc.limits',
    ]);
    expect(agent.tools.map((tool) => tool.name).sort()).toEqual(['bash', 'edit', 'read', 'write']);
    // Skills are archive tags, returned beside the runtime facts, never as tools.
    expect(agent.skills).toEqual(['React', '可访问性']);
    expect(agent.departmentName).toBe('工程部');
  });

  it('installs decomposition only for someone with reports', async () => {
    const org = new OrgService(db);
    const department = org.createDepartment({ name: '工程部', code: 'EN-01' });
    const manager = org.hire({
      name: '沈聿',
      role: '技术负责人',
      departmentId: department.id,
      isHead: true,
    });
    const report = org.hire({
      name: '林澈',
      role: '前端工程师',
      departmentId: department.id,
      reportsToEmployeeId: manager.id,
    });

    const catalog = await workWith(org).capabilities();
    const find = (id: string) => catalog.agents.find((entry) => entry.employeeId === id)!;

    expect(find(manager.id).extensions.map((extension) => extension.name)).toContain(
      'opc.decompose',
    );
    expect(find(manager.id).tools.map((tool) => tool.name)).toContain('decompose_task');
    expect(find(report.id).extensions.map((extension) => extension.name)).not.toContain(
      'opc.decompose',
    );
  });

  it('leaves out speech and image tools while no provider is configured', async () => {
    const org = new OrgService(db);
    const department = org.createDepartment({ name: '设计部', code: 'DE-01' });
    org.hire({ name: '苏晚', role: '视觉设计师', departmentId: department.id });

    const catalog = await workWith(org).capabilities();
    const names = catalog.agents.flatMap((agent) => agent.tools.map((tool) => tool.name));

    expect(names).not.toContain('generate_image');
    expect(names).not.toContain('transcribe_audio');
    expect(names).not.toContain('text_to_speech');
  });
});
