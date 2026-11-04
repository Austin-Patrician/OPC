import fs from 'node:fs';
import path from 'node:path';
import {
  adaptOAuthProvider,
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  OAuthCallbackServer,
  type McpOAuthState,
  type McpOAuthStateStore,
  type OAuthClientMetadata,
} from '@earendil-works/pi-mcp/oauth';
import type { AuthProvider } from '@earendil-works/pi-mcp';
import { decryptSecret, encryptSecret } from '../models/keyCipher';
import type { McpHttpServer, McpServerConfig } from './contract';

/**
 * MCP 的 OAuth（M2b）。
 *
 * 这是 MCP 里唯一**有状态**的部分：一次登录要在后面每一轮请求里生效，还要在 token 过期
 * 之后自己续上。三件事必须做对：
 *
 * 1. **token 落盘且加密。** 它等价于一个能读你数据的密码，明文放 JSON 里是疏忽。
 * 2. **绑 URL。** 同一个名字换了地址就是另一台服务器，旧 token 不能跟着过去。
 * 3. **401 之后要么续、要么明说"要重新登录"**，不能静默变成一堆工具调用失败。
 */

/** 状态文件。和模型的凭据分开放：两件事的生命周期不一样。 */
export const authFile = (userDataDir: string): string => path.join(userDataDir, 'mcp-auth.json');

/**
 * 一个服务器的 OAuth 状态。**按名字各存一份，密文。**
 *
 * 每次 load/save 都整份读改写：这个文件只有几个条目，而"读-改-写"能保证两个人的
 * 登录不会互相覆盖——原子替换（tmp + rename）保证崩在中间不会留下半个文件。
 */
/** 加解密。默认是系统密钥环（`safeStorage`）；用例里换成能算的那种。 */
export interface McpCipher {
  encrypt(plain: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

const systemCipher: McpCipher = { encrypt: encryptSecret, decrypt: decryptSecret };

export class McpAuthStore implements McpOAuthStateStore {
  constructor(
    private readonly file: string,
    private readonly name: string,
    private readonly cipher: McpCipher = systemCipher,
  ) {}

  load(): McpOAuthState | undefined {
    const all = this.readAll();
    const cipher = all[this.name];
    if (!cipher) return undefined;
    try {
      return JSON.parse(this.cipher.decrypt(Buffer.from(cipher, 'base64'))) as McpOAuthState;
    } catch {
      // 解不开（换了机器、换了密钥）当作没登录：让用户重新登一次，而不是抛在下一次调用里。
      return undefined;
    }
  }

  save(state: McpOAuthState): void {
    const all = this.readAll();
    all[this.name] = this.cipher.encrypt(JSON.stringify(state)).toString('base64');
    this.writeAll(all);
  }

  /** 登出：连 client 注册信息一起丢掉。 */
  clear(): void {
    const all = this.readAll();
    if (!(this.name in all)) return;
    delete all[this.name];
    this.writeAll(all);
  }

  hasTokens(): boolean {
    return this.load()?.tokens !== undefined;
  }

  private readAll(): Record<string, string> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') return {};
      return Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).filter(
          (pair): pair is [string, string] => typeof pair[1] === 'string',
        ),
      );
    } catch {
      return {};
    }
  }

  private writeAll(all: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const target = `${this.file}.tmp`;
    fs.writeFileSync(target, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(target, this.file);
  }
}

export const isHttp = (config: McpServerConfig): config is McpHttpServer =>
  typeof (config as McpHttpServer).url === 'string';

/** 有 `Authorization` 头就说明它用的是自带凭据，OAuth 不该插手。 */
const hasOwnAuth = (config: McpHttpServer): boolean =>
  Object.keys(config.headers ?? {}).some((key) => key.toLowerCase() === 'authorization');

const clientMetadata: Omit<OAuthClientMetadata, 'redirect_uris'> & { redirect_uris?: string[] } = {
  client_name: 'OPC 工作台',
};

/**
 * 一个服务的 OAuth 提供方。
 *
 * 每次现造而不是缓存实例：状态在文件里，实例本身没有状态。缓存它只会让"登出之后
 * 还在用旧 token"变成一个可能。
 */
export function oauthProviderFor(
  config: McpHttpServer,
  deps: { store: McpOAuthStateStore; redirectUrl: string | URL; onRedirect: (url: URL) => void },
): McpOAuthProvider {
  return new McpOAuthProvider({
    serverUrl: config.url,
    redirectUrl: deps.redirectUrl,
    clientMetadata,
    store: deps.store,
    onRedirect: deps.onRedirect,
  });
}

/**
 * 运行时的 AuthProvider：交给 transport，401 时自动续，续不上就抛。
 *
 * `redirectUrl` 在运行时用不到（没人会在这里开浏览器），但 `McpOAuthProvider` 要求它。
 * 给一个必然不会被监听的地址，是为了让"运行时想发起登录"变成一件做不到的事——
 * 需要人点头的事不该在一次工具调用里发生。
 */
export function runtimeAuthProvider(
  config: McpHttpServer,
  store: McpOAuthStateStore,
): AuthProvider | undefined {
  if (hasOwnAuth(config)) return undefined;
  return adaptOAuthProvider(
    oauthProviderFor(config, {
      store,
      redirectUrl: 'http://127.0.0.1:0/callback',
      onRedirect: () => undefined,
    }),
  );
}

export interface LoginDeps {
  store: McpOAuthStateStore;
  /** 打开浏览器。宿主注入，因为只有它知道这是个桌面应用。 */
  openBrowser: (url: string) => Promise<void> | void;
  /** 等人点头的上限。默认 5 分钟。 */
  timeoutMs?: number;
  /** 用例注入：把"发现授权服务器 / 换 token"那一段换掉——它会发网络请求。 */
  flow?: typeof authorizeMcp;
  /** 用例注入：一个假的回调服务。 */
  callback?: (options: { timeoutMs: number }) => Promise<{
    redirectUrl: string;
    waitForCallback: (state: string) => Promise<{ code: string; iss?: string }>;
    close: () => Promise<void>;
  }>;
}

/**
 * 走一遍登录。返回 `{ ok }` 而不是抛：设置页要能把原因显示成一行红字。
 *
 * 流程就是官方 README 的那一段：先**不带凭据连一次**，撞到 401 才知道要登录、也才知道
 * 授权服务器是谁；然后开浏览器，等回调，拿 code 换 token。
 */
export async function loginMcp(
  config: McpHttpServer,
  deps: LoginDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const timeoutMs = deps.timeoutMs ?? 5 * 60_000;
  const flow = deps.flow ?? authorizeMcp;
  const listen = deps.callback ?? ((options: { timeoutMs: number }) => OAuthCallbackServer.listen(options));
  const callback = await listen({ timeoutMs });

  // 用一个对象装着而不是一个 `let`：`onRedirect` 是在 await 里被调的，
  // 局部变量的窄化会让编译器以为它永远是 undefined。
  const redirect: { url?: URL } = {};
  const provider = oauthProviderFor(config, {
    store: deps.store,
    redirectUrl: callback.redirectUrl,
    onRedirect: (url) => {
      redirect.url = url;
    },
  });

  try {
    // ① 先试一次：已经登录过就直接续上，不必再问人。
    try {
      const outcome = await flow(provider, { serverUrl: config.url });
      if (outcome === 'AUTHORIZED') return { ok: true };
    } catch (error) {
      // 需要人点头的那一类在这里是正常的；别的错误照实说。
      if (!(error instanceof McpOAuthAuthorizationRequiredError) && !redirect.url) throw error;
    }

    // ② 要人点头：先把"等人回来"挂上，再开浏览器——顺序反了会漏掉极快的回调。
    const state = await provider.state();
    const pending = callback.waitForCallback(state);
    if (!redirect.url) {
      // 上面那一步没给出地址（例如服务器只肯在发现阶段告知），再走一次拿到它。
      await flow(provider, { serverUrl: config.url, skipRefresh: true });
    }
    if (!redirect.url) throw new Error('授权服务器没有给出登录地址');
    await deps.openBrowser(redirect.url.toString());

    const { code, iss } = await pending;
    await flow(provider, {
      serverUrl: config.url,
      authorizationCode: code,
      ...(iss ? { iss } : {}),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await callback.close().catch(() => undefined);
  }
}
