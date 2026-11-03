import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from './companyDatabase';
import { SCHEMA_VERSION } from './schema';
import { ThreadRepository } from './threadRepository';

/**
 * The v2 core tables against a real SQLite file (migration V25).
 *
 * These assert the things a router will depend on and that a unit test of SQL
 * strings would miss: that the CHECK constraints actually reject bad states,
 * that closing a thread stamps a time, and that the attention queue orders a
 * `decide` above a newer `notify`.
 */
let dir: string;
let db: CompanyDatabase;
let threads: ThreadRepository;
let tick = 1_700_000_000_000;
let seq = 0;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-thread-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  tick = 1_700_000_000_000;
  seq = 0;
  threads = new ThreadRepository(db, {
    now: () => (tick += 1_000),
    id: () => `id-${(seq += 1)}`,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('thread', () => {
  it('starts open and silent: work is not allowed to interrupt by default', () => {
    const thread = threads.createThread({ title: '整理 Q3 财报', goal: '输出一页摘要' });
    expect(thread.state).toBe('open');
    expect(thread.attention).toBe('silent');
    expect(thread.spentTokens).toBe(0);
    expect(thread.closedAt).toBeNull();
  });

  it('stamps closed_at when a thread reaches a terminal state and clears it on reopen', () => {
    const thread = threads.createThread({ title: 'A' });
    expect(threads.setState(thread.id, 'done').closedAt).not.toBeNull();
    expect(threads.setState(thread.id, 'running').closedAt).toBeNull();
  });

  it('rejects a state the CHECK constraint does not know', () => {
    const thread = threads.createThread({ title: 'A' });
    expect(() =>
      db.prepare("UPDATE thread SET state = 'paused' WHERE id = ?").run(thread.id),
    ).toThrow();
  });

  it('keeps terminal threads out of the active list', () => {
    const live = threads.createThread({ title: 'live' });
    const done = threads.createThread({ title: 'done' });
    threads.setState(done.id, 'done');
    expect(threads.listActiveThreads().map((row) => row.id)).toEqual([live.id]);
  });

  it('reports the charge that crosses the ceiling, and only that one', () => {
    const thread = threads.createThread({ title: 'A', budgetTokens: 100 });
    expect(threads.charge(thread.id, 60)).toBe(false);
    expect(threads.charge(thread.id, 40)).toBe(true);
    expect(threads.getThread(thread.id)?.spentTokens).toBe(100);
  });

  it('never reports a crossing when the thread has no ceiling', () => {
    const thread = threads.createThread({ title: 'A' });
    expect(threads.charge(thread.id, 10_000_000)).toBe(false);
  });

  it('touches last_activity_at so the list follows what moved last', () => {
    const first = threads.createThread({ title: 'first' });
    const second = threads.createThread({ title: 'second' });
    expect(threads.listThreads()[0]?.id).toBe(second.id);
    threads.touch(first.id);
    expect(threads.listThreads()[0]?.id).toBe(first.id);
  });
});

describe('worker', () => {
  it('carries skills as a list, not a career', () => {
    const thread = threads.createThread({ title: 'A' });
    const worker = threads.createWorker({
      name: '小周',
      template: 'code',
      skills: ['typescript', 'sqlite'],
      threadId: thread.id,
    });
    expect(worker.skills).toEqual(['typescript', 'sqlite']);
    expect(worker.status).toBe('idle');
  });

  it('leaves the active list when retired but keeps its row', () => {
    const thread = threads.createThread({ title: 'A' });
    const worker = threads.createWorker({ name: '小周', threadId: thread.id });
    expect(threads.listWorkers(thread.id)).toHaveLength(1);
    const retired = threads.retireWorker(worker.id);
    expect(retired.status).toBe('retired');
    expect(retired.retiredAt).not.toBeNull();
    expect(threads.listWorkers(thread.id)).toHaveLength(0);
    expect(threads.getWorker(worker.id)).not.toBeNull();
  });
});

describe('event', () => {
  it('lands pending and is the only thing the semantic layer is shown', () => {
    const kept = threads.enqueueEvent({ kind: 'folder.changed', payload: { file: 'a.pdf' } });
    const accepted = threads.enqueueEvent({ kind: 'manual' });
    threads.triageEvent(accepted.id, 'dropped');
    expect(threads.listPendingEvents().map((row) => row.id)).toEqual([kept.id]);
    expect(kept.payload).toEqual({ file: 'a.pdf' });
  });

  it('refuses an accepted event without a thread — it would have nowhere to live', () => {
    const event = threads.enqueueEvent({ kind: 'manual' });
    expect(() => threads.triageEvent(event.id, 'accepted')).toThrow(/threadId/);
  });

  it('records a dropped event instead of deleting it, so you can see what was ignored', () => {
    const event = threads.enqueueEvent({ kind: 'im.message', source: 'im' });
    threads.triageEvent(event.id, 'dropped');
    const row = db.prepare('SELECT triage, triaged_at FROM event WHERE id = ?').get(event.id) as {
      triage: string;
      triaged_at: number | null;
    };
    expect(row.triage).toBe('dropped');
    expect(row.triaged_at).not.toBeNull();
  });
});

describe('report', () => {
  it('puts a decision above a newer notification', () => {
    const thread = threads.createThread({ title: 'A' });
    threads.addReport({ threadId: thread.id, level: 'notify', title: '做完了' });
    threads.addReport({ threadId: thread.id, level: 'decide', title: '要不要发出去？' });
    expect(threads.listQueue().map((row) => row.level)).toEqual(['decide', 'notify']);
  });

  it('keeps silent reports out of the interruption queue', () => {
    const thread = threads.createThread({ title: 'A' });
    threads.addReport({ threadId: thread.id, level: 'silent', title: '已归档' });
    expect(threads.listQueue()).toHaveLength(0);
  });

  it('drops a read report from the queue and stamps the time', () => {
    const thread = threads.createThread({ title: 'A' });
    const report = threads.addReport({ threadId: thread.id, title: '做完了' });
    expect(threads.markReportRead(report.id).readAt).not.toBeNull();
    expect(threads.listQueue()).toHaveLength(0);
  });

  it('touches its thread, so the queue and the thread list agree on what moved', () => {
    const first = threads.createThread({ title: 'first' });
    const second = threads.createThread({ title: 'second' });
    threads.addReport({ threadId: first.id, title: '有新进展' });
    expect(threads.listThreads()[0]?.id).toBe(first.id);
    expect(second.id).toBeDefined();
  });
});

describe('schema version', () => {
  it('lands on the version the code declares, with the v2 tables present', () => {
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
    for (const table of ['thread', 'worker', 'event', 'report']) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { name: string } | undefined;
      expect(row?.name).toBe(table);
    }
  });
});

/**
 * B3-2: worker 是运行时身份的载体。
 *
 * 一条工作线可以有多个 worker——这正是 harness 必须按 worker 而不是按 thread 开库的
 * 原因（docs/v2/01-core.md §6）。同一 (thread, employee) 必须复用，否则同一个人在同一
 * 条线索上的上下文会被反复重建。
 */
describe('ensureWorker', () => {
  it('reuses the worker for the same person on the same thread', () => {
    const thread = threads.createThread({ title: '整理财报' });
    const first = threads.ensureWorker({ threadId: thread.id, ownerId: 'emp-1', name: '李雷' });
    const again = threads.ensureWorker({ threadId: thread.id, ownerId: 'emp-1', name: '李雷' });
    expect(again.id).toBe(first.id);
    expect(threads.listWorkers(thread.id)).toHaveLength(1);
  });

  it('gives two people on one thread two runtimes', () => {
    const thread = threads.createThread({ title: '整理财报' });
    const a = threads.ensureWorker({ threadId: thread.id, ownerId: 'emp-1', name: '李雷' });
    const b = threads.ensureWorker({ threadId: thread.id, ownerId: 'emp-2', name: '韩梅梅' });
    expect(a.id).not.toBe(b.id);
    // Two workers on one thread is legal; sharing one harness would not be.
    expect(threads.listWorkers(thread.id)).toHaveLength(2);
    expect(a.ownerId).toBe('emp-1');
    expect(b.ownerId).toBe('emp-2');
  });

  it('makes a new worker after the old one is retired', () => {
    const thread = threads.createThread({ title: '整理财报' });
    const first = threads.ensureWorker({ threadId: thread.id, ownerId: 'emp-1', name: '李雷' });
    threads.retireWorker(first.id);
    const again = threads.ensureWorker({ threadId: thread.id, ownerId: 'emp-1', name: '李雷' });
    expect(again.id).not.toBe(first.id);
  });
});
