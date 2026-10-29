import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppPaths } from '../env';
import { OrgService } from '../org/orgService';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import type { DecisionService } from '../models/decisionService';
import type { OcrEngine } from '../ocr/service';
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

function workWith(org: OrgService, ocr?: OcrEngine, decisions?: DecisionService): WorkService {
  return new WorkService({
    db,
    paths,
    agents: [],
    upsertTaskCard: () => undefined,
    org,
    ...(ocr ? { ocr } : {}),
    ...(decisions ? { decisions } : {}),
  });
}

/** Only `isAvailable` + `classify` are used by the tool slot. */
function fakeDecisions(available: boolean): DecisionService {
  return {
    isAvailable: () => available,
    classify: async () => ({ ok: true, answers: {} }),
  } as unknown as DecisionService;
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
    expect(names).not.toContain('decide');
  });

  it('installs decide only while a decision model is configured', async () => {
    const org = new OrgService(db);
    const department = org.createDepartment({ name: '运营部', code: 'OP-01' });
    const employee = org.hire({ name: '顾南', role: '内容运营', departmentId: department.id });

    const on = await workWith(org, undefined, fakeDecisions(true)).capabilities();
    expect(on.agents[0]?.tools.map((tool) => tool.name)).toContain('decide');
    expect(on.agents[0]?.extensions.map((extension) => extension.name)).toContain('opc.decision');

    // It is a normal optional extension: the boss can switch it off per employee.
    const managed = workWith(org, undefined, fakeDecisions(true));
    await managed.setStack(employee.id, {
      policy: { disabledExtensions: ['opc.decision'], disabledTools: [] },
    });
    const hidden = await managed.capabilities();
    expect(hidden.agents[0]?.tools.map((tool) => tool.name)).not.toContain('decide');

    // Without a keyed, enabled classifier the tool is absent and the stack page
    // says why, rather than offering a tool whose first call can only fail.
    const work = workWith(org, undefined, fakeDecisions(false));
    const off = await work.capabilities();
    expect(off.agents[0]?.tools.map((tool) => tool.name)).not.toContain('decide');

    const stack = await work.stack(employee.id);
    expect(stack.extensions.find((extension) => extension.name === 'opc.decision')).toMatchObject({
      available: false,
      reason: 'no-decision-model',
    });
  });

  it('installs ocr_image only when it is switched on and the models are on disk', async () => {
    const org = new OrgService(db);
    const department = org.createDepartment({ name: '设计部', code: 'DE-01' });
    org.hire({ name: '苏晚', role: '视觉设计师', departmentId: department.id });

    // Two independent gates from 设置 → 运行时: the boss's switch and the models
    // actually being there. Both must be true or the tool cannot work once.
    const fake = (enabled: boolean, assetsReady: boolean) =>
      ({
        recognize: async () => ({ text: '', lines: [], confidence: 0 }),
        dispose: async () => undefined,
        assetsReady: () => assetsReady,
        settings: () => ({ enabled, detail: 'text' }),
      }) as unknown as OcrEngine;

    const on = await workWith(org, fake(true, true)).capabilities();
    expect(on.agents[0]?.tools.map((tool) => tool.name)).toContain('ocr_image');
    expect(on.agents[0]?.extensions.map((extension) => extension.name)).toContain('opc.ocr');

    // Switched off, or models missing: the catalog must say "not installed"
    // rather than claim a tool whose first call would fail.
    for (const catalog of [
      await workWith(org, fake(false, true)).capabilities(),
      await workWith(org, fake(true, false)).capabilities(),
    ]) {
      expect(catalog.agents[0]?.tools.map((tool) => tool.name)).not.toContain('ocr_image');
      expect(catalog.agents[0]?.extensions.map((extension) => extension.name)).not.toContain(
        'opc.ocr',
      );
    }
  });
});

describe('WorkService.stack', () => {
  it('describes every tool group with an availability reason, not just the installed ones', async () => {
    const org = new OrgService(db);
    const department = org.createDepartment({ name: '工程部', code: 'EN-01' });
    const employee = org.hire({ name: '林澈', role: '前端工程师', departmentId: department.id });

    const stack = await workWith(org).stack(employee.id);
    const byName = new Map(stack.extensions.map((extension) => [extension.name, extension]));

    expect(stack.model).toBeNull();
    expect(byName.get('coding-tools')).toMatchObject({ essential: true, available: true, enabled: true });
    expect(byName.get('coding-tools')?.tools.map((tool) => tool.name).sort()).toEqual([
      'bash',
      'edit',
      'read',
      'write',
    ]);
    // No image/speech provider and no reports in this company.
    expect(byName.get('opc.image')).toMatchObject({ available: false, reason: 'no-image-provider' });
    expect(byName.get('opc.speech')).toMatchObject({ available: false, reason: 'no-speech-model' });
    expect(byName.get('opc.decision')).toMatchObject({
      available: false,
      reason: 'no-decision-model',
    });
    expect(byName.get('opc.decompose')).toMatchObject({
      available: false,
      reason: 'no-subordinates',
    });
  });

  it('removes a disabled tool from the registry the next task would get', async () => {
    const org = new OrgService(db);
    const department = org.createDepartment({ name: '工程部', code: 'EN-01' });
    const employee = org.hire({ name: '林澈', role: '前端工程师', departmentId: department.id });
    const work = workWith(org);

    await work.setStack(employee.id, {
      policy: { disabledExtensions: [], disabledTools: ['bash'] },
    });

    const catalog = await work.capabilities();
    const agent = catalog.agents.find((entry) => entry.employeeId === employee.id)!;
    expect(agent.tools.map((tool) => tool.name).sort()).toEqual(['edit', 'read', 'write']);
  });

  it('refuses to switch off a core extension', async () => {
    const org = new OrgService(db);
    const department = org.createDepartment({ name: '工程部', code: 'EN-01' });
    const employee = org.hire({ name: '林澈', role: '前端工程师', departmentId: department.id });

    await expect(
      workWith(org).setStack(employee.id, {
        policy: { disabledExtensions: ['coding-tools'], disabledTools: [] },
      }),
    ).rejects.toThrow(/核心扩展/);
  });
});
