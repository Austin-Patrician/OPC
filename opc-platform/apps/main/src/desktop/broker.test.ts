import { describe, expect, it, vi } from 'vitest';
import type { McpConnection } from '../mcp/connection';
import {
  createReconnectingDesktopMcpConnection,
  desktopCommandOptions,
  desktopSessionId,
  desktopSessionName,
  extractExecErrorOutput,
  parseCurrentUserSid,
} from './broker';

describe('desktop CLI behavior', () => {
  it('passes arbitrary application identifiers through to agent-desktop', () => {
    expect(desktopCommandOptions('snapshot', 'com.example.AnyApp')).toEqual(['--app', 'com.example.AnyApp']);
  });

  it('places application and window selectors only on commands that support them', () => {
    expect(desktopCommandOptions('snapshot', 'TextEdit', 'window-1')).toEqual(['--app', 'TextEdit', '--window-id', 'window-1']);
    expect(desktopCommandOptions('focus-window', 'TextEdit', 'window-1')).toEqual(['--app', 'TextEdit', '--window-id', 'window-1']);
    expect(desktopCommandOptions('click', 'TextEdit', 'window-1')).toEqual([]);
  });

  it('accepts only a successful native session id', () => {
    expect(desktopSessionId({ ok: true, text: '', data: { session_id: 'native-123' } })).toBe('native-123');
    expect(desktopSessionId({ ok: true, text: '', data: { session_id: '  ' } })).toBeUndefined();
    expect(desktopSessionId({ ok: true, text: '', data: {} })).toBeUndefined();
    expect(desktopSessionId({ ok: false, text: 'runtime unavailable', data: { session_id: 'native-123' } })).toBeUndefined();
  });

  it('keeps native session names isolated when task ids sanitize to the same prefix', () => {
    expect(desktopSessionName('a/b')).not.toBe(desktopSessionName('a_b'));
    expect(desktopSessionName('a/b')).toMatch(/^opc-a_b-[a-f0-9]{12}$/);
  });

  it('preserves child_process JSON stdout when an agent-desktop command fails', () => {
    const err = Object.assign(new Error('Command failed: agent-desktop.exe session start'), {
      stdout: '{"ok":false,"error":{"code":"INTERNAL","message":"private file DACL grants an untrusted principal"}}',
      stderr: '',
    });
    const extracted = extractExecErrorOutput(err);
    expect(extracted.stdout).toContain('private file DACL grants an untrusted principal');
    expect(extracted.stderr).toContain('Command failed');
  });

  it('parses the Windows user SID from whoami CSV output', () => {
    expect(parseCurrentUserSid('"DESKTOP-0PQNUUF\\admin","S-1-5-21-12345-67890-1001"\r\n')).toBe('S-1-5-21-12345-67890-1001');
    expect(parseCurrentUserSid('')).toBeUndefined();
  });

  it('reconnects agent-desktop MCP seamlessly when a session disconnects mid-task', async () => {
    let opened = 0;
    let disconnectCount = 0;
    let reconnectCount = 0;
    const closeListeners: Array<() => void> = [];
    const connections: Array<{ closed: boolean }> = [];

    const makeConn = (generation: number): McpConnection => {
      const state = { closed: false };
      connections.push(state);
      return {
        config: { name: 'agent_desktop_worker', command: 'agent-desktop', args: ['mcp'] },
        serverInfo: { name: 'agent-desktop', version: '1.2.0' },
        tools: [{ name: 'snapshot', inputSchema: { type: 'object', properties: {} } }],
        resources: [],
        refreshTools: async () => [],
        onToolsChanged: () => () => undefined,
        onClose: (listener) => {
          closeListeners.push(listener);
          return () => undefined;
        },
        callTool: vi.fn(async (name: string) => {
          if (generation === 1 && state.closed) {
            const error = new Error('MCP connection closed');
            error.name = 'McpConnectionClosedError';
            throw error;
          }
          return { content: [{ type: 'text' as const, text: `${name}:gen${generation}` }] };
        }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => [],
        close: async () => {
          state.closed = true;
        },
      };
    };

    const proxy = await createReconnectingDesktopMcpConnection({
      open: async () => {
        opened += 1;
        return makeConn(opened);
      },
      onDisconnect: () => {
        disconnectCount += 1;
      },
      onReconnect: () => {
        reconnectCount += 1;
      },
    });

    const first = await proxy.callTool('snapshot', {});
    expect(first.content[0]).toEqual({ type: 'text', text: 'snapshot:gen1' });

    // Simulate the stdio pipe dying unexpectedly mid-task.
    connections[0]!.closed = true;
    closeListeners[0]?.();
    expect(disconnectCount).toBe(1);

    const recovered = await proxy.callTool('click', {});
    expect(recovered.content[0]).toEqual({ type: 'text', text: 'click:gen2' });
    expect(opened).toBe(2);
    expect(reconnectCount).toBe(1);

    await proxy.close();
    expect(connections[1]!.closed).toBe(true);
    await expect(proxy.callTool('snapshot', {})).rejects.toThrow(/已关闭/);
  });

  it('retries once on a fresh agent-desktop session when callTool hits McpConnectionClosedError mid-call', async () => {
    let generation = 0;
    const closedFlags: boolean[] = [];

    const proxy = await createReconnectingDesktopMcpConnection({
      open: async () => {
        generation += 1;
        const currentGen = generation;
        const state = { closed: false };
        closedFlags.push(false);
        return {
          config: { name: 'agent_desktop_worker', command: 'agent-desktop', args: ['mcp'] },
          serverInfo: { name: 'agent-desktop', version: '1.2.0' },
          tools: [{ name: 'click', inputSchema: { type: 'object', properties: {} } }],
          resources: [],
          refreshTools: async () => [],
          onToolsChanged: () => () => undefined,
          callTool: async (name: string) => {
            if (currentGen === 1) {
              const error = new Error('MCP connection closed');
              error.name = 'McpConnectionClosedError';
              throw error;
            }
            return { content: [{ type: 'text', text: `${name}:recovered` }] };
          },
          readResource: async () => ({ contents: [] }),
          listResourceTemplates: async () => [],
          close: async () => {
            state.closed = true;
            closedFlags[currentGen - 1] = true;
          },
        };
      },
    });

    const result = await proxy.callTool('click', {});
    expect(result.content[0]).toEqual({ type: 'text', text: 'click:recovered' });
    expect(generation).toBe(2);
    expect(closedFlags[0]).toBe(true);
    await proxy.close();
  });
});
