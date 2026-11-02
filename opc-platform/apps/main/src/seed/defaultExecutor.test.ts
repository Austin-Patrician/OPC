import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { OrgService } from '../org/orgService';
import { pickWorker } from '../work/workerPool';
import { agentsFromOrg } from './firstCompany';
import { ensureDefaultExecutor } from './defaultExecutor';

/**
 * 全新安装要能直接干活。
 *
 * 界面上已经没有招聘和组织架构了，如果这里不建人，老板丢第一个目标时只会得到
 * 「没有可用的执行者」。所以：一个人，不是六个人的演示公司。
 */
let dir: string;
let db: CompanyDatabase;
let org: OrgService;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-executor-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  org = new OrgService(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ensureDefaultExecutor', () => {
  it('gives a fresh install exactly one person to do the work', () => {
    const result = ensureDefaultExecutor(org);

    expect(result.created).toBe(true);
    const people = agentsFromOrg(org);
    expect(people).toHaveLength(1);
    expect(people[0]?.name).toBe('小助手');
    expect(result.employeeId).toBe(people[0]?.id);
  });

  it('leaves an existing roster alone', () => {
    ensureDefaultExecutor(org);
    const first = agentsFromOrg(org)[0]!;

    const again = ensureDefaultExecutor(org);
    expect(again.created).toBe(false);
    expect(again.employeeId).toBe(first.id);
    expect(agentsFromOrg(org)).toHaveLength(1);
  });

  it('can take any kind of work the router sends it', () => {
    ensureDefaultExecutor(org);
    const people = agentsFromOrg(org).map((agent) => ({
      employeeId: agent.id,
      name: agent.name,
      skills: agent.skills ?? [],
    }));

    // One person must be pickable for every template — otherwise a fresh install
    // silently loses the work it was just asked to do.
    for (const template of ['code', 'research', 'ops'] as const) {
      expect(pickWorker(people, template)?.employeeId).toBe(people[0]?.employeeId);
    }
  });
});
