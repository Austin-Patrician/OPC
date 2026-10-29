import { describe, expect, it } from 'vitest';
import {
  EMPTY_TOOL_POLICY,
  filterExtensionTools,
  isExtensionEnabled,
  isToolActive,
  normalizeToolPolicy,
  parseToolPolicy,
} from './toolPolicy';

/**
 * The policy is a pair of deny lists. These tests pin the two properties the
 * UI and the registry both rely on: unknown/malformed rows degrade to "all on",
 * and filtering trims tools without touching hooks or tasks.
 */
describe('normalizeToolPolicy', () => {
  it('turns garbage into the default "everything available" policy', () => {
    expect(normalizeToolPolicy(null)).toEqual(EMPTY_TOOL_POLICY);
    expect(normalizeToolPolicy('nope')).toEqual(EMPTY_TOOL_POLICY);
    expect(normalizeToolPolicy({ disabledExtensions: 'opc.image' })).toEqual(EMPTY_TOOL_POLICY);
  });

  it('de-duplicates and drops empty / non-string entries', () => {
    expect(
      normalizeToolPolicy({
        disabledExtensions: ['opc.image', 'opc.image', '', 7, null],
        disabledTools: ['bash', 'bash'],
      }),
    ).toEqual({ disabledExtensions: ['opc.image'], disabledTools: ['bash'] });
  });

  it('reads malformed JSON as the default policy instead of throwing', () => {
    expect(parseToolPolicy('{not json')).toEqual(EMPTY_TOOL_POLICY);
    expect(parseToolPolicy('')).toEqual(EMPTY_TOOL_POLICY);
  });
});

describe('policy checks', () => {
  const policy = { disabledExtensions: ['opc.image'], disabledTools: ['bash'] };

  it('combines the extension and tool deny lists', () => {
    expect(isExtensionEnabled(policy, 'coding-tools')).toBe(true);
    expect(isExtensionEnabled(policy, 'opc.image')).toBe(false);
    expect(isToolActive(policy, 'coding-tools', 'bash')).toBe(false);
    expect(isToolActive(policy, 'coding-tools', 'read')).toBe(true);
    // An extension that is off makes every tool inactive, even an allowed one.
    expect(isToolActive(policy, 'opc.image', 'generate_image')).toBe(false);
  });

  it('filters tools while carrying hooks, tasks and sections over', () => {
    const extension = {
      name: 'coding-tools',
      tools: [{ name: 'bash' }, { name: 'read' }],
      hooks: [{ task: 'pi.tool' }],
      tasks: [{ definition: { name: 'work.task' } }],
    };
    const filtered = filterExtensionTools(extension, policy);

    expect(filtered.tools?.map((tool) => tool.name)).toEqual(['read']);
    expect(filtered.hooks).toBe(extension.hooks);
    expect(filtered.tasks).toBe(extension.tasks);
  });

  it('returns the same object when no tools are denied', () => {
    const extension = { name: 'coding-tools', tools: [{ name: 'bash' }] };
    expect(filterExtensionTools(extension, EMPTY_TOOL_POLICY)).toBe(extension);
  });
});
