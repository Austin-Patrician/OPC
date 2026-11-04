import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpOAuthAuthorizationRequiredError, type OAuthFlowOptions } from '@earendil-works/pi-mcp/oauth';
import { McpAuthStore, loginMcp, type McpCipher } from './auth';
import type { McpHttpServer } from './contract';

/**
 * MCP 的 OAuth（M2b）。
 *
 * 这一段是 MCP 里唯一**有状态**的部分，所以要锁两件事：
 *
 * 1. **token 落盘且加密**——它等价于一个能读你数据的密码，明文放 JSON 里是疏忽。
 * 2. **登录那几步的顺序**——先挂上"等人回来"，再开浏览器。反了会漏掉浏览器回调得很快
 *    的那一次，表现为"点了登录，浏览器回来了，界面还是未登录"。
 *
 * 真正的授权服务器要发网络请求，所以这里注入了一个假的 flow：它只把"什么时候该抛出
 * 需要登录、什么时候该存下 token"这两件事做对。
 */
/**
 * 测试用的"加密"：逐字节取反。
 *
 * 真加密是 Elect�ron 的 `safeStorage`（系统密钥环），在 vitest 里没有那件东西。
 * 这一组要验的是**读写与隔离**，不是密码学——用能算的替身，才能把"文件里看不到明文"
 * 也一起验了。
 */
const cipher: McpCipher = {
  encrypt: (plain) => Buffer.from([...Buffer.from(plain, 'utf8')].map((byte) => byte ^ 0xff)),
  decrypt: (ciphertext) =>
    Buffer.from([...ciphertext].map((byte) => byte ^ 0xff)).toString('utf8'),
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-mcp-auth-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const server: McpHttpServer = { name: 'jira', url: 'https://jira.example.com/mcp' };

describe('token 存在哪', () => {
  it('存下来能读回来，但文件里看不到明文', () => {
    const store = new McpAuthStore(path.join(dir, 'mcp-auth.json'), 'jira', cipher);
    store.save({ serverUrl: server.url, tokens: { access_token: 'super-secret', token_type: 'Bearer' } as never });

    expect(store.load()?.tokens?.access_token).toBe('super-secret');
    const onDisk = readFileSync(path.join(dir, 'mcp-auth.json'), 'utf8');
    expect(onDisk).not.toContain('super-secret');
  });

  it('按名字各存一份：一台服务器换了地址，另一台的凭据不受影响', () => {
    const file = path.join(dir, 'mcp-auth.json');
    new McpAuthStore(file, 'jira', cipher).save({ serverUrl: 'https://a/mcp', tokens: { access_token: 'A' } as never });
    new McpAuthStore(file, 'docs', cipher).save({ serverUrl: 'https://b/mcp', tokens: { access_token: 'B' } as never });

    expect(new McpAuthStore(file, 'jira', cipher).load()?.tokens?.access_token).toBe('A');
    expect(new McpAuthStore(file, 'docs', cipher).load()?.tokens?.access_token).toBe('B');
  });

  it('登出连 client 注册信息一起清掉', () => {
    const store = new McpAuthStore(path.join(dir, 'mcp-auth.json'), 'jira', cipher);
    store.save({ serverUrl: server.url, tokens: { access_token: 'x' } as never });
    store.clear();
    expect(store.hasTokens()).toBe(false);
    expect(store.load()).toBeUndefined();
  });

  it('解不开就当没登录：换台机器不该在第一次调用里抛', () => {
    const file = path.join(dir, 'mcp-auth.json');
    writeFileSync(file, JSON.stringify({ jira: 'bm90LWEtY2lwaGVy' }));
    expect(new McpAuthStore(file, 'jira', cipher).load()).toBeUndefined();
  });
});

describe('登录那几步', () => {
  function harness(behaviour: 'authorized' | 'needs-user') {
    const opened: string[] = [];
    const store = new McpAuthStore(path.join(dir, 'mcp-auth.json'), 'jira', cipher);
    const flow = (async (provider: { redirectToAuthorization(url: URL): Promise<void>; saveTokens(t: unknown): Promise<void> }, options: OAuthFlowOptions) => {
      if (!options.authorizationCode) {
        if (behaviour === 'authorized') return 'AUTHORIZED';
        await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize?x=1'));
        throw new McpOAuthAuthorizationRequiredError();
      }
      await provider.saveTokens({ access_token: 'after-login', token_type: 'Bearer' });
      return 'AUTHORIZED';
    }) as never;

    const login = () =>
      loginMcp(server, {
        store,
        openBrowser: (url) => {
          opened.push(url);
        },
        timeoutMs: 1_000,
        flow,
        callback: async () => ({
          redirectUrl: 'http://127.0.0.1:7777/callback',
          waitForCallback: async () => ({ code: 'the-code' }),
          close: async () => undefined,
        }),
      });

    return { login, opened, store };
  }

  it('已经登录过就直接续上，不开浏览器', async () => {
    const { login, opened, store } = harness('authorized');
    expect(await login()).toEqual({ ok: true });
    expect(opened).toHaveLength(0);
    expect(store.hasTokens()).toBe(false);
  });

  it('要人点头：开浏览器、等回调、拿 code 换 token', async () => {
    const { login, opened, store } = harness('needs-user');
    expect(await login()).toEqual({ ok: true });
    expect(opened).toEqual(['https://auth.example.com/authorize?x=1']);
    expect(store.load()?.tokens?.access_token).toBe('after-login');
  });

  it('失败不抛：设置页要能把原因显示成一行红字', async () => {
    const store = new McpAuthStore(path.join(dir, 'mcp-auth.json'), 'jira', cipher);
    const result = await loginMcp(server, {
      store,
      openBrowser: () => undefined,
      timeoutMs: 1_000,
      flow: (async () => {
        throw new Error('授权服务器拒绝');
      }) as never,
      callback: async () => ({
        redirectUrl: 'http://127.0.0.1:7777/callback',
        waitForCallback: async () => ({ code: 'x' }),
        close: async () => undefined,
      }),
    });
    expect(result).toEqual({ ok: false, error: '授权服务器拒绝' });
  });
});
