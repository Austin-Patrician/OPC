import { afterEach, describe, expect, it } from 'vitest';
import type { JsonRpcMessage, Tool } from '@earendil-works/pi-mcp';
import { createInMemoryTransportPair, type InMemoryTransport } from '@earendil-works/pi-mcp/testing';
import {
  MAX_MCP_TEXT,
  mcpToolName,
  needsApproval,
  truncateMiddle,
  uniqueToolNames,
  type McpServerConfig,
} from './contract';
import { mountMcp, toOutput } from './extension';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import type { McpConnection } from './connection';
import { normalize, readFile } from './config';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setToolApproval } from './policy';

/**
 * MCP：把服务器上的工具变成执行体的工具。
 *
 * 这一层要证明的只有三件事，都不需要连真服务器（`pi-mcp/testing` 给了内存 transport）：
 * 工具名可预测、`deferred` 是默认、结果进上下文之前会被截断。真 stdio 子进程那条路由
 * 探针覆盖（`OPC_MCP_PROBE`）。
 */

/** 一个够用的假服务器：initialize / tools/list / tools/call / resources/*。 */
function fakeServer(transport: InMemoryTransport, tools: Tool[], text = 'pong') {
  const state = { tools: [...tools] };
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  transport.onMessage((message: JsonRpcMessage) => {
    const request = message as { id?: unknown; method?: string; params?: unknown };
    if (request.id === undefined || !request.method) return;
    const id = request.id as never;
    const reply = (result: unknown) => void transport.send({ jsonrpc: '2.0', id, result } as never);

    switch (request.method) {
      case 'initialize':
        reply({
          protocolVersion: '2025-11-25',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'fixture', version: '1.0.0' },
        });
        return;
      case 'tools/list':
        reply({ tools: state.tools });
        return;
      case 'tools/call': {
        const params = request.params as { name: string; arguments?: Record<string, unknown> };
        calls.push({ name: params.name, arguments: params.arguments ?? {} });
        reply({ content: [{ type: 'text', text }] });
        return;
      }
      case 'resources/list':
        reply({ resources: [{ uri: 'mem://doc', name: 'doc', mimeType: 'text/plain' }] });
        return;
      case 'resources/read':
        reply({ contents: [{ uri: 'mem://doc', text: '资源的正文' }] });
        return;
      case 'resources/templates/list':
        reply({ resourceTemplates: [] });
        return;
      default:
        reply({});
    }
  });
  void transport.start();
  return {
    calls,
    state,
    /** 服务器加了工具，然后按协议宣布一声。 */
    async announce(tool: Tool) {
      state.tools.push(tool);
      await transport.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' } as never);
    },
  };
}

const echoTool: Tool = {
  name: 'echo',
  description: '把输入原样吐回来',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  annotations: { readOnlyHint: true },
};

const config = (name = 'fixture'): McpServerConfig => ({ name, command: 'fake' });

/** 用内存 transport 造一个"连上了"的连接。 */
async function connectionWith(tools: Tool[], text = 'pong'): Promise<{
  connection: McpConnection;
  calls: { name: string; arguments: Record<string, unknown> }[];
  announce: (tool: Tool) => Promise<void>;
}> {
  const pair = createInMemoryTransportPair();
  const server = fakeServer(pair.server, tools, text);
  const { McpClient } = await import('@earendil-works/pi-mcp');
  const client = new McpClient({ name: 'test', version: '1' });
  await client.connect(pair.client);
  let list = await client.listTools();
  const resources = await client.listResources();

  return {
    calls: server.calls,
    announce: server.announce,
    connection: {
      config: config(),
      serverInfo: { name: 'fixture', version: '1.0.0' },
      // 和真的 `McpConnection` 一样：刷新之后 `tools` 跟着变（只返回新列表而字段不动，
      // 就是在测一个不存在的实现）。
      get tools() {
        return list;
      },
      resources,
      refreshTools: async () => {
        list = await client.listTools();
        return list;
      },
      onToolsChanged: (listener) => client.onNotification('notifications/tools/list_changed', () => listener()),
      callTool: (name, args) => client.callTool(name, args),
      readResource: (uri) => client.readResource(uri),
      listResourceTemplates: () => client.listResourceTemplates(),
      close: () => client.close(),
    },
  };
}

const live: McpConnection[] = [];
afterEach(async () => {
  for (const connection of live.splice(0)) await connection.close().catch(() => undefined);
});

describe('工具名', () => {
  it('照 pi 的命名法：mcp__<server>__<tool>', () => {
    expect(mcpToolName('github', 'search_code')).toBe('mcp__github__search_code');
  });

  it('奇怪的字符换成下划线：工具名会一路进 schema、轨迹和日志', () => {
    expect(mcpToolName('my-server', 'read.file')).toBe('mcp__my_server__read_file');
  });

  it('撞名的加短哈希：否则后一个会静默盖掉前一个', () => {
    const names = uniqueToolNames([
      { server: 'a', tool: 'search' },
      { server: 'a', tool: 'search' },
    ]);
    expect(names[0]).toBe('mcp__a__search');
    expect(names[1]).toMatch(/^mcp__a__search_.+$/);
    expect(names[0]).not.toBe(names[1]);
  });
});

describe('截断', () => {
  const spill = (text: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opc-mcp-test-'));
    const file = path.join(dir, 'full.txt');
    writeFileSync(file, text);
    return file;
  };

  it('短文本原样给', () => {
    expect(truncateMiddle('pong', { spill })).toEqual({ text: 'pong', dropped: 0 });
  });

  it('长文本挖中间：开头是形状、结尾是结论', () => {
    const text = `${'头'.repeat(MAX_MCP_TEXT)}中间${'尾'.repeat(MAX_MCP_TEXT)}`;
    const result = truncateMiddle(text, { spill });

    expect(result.dropped).toBeGreaterThan(0);
    expect(result.text.startsWith('头')).toBe(true);
    expect(result.text.endsWith('尾')).toBe(true);
    expect(result.text).toContain('中间略去');
    expect(result.spillPath).toBeTruthy();
    expect(result.text.length).toBeLessThan(text.length);
  });
});

describe('要不要先问一句', () => {
  it('服务器说它会破坏东西、或者会伸到外面去，就要问', () => {
    expect(needsApproval({ destructiveHint: true })).toBe(true);
    expect(needsApproval({ openWorldHint: true })).toBe(true);
    expect(needsApproval({ readOnlyHint: true })).toBe(false);
    // 没声明就是没声明：不替服务器担保，也不冤枉它。
    expect(needsApproval(undefined)).toBe(false);
  });
});

describe('挂载', () => {
  it('单工具例外覆盖服务器默认审批策略', async () => {
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'opc-mcp-policy-'));
    const gated = { ...echoTool, annotations: { destructiveHint: true } };
    const { connection } = await connectionWith([gated]);
    live.push(connection);
    setToolApproval(userDataDir, 'fixture', 'echo', true);
    const allowed = await mountMcp({
      servers: [{ ...config(), autoApprove: false }],
      userDataDir,
      connect: async () => connection,
    });
    expect(allowed.extension?.hooks ?? []).toHaveLength(0);
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it('每个工具一个 deferred 工具，名字可预测，说明里带服务器名', async () => {
    const { connection } = await connectionWith([echoTool]);
    live.push(connection);

    const mount = await mountMcp({ servers: [config()], connect: async () => connection });
    const tools = mount.extension?.tools ?? [];

    const echo = tools.find((tool) => tool.name === 'mcp__fixture__echo');
    expect(echo).toBeTruthy();
    expect(echo?.deferred).toBe(true);
    expect(echo?.description).toContain('[fixture]');
  });

  it('自动放行的服务器不会为高影响工具安装审批门', async () => {
    const { connection } = await connectionWith([{ ...echoTool, annotations: { destructiveHint: true } }]);
    live.push(connection);
    const mount = await mountMcp({
      servers: [{ ...config(), autoApprove: true }],
      connect: async () => connection,
    });
    expect(mount.extension?.hooks ?? []).toHaveLength(0);
  });

  it('direct 的服务器不延迟：模型一上手就看得见', async () => {
    const { connection } = await connectionWith([echoTool]);
    live.push(connection);

    const mount = await mountMcp({
      servers: [{ ...config(), exposure: 'direct' }],
      connect: async () => connection,
    });
    expect(mount.extension?.tools?.find((tool) => tool.name === 'mcp__fixture__echo')?.deferred).toBe(
      undefined,
    );
  });

  it('调用真的走到服务器，结果变成模型看得懂的内容', async () => {
    const { connection, calls } = await connectionWith([echoTool], 'pong');
    live.push(connection);

    const mount = await mountMcp({ servers: [config()], connect: async () => connection });
    const echo = mount.extension!.tools!.find((tool) => tool.name === 'mcp__fixture__echo')!;
    const result = await echo.execute({ text: 'hi' }, {} as never, {} as never);

    expect(calls).toEqual([{ name: 'echo', arguments: { text: 'hi' } }]);
    expect(result.output).toEqual([{ type: 'text', text: 'pong' }]);
  });

  it('一个服务器连不上，不影响别的装上', async () => {
    const { connection } = await connectionWith([echoTool]);
    live.push(connection);

    const mount = await mountMcp({
      servers: [config('broken'), config('fixture')],
      connect: async (server) => {
        if (server.name === 'broken') throw new Error('连不上');
        return connection;
      },
    });

    expect(mount.extension?.tools?.some((tool) => tool.name === 'mcp__fixture__echo')).toBe(true);
    expect(mount.servers.find((server) => server.name === 'broken')?.error).toBe('连不上');
  });

  it('一个都没连上就不装扩展：不要往注册表里塞一个空壳', async () => {
    const mount = await mountMcp({
      servers: [config()],
      connect: async () => {
        throw new Error('连不上');
      },
    });
    expect(mount.extension).toBeNull();
  });

  it('有资源的服务器才装资源三件套', async () => {
    const { connection } = await connectionWith([echoTool]);
    live.push(connection);

    const mount = await mountMcp({ servers: [config()], connect: async () => connection });
    const names = (mount.extension?.tools ?? []).map((tool) => tool.name);
    expect(names).toContain('list_mcp_resources');
    expect(names).toContain('read_mcp_resource');
  });

  it('提示词里只说"有这些服务器"，不列工具名——列了就等于把 schema 塞回去', async () => {
    const { connection } = await connectionWith([echoTool]);
    live.push(connection);

    const mount = await mountMcp({
      servers: [{ ...config(), description: '文件与代码搜索' }],
      connect: async () => connection,
    });
    const rendered = mount.extension!.sections![0]!.render({} as never, {} as never) ?? '';

    expect(rendered).toContain('fixture');
    expect(rendered).toContain('文件与代码搜索');
    expect(rendered).not.toContain('echo');
    expect(rendered).toContain('tool_search');
  });

  it('同一个 tool_search 可以发现并调用任意名称的 MCP 服务器工具', async () => {
    const alpha = await connectionWith([echoTool], 'alpha result');
    const beta = await connectionWith([echoTool], 'beta result');
    live.push(alpha.connection, beta.connection);

    const mount = await mountMcp({
      servers: [config('alpha'), config('beta')],
      connect: async (server) => (server.name === 'alpha' ? alpha.connection : beta.connection),
    });
    const mountedTools = mount.extension?.tools ?? [];
    const search = createToolSearchExtension().tools?.[0];
    expect(search).toBeTruthy();

    const searchResult = await search!.execute(
      { query: 'beta', limit: 1 },
      {
        agent: async () => ({
          deferred: mountedTools.filter((tool) => tool.deferred === true),
        }),
      } as never,
      {} as never,
    );

    expect(searchResult.control?.addTools).toEqual(['mcp__beta__echo']);
    const betaTool = mountedTools.find((tool) => tool.name === 'mcp__beta__echo');
    expect(betaTool).toBeTruthy();
    await betaTool!.execute({ text: '动态发现' }, {} as never, {} as never);
    expect(beta.calls).toEqual([{ name: 'echo', arguments: { text: '动态发现' } }]);
    expect(alpha.calls).toEqual([]);
  });
});

describe('服务器换了工具', () => {
  it('它一说变了，就重读目录并造一份新的，交给宿主替换', async () => {
    const { connection, announce } = await connectionWith([echoTool]);
    live.push(connection);

    const refreshed: { name: string }[] = [];
    await mountMcp({
      servers: [config()],
      connect: async () => connection,
      onToolsChanged: (extension) => {
        for (const tool of extension.tools ?? []) refreshed.push({ name: tool.name });
      },
    });

    await announce({ name: 'poke', inputSchema: { type: 'object' } });

    // 通知是异步的：等它落到我们的回调上。
    for (let index = 0; index < 100 && !refreshed.some((tool) => tool.name === 'mcp__fixture__poke'); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(refreshed.map((tool) => tool.name)).toContain('mcp__fixture__poke');
  });
});

describe('结果转换', () => {
  it('图片、音频、资源链接都变成模型读得懂的块', () => {
    const blocks = toOutput(
      [
        { type: 'image', data: 'AAA', mimeType: 'image/png' },
        { type: 'audio', data: 'BBB', mimeType: 'audio/wav' },
        { type: 'resource_link', uri: 'mem://x', name: 'x' },
      ],
      undefined,
    );
    expect(blocks[0]).toEqual({ type: 'image', data: 'AAA', mimeType: 'image/png' });
    expect(blocks[1]).toMatchObject({ type: 'text' });
    expect(blocks[2]).toMatchObject({ type: 'text' });
  });

  it('没有 content 只有 structuredContent：JSON 也算结果', () => {
    const blocks = toOutput([], { total: 3 });
    expect(blocks[0]).toMatchObject({ type: 'text' });
    expect((blocks[0] as { text: string }).text).toContain('"total": 3');
  });

  it('什么都没有也说一句，不留空', () => {
    expect(toOutput([], undefined)[0]).toMatchObject({ type: 'text' });
  });
});

describe('配置文件', () => {
  it('认 mcpServers 的两种形状，允许注释', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opc-mcp-cfg-'));
    const file = path.join(dir, 'mcp.json');
    writeFileSync(
      file,
      `{
        // 本地服务器
        "mcpServers": {
          "fs": { "command": "npx", "args": ["-y", "server-fs"], "env": { "A": "1" } },
          "docs": { "url": "https://example.com/mcp", "description": "文档" }
        }
      }`,
    );
    const servers = readFile(file) ?? [];
    expect(servers).toHaveLength(2);
    expect(servers.find((server) => server.name === 'fs')).toMatchObject({
      command: 'npx',
      args: ['-y', 'server-fs'],
      env: { A: '1' },
    });
    expect(servers.find((server) => server.name === 'docs')).toMatchObject({ url: 'https://example.com/mcp' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('坏条目跳过，不让一条写错的配置把所有服务器都弄没', () => {
    expect(normalize('x', { type: 'sse', url: 'https://x/sse' })).toBeNull();
    expect(normalize('y', {})).toBeNull();
    expect(normalize('z', { command: 'node', enabled: false })).toMatchObject({ enabled: false });
  });
});
