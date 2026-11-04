import type { ToolAnnotations } from '@earendil-works/pi-mcp';

/**
 * MCP 的服务器配置与命名规则。
 *
 * 形状照抄 pi 的 `mcp.json`（那是这套生态里公认的写法），所以**已有的配置能直接拿来用**：
 * 用过 pi / Cursor / Claude Code 的人不用重填一遍。我们只多三个字段（`enabled` /
 * `exposure` / `timeoutSeconds`），它们决定工具怎么到模型面前。
 */

export type McpExposure = 'deferred' | 'direct' | 'hidden';

interface Common {
  /** 服务器名。工具名是 `mcp__<server>__<tool>`，所以它只能用字母、数字、`_`、`-`。 */
  name: string;
  enabled?: boolean;
  /**
   * 工具怎么到模型面前：
   * - `deferred`（默认）：先 `tool_search` 搜到，再调用。几百个工具也不占上下文；
   * - `direct`：像内置工具一样直接摆出来。只适合小而常用的几件；
   * - `hidden`：注册了但拿不到。先关掉一个服务器而不删配置用它。
   */
  exposure?: McpExposure;
  timeoutSeconds?: number;
  /** 一句话说明它提供什么。`tool_search` 和提示词都用它。 */
  description?: string;
}

export interface McpStdioServer extends Common {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpServer extends Common {
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServer | McpHttpServer;

export const isStdioServer = (server: McpServerConfig): server is McpStdioServer =>
  typeof (server as McpStdioServer).command === 'string';

export const isEnabled = (server: McpServerConfig): boolean => server.enabled !== false;

export const exposureOf = (server: McpServerConfig): McpExposure => server.exposure ?? 'deferred';

/** 工具名前缀。命名法照抄 pi：`mcp__<server>__<tool>`。 */
export const MCP_PREFIX = 'mcp__';

/**
 * 一个 MCP 工具在我们这里的名字。
 *
 * 只留字母、数字、`_`：工具名会进 JSON Schema 的 key、进轨迹、进日志，一处允许奇怪字符，
 * 四面都要处理。撞名由 `uniqueToolNames` 兜。
 */
export function mcpToolName(server: string, tool: string): string {
  return `${MCP_PREFIX}${sanitize(server)}__${sanitize(tool)}`;
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * 撞名时后面加一个短哈希。
 *
 * 不这么做，"两个工具都叫 search"会在注册表里静默覆盖掉一个——而模型看到的是它少的
 * 那一半能力，没人会收到错误。
 */
export function uniqueToolNames(entries: readonly { server: string; tool: string }[]): string[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const base = mcpToolName(entry.server, entry.tool);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${shortHash(`${entry.server}/${entry.tool}/${count}`)}`;
  });
}

function shortHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 4);
}

/**
 * 一次工具结果的上限。超过就把中间挖掉，全文另存。
 *
 * 和 pi 内置 MCP 同一个数：一个工具吐回一份 200 KB 的 JSON 是常态，整段塞进上下文等于
 * 让这一轮之后什么都看不见。挖中间而不是截尾：开头是形状、结尾是结论，中间是可以再查的
 * 细节。
 */
export const MAX_MCP_TEXT = 20_000;

export interface Truncated {
  text: string;
  /** 全文被存到哪里；没超限时为 undefined。 */
  spillPath?: string;
  /** 挖掉了多少字符。 */
  dropped: number;
}

export function truncateMiddle(
  text: string,
  options: { max?: number; spill: (text: string) => string },
): Truncated {
  const max = options.max ?? MAX_MCP_TEXT;
  if (text.length <= max) return { text, dropped: 0 };

  const keep = Math.floor((max - 80) / 2);
  const head = text.slice(0, keep);
  const tail = text.slice(-keep);
  const dropped = text.length - keep * 2;
  const spillPath = options.spill(text);
  return {
    text: `${head}\n…（中间略去 ${dropped} 字符，全文在 ${spillPath}）…\n${tail}`,
    spillPath,
    dropped,
  };
}

/**
 * 这个工具要不要先问一句。
 *
 * MCP 服务器会声明 `destructiveHint` / `openWorldHint`——**这是服务器自己说的话**，
 * 不是我们猜的。真正的许可票在 `mcp/approval.ts`（M3），这里只把判断单独拿出来，
 * 好让"为什么拦它"能被测。
 */
export function needsApproval(annotations: ToolAnnotations | undefined): boolean {
  if (!annotations) return false;
  return annotations.destructiveHint === true || annotations.openWorldHint === true;
}
