import type { EmployeeToolPolicy } from '@opc/shared/domain';

/**
 * The one place that decides what a stored tool policy means.
 *
 * Both the worker (`WorkService.buildRegistry`) and the stack page read through
 * these helpers, so the page can never describe a tool the model does not get.
 * The policy is a pair of deny lists: empty means "everything the runtime can
 * install", which keeps new extensions available to existing employees.
 */

export const EMPTY_TOOL_POLICY: EmployeeToolPolicy = {
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
export function normalizeToolPolicy(value: unknown): EmployeeToolPolicy {
  if (!value || typeof value !== 'object') return { ...EMPTY_TOOL_POLICY };
  const raw = value as Record<string, unknown>;
  return {
    disabledExtensions: cleanNames(raw.disabledExtensions),
    disabledTools: cleanNames(raw.disabledTools),
  };
}

export function parseToolPolicy(json: string | null | undefined): EmployeeToolPolicy {
  if (!json) return { ...EMPTY_TOOL_POLICY };
  try {
    return normalizeToolPolicy(JSON.parse(json));
  } catch {
    return { ...EMPTY_TOOL_POLICY };
  }
}

export function isExtensionEnabled(policy: EmployeeToolPolicy, extensionName: string): boolean {
  return !policy.disabledExtensions.includes(extensionName);
}

export function isToolEnabled(policy: EmployeeToolPolicy, toolName: string): boolean {
  return !policy.disabledTools.includes(toolName);
}

/** Effective state used by the UI and the registry alike. */
export function isToolActive(
  policy: EmployeeToolPolicy,
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
  policy: EmployeeToolPolicy,
): T {
  if (policy.disabledTools.length === 0 || !extension.tools) return extension;
  const disabled = new Set(policy.disabledTools);
  return { ...extension, tools: extension.tools.filter((tool) => !disabled.has(tool.name)) };
}
