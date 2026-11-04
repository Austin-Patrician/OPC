import fs from 'node:fs';
import path from 'node:path';
import {
  exposureOf,
  isEnabled,
  isStdioServer,
  type McpExposure,
  type McpServerConfig,
} from './contract';
import { readFile, readMcpConfig } from './config';
import { connectMcp, type McpConnection } from './connection';

/**
 * MCP 服务器的那一页（M2）。
 *
 * 存储还是那个文件——`<userData>/mcp.json`。**不用数据库**：这份配置是 MCP 生态的公共
 * 格式，手写得、能进版本库、换台机器拷过去就能用。设置页只是它的一个编辑器，不是它的
 * 所有者。
 */

/** 界面上的一行。`tools` / `resources` 只有测过之后才有。 */
export interface McpServerView {
  name: string;
  transport: 'stdio' | 'http';
  /** 「npx -y server-fs」或 URL：一行里能认出它连的是什么。 */
  target: string;
  enabled: boolean;
  exposure: McpExposure;
  description?: string;
  tools?: number;
  resources?: number;
  /** 探测失败的原因。一个服务器坏了只是一行红字。 */
  error?: string;
}

const fileName = (userDataDir: string) => path.join(userDataDir, 'mcp.json');

/** 列出配置（不连接）。`sources` 说明当前生效的是哪几个文件。 */
export function listServers(options: { userDataDir: string; homeDir?: string }): {
  servers: McpServerView[];
  sources: string[];
} {
  const { servers, sources } = readMcpConfig(options);
  return { servers: servers.map(toView), sources };
}

export function toView(config: McpServerConfig): McpServerView {
  return {
    name: config.name,
    transport: isStdioServer(config) ? 'stdio' : 'http',
    target: isStdioServer(config)
      ? [config.command, ...(config.args ?? [])].join(' ')
      : config.url,
    enabled: isEnabled(config),
    exposure: exposureOf(config),
    ...(config.description ? { description: config.description } : {}),
  };
}

/**
 * 测一台：连上、读目录、断开。
 *
 * 用**独立连接**而不是共享池：设置页点一下"测试"不该在进程里留下一条连接，也不该让
 * 一个错误的配置污染正在干活的那一份。
 */
export async function testServer(
  config: McpServerConfig,
  connect: (config: McpServerConfig) => Promise<McpConnection> = connectMcp,
): Promise<McpServerView> {
  const view = toView(config);
  let connection: McpConnection | null = null;
  try {
    connection = await connect(config);
    return { ...view, tools: connection.tools.length, resources: connection.resources.length };
  } catch (error) {
    return { ...view, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await connection?.close().catch(() => undefined);
  }
}

/** 写入或改一台。返回写入后的完整清单（界面的来源就是它）。 */
export function saveServer(
  options: { userDataDir: string; homeDir?: string },
  config: McpServerConfig,
): { servers: McpServerView[]; sources: string[] } {
  const file = fileName(options.userDataDir);
  const current = readFile(file) ?? [];
  const next = [...current.filter((server) => server.name !== config.name), config];
  writeServers(file, next);
  return listServers(options);
}

export function removeServer(
  options: { userDataDir: string; homeDir?: string },
  name: string,
): { servers: McpServerView[]; sources: string[] } {
  const file = fileName(options.userDataDir);
  const current = readFile(file) ?? [];
  writeServers(
    file,
    current.filter((server) => server.name !== name),
  );
  return listServers(options);
}

/**
 * 写回文件。
 *
 * 删掉只剩 `mcpServers: {}` 的文件没有意义，所以空了就删文件——不然界面会显示"读到了
 * 一个空的 mcp.json"，让人以为哪里坏了。
 */
function writeServers(file: string, servers: readonly McpServerConfig[]): void {
  if (servers.length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  const table: Record<string, unknown> = {};
  for (const server of servers) table[server.name] = toEntry(server);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ mcpServers: table }, null, 2)}\n`, 'utf8');
}

/** 我们的形状 → 文件里的形状。字段名就是 pi 的那一套，所以两边通用。 */
export function toEntry(config: McpServerConfig): Record<string, unknown> {
  const common = {
    ...(config.enabled === false ? { enabled: false } : {}),
    ...(config.exposure ? { exposure: config.exposure } : {}),
    ...(config.timeoutSeconds ? { timeoutSeconds: config.timeoutSeconds } : {}),
    ...(config.description ? { description: config.description } : {}),
  };
  if (isStdioServer(config)) {
    return {
      command: config.command,
      ...(config.args && config.args.length > 0 ? { args: config.args } : {}),
      ...(config.env ? { env: config.env } : {}),
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...common,
    };
  }
  return { url: config.url, ...(config.headers ? { headers: config.headers } : {}), ...common };
}
