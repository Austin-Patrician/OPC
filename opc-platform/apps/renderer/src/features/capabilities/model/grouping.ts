import type { AgentCapability, CapabilityTool } from '@opc/shared/ipc';

/**
 * Pure aggregation for the 扩展 settings page.
 *
 * Groups built-in capability modules across executors while keeping MCP
 * (`opc.mcp`) and local Pi extensions (`pi.*`) isolated to their dedicated
 * management views.
 */

const EXCLUDED_BUILTIN_EXTENSIONS = new Set(['opc.mcp']);

export interface ExtensionGroup {
  name: string;
  tools: CapabilityTool[];
  /** How many agents install this extension. */
  agents: number;
  hooks: number;
  tasks: number;
  sections: number;
}

/** Union of built-in modules every execution body installed, in first-seen order. */
export function groupExtensions(agents: readonly AgentCapability[]): ExtensionGroup[] {
  const groups = new Map<string, ExtensionGroup>();

  for (const agent of agents) {
    for (const extension of agent.extensions) {
      if (EXCLUDED_BUILTIN_EXTENSIONS.has(extension.name) || extension.name.startsWith('pi.')) {
        continue;
      }
      const group = groups.get(extension.name) ?? {
        name: extension.name,
        tools: [],
        agents: 0,
        hooks: 0,
        tasks: 0,
        sections: 0,
      };
      group.agents += 1;
      // A registry can differ per execution body, so take the widest shape seen.
      group.hooks = Math.max(group.hooks, extension.hooks);
      group.tasks = Math.max(group.tasks, extension.tasks);
      group.sections = Math.max(group.sections, extension.sections);
      for (const tool of agent.tools) {
        if (tool.extension !== extension.name) continue;
        if (!group.tools.some((entry) => entry.name === tool.name)) group.tools.push(tool);
      }
      groups.set(extension.name, group);
    }
  }

  return [...groups.values()];
}

/** Distinct non-MCP built-in tool names across every agent. */
export function distinctToolNames(groups: readonly ExtensionGroup[]): Set<string> {
  return new Set(groups.flatMap((group) => group.tools.map((tool) => tool.name)));
}
