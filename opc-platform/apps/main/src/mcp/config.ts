import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpExposure, McpServerConfig } from './contract';

/**
 * 服务器配置从哪来。
 *
 * 先读**我们自己的** `mcp.json`（在 userData 下），再读 pi 的 `~/.pi/agent/mcp.json`——
 * 后者是白送的：用过 pi 的人不必再填一遍，而两份配置的形状是同一个（MCP 生态的
 * `mcpServers`）。同名时我们的赢：那是这个人在这台机器上为**这个应用**做的选择。
 *
 * 不读项目目录下的 `.mcp.json`：那是"仓库自带"的配置，打开一个陌生仓库就连上它声明的
 * 服务器，等于让 clone 变成一次安装。
 */
export function readMcpConfig(options: { userDataDir: string; homeDir?: string }): {
  servers: McpServerConfig[];
  sources: string[];
} {
  const home = options.homeDir ?? os.homedir();
  const sources = [
    path.join(options.userDataDir, 'mcp.json'),
    path.join(home, '.pi', 'agent', 'mcp.json'),
  ];

  const servers = new Map<string, McpServerConfig>();
  const used: string[] = [];

  // 后面的赢，所以从低优先级的开始读。
  for (const file of [...sources].reverse()) {
    const parsed = readFile(file);
    if (!parsed) continue;
    used.unshift(file);
    for (const server of parsed) servers.set(server.name, server);
  }

  return { servers: [...servers.values()], sources: used };
}

/** 一个文件里的 `mcpServers`。坏条目跳过并留一句警告——一条配置写错不该让所有服务器消失。 */
export function readFile(file: string): McpServerConfig[] | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonComments(text));
  } catch (error) {
    console.warn(`[mcp] ${file} 不是合法 JSON，跳过`, error);
    return null;
  }

  const table = (raw as { mcpServers?: unknown })?.mcpServers;
  if (!table || typeof table !== 'object') return [];

  const servers: McpServerConfig[] = [];
  for (const [name, value] of Object.entries(table as Record<string, unknown>)) {
    const server = normalize(name, value);
    if (server) servers.push(server);
  }
  return servers;
}

/** 条目 → 我们的形状。认不出来的条目返回 null（并说一句为什么）。 */
export function normalize(name: string, value: unknown): McpServerConfig | null {
  if (!value || typeof value !== 'object') {
    console.warn(`[mcp] ${name}：配置不是一个对象，跳过`);
    return null;
  }
  const entry = value as Record<string, unknown>;
  const common = {
    name,
    ...(entry.enabled === false ? { enabled: false } : {}),
    ...(isExposure(entry.exposure) ? { exposure: entry.exposure } : {}),
    ...(typeof entry.timeoutSeconds === 'number' ? { timeoutSeconds: entry.timeoutSeconds } : {}),
    ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
  };

  // SSE 明确不支持（pi 也是）：声明了 sse 的服务器通常也提供 streamable HTTP。
  if (entry.type === 'sse') {
    console.warn(`[mcp] ${name}：不支持 SSE，用它的 streamable HTTP 地址（通常是 /mcp）`);
    return null;
  }

  if (typeof entry.url === 'string') {
    const headers = stringRecord(entry.headers);
    return { ...common, url: entry.url, ...(headers ? { headers } : {}) };
  }

  if (typeof entry.command === 'string') {
    const args = Array.isArray(entry.args) ? entry.args.filter((item): item is string => typeof item === 'string') : undefined;
    const env = stringRecord(entry.env);
    return {
      ...common,
      command: entry.command,
      ...(args && args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
      ...(typeof entry.cwd === 'string' ? { cwd: expandHome(entry.cwd) } : {}),
    };
  }

  console.warn(`[mcp] ${name}：既没有 command 也没有 url，跳过`);
  return null;
}

function isExposure(value: unknown): value is McpExposure {
  return value === 'deferred' || value === 'direct' || value === 'hidden';
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (pair): pair is [string, string] => typeof pair[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** `~/x` → `$HOME/x`。命令、参数、cwd 里都允许。 */
function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** 配置是给人手写的，允许注释（JSONC 的那一半）。 */
function stripJsonComments(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}
