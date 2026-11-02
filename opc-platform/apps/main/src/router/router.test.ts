import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { ThreadRepository } from '../data/threadRepository';
import { Router, type RouterDeps } from './router';

/**
 * The router with fakes — the exit criterion of S2: a fake event walks the whole
 * path (filter → judge → thread → dispatch → report) without a model.
 *
 * What these lock down is the promise the product makes: **finishing work does
 * not interrupt the boss.** Only a decision or a failure does.
 */
let dir: string;
let db: CompanyDatabase;
let threads: ThreadRepository;
let tick: number;
let seq: number;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-router-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  tick = 1_700_000_000_000;
  seq = 0;
  threads = new ThreadRepository(db, { now: () => (tick += 1_000), id: () => `id-${(seq += 1)}` });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function router(overrides: Omit<Partial<RouterDeps>, 'threads'> = {}) {
  return new Router({ threads, ...overrides });
}

describe('router', () => {
  it('does nothing at all on an empty queue', async () => {
    const report = await router({}).tick();
    expect(report).toEqual({ dropped: 0, rejected: 0, opened: [], reported: [], failed: 0 });
  });

  it('drops program-layer noise without opening a thread or calling the judge', async () => {
    threads.enqueueEvent({ kind: 'im.typing', source: 'im' });
    let judged = 0;
    const report = await router({
      prefilter: (event) => (event.kind === 'im.typing' ? 'drop' : 'keep'),
      judge: async (events) => {
        judged += events.length;
        return events.map((event) => ({ eventId: event.id, accept: true }));
      },
    }).tick();

    expect(report.dropped).toBe(1);
    expect(judged).toBe(0);
    expect(threads.listThreads()).toHaveLength(0);
  });

  it('judges a whole burst in one call, not one call per event', async () => {
    for (const kind of ['a', 'b', 'c']) threads.enqueueEvent({ kind });
    let calls = 0;
    let seen = 0;
    const report = await router({
      judge: async (events) => {
        calls += 1;
        seen = events.length;
        return events.map((event) => ({ eventId: event.id, accept: true }));
      },
    }).tick();

    expect(calls).toBe(1);
    expect(seen).toBe(3);
    expect(report.opened).toHaveLength(3);
  });

  it('finishes quietly: a delivered thread is done and does not reach the queue', async () => {
    threads.enqueueEvent({ kind: 'folder.changed', payload: { goal: '读一下这份财报' } });
    const report = await router({
      dispatch: async () => ({ status: 'delivered', summary: '摘要写好了，在 artifacts 里' }),
    }).tick();

    const thread = threads.listThreads()[0]!;
    expect(thread.state).toBe('done');
    expect(thread.goal).toBe('读一下这份财报');
    expect(report.reported[0]?.level).toBe('silent');
    expect(threads.listQueue()).toHaveLength(0);
  });

  it('asks the boss only when a decision is actually needed', async () => {
    threads.enqueueEvent({ kind: 'manual', payload: { goal: '发一封邮件' } });
    await router({
      dispatch: async () => ({ status: 'needs-decision', question: '发给张总还是李总？' }),
    }).tick();

    const thread = threads.listThreads()[0]!;
    expect(thread.state).toBe('waiting');
    const queue = threads.listQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]?.level).toBe('decide');
    expect(queue[0]?.body).toBe('发给张总还是李总？');
  });

  it('turns an executor crash into a failed thread with a visible reason', async () => {
    threads.enqueueEvent({ kind: 'manual' });
    const report = await router({
      dispatch: async () => {
        throw new Error('workspace 不存在');
      },
    }).tick();

    const thread = threads.listThreads()[0]!;
    expect(thread.state).toBe('failed');
    expect(report.reported[0]?.level).toBe('decide');
    expect(threads.listQueue()[0]?.body).toBe('workspace 不存在');
    // The event is settled: retrying work that already touched files is worse
    // than asking the boss.
    expect(threads.listPendingEvents()).toHaveLength(0);
  });

  it('keeps an event pending when the judge itself blows up', async () => {
    threads.enqueueEvent({ kind: 'manual' });
    const report = await router({
      judge: async () => {
        throw new Error('模型挂了');
      },
    }).tick();

    expect(report.failed).toBe(1);
    expect(report.rejected).toBe(0);
    // Nothing was accepted, so nothing was lost: the event is still pending.
    expect(threads.listPendingEvents()).toHaveLength(1);
  });

  it('joins an existing line of work instead of opening a second one', async () => {
    const first = threads.enqueueEvent({ kind: 'manual', payload: { goal: '整理财报' } });
    const thread = threads.createThread({ title: '整理财报' });
    threads.triageEvent(first.id, 'accepted', thread.id);

    threads.enqueueEvent({ kind: 'folder.changed', payload: { goal: '又下载了一份' } });
    const report = await router({
      judge: async (events) => events.map((event) => ({ eventId: event.id, accept: true, threadId: thread.id })),
      dispatch: async () => ({ status: 'delivered', summary: 'ok' }),
    }).tick();

    expect(report.opened).toHaveLength(0);
    expect(threads.listThreads()).toHaveLength(1);
  });

  it('opens a new thread when the verdict points at one that is already closed', async () => {
    const closed = threads.createThread({ title: '旧活' });
    threads.setState(closed.id, 'done');
    threads.enqueueEvent({ kind: 'manual' });

    const report = await router({
      judge: async (events) => events.map((event) => ({ eventId: event.id, accept: true, threadId: closed.id })),
      dispatch: async () => ({ status: 'delivered', summary: 'ok' }),
    }).tick();

    expect(report.opened).toHaveLength(1);
    expect(report.opened[0]?.id).not.toBe(closed.id);
  });

  it('triages without executing when no executor is wired yet', async () => {
    threads.enqueueEvent({ kind: 'manual' });
    const report = await router({}).tick();

    expect(report.opened).toHaveLength(1);
    expect(report.reported).toHaveLength(0);
    expect(threads.listThreads()[0]?.state).toBe('open');
  });
});
