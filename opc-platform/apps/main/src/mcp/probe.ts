import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeAllMcpConnections } from './connection';
import { mountMcp } from './extension';
import type { McpServerConfig } from './contract';

/**
 * 探针：真的起一个 stdio 子进程当 MCP 服务器，连上、列工具、调一次。
 *
 * 内存 transport 的用例证明的是"我们的映射对不对"；这个探针证明的是**能连上真进程**——
 * 子进程、stdin/stdout 上的 JSON 行、initialize 握手、退出时收得干净。两件事不一样，
 * 少了后面这条，"接完整"就只是类型完整。
 */

export interface McpProbeResult {
  ok: boolean;
  server: string;
  tools: string[];
  /** 真调到了一次工具，结果是什么。 */
  answer: string;
  /** 调完之后子进程有没有被收掉。 */
  closed: boolean;
  elapsedMs: number;
  error?: string;
}

/**
 * 一个够用的 MCP 服务器：只实现 initialize / tools/list / tools/call。
 *
 * 写成一段字符串而不是仓库里的 .mjs：它是探针的零件，不该出现在构建产物里，也不该
 * 有人以为它是产品代码。
 */
const FIXTURE = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue; // notification：不答
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    switch (message.method) {
      case 'initialize':
        reply({
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'opc-fixture', version: '1.0.0' },
        });
        break;
      case 'tools/list':
        reply({
          tools: [
            {
              name: 'echo',
              description: '把这个字符串原样返回',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            },
          ],
        });
        break;
      case 'tools/call':
        reply({ content: [{ type: 'text', text: 'echo: ' + String(message.params?.arguments?.text ?? '') }] });
        break;
      default:
        reply({});
    }
  }
});
`;

export async function probeMcp(): Promise<McpProbeResult> {
  const startedAt = Date.now();
  const dir = mkdtempSync(path.join(tmpdir(), 'opc-mcp-probe-'));
  const result: McpProbeResult = {
    ok: false,
    server: 'opc-fixture',
    tools: [],
    answer: '',
    closed: false,
    elapsedMs: 0,
  };

  try {
    const fixture = path.join(dir, 'server.mjs');
    writeFileSync(fixture, FIXTURE, 'utf8');

    const config: McpServerConfig = {
      name: 'fixture',
      // `process.execPath` 在 Electron 里是 Electron 自己，不是 node：不设
      // `ELECTRON_RUN_AS_NODE` 的话，这个"子进程"会去开一个窗口，然后一直不写 stdout。
      command: process.execPath,
      args: [fixture],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      exposure: 'deferred',
      timeoutSeconds: 20,
    };

    const mount = await mountMcp({ servers: [config] });
    try {
      const names = (mount.extension?.tools ?? []).map((tool) => tool.name);
      result.tools = names;
      const echo = mount.extension?.tools?.find((tool) => tool.name === 'mcp__fixture__echo');
      if (!echo) throw new Error(`没挂上 echo 工具（拿到：${names.join('、') || '空'}）`);

      const called = await echo.execute({ text: '你好' }, {} as never, {} as never);
      result.answer =
        (called.output ?? [])
          .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
          .join('\n') || '';

      result.ok = result.answer.includes('你好') && names.includes('mcp__fixture__echo');
      return result;
    } finally {
      await mount.close();
      await closeAllMcpConnections();
      // 子进程收干净了吗：进程表里不该还留着一个跑我们的 fixture 的 node。
      result.closed = !hasFixtureProcess(fixture);
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  } finally {
    result.elapsedMs = Date.now() - startedAt;
    rmSync(dir, { recursive: true, force: true });
  }
}

function hasFixtureProcess(fixture: string): boolean {
  try {
    const output = execFileSync('ps', ['-Ao', 'command'], { encoding: 'utf8' });
    return output.includes(fixture) && !output.includes('ps -Ao');
  } catch {
    // 拿不到进程表就别下结论：探针不该因为查不了而判自己失败。
    return false;
  }
}
