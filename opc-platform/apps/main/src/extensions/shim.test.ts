import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { loadPiExtension } from './shim';

/**
 * These tests run jiti for real: a Pi extension is TypeScript that imports the
 * coding-agent package, and the whole point of the shim is that such a file
 * loads unchanged. Faking the importer here would test nothing.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'opc-shim-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(name: string, source: string) {
  const entry = path.join(root, `${name}.ts`);
  writeFileSync(entry, source, 'utf8');
  return entry;
}

/** Just enough of `ToolExecutionApi` for the adapter. */
function fakeApi(overrides: Partial<ToolExecutionApi> = {}) {
  const output: string[] = [];
  const diagnostics: { severity: string; message: string }[] = [];
  const api = {
    callId: 'call-1',
    conversationId: 'conv-1',
    output: (chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') output.push(chunk);
    },
    diagnostic: (value: { severity: string; message: string }) => diagnostics.push(value),
    ...overrides,
  } as unknown as ToolExecutionApi;
  return { api, output, diagnostics };
}

describe('loadPiExtension', () => {
  it('lowers registerTool to a pi-durable tool with the same schema and result', async () => {
    const entry = write(
      'greet',
      `
        import { Type } from 'typebox';
        export default function (pi: any) {
          pi.registerTool({
            name: 'greet',
            label: 'Greet',
            description: 'Greet someone',
            parameters: Type.Object({ name: Type.String() }),
            async execute(_id: string, params: { name: string }) {
              return { content: [{ type: 'text', text: 'Hello, ' + params.name }], details: { greeted: true } };
            },
          });
        }
      `,
    );

    const loaded = await loadPiExtension(entry, { name: 'pi.greet', dir: root });
    expect(loaded.tools).toEqual(['greet']);
    expect(loaded.extension.name).toBe('pi.greet');

    const tool = loaded.extension.tools![0]!;
    expect(tool.name).toBe('greet');
    expect(tool.description).toBe('Greet someone');

    const { api } = fakeApi();
    const result = await tool.execute({ name: 'Ada' }, api, {} as never);
    expect(result.output).toEqual([{ type: 'text', text: 'Hello, Ada' }]);
    expect(result.details).toEqual({ greeted: true });
  });

  it('turns a tool_call handler into a ToolTask beforeTool hook that can block', async () => {
    const entry = write(
      'guard',
      `
        import { isToolCallEventType } from '@earendil-works/pi-coding-agent';
        import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
        export default function (pi: ExtensionAPI) {
          pi.on('tool_call', async (event: any) => {
            if (isToolCallEventType('bash', event) && String(event.input.command).includes('rm -rf')) {
              return { block: true, reason: 'no destructive commands' };
            }
            return undefined;
          });
        }
      `,
    );

    const loaded = await loadPiExtension(entry, { name: 'pi.guard', dir: root });
    expect(loaded.events).toEqual(['tool_call']);
    expect(loaded.unsupported).toEqual([]);

    const handlers = loaded.extension.hooks![0]!.handlers as {
      beforeTool(call: unknown, api: unknown, context: unknown): Promise<unknown>;
    };

    expect(
      await handlers.beforeTool({ id: '1', name: 'bash', arguments: { command: 'rm -rf /' } }, {}, {}),
    ).toEqual({ block: 'no destructive commands' });
    expect(
      await handlers.beforeTool({ id: '2', name: 'bash', arguments: { command: 'ls' } }, {}, {}),
    ).toBeUndefined();
  });

  it('records unsupported APIs instead of aborting the load', async () => {
    const entry = write(
      'mixed',
      `
        export default function (pi: any) {
          pi.on('session_start', async () => {});
          pi.registerProvider('local', {});
          pi.registerCommand('hello', { handler: () => {} });
          pi.registerTool({
            name: 'ping',
            description: 'ping',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
          });
        }
      `,
    );

    const loaded = await loadPiExtension(entry, { name: 'pi.mixed', dir: root });

    expect(loaded.tools).toEqual(['ping']);
    expect(loaded.commands).toEqual(['hello']);
    expect(loaded.unsupported).toEqual(
      expect.arrayContaining(['event:session_start', 'registerProvider']),
    );
  });

  it('fails closed when an extension asks for a UI dialog', async () => {
    const entry = write(
      'dialog',
      `
        export default function (pi: any) {
          pi.registerTool({
            name: 'ask',
            description: 'ask',
            parameters: { type: 'object', properties: {} },
            async execute(_id: string, _params: unknown, _signal: unknown, _update: unknown, ctx: any) {
              const ok = await ctx.ui.confirm('Sure?', 'Really?');
              return { content: [{ type: 'text', text: String(ok) }] };
            },
          });
        }
      `,
    );

    const loaded = await loadPiExtension(entry, { name: 'pi.dialog', dir: root });
    const { api, diagnostics } = fakeApi();
    const result = await loaded.extension.tools![0]!.execute({}, api, {} as never);

    expect(result.output).toEqual([{ type: 'text', text: 'false' }]);
    expect(diagnostics.some((entry) => entry.message.includes('ctx.ui.confirm'))).toBe(true);
  });

  it('reports a module without a default factory', async () => {
    const entry = write('empty', 'export const nothing = 1;');
    await expect(loadPiExtension(entry, { name: 'pi.empty', dir: root })).rejects.toThrow(/默认导出/);
  });
});
