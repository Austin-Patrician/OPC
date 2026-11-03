import { describe, expect, it } from 'vitest';
import { createGitHubAdapter } from './github';
import { hmacHex } from './verify';
import type { TriggerRequest } from './types';

const SECRET = 'github-secret';

function request(body: unknown, event = 'pull_request', delivery = 'del-1'): TriggerRequest {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    method: 'POST',
    path: '/hook/github',
    headers: {
      'x-github-event': event,
      'x-github-delivery': delivery,
      'x-hub-signature-256': `sha256=${hmacHex(SECRET, raw)}`,
      'content-type': 'application/json',
    },
    body: raw,
  };
}

const adapter = createGitHubAdapter(() => SECRET);

const pullRequest = {
  action: 'opened',
  number: 128,
  repository: { full_name: 'Acme/Api' },
  sender: { login: 'octocat' },
  pull_request: { number: 128, title: '加一个健康检查', body: '给 /health 加一个接口', merged: false },
};

/**
 * GitHub 是第一个"真·外部触发源"，它验证的是 Thread 的定义：**一个 PR 就是一条线**。
 * PR 下新来的评论、新的提交、CI 的结论都落在同一个身份上，不是三件互不相干的事。
 */
describe('GitHub 适配器', () => {
  it('一个 PR 的身份是 github:<owner/repo>#<number>，大小写归一', () => {
    const [trigger] = adapter.normalize(request(pullRequest));
    expect(trigger?.identity?.key).toBe('github:acme/api#128');
    expect(trigger?.kind).toBe('pr.opened');
    expect(trigger?.actor).toBe('octocat');
  });

  it('PR 下的评论并进同一个身份，而不是另开一条线', () => {
    const [trigger] = adapter.normalize(
      request(
        {
          action: 'created',
          repository: { full_name: 'acme/api' },
          issue: { number: 128, title: '加一个健康检查' },
          comment: { body: '这个接口要不要鉴权？', user: { login: 'reviewer' } },
        },
        'issue_comment',
      ),
    );
    expect(trigger?.identity?.key).toBe('github:acme/api#128');
    expect(trigger?.text).toContain('要不要鉴权');
  });

  it('带 pull_request 的 issue 仍然是同一个 PR 的身份，不会分裂成两条线', () => {
    const [trigger] = adapter.normalize(
      request(
        {
          action: 'edited',
          issue: { number: 128, title: '加一个健康检查', pull_request: { url: 'x' } },
          repository: { full_name: 'acme/api' },
        },
        'issues',
      ),
    );
    expect(trigger?.kind).toBe('pr.edited');
    expect(trigger?.identity?.key).toBe('github:acme/api#128');
  });

  it('CI 结论落在产生它的那个 PR 上，并且是「一个结果」而不是「一个请求」', () => {
    const [trigger] = adapter.normalize(
      request(
        {
          action: 'completed',
          repository: { full_name: 'acme/api' },
          check_run: { name: 'build', conclusion: 'failure', pull_requests: [{ number: 128 }] },
        },
        'check_run',
      ),
    );
    expect(trigger?.identity?.key).toBe('github:acme/api#128');
    expect(trigger?.kind).toBe('check.failure');
    // 它不新开线：只有一个 summary，没有正文可派活。
    expect(trigger?.text).toBeUndefined();
  });

  it('push 按分支并线', () => {
    const [trigger] = adapter.normalize(
      request(
        {
          ref: 'refs/heads/main',
          repository: { full_name: 'acme/api' },
          commits: [{ message: 'fix: 修一个边界\n\n详细说明' }],
        },
        'push',
      ),
    );
    expect(trigger?.identity?.key).toBe('github:acme/api@main');
    expect(trigger?.text).toBe('- fix: 修一个边界');
  });

  it('关闭/合并是结束信号，不是又一件活', () => {
    const [trigger] = adapter.normalize(request({ ...pullRequest, action: 'closed' }));
    expect(trigger?.terminal).toBe(true);
  });

  it('ping 不是活：接入时的那一条不该落成事件', () => {
    expect(adapter.normalize(request({ zen: 'Keep it logically awesome.' }, 'ping'))).toEqual([]);
  });

  it('不认识的 event 返回空数组，而不是硬造一条', () => {
    expect(adapter.normalize(request({}, 'star'))).toEqual([]);
  });

  it('投递 id 带出来，重投才有得比', () => {
    const [trigger] = adapter.normalize(request(pullRequest, 'pull_request', 'delivery-42'));
    expect(trigger?.deliveryId).toBe('delivery-42');
  });

  describe('校验来源', () => {
    it('签名对得上才放行', () => {
      expect(adapter.verify(request(pullRequest)).ok).toBe(true);
    });

    it('正文改一个字就不过', () => {
      const good = request(pullRequest);
      const tampered = { ...good, body: `${good.body} ` };
      expect(adapter.verify(tampered).ok).toBe(false);
    });

    it('没配密钥是「拒绝」，不是「跳过」', () => {
      const unconfigured = createGitHubAdapter(() => null);
      const result = unconfigured.verify(request(pullRequest));
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toContain('没配');
    });
  });
});
