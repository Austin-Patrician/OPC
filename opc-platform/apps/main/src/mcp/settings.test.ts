import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listServers, removeServer, saveServer, testServer } from './settings';
import type { McpConnection } from './connection';
import type { McpServerConfig } from './contract';

/**
 * 设置页背后的那份文件（M2）。
 *
 * 存储故意留在 `mcp.json`：那是 MCP 生态的公共格式，手写得、能进版本库、换台机器拷过去
 * 就能用。这一组锁的是**别把它写坏**——写坏一次，界面上就是"服务器都不见了"。
 */
let userData: string;
let home: string;

beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'opc-mcp-user-'));
  home = mkdtempSync(path.join(tmpdir(), 'opc-mcp-home-'));
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const options = () => ({ userDataDir: userData, homeDir: home });

describe('服务器的增删改', () => {
  it('写进去、读回来，形状不丢', () => {
    saveServer(options(), {
      name: 'fs',
      command: 'npx',
      args: ['-y', 'server-fs'],
      exposure: 'direct',
      description: '本机文件',
    });

    const { servers } = listServers(options());
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: 'fs',
      transport: 'stdio',
      target: 'npx -y server-fs',
      enabled: true,
      exposure: 'direct',
      description: '本机文件',
    });
  });

  it('同名是改，不是加一条', () => {
    saveServer(options(), { name: 'fs', command: 'npx', args: ['a'] });
    saveServer(options(), { name: 'fs', command: 'node', args: ['b'] });
    expect(listServers(options()).servers).toHaveLength(1);
    expect(listServers(options()).servers[0]?.target).toBe('node b');
  });

  it('删掉最后一台，文件也不留——空文件会让人以为哪里坏了', () => {
    saveServer(options(), { name: 'fs', command: 'npx' });
    removeServer(options(), 'fs');
    expect(listServers(options()).servers).toHaveLength(0);
    expect(() => readFileSync(path.join(userData, 'mcp.json'), 'utf8')).toThrow();
  });

  it('HTTP 服务器写 url，不写 command', () => {
    saveServer(options(), { name: 'docs', url: 'https://example.com/mcp' });
    const raw = JSON.parse(readFileSync(path.join(userData, 'mcp.json'), 'utf8'));
    expect(raw.mcpServers.docs).toMatchObject({ url: 'https://example.com/mcp' });
    expect(raw.mcpServers.docs.command).toBeUndefined();
  });

  it('我们自己的配置文件赢过 pi 那一份（同名时）', () => {
    mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      path.join(home, '.pi', 'agent', 'mcp.json'),
      JSON.stringify({ mcpServers: { fs: { command: 'pi-version' }, only: { command: 'x' } } }),
    );
    saveServer(options(), { name: 'fs', command: 'ours' });

    const { servers, sources } = listServers(options());
    expect(servers.find((server) => server.name === 'fs')?.target).toBe('ours');
    // pi 那份里独有的仍然在：读它是白送的，不是覆盖。
    expect(servers.find((server) => server.name === 'only')).toBeTruthy();
    expect(sources).toHaveLength(2);
  });
});

describe('测一台服务器', () => {
  const config: McpServerConfig = { name: 'fs', command: 'npx' };

  it('通了就报工具与资源的数量', async () => {
    const view = await testServer(config, async () => fakeConnection(3, 1));
    expect(view).toMatchObject({ tools: 3, resources: 1 });
    expect(view.error).toBeUndefined();
  });

  it('连不上就说原因，不说"失败"两个字', async () => {
    const view = await testServer(config, async () => {
      throw new Error('spawn npx ENOENT');
    });
    expect(view.error).toBe('spawn npx ENOENT');
  });

  it('测完一定把连接关掉：设置页点一下不该在进程里留一条连接', async () => {
    let closed = false;
    const connection = fakeConnection(1, 0, () => {
      closed = true;
    });
    await testServer(config, async () => connection);
    expect(closed).toBe(true);
  });
});

function fakeConnection(tools: number, resources: number, onClose = () => undefined): McpConnection {
  return {
    config: { name: 'fs', command: 'npx' },
    serverInfo: { name: 'fake', version: '1' },
    tools: Array.from({ length: tools }, (_, index) => ({
      name: `t${index}`,
      inputSchema: { type: 'object' },
    })),
    resources: Array.from({ length: resources }, (_, index) => ({
      uri: `mem://${index}`,
      name: `r${index}`,
    })),
    callTool: async () => ({ content: [] }),
    readResource: async () => ({ contents: [] }),
    listResourceTemplates: async () => [],
    close: async () => onClose(),
  };
}
