import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppPaths } from '../env';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { ThreadRepository } from '../data/threadRepository';
import { OrgService } from '../org/orgService';
import { WorkService } from './workService';

/**
 * The join between the two halves: a real task, run through the real durable
 * runner and the real acceptance command, speaking to a real thread.
 *
 * `threadOutcome.test.ts` pins the mapping; this pins that the mapping is actually
 * reached — that a task carrying a `threadId` leaves a report behind and moves its
 * line of work, without anyone wiring it by hand.
 *
 * No model is involved: `scriptedBrain` writes a working HTTP server and the
 * acceptance gate really starts it (that path is what `--self-test` uses too).
 */
let dir: string;
let db: CompanyDatabase;
let paths: AppPaths;
let org: OrgService;
let work: WorkService;
let threads: ThreadRepository;
let assigneeId: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-thread-report-'));
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

  org = new OrgService(db);
  const department = org.createDepartment({ name: '工程部', code: 'EN-01' });
  assigneeId = org.hire({
    name: '李雷',
    role: '全栈工程师',
    departmentId: department.id,
    skills: ['Node.js'],
  }).id;

  work = new WorkService({
    db,
    paths,
    agents: [],
    upsertTaskCard: () => undefined,
    org,
  });
  threads = new ThreadRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function runOne(overrides: { threadId?: string } = {}) {
  const thread = threads.createThread({ title: '写一个返回 ok 的服务' });
  const created = work.createTask({
    title: '写一个返回 ok 的服务',
    brief: '用 node 内置 http',
    deliverableSpec: 'server.js 返回 ok',
    assigneeId,
    estTokens: 5_000,
    acceptanceCommand: ['node', '{checks}/verify.mjs'],
    acceptanceTemplate: 'http-ok',
    ...(overrides.threadId === undefined ? { threadId: thread.id } : { threadId: overrides.threadId }),
  });
  if (!created.ok) throw new Error(created.error.message);
  const final = await work.runTaskAndWait(created.task.id);
  return { thread, task: final };
}

describe('task → thread reporting', () => {
  it('closes the line of work quietly when the work passes acceptance', async () => {
    const { thread, task } = await runOne();

    expect(task.status).toBe('accepted');
    const updated = threads.getThread(thread.id);
    expect(updated?.state).toBe('done');
    expect(updated?.spentTokens).toBeGreaterThanOrEqual(0);

    // Recorded, but not in the boss's face: the queue stays empty.
    expect(threads.listQueue()).toHaveLength(0);
  });

  it('carries the thread on the task, so the work line owns the work', async () => {
    const { thread, task } = await runOne();
    expect(task.threadId).toBe(thread.id);
    expect(task.workerId).toBeDefined();
  });
});
