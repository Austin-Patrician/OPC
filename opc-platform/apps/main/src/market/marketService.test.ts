import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompanyDatabase } from '../data/companyDatabase';
import { openCompanyDatabase } from '../data/companyDatabase';
import { OrgService } from '../org/orgService';
import { MarketService, PACKAGE_FORMAT, parseAgentPackage } from './marketService';

describe('agent package parsing', () => {
  it('accepts the documented envelope', () => {
    const { agents } = parseAgentPackage(
      JSON.stringify({
        format: PACKAGE_FORMAT,
        name: 'team-pack',
        agents: [{ name: '林工', role: '前端工程师', skills: ['React'], level: 'P6' }],
      }),
    );
    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe('林工');
  });

  it('treats a bare agent object as a one-agent package', () => {
    const { agents } = parseAgentPackage(JSON.stringify({ name: '单兵', role: '研究员' }));
    expect(agents).toHaveLength(1);
  });

  it('drops agents without a name or role', () => {
    const { agents } = parseAgentPackage(
      JSON.stringify({ format: PACKAGE_FORMAT, agents: [{ name: 'A' }, { name: 'B', role: 'QA' }] }),
    );
    expect(agents.map((agent) => agent.name)).toEqual(['B']);
  });

  it('rejects an unknown format', () => {
    expect(() => parseAgentPackage(JSON.stringify({ format: 'other@9', agents: [] }))).toThrow(/不支持的包格式/);
  });

  it('rejects an empty package and invalid JSON', () => {
    expect(() => parseAgentPackage(JSON.stringify({ agents: [] }))).toThrow(/没有可用的 Agent/);
    expect(() => parseAgentPackage('{nope')).toThrow(/不是合法的 JSON/);
  });
});

/**
 * Recruitment: the trial run and the exported package.
 *
 * Both exist to answer questions the market table alone cannot: "is this candidate
 * actually good at the job, and at what cost" and "can I get this person out of this
 * installation intact".
 */

let dir: string;
let db: CompanyDatabase;
let org: OrgService;
let market: MarketService;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-market-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  org = new OrgService(db);
  market = new MarketService(db, org);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function candidate(overrides: Record<string, unknown> = {}) {
  const [imported] = market.importJson(
    JSON.stringify({
      format: 'opc-agent-package@1',
      name: '外部候选人',
      agents: [
        {
          name: '周航',
          role: '前端工程师',
          level: 'P6',
          skills: ['React', 'TypeScript'],
          persona: '先给可运行的例子，再解释。',
          ...overrides,
        },
      ],
    }),
    'test.json',
  );
  return imported!;
}

describe('trial run (interview)', () => {
  it('records a run with its cost and duration', async () => {
    const person = candidate();
    market.runTrial = async ({ prompt }) => ({
      text: `产出：${prompt.slice(0, 4)}…`,
      tokens: 1234,
      costUsd: 0.0123,
    });

    const [created] = market.interviews(person.id);
    expect(created).toBeUndefined();

    const interview = market.createInterview(person.id, '把这个页面的加载时间降到 1s 内');
    expect(interview.status).toBe('pending');

    const done = await market.runInterview(interview.id);
    expect(done.status).toBe('done');
    expect(done.result).toContain('产出：');
    expect(done.tokensUsed).toBe(1234);
    expect(done.costUsd).toBeCloseTo(0.0123);
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
    expect(done.finishedAt).toBeDefined();
  });

  it('keeps a failed run as a row instead of throwing it away', async () => {
    const person = candidate();
    market.runTrial = async () => {
      throw new Error('模型超时');
    };

    const interview = market.createInterview(person.id, '修一个 bug');
    const failed = await market.runInterview(interview.id);

    // "This candidate's trial blew up" is exactly the information the boss needs.
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('模型超时');
    expect(market.interviews(person.id)).toHaveLength(1);
  });

  it('refuses to run without a model, and says why', async () => {
    const person = candidate();
    const interview = market.createInterview(person.id, '写个接口');

    expect(market.runTrial).toBeUndefined();
    await expect(market.runInterview(interview.id)).rejects.toThrow('没有可用的模型，无法试跑');
    // The record stays pending, so it can be run once a provider is configured.
    expect(market.interviews(person.id)[0]?.status).toBe('pending');
  });

  it('refuses to run the same trial twice', async () => {
    const person = candidate();
    market.runTrial = async () => ({ text: 'ok', tokens: 1, costUsd: 0 });
    const interview = market.createInterview(person.id, '任务');
    await market.runInterview(interview.id);

    await expect(market.runInterview(interview.id)).rejects.toThrow('已经跑完');
  });

  it('refuses an empty task', () => {
    const person = candidate();
    expect(() => market.createInterview(person.id, '   ')).toThrow('试跑任务不能为空');
  });

  it('hires through the decision, and keeps the record after the candidate is gone', async () => {
    const department = org.createDepartment({ name: '工程部' });
    const person = candidate();
    market.runTrial = async () => ({ text: '做得不错', tokens: 900, costUsd: 0.01 });
    const interview = market.createInterview(person.id, '实现一个表格组件');
    await market.runInterview(interview.id);

    const { employeeId, interview: decided } = market.decideInterview({
      interviewId: interview.id,
      decision: 'hire',
      departmentId: department.id,
    });

    expect(employeeId).toBeDefined();
    expect(decided.decision).toBe('hire');
    // The candidate left the market…
    expect(market.list()).toHaveLength(0);
    // …but the interview still explains why they were hired.
    const kept = market.interviews().find((entry) => entry.id === interview.id)!;
    expect(kept.candidateName).toBe('周航');
    expect(kept.candidateId).toBeUndefined();
    expect(org.everyone().find((member) => member.id === employeeId)?.name).toBe('周航');
  });

  it('keeps a rejected candidate in the market', async () => {
    const person = candidate();
    market.runTrial = async () => ({ text: '答非所问', tokens: 10, costUsd: 0 });
    const interview = market.createInterview(person.id, '任务');
    await market.runInterview(interview.id);

    market.decideInterview({ interviewId: interview.id, decision: 'reject' });

    // "Not this role" is not "remove from the pool".
    expect(market.list()).toHaveLength(1);
    expect(market.interviews(person.id)[0]?.decision).toBe('reject');
  });

  it('refuses a decision before the run finished, or a second decision', async () => {
    const person = candidate();
    const interview = market.createInterview(person.id, '任务');

    expect(() =>
      market.decideInterview({ interviewId: interview.id, decision: 'reject' }),
    ).toThrow('试跑还没跑完');

    market.runTrial = async () => ({ text: 'ok', tokens: 1, costUsd: 0 });
    await market.runInterview(interview.id);
    market.decideInterview({ interviewId: interview.id, decision: 'reject' });

    expect(() =>
      market.decideInterview({ interviewId: interview.id, decision: 'reject' }),
    ).toThrow('已经决定过了');
  });

  it('requires a department to hire', async () => {
    const person = candidate();
    market.runTrial = async () => ({ text: 'ok', tokens: 1, costUsd: 0 });
    const interview = market.createInterview(person.id, '任务');
    await market.runInterview(interview.id);

    expect(() => market.decideInterview({ interviewId: interview.id, decision: 'hire' })).toThrow(
      '录用需要指定部门',
    );
  });
});

describe('employee package', () => {
  it('writes a file that the importer can read back', async () => {
    const department = org.createDepartment({ name: '工程部' });
    org.hire({
      name: '李雷',
      role: '全栈工程师',
      level: 'P6',
      departmentId: department.id,
      skills: ['Node.js', 'SQLite'],
      persona: '用最小依赖实现。',
    });

    const file = path.join(dir, 'team.json');
    const record = await market.exportPackage({
      kind: 'company',
      name: '全公司',
      filePath: file,
    });

    expect(record.members.map((member) => member.name)).toEqual(['李雷']);
    expect(record.members[0]?.department).toBe('工程部');
    expect(record.fileSize).toBeGreaterThan(0);
    expect(record.fileHash).toMatch(/^[a-f0-9]{64}$/);

    // The exported envelope is the same one the market imports.
    const raw = readFileSync(file, 'utf8');
    const parsed = parseAgentPackage(raw);
    expect(parsed.agents[0]).toMatchObject({
      name: '李雷',
      role: '全栈工程师',
      level: 'P6',
      skills: ['Node.js', 'SQLite'],
      persona: '用最小依赖实现。',
    });

    // And importing it actually creates a candidate.
    const imported = market.importJson(raw, 'team.json');
    expect(imported[0]?.name).toBe('李雷');
  });

  it('exports only the chosen employees', async () => {
    const department = org.createDepartment({ name: '工程部' });
    const kept = org.hire({ name: '甲', role: '工程师', departmentId: department.id });
    org.hire({ name: '乙', role: '工程师', departmentId: department.id });

    const record = await market.exportPackage({
      kind: 'employee',
      name: '只有甲',
      employeeIds: [kept.id],
      filePath: path.join(dir, 'one.json'),
    });

    expect(record.members.map((member) => member.name)).toEqual(['甲']);
  });

  it('refuses an empty selection and an empty name', async () => {
    const department = org.createDepartment({ name: '工程部' });
    org.hire({ name: '甲', role: '工程师', departmentId: department.id });

    await expect(
      market.exportPackage({ kind: 'employee', name: 'x', employeeIds: ['agent-ghost'], filePath: path.join(dir, 'x.json') }),
    ).rejects.toThrow('没有可导出的员工');

    await expect(
      market.exportPackage({ kind: 'company', name: '   ', filePath: path.join(dir, 'y.json') }),
    ).rejects.toThrow('包名不能为空');
  });

  it('detects a package whose file changed after export', async () => {
    const department = org.createDepartment({ name: '工程部' });
    org.hire({ name: '甲', role: '工程师', departmentId: department.id });
    const file = path.join(dir, 'pkg.json');
    const record = await market.exportPackage({ kind: 'company', name: '全公司', filePath: file });

    expect(await market.verifyPackage(record.id)).toEqual({ ok: true });

    writeFileSync(file, '{"format":"opc-agent-package@1","agents":[]}', 'utf8');
    const tampered = await market.verifyPackage(record.id);
    expect(tampered.ok).toBe(false);
    expect(tampered.reason).toBe('文件内容已改变');
  });

  it('reports a deleted file rather than throwing', async () => {
    const department = org.createDepartment({ name: '工程部' });
    org.hire({ name: '甲', role: '工程师', departmentId: department.id });
    const file = path.join(dir, 'gone.json');
    const record = await market.exportPackage({ kind: 'company', name: '全公司', filePath: file });

    rmSync(file);

    expect(await market.verifyPackage(record.id)).toEqual({ ok: false, reason: '文件已不存在' });
  });
});
