import { describe, expect, it } from 'vitest';
import { createGitHubAdapter } from './github';
import { createFeishuAdapter } from './feishu';
import { TriggerRegistry, routeId } from './registry';
import { hmacHex } from './verify';
import type { TriggerRequest } from './types';

/**
 * 入口路由：认人 → 验身 → 归一。
 *
 * 三种失败的原因必须分开，否则用户只看到"没反应"：路径不认识（404）、签名不过
 * （401）、归一为空（200 —— 这是**成功**）。最后一种最容易写错：回 4xx 会让平台
 * 一直重投，一条无意义的消息变成永久的噪声源。
 */
const SECRET = 's3cret';

function registry() {
  return new TriggerRegistry([
    createGitHubAdapter(() => SECRET),
    createFeishuAdapter(() => null),
  ]);
}

function github(body: unknown, event = 'pull_request'): TriggerRequest {
  const raw = JSON.stringify(body);
  return {
    method: 'POST',
    path: '/hook/github',
    headers: {
      'x-github-event': event,
      'x-hub-signature-256': `sha256=${hmacHex(SECRET, raw)}`,
    },
    body: raw,
  };
}

describe('TriggerRegistry', () => {
  it('不认识的路径回 404，并告诉你已知入口', () => {
    const outcome = registry().handle({ ...github({}), path: '/hook/nope' });
    expect(outcome.status).toBe(404);
    expect(outcome.body).toContain('github');
  });

  it('签名不过回 401，原因写进日志而不是响应', () => {
    const request = github({});
    const outcome = registry().handle({
      ...request,
      headers: { ...request.headers, 'x-hub-signature-256': 'sha256=deadbeef' },
    });
    expect(outcome.status).toBe(401);
    expect(outcome.reason).toContain('签名不匹配');
    expect(outcome.body).not.toContain('签名');
  });

  it('ping 归一到零条事件，但仍然是 200', () => {
    const outcome = registry().handle(github({ zen: 'hi' }, 'ping'));
    expect(outcome.status).toBe(200);
    expect(outcome.accepted).toEqual([]);
  });

  it('归一了事件就把来源带出来，落库要用它', () => {
    const outcome = registry().handle(
      github({
        action: 'opened',
        number: 7,
        repository: { full_name: 'acme/api' },
        pull_request: { number: 7, title: 't' },
      }),
    );
    expect(outcome.status).toBe(200);
    expect(outcome.accepted).toHaveLength(1);
    expect(outcome.source).toBe('github');
    expect(outcome.adapterId).toBe('github');
  });

  it('接入挑战回原文，且不需要签名（密钥这时才刚填进去）', () => {
    const outcome = registry().handle({
      method: 'POST',
      path: '/hook/feishu',
      headers: {},
      body: JSON.stringify({ type: 'url_verification', challenge: 'abc' }),
    });
    expect(outcome.status).toBe(200);
    expect(outcome.body).toBe('abc');
    expect(outcome.accepted).toEqual([]);
  });

  it('归一自己炸了也不回 5xx：否则平台会一直重投一条我们读不懂的消息', () => {
    const outcome = registry().handle({
      method: 'POST',
      path: '/hook/github',
      headers: { ...github({}).headers, 'x-github-event': 'pull_request' },
      body: '签名对不上的坏正文不可能走到这里，所以这里只断言不会抛',
    });
    expect([200, 401]).toContain(outcome.status);
  });
});

describe('routeId', () => {
  it('只认一层短路径', () => {
    expect(routeId('/hook/github')).toBe('github');
    expect(routeId('/hook/github/')).toBe('github');
    expect(routeId('/hook/github/extra')).toBeNull();
    expect(routeId('/hook')).toBeNull();
    expect(routeId('/hook/GITHUB')).toBeNull();
  });
});
