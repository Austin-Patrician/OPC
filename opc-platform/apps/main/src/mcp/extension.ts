import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineExtension, defineTool, section, type Extension, type ToolExecutionResult } from '@earendil-works/pi-durable';
import type { ContentBlock } from '@earendil-works/pi-mcp';
import {
  exposureOf,
  isEnabled,
  needsApproval,
  truncateMiddle,
  uniqueToolNames,
  type McpServerConfig,
} from './contract';
import { approvalHook } from './approval';
import { sharedMcpConnection, type McpConnection } from './connection';

/**
 * MCP 挂进执行体的方式。
 *
 * 形状照抄 pi 内置 MCP（`pi.dev/docs/latest/mcp`）：`mcp__<server>__<tool>`，默认
 * `deferred`（`tool_search` 搜到才进上下文），一个服务器可以整体 `hidden`。
 *
 * 这里只做"把服务器的工具变成我们的工具"，不发明协议：连接、目录、调用、资源都在
 * `@earendil-works/pi-mcp` 里，那是官方独立客户端。
 */

export interface McpServerStatus {
  name: string;
  tools: number;
  resources: number;
  /** 连不上时的原因。一个服务器坏了不影响别的。 */
  error?: string;
}

export interface McpMount {
  /** 没有任何可用服务器时为 null（不必往注册表里装一个空扩展）。 */
  extension: Extension | null;
  servers: McpServerStatus[];
  /**
   * 服务器换了工具时，把重新造好的扩展交给这里去**就地替换**。
   *
   * 是一个可设置的字段而不是构造参数：一个执行体的注册表会被重建（换栈、改配置），
   * 而挂载是复用的——每次重建都把这里指向新的那一个注册表。
   */
  refreshTarget?: (extension: Extension) => void;
  close: () => Promise<void>;
}

/** 全文落到哪里。和 pi 一样：超过上限就把全文存盘，模型拿路径。 */
const SPILL_DIR = path.join(os.tmpdir(), 'opc-mcp');

function spillToFile(text: string): string {
  fs.mkdirSync(SPILL_DIR, { recursive: true });
  const file = path.join(SPILL_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

/**
 * 挂载。**同步等所有服务器连上**（每台各有自己的超时），因为工具必须在注册表建好之前
 * 就位——pi 的 deferred 工具是注册表里的东西，不是运行时凭空长出来的。
 *
 * 代价照实说：一个服务器卡住会拖慢建注册表。所以每台服务器的连接超时由它自己的
 * `timeoutSeconds` 管，坏了的那台只会记一条 `error`，不会阻止别的装上。
 */
export async function mountMcp(input: {
  servers: readonly McpServerConfig[];
  connect?: (config: McpServerConfig) => Promise<McpConnection>;
  /**
   * 服务器宣布工具变了之后，重新造好的那一份扩展交给它去**就地替换**。
   *
   * 不替换的话，模型会一直看着一份过期的工具列表：新加的搜不到，删掉的点了报"未知工具"
   * ——而这两件事它都不会说，它只会换条路走。
   */
  onToolsChanged?: (extension: Extension) => void;
}): Promise<McpMount> {
  const connect = input.connect ?? sharedMcpConnection;
  /*
   * 默认连接是**进程级共享**的（`sharedMcpConnection`）：一百个执行体连同一个服务器，
   * 等于一百个子进程。共享的东西不该由某一次挂载关掉——所以只有调用方自己给了
   * `connect`（测试、探针）时才归它所有。
   */
  const ownsConnections = input.connect !== undefined;
  const statuses: McpServerStatus[] = [];
  const opened: McpConnection[] = [];

  const enabled = input.servers.filter(isEnabled);
  const results = await Promise.all(
    enabled.map(async (config) => {
      try {
        const connection = await connect(config);
        opened.push(connection);
        return { config, connection };
      } catch (error) {
        statuses.push({
          name: config.name,
          tools: 0,
          resources: 0,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }),
  );

  const live = results.filter((entry): entry is { config: McpServerConfig; connection: McpConnection } => entry !== null);
  if (live.length === 0) {
    return { extension: null, servers: statuses, close: async () => undefined };
  }

  /**
   * 造一次扩展。第一次挂载造一次；服务器宣布工具变了之后再造一次——**同一个函数**，
   * 所以"热更新"和"启动时"这两条路不可能长出两套不同的映射规则。
   */
  const build = (): Extension => {
    // 工具名可能撞（两个服务器都有 `search`）。撞了加短哈希，而不是让后一个静默覆盖前一个。
    const flat = live.flatMap((entry) =>
      entry.connection.tools.map((tool) => ({
        server: entry.config.name,
        tool,
        connection: entry.connection,
        config: entry.config,
      })),
    );
    const names = uniqueToolNames(flat.map((entry) => ({ server: entry.server, tool: entry.tool.name })));

    /** 要人点头的那些：工具名 → 给人看的一行。空表就不装 hook。 */
    const gated = new Map<string, string>();
    const tools = flat.map((entry, index) => {
      const name = names[index]!;
      const exposure = exposureOf(entry.config);
      const description = entry.tool.description ?? entry.tool.title ?? entry.tool.name;
      // 服务器自己声明的后果（`destructiveHint` / `openWorldHint`）——不是我们猜的。
      if (needsApproval(entry.tool.annotations)) {
        gated.set(name, `[${entry.server}] ${entry.tool.title ?? entry.tool.name}`);
      }
      return defineTool({
        name,
        // 说明里带服务器名：模型在 `tool_search` 的结果里要能看出"这是谁的 search"。
        description: `[${entry.server}] ${description}`,
        parameters: entry.tool.inputSchema,
        // `deferred`：先搜到再调用。这是 pi 对 MCP 的默认，理由很直接——一个服务器
        // 十来个工具的 schema 就是几千 token，而大多数轮次一个都用不上。
        ...(exposure === 'direct' ? {} : { deferred: true as const }),
        execute: async (args: unknown): Promise<ToolExecutionResult> => {
          const result = await entry.connection.callTool(
            entry.tool.name,
            (args ?? {}) as Record<string, unknown>,
          );
          return {
            ...(result.isError === true ? { isError: true } : {}),
            output: toOutput(result.content, result.structuredContent),
          };
        },
      });
    });

    // 资源：任一服务器声明了 resources 才装这三件（不然就是三颗空炮）。
    if (live.some((entry) => entry.connection.resources.length > 0)) {
      tools.push(...resourceTools(live));
    }

    // 状态表就地更新：界面上那一行"几个工具"跟着目录变。
    // 只改**连上的**那几台——连不上的那些行（带着 error）要留着，不然界面上会变成
    // "这台服务器不存在了"，而实际上它只是没起来。
    for (const entry of live) {
      const row = statuses.find((status) => status.name === entry.config.name);
      const tools = entry.connection.tools.length;
      const resources = entry.connection.resources.length;
      if (row) {
        row.tools = tools;
        row.resources = resources;
      } else {
        statuses.push({ name: entry.config.name, tools, resources });
      }
    }

    const summary = live
      .map((entry) => {
        const description = entry.config.description?.trim();
        const counts = `${entry.connection.tools.length} 个工具`;
        return `- ${entry.config.name}（${counts}）${description ? `：${description}` : ''}`;
      })
      .join('\n');

    const approval = approvalHook(gated);
    return defineExtension({
      name: 'opc.mcp',
      tools,
      ...(approval ? { hooks: [approval] } : {}),
      // 一个短段落告诉模型"还有这些外部能力"。不列工具名：那正是 `deferred` 要避免的，
      // 列了就等于把 schema 的一半又塞回上下文。
      sections: [
        section('mcp_servers', () =>
          [
            '## 接入的外部能力（MCP）',
            '下面这些服务器的工具**不在**你的工具列表里，要用 `tool_search` 搜出来再调。',
            summary,
          ].join('\n'),
        ),
      ],
    });
  };

  let extension = build();

  /*
   * 服务器换了工具（`notifications/tools/list_changed`）：重读目录、再造一份扩展，
   * 交给宿主去**就地替换**注册表里的那一份。
   *
   * 不替换的话，模型会一直看着一份过期的工具列表：新加的搜不到，删掉的点了报"未知工具"。
   * 而这两件事它都不会说，它只会换条路走——你看到的是"它怎么不用那个工具"。
   */
  const unsubscribes = live.map((entry) =>
    entry.connection.onToolsChanged(() => {
      void (async () => {
        try {
          await entry.connection.refreshTools();
          extension = build();
          input.onToolsChanged?.(extension);
          mount.refreshTarget?.(extension);
        } catch (error) {
          console.warn(`[mcp] ${entry.config.name} 的工具目录没刷新成功`, error);
        }
      })();
    }),
  );

  const mount: McpMount = {
    extension,
    servers: statuses,
    close: async () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      if (!ownsConnections) return;
      for (const connection of opened) await connection.close().catch(() => undefined);
    },
  };
  return mount;
}

/**
 * MCP 的一段结果 → 模型看得懂的内容。
 *
 * 一条规则最要紧：**文本超过 20 KB 就把中间挖掉**。整段塞进去，这一轮之后模型就什么都
 * 看不见了；挖中间而不是截尾，是因为开头是形状、结尾是结论，中间是可以再查的细节。
 */
export function toOutput(
  content: readonly ContentBlock[],
  structured: unknown,
): NonNullable<ToolExecutionResult['output']> {
  const blocks: NonNullable<ToolExecutionResult['output']> = [];

  for (const block of content) {
    switch (block.type) {
      case 'text': {
        const clipped = truncateMiddle(block.text, { spill: spillToFile });
        blocks.push({ type: 'text', text: clipped.text });
        break;
      }
      case 'image':
        blocks.push({ type: 'image', data: block.data, mimeType: block.mimeType });
        break;
      case 'audio':
        blocks.push({ type: 'text', text: `（服务器返回了一段音频：${block.mimeType}，这里放不了）` });
        break;
      case 'resource_link':
        blocks.push({ type: 'text', text: `资源：${block.uri}${block.name ? `（${block.name}）` : ''}` });
        break;
      case 'resource': {
        const resource = block.resource;
        if ('text' in resource) {
          const clipped = truncateMiddle(resource.text, { spill: spillToFile });
          blocks.push({ type: 'text', text: `${resource.uri}\n${clipped.text}` });
        } else {
          blocks.push({
            type: 'text',
            text: `（二进制资源 ${resource.uri}，${resource.mimeType ?? '未知类型'}，这里放不了）`,
          });
        }
        break;
      }
    }
  }

  // 没有 content 但有 structuredContent：服务器只是懒得渲染成人话。
  if (blocks.length === 0 && structured !== undefined) {
    const text = JSON.stringify(structured, null, 2) ?? '';
    blocks.push({ type: 'text', text: truncateMiddle(text, { spill: spillToFile }).text });
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '（服务器没有返回内容）' });

  return blocks;
}

/** 资源三件套。名字和 pi 内置的那三个一样，免得同一个能力有两个叫法。 */
function resourceTools(
  live: readonly { config: McpServerConfig; connection: McpConnection }[],
) {
  const byName = new Map(live.map((entry) => [entry.config.name, entry.connection]));
  const pick = (server: string | undefined): McpConnection[] => {
    if (server) {
      const one = byName.get(server);
      if (!one) throw new Error(`没有这个服务器：${server}`);
      return [one];
    }
    return [...byName.values()];
  };

  const deferred = live.every((entry) => exposureOf(entry.config) !== 'direct');

  return [
    defineTool({
      name: 'list_mcp_resources',
      description:
        '列出 MCP 服务器上可读的资源（文件、文档、条目）。这是"那份东西在哪"，不是它的内容。',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: '只看某一个服务器，不填就是全部' },
        },
      },
      ...(deferred ? { deferred: true as const } : {}),
      execute: async (args: unknown): Promise<ToolExecutionResult> => {
        const input = (args ?? {}) as { server?: string };
        const rows: { server: string; uri: string; name: string; mimeType?: string }[] = [];
        for (const connection of pick(input.server)) {
          for (const resource of connection.resources) {
            rows.push({
              server: connection.config.name,
              uri: resource.uri,
              name: resource.name,
              ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
            });
          }
        }
        return { output: [{ type: 'text', text: JSON.stringify({ resources: rows }, null, 2) }] };
      },
    }),
    defineTool({
      name: 'read_mcp_resource',
      description: '读一个 MCP 资源的正文。先 `list_mcp_resources` 拿到 server 与 uri。',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: '哪个服务器' },
          uri: { type: 'string', description: '资源地址' },
        },
        required: ['server', 'uri'],
      },
      ...(deferred ? { deferred: true as const } : {}),
      execute: async (args: unknown): Promise<ToolExecutionResult> => {
        const input = (args ?? {}) as { server?: string; uri?: string };
        if (!input.uri) {
          return { isError: true, output: [{ type: 'text', text: '要读哪个资源？给一个 uri。' }] };
        }
        const [connection] = pick(input.server);
        if (!connection) {
          return { isError: true, output: [{ type: 'text', text: '没有可读的资源服务器' }] };
        }
        const read = await connection.readResource(input.uri);
        const blocks: NonNullable<ToolExecutionResult['output']> = [];
        for (const item of read.contents) {
          if ('text' in item) {
            blocks.push({ type: 'text', text: truncateMiddle(item.text, { spill: spillToFile }).text });
          } else {
            blocks.push({ type: 'text', text: `（二进制资源 ${item.uri}，${item.mimeType ?? '未知类型'}）` });
          }
        }
        return { output: blocks.length > 0 ? blocks : [{ type: 'text', text: '（资源是空的）' }] };
      },
    }),
  ];
}
