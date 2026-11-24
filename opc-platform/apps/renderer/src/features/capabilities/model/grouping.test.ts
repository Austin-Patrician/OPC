import { describe, expect, it } from 'vitest';
import type { AgentCapability, CapabilityExtension, CapabilityTool } from '@opc/shared/ipc';
import { distinctToolNames, groupExtensions } from './grouping';

const tool = (name: string, extension: string, deferred = false): CapabilityTool => ({
  name,
  description: `${name} does things.`,
  extension,
  deferred,
});

const extension = (name: string, overrides: Partial<CapabilityExtension> = {}): CapabilityExtension => ({
  name,
  tools: [],
  hooks: 0,
  tasks: 0,
  sections: 0,
  ...overrides,
});

const agent = (id: string, extensions: CapabilityExtension[], tools: CapabilityTool[]): AgentCapability => ({
  workerId: id,
  name: id,
  template: 'code',
  status: 'idle',
  model: '',
  skills: [],
  extensions,
  tools,
});

describe('groupExtensions', () => {
  it('lists an extension once and counts the agents that install it', () => {
    const coding = extension('coding-tools');
    const groups = groupExtensions([
      agent('a', [coding], [tool('read', 'coding-tools'), tool('bash', 'coding-tools')]),
      agent('b', [coding], [tool('read', 'coding-tools')]),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ name: 'coding-tools', agents: 2 });
    expect(groups[0]!.tools.map((entry) => entry.name)).toEqual(['read', 'bash']);
  });

  it('keeps the widest hook/task/section counts across execution bodies', () => {
    const groups = groupExtensions([
      agent('a', [extension('opc.sandbox', { hooks: 1 })], []),
      agent('b', [extension('opc.sandbox', { hooks: 2, sections: 1 })], []),
    ]);

    expect(groups[0]).toMatchObject({ hooks: 2, sections: 1 });
  });

  it('never borrows a tool from another extension', () => {
    const groups = groupExtensions([
      agent(
        'a',
        [extension('coding-tools'), extension('opc.memory')],
        [tool('read', 'coding-tools'), tool('remember', 'opc.memory')],
      ),
    ]);

    expect(groups.map((group) => [group.name, group.tools.map((entry) => entry.name)])).toEqual([
      ['coding-tools', ['read']],
      ['opc.memory', ['remember']],
    ]);
  });

  it('excludes opc.mcp and local pi.* extensions from built-in groups', () => {
    const groups = groupExtensions([
      agent(
        'a',
        [extension('coding-tools'), extension('opc.mcp'), extension('pi.custom-ext')],
        [
          tool('read', 'coding-tools'),
          tool('github__search', 'opc.mcp', true),
          tool('custom_op', 'pi.custom-ext'),
        ],
      ),
    ]);

    expect(groups.map((group) => group.name)).toEqual(['coding-tools']);
    expect(distinctToolNames(groups)).toEqual(new Set(['read']));
  });

  it('returns nothing for a company with no agents', () => {
    expect(groupExtensions([])).toEqual([]);
  });
});

describe('distinctToolNames', () => {
  it('does not double count a tool shared by two extensions', () => {
    const groups = groupExtensions([
      agent('a', [extension('x'), extension('y')], [tool('read', 'x'), tool('read', 'y')]),
    ]);

    expect(distinctToolNames(groups).size).toBe(1);
  });
});
