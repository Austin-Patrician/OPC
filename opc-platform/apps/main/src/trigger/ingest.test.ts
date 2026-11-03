import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { TaskRepository } from '../data/taskRepository';
import { ThreadRepository } from '../data/threadRepository';
import { createGitHubAdapter } from './github';
import { ingestTrigger } from './ingest';
import { TriggerRegistry } from './registry';
import { startTriggerServer, type TriggerServer } from './server';
import { hmacHex } from './verify';
import type { NormalizedTrigger } from './types';

/**
 * 从一条外部 HTTP 请求到一条排队中的事件——整条触发链路。
 *
 * 这一层要证明的不是"能收 POST"，而是三件容易漏的事：
 *
 * 1. **重投不多派活**：GitHub 超时会重投，同一个 `x-github-delivery` 只落一条事件；
 * 2. **结束信号收线**：PR 合并之后那条线不该继续等人干活；
 * 3. **身份一路带到事件里**：`payload.threadKey` 是直通（§3.2）的唯一依据，掉了它就
 *    退化成一堆互不相干的新任务。
 */
const SECRET = 'gh-secret';
let dir: string;
let db: CompanyDatabase;
let threads: ThreadRepository;
let tasks: TaskRepository;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-trigger-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  threads = new ThreadRepository(db);
  tasks = new TaskRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function prPayload(action = 'opened', number = 12) {
  return {
    action,
    number,
    repository: { full_name: 'acme/api' },
    sender: { login: 'octocat' },
    pull_request: { number, title: '加健康检查', body: '给 /health 一个接口' },
  };
}

function delivery(body: unknown, deliveryId = 'del-1', event = 'pull_request') {
  const raw = JSON.stringify(body);
  return {
    method: 'POST',
    path: '/hook/github',
    headers: {
      'x-github-event': event,
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': `sha256=${hmacHex(SECRET, raw)}`,
    },
    body: raw,
  };
}

function registry() {
  return new TriggerRegistry([createGitHubAdapter(() => SECRET)]);
}

describe('ingestTrigger', () => {
  const meta = { adapterId: 'github', source: 'github' as const };
  const trigger: NormalizedTrigger = {
    kind: 'pr.opened',
    identity: { key: 'github:acme/api#12', source: 'github', externalId: 'acme/api#12' },
    summary: 'acme/api PR #12 opened：加健康检查',
    text: '给 /health 一个接口',
    actor: 'octocat',
    deliveryId: 'del-1',
  };

  it('身份、摘要、作者一起落到事件里：直通全靠那个 threadKey', () => {
    const { event, inserted } = ingestTrigger({ threads, tasks }, trigger, meta);
    expect(inserted).toBe(true);
    expect(event.source).toBe('github');
    expect(event.payload.threadKey).toBe('github:acme/api#12');
    expect(event.payload.text).toBe('给 /health 一个接口');
    expect(event.payload.author).toBe('octocat');
    expect(event.triage).toBe('pending');
  });

  it('同一个投递 id 只落一条事件', () => {
    const first = ingestTrigger({ threads, tasks }, trigger, meta);
    const second = ingestTrigger({ threads, tasks }, trigger, meta);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    expect(threads.listPendingEvents(10)).toHaveLength(1);
  });

  it('结束信号收掉那条线，并留一条安静的记录', () => {
    const live = threads.createThread({
      title: 'acme/api#12',
      threadKey: 'github:acme/api#12',
    });
    const { closedThreadId } = ingestTrigger(
      { threads, tasks },
      { ...trigger, kind: 'pr.closed', deliveryId: 'del-2', terminal: true },
      meta,
    );
    expect(closedThreadId).toBe(live.id);
    expect(threads.getThread(live.id)?.state).toBe('done');
    expect(threads.listQueue()).toHaveLength(0);
  });

  it('手上还有活的时候不收线：抢在前面收线会让正在写的任务失去线索', () => {
    const live = threads.createThread({ title: 'acme/api#12', threadKey: 'github:acme/api#12' });
    const worker = threads.createWorker({ name: '李雷', threadId: live.id });
    const created = tasks.createTask(
      {
        title: '改健康检查',
        brief: 'x',
        deliverableSpec: 'x',
        assigneeId: worker.id,
        estTokens: 100,
        acceptanceCommand: ['true'],
        acceptanceTemplate: 'http-ok',
        threadId: live.id,
      },
      'w/1',
      'task-1',
    );
    expect(created.id).toBe('task-1');
    tasks.setStatus('task-1', 'running', { startedAt: Date.now() });

    const { closedThreadId } = ingestTrigger(
      { threads, tasks },
      { ...trigger, kind: 'pr.closed', deliveryId: 'del-3', terminal: true },
      meta,
    );
    expect(closedThreadId).toBeNull();
    expect(threads.getThread(live.id)?.state).not.toBe('done');
  });

  it('没有身份的事件照旧落库，只是不并线', () => {
    const { event } = ingestTrigger(
      { threads, tasks },
      { kind: 'message.received', identity: null, summary: '单聊里说了句话', text: '在吗' },
      { adapterId: 'feishu', source: 'im' },
    );
    expect(event.payload.threadKey).toBeUndefined();
    expect(event.source).toBe('im');
  });
});

describe('触发入口（真的起一个端口）', () => {
  let server: TriggerServer;
  const accepted: NormalizedTrigger[] = [];

  beforeEach(async () => {
    accepted.length = 0;
    server = await startTriggerServer({
      registry: registry(),
      port: 0,
      onAccepted: (trigger, meta) => {
        ingestTrigger({ threads, tasks }, trigger, meta);
        accepted.push(trigger);
      },
    });
  });

  afterEach(async () => {
    await server.close();
  });

  function post(url: string, body: string, headers: Record<string, string>) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const target = new URL(url);
      const request = http.request(
        {
          host: target.hostname,
          port: target.port,
          path: target.pathname,
          method: 'POST',
          headers: { ...headers, 'content-length': Buffer.byteLength(body) },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      request.on('error', reject);
      request.end(body);
    });
  }

  it('一条合法的 PR 投递落成一条带身份的事件', async () => {
    const request = delivery(prPayload());
    const result = await post(server.urls[0]!.url, request.body, request.headers as Record<string, string>);

    expect(result.status).toBe(200);
    expect(accepted).toHaveLength(1);
    const [event] = threads.listPendingEvents(10);
    expect(event?.payload.threadKey).toBe('github:acme/api#12');
  });

  it('重投同一投递 id 不会变成两条事件', async () => {
    const request = delivery(prPayload());
    await post(server.urls[0]!.url, request.body, request.headers as Record<string, string>);
    await post(server.urls[0]!.url, request.body, request.headers as Record<string, string>);
    expect(threads.listPendingEvents(10)).toHaveLength(1);
  });

  it('签名不对回 401，一条事件都不落', async () => {
    const request = delivery(prPayload());
    const result = await post(server.urls[0]!.url, request.body, {
      ...(request.headers as Record<string, string>),
      'x-hub-signature-256': 'sha256=00',
    });
    expect(result.status).toBe(401);
    expect(threads.listPendingEvents(10)).toHaveLength(0);
  });

  it('GET 一律 405：这扇门只收平台推过来的 POST', async () => {
    const url = new URL(server.urls[0]!.url);
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        { host: url.hostname, port: url.port, path: url.pathname, method: 'GET' },
        (response) => resolve(response.statusCode ?? 0),
      );
      request.on('error', reject);
      request.end();
    });
    expect(status).toBe(405);
  });
});
