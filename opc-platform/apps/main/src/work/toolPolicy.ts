import type { ToolPolicy } from '@opc/shared/domain';

/**
 * The one place that decides what a stored tool policy means.
 *
 * Both the worker (`WorkService.buildRegistry`) and the stack page read through
 * these helpers, so the page can never describe a tool the model does not get.
 * The policy is a pair of deny lists: empty means "everything the runtime can
 * install", which keeps new extensions available to existing employees.
 */

export const EMPTY_TOOL_POLICY: ToolPolicy = {
  disabledExtensions: [],
  disabledTools: [],
};

function cleanNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0),
    ),
  ];
}

/** Tolerates legacy / hand-edited JSON instead of throwing on a bad row. */
export function normalizeToolPolicy(value: unknown): ToolPolicy {
  if (!value || typeof value !== 'object') return { ...EMPTY_TOOL_POLICY };
  const raw = value as Record<string, unknown>;
  return {
    disabledExtensions: cleanNames(raw.disabledExtensions),
    disabledTools: cleanNames(raw.disabledTools),
  };
}

export function parseToolPolicy(json: string | null | undefined): ToolPolicy {
  if (!json) return { ...EMPTY_TOOL_POLICY };
  try {
    return normalizeToolPolicy(JSON.parse(json));
  } catch {
    return { ...EMPTY_TOOL_POLICY };
  }
}

export function isExtensionEnabled(policy: ToolPolicy, extensionName: string): boolean {
  return !policy.disabledExtensions.includes(extensionName);
}

/**
 * 一条拒绝规则是否命中某个工具名。
 *
 * 结尾的 `*` 是前缀匹配：`mcp__github__*` 关掉一个 MCP 服务器的全部工具，而不必在
 * 服务器加了一个工具之后回来补一条。这也是 pi 自己的写法（`--tools 'mcp__radius__*'`）。
 */
export function toolMatches(pattern: string, toolName: string): boolean {
  return pattern.endsWith('*') ? toolName.startsWith(pattern.slice(0, -1)) : pattern === toolName;
}

export function isToolEnabled(policy: ToolPolicy, toolName: string): boolean {
  return !policy.disabledTools.some((pattern) => toolMatches(pattern, toolName));
}

/** Effective state used by the UI and the registry alike. */
export function isToolActive(
  policy: ToolPolicy,
  extensionName: string,
  toolName: string,
): boolean {
  return isExtensionEnabled(policy, extensionName) && isToolEnabled(policy, toolName);
}

/**
 * Narrows an installed extension to the tools this employee may call.
 *
 * Rebuilding the object (rather than mutating) keeps the original extension
 * factory result immutable and works for extension objects that are frozen.
 * Hooks, tasks and sections are carried over untouched: this trims the model's
 * menu, it does not change the policy the extension enforces.
 */
export function filterExtensionTools<T extends { tools?: readonly { name: string }[] }>(
  extension: T,
  policy: ToolPolicy,
): T {
  if (policy.disabledTools.length === 0 || !extension.tools) return extension;
  return {
    ...extension,
    tools: extension.tools.filter(
      (tool) => !policy.disabledTools.some((pattern) => toolMatches(pattern, tool.name)),
    ),
  };
}
