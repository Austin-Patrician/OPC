import {
  McpClient,
  StdioTransport,
  StreamableHttpTransport,
  type CallToolResult,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  type Tool,
} from '@earendil-works/pi-mcp';
import { isStdioServer, type McpServerConfig } from './contract';
import { McpAuthStore, authFile, runtimeAuthProvider } from './auth';

/**
 * 一个 MCP 服务器的连接。
 *
 * 三件事在这里定下来，都是代价换来的：
 *
 * 1. **连接是懒的吗？不，是"一次性、可复用"的。** 每个服务器一份进程级连接（`shared`），
 *    而不是每件活一份：一百个执行体各连一次同一个服务器，等于一百个子进程。
 * 2. **工具有缓存。** `tools/list` 只是拿来注册工具，不必每次调用重发。
 * 3. **关得不含糊。** `close()` 拒绝新调用、中断在途的、关掉 transport——stdio 服务器
 *    是子进程，漏一个就是漏一个进程。
 */

export interface McpConnection {
  readonly config: McpServerConfig;
  /** 服务器自报的身份，用来在界面上说"连上了谁"。 */
  readonly serverInfo: { name: string; version: string } | undefined;
  /** 连接时读到的工具目录。 */
  /** 当前目录。服务器宣布变了之后，这里跟着变（见 `refreshTools`）。 */
  readonly tools: readonly Tool[];
  readonly resources: readonly Resource[];
  /** 重新读一遍目录。`notifications/tools/list_changed` 来了就调它。 */
  refreshTools(): Promise<readonly Tool[]>;
  /** 服务器说它的工具变了。返回撤销订阅。 */
  onToolsChanged(listener: () => void): () => void;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  readResource(uri: string): Promise<ReadResourceResult>;
  listResourceTemplates(): Promise<readonly ResourceTemplate[]>;
  close(): Promise<void>;
}

const CLIENT_INFO = { name: 'opc', version: '0.1.0' } as const;

/**
 * OAuth 的状态文件。没有配置就没有 OAuth——匿名能连的服务器照连。
 *
 * 用模块级而不是构造参数：`connectMcp` 是被四条路径共用的（建注册表、测试、探针、
 * 登录后重连），把 userData 一路传下去只会让每个调用方都多知道一件与它无关的事。
 */
let authStore: string | null = null;

export function configureMcpAuth(userDataDir: string): void {
  authStore = authFile(userDataDir);
}

/** 连上并读完工具与资源目录。失败就抛：调用方决定"这一个坏了"还是"整个都别用"。 */
export async function connectMcp(
  config: McpServerConfig,
  options: { signal?: AbortSignal } = {},
): Promise<McpConnection> {
  const client = new McpClient({
    ...CLIENT_INFO,
    requestTimeoutMs: Math.max(1, config.timeoutSeconds ?? 60) * 1000,
  });

  const transport = isStdioServer(config)
    ? new StdioTransport({
        command: config.command,
        ...(config.args ? { args: config.args } : {}),
        ...(config.env ? { env: config.env } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
        // stderr 收着而不是直接吐到我们的终端：服务器崩掉时，最后几十行 stderr 是
        // 唯一能说清"它为什么崩"的东西，而它常常不是我们的输出。
        stderr: 'pipe',
      })
    : new StreamableHttpTransport({
        url: config.url,
        ...(config.headers ? { headers: config.headers } : {}),
        // 有 `Authorization` 头就说明它自带凭据，OAuth 不该插手（那会把 401 变成登录流程）。
        ...(() => {
          const provider = authStore
            ? runtimeAuthProvider(config, new McpAuthStore(authStore, config.name))
            : undefined;
          return provider ? { authProvider: provider } : {};
        })(),
      });

  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }

  const request = { ...(options.signal ? { signal: options.signal } : {}) };
  const tools = await client.listTools(request);
  // 资源是可选的：服务器没声明这项能力就不去问（问了也是一颗空炮）。
  const supportsResources = client.serverCapabilities?.resources !== undefined;
  const resources = supportsResources ? await client.listResources(request) : [];

  const info = client.serverInfo;
  let current: readonly Tool[] = tools;

  return {
    config,
    serverInfo: info ? { name: info.name, version: info.version } : undefined,
    get tools() {
      return current;
    },
    resources,
    refreshTools: async () => {
      current = await client.listTools(request);
      return current;
    },
    onToolsChanged: (listener) =>
      client.onNotification('notifications/tools/list_changed', () => listener()),
    callTool: (name, args) => client.callTool(name, args, request),
    readResource: (uri) => client.readResource(uri, request),
    listResourceTemplates: () => client.listResourceTemplates(request),
    close: async () => {
      await client.close();
    },
  };
}

/**
 * 服务器配置 → 连接。同一份配置在一个进程里只连一次。
 *
 * 键取名字 + 配置本身：改了命令或 URL 就是另一个服务器，旧连接留着只会让人困惑。
 */
const shared = new Map<string, Promise<McpConnection>>();

const keyOf = (config: McpServerConfig): string =>
  `${config.name}:${isStdioServer(config) ? `${config.command} ${(config.args ?? []).join(' ')}` : config.url}`;

export function sharedMcpConnection(config: McpServerConfig): Promise<McpConnection> {
  const key = keyOf(config);
  const existing = shared.get(key);
  if (existing) return existing;

  const opened = connectMcp(config);
  shared.set(key, opened);
  // 连不上就别把它缓存成一个永远失败的 promise：下次改完配置要能重试。
  opened.catch(() => shared.delete(key));
  return opened;
}

/** 关掉所有共享连接（退出时调；测试里也用）。 */
export async function closeAllMcpConnections(): Promise<void> {
  const opening = [...shared.values()];
  shared.clear();
  for (const pending of opening) {
    try {
      const connection = await pending;
      await connection.close();
    } catch {
      // 本来就没连上：没有要关的。
    }
  }
}

/** 只为用例：注入一个连接工厂，并在每次用完清空缓存。 */
export function resetMcpConnectionsForTests(): void {
  shared.clear();
}
