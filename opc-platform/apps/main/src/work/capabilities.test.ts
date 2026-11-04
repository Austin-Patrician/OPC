import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppPaths } from '../env';
import { ThreadRepository } from '../data/threadRepository';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import type { DecisionService } from '../models/decisionService';
import type { OcrEngine } from '../ocr/service';
import { WorkService } from './workService';

/**
 * The 「技能与工具」 page must describe the runtime, not a hand-written list.
 * These tests pin the contract: capabilities are read from the same registry the
 * executor installs, so a conditional extension appears exactly when it is usable.
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

/**
 * 一个执行体。工具策略属于它自己（§2.2），所以这些用例按 worker 查，
 * 不再按"某个员工"查——现在按执行体查。
 */
function executor(input: { name?: string; template?: 'research' | 'code' | 'ops'; skills?: string[] } = {}): string {
  const threads = new ThreadRepository(db);
  const thread = threads.createThread({ title: '测试', goal: '测试' });
  return threads.createWorker({
    name: input.name ?? '执行体',
    ...(input.template ? { template: input.template } : {}),
    ...(input.skills ? { skills: input.skills } : {}),
    threadId: thread.id,
  }).id;
}

function workWith(ocr?: OcrEngine, decisions?: DecisionService): WorkService {
  return new WorkService({
    db,
    paths,
    upsertTaskCard: () => undefined,
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
  it('lists the base extensions and coding tools every executor really gets', async () => {
    const workerId = executor({ name: '林澈', template: 'code', skills: ['React', '可访问性'] });

    const catalog = await workWith().capabilities();
    const agent = catalog.agents.find((entry) => entry.workerId === workerId)!;

    expect(agent.extensions.map((extension) => extension.name)).toEqual([
      'opc.work',
      // 动作流：所有工具调用的旁听者（`opc.trace`），不该由哪个工具自己负责。
      'opc.trace',
      'coding-tools',
      'opc.sandbox',
      'opc.limits',
      'opc.recall',
      'opc.escalate',
      'opc.handback',
    ]);
    // 三个「嘴」之外的执行体能力：`recall` 回源头（§3.3），`escalate` 请示、
    // `hand_back` 交回（§2.2 / §3.2）——它们以前都不在，执行体卡住时只能猜或失败。
    expect(agent.tools.map((tool) => tool.name).sort()).toEqual([
      'bash',
      'edit',
      'escalate',
      'hand_back',
      'read',
      'recall',
      'write',
    ]);
    // Skills are worker attributes, returned beside the runtime facts, never as tools.
    expect(agent.skills).toEqual(['React', '可访问性']);
    expect(agent.template).toBe('code');
    expect(agent.status).toBe('idle');
  });

  it('installs decomposition for every executor once another one exists', async () => {
    const first = executor({ name: '沈聿', template: 'research' });
    const second = executor({ name: '林澈', template: 'code' });

    const catalog = await workWith().capabilities();
    const find = (id: string) => catalog.agents.find((entry) => entry.workerId === id)!;

    // 谁都可以把活交给别人：这里已经没有汇报线了，只有"还有没有别的执行体"。
    expect(find(first).extensions.map((extension) => extension.name)).toContain('opc.decompose');
    expect(find(first).tools.map((tool) => tool.name)).toContain('decompose_task');
    expect(find(second).extensions.map((extension) => extension.name)).toContain('opc.decompose');
  });

  it('leaves out speech and image tools while no provider is configured', async () => {
    const workerId = executor({ name: '苏晚', template: 'research' });

    const catalog = await workWith().capabilities();
    const agent = catalog.agents.find((entry) => entry.workerId === workerId)!;
    const names = catalog.agents.flatMap((entry) => entry.tools.map((tool) => tool.name));

    expect(agent).toBeDefined();
    expect(names).not.toContain('generate_image');
    expect(names).not.toContain('transcribe_audio');
    expect(names).not.toContain('text_to_speech');
    expect(names).not.toContain('decide');
  });

  it('installs decide only while a decision model is configured', async () => {
    const workerId = executor({ name: '顾南', template: 'research' });

    const on = await workWith(undefined, fakeDecisions(true)).capabilities();
    const withDecision = on.agents.find((entry) => entry.workerId === workerId)!;
    expect(withDecision.tools.map((tool) => tool.name)).toContain('decide');
    expect(withDecision.extensions.map((extension) => extension.name)).toContain('opc.decision');

    // 它是个普通可选扩展：你可以按**执行体**关掉它（§2.2 工具集是执行体自己的）。
    const managed = workWith(undefined, fakeDecisions(true));
    await managed.setStack(workerId, {
      policy: { disabledExtensions: ['opc.decision'], disabledTools: [] },
    });
    const hidden = await managed.stack(workerId);
    const decision = hidden.extensions.find((extension) => extension.name === 'opc.decision')!;
    expect(decision.enabled).toBe(false);

    // Without a keyed, enabled classifier the tool is absent and the stack page
    // says why, rather than offering a tool whose first call can only fail.
    const work = workWith(undefined, fakeDecisions(false));
    const off = await work.capabilities();
    expect(off.agents.find((entry) => entry.workerId === workerId)!.tools.map((tool) => tool.name)).not.toContain(
      'decide',
    );

    const stack = await work.stack(workerId);
    expect(stack.extensions.find((extension) => extension.name === 'opc.decision')).toMatchObject({
      available: false,
      reason: 'no-decision-model',
    });
  });

  it('installs ocr_image only when it is switched on and the models are on disk', async () => {
    const workerId = executor({ name: '苏晚', template: 'research' });

    // Two independent gates from 设置 → 运行时: the your switch and the models
    // actually being there. Both must be true or the tool cannot work once.
    const fake = (enabled: boolean, assetsReady: boolean) =>
      ({
        recognize: async () => ({ text: '', lines: [], confidence: 0 }),
        dispose: async () => undefined,
        assetsReady: () => assetsReady,
        settings: () => ({ enabled, detail: 'text' }),
      }) as unknown as OcrEngine;

    const on = await workWith(fake(true, true)).capabilities();
    const withOcr = on.agents.find((entry) => entry.workerId === workerId)!;
    expect(withOcr.tools.map((tool) => tool.name)).toContain('ocr_image');
    expect(withOcr.extensions.map((extension) => extension.name)).toContain('opc.ocr');

    // Switched off, or models missing: the catalog must say "not installed"
    // rather than claim a tool whose first call would fail.
    for (const catalog of [
      await workWith(fake(false, true)).capabilities(),
      await workWith(fake(true, false)).capabilities(),
    ]) {
      const agent = catalog.agents.find((entry) => entry.workerId === workerId)!;
      expect(agent.tools.map((tool) => tool.name)).not.toContain('ocr_image');
      expect(agent.extensions.map((extension) => extension.name)).not.toContain('opc.ocr');
    }
  });
});

describe('WorkService.stack', () => {
  it('describes every tool group with an availability reason, not just the installed ones', async () => {
    const stack = await workWith().stack(executor({ name: '独苗' }));
    const byName = new Map(stack.extensions.map((extension) => [extension.name, extension]));

    expect(stack.model).toBeNull();
    expect(byName.get('coding-tools')).toMatchObject({ essential: true, available: true, enabled: true });
    expect(byName.get('coding-tools')?.tools.map((tool) => tool.name).sort()).toEqual([
      'bash',
      'edit',
      'read',
      'write',
    ]);
    // No image/speech provider and no other executor in this company.
    expect(byName.get('opc.image')).toMatchObject({ available: false, reason: 'no-image-provider' });
    expect(byName.get('opc.speech')).toMatchObject({ available: false, reason: 'no-speech-model' });
    expect(byName.get('opc.decision')).toMatchObject({
      available: false,
      reason: 'no-decision-model',
    });
    expect(byName.get('opc.decompose')).toMatchObject({
      available: false,
      reason: 'sole-executor',
    });
  });

  it('removes a disabled tool from the registry the next task would get', async () => {
    const work = workWith();
    const workerId = executor();

    await work.setStack(workerId, {
      policy: { disabledExtensions: [], disabledTools: ['bash'] },
    });

    const after = await work.stack(workerId);
    const coding = after.extensions.find((extension) => extension.name === 'coding-tools')!;
    expect(coding.tools.filter((tool) => tool.enabled).map((tool) => tool.name).sort()).toEqual([
      'edit',
      'read',
      'write',
    ]);
  });

  it('refuses to switch off a core extension', async () => {
    const workerId = executor();

    await expect(
      workWith().setStack(workerId, {
        policy: { disabledExtensions: ['coding-tools'], disabledTools: [] },
      }),
    ).rejects.toThrow(/核心扩展/);
  });
});
