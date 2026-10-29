import type { AgentCapability, CapabilityTool } from '@opc/shared/ipc';

/**
 * Pure aggregation for the 技能与工具 page.
 *
 * The page has two questions to answer and they need different shapes:
 *   - the 扩展 tab asks "what is installed", so it wants one row per extension;
 *   - the 工具 tab asks "what can the model call", so it wants one row per tool.
 *
 * Both are derived from the same per-agent snapshot, which is why this lives
 * outside the components: the two tabs can never disagree about a tool name or
 * an install count.
 */

export interface ExtensionGroup {
  name: string;
  tools: CapabilityTool[];
  /** How many agents install this extension. */
  agents: number;
  hooks: number;
  tasks: number;
  sections: number;
}

export interface ToolGroup {
  /** Extension that provides the tools, used as the section header. */
  name: string;
  tools: CapabilityTool[];
  agents: number;
}

/** Union of what every agent installed, in the order the first agent had them. */
export function groupExtensions(agents: readonly AgentCapability[]): ExtensionGroup[] {
  const groups = new Map<string, ExtensionGroup>();

  for (const agent of agents) {
    for (const extension of agent.extensions) {
      const group = groups.get(extension.name) ?? {
        name: extension.name,
        tools: [],
        agents: 0,
        hooks: 0,
        tasks: 0,
        sections: 0,
      };
      group.agents += 1;
      // A registry can differ per employee, so take the widest shape seen.
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

/** The 工具 tab's view: the same data, with the extension fields dropped. */
export function toToolGroups(groups: readonly ExtensionGroup[]): ToolGroup[] {
  return groups.map(({ name, tools, agents }) => ({ name, tools, agents }));
}

/** tool name → how many agents can call it. */
export function toolAgentCounts(agents: readonly AgentCapability[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    for (const tool of agent.tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  }
  return counts;
}

/** Distinct tool names across every agent — the headline number. */
export function distinctToolNames(groups: readonly ExtensionGroup[]): Set<string> {
  return new Set(groups.flatMap((group) => group.tools.map((tool) => tool.name)));
}
