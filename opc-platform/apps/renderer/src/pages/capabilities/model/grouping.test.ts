import { describe, expect, it } from 'vitest';
import type { AgentCapability, CapabilityExtension, CapabilityTool } from '@opc/shared/ipc';
import { distinctToolNames, groupExtensions, toToolGroups, toolAgentCounts } from './grouping';

/**
 * The two tabs read the same snapshot through these helpers, so a bug here shows
 * up as "the Extensions tab says 7 agents, the Tools tab says 6".
 */

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
  employeeId: id,
  name: id,
  role: '工程师',
  level: 'P5',
  model: '',
  avatar: '',
  departmentId: 'd1',
  departmentName: '工程部',
  isHead: false,
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

  it('keeps the widest hook/task/section counts across employees', () => {
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

  it('returns nothing for a company with no agents', () => {
    expect(groupExtensions([])).toEqual([]);
  });
});

describe('toToolGroups', () => {
  it('drops the extension-only fields and keeps tools and agent count', () => {
    const groups = groupExtensions([
      agent('a', [extension('opc.work', { tasks: 1 })], []),
    ]);

    expect(toToolGroups(groups)).toEqual([{ name: 'opc.work', tools: [], agents: 1 }]);
  });
});

describe('toolAgentCounts', () => {
  it('counts how many agents can call each tool', () => {
    const counts = toolAgentCounts([
      agent('a', [], [tool('read', 'coding-tools'), tool('decide', 'opc.decision')]),
      agent('b', [], [tool('read', 'coding-tools')]),
    ]);

    expect(counts.get('read')).toBe(2);
    expect(counts.get('decide')).toBe(1);
    expect(counts.get('bash')).toBeUndefined();
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
