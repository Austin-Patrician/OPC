import fs from 'node:fs';
import path from 'node:path';

/** Per-tool approval overrides are deliberately kept outside mcp.json. */
export interface McpApprovalPolicy {
  servers: Record<string, Record<string, boolean>>;
}

const fileName = (userDataDir: string) => path.join(userDataDir, 'mcp-approval.json');

export function readApprovalPolicy(userDataDir: string): McpApprovalPolicy {
  try {
    const raw = JSON.parse(fs.readFileSync(fileName(userDataDir), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return { servers: {} };
    const servers: Record<string, Record<string, boolean>> = {};
    for (const [server, value] of Object.entries((raw as { servers?: unknown }).servers ?? {})) {
      if (!value || typeof value !== 'object') continue;
      const tools: Record<string, boolean> = {};
      for (const [tool, enabled] of Object.entries(value as Record<string, unknown>)) {
        if (typeof enabled === 'boolean') tools[tool] = enabled;
      }
      if (Object.keys(tools).length > 0) servers[server] = tools;
    }
    return { servers };
  } catch {
    return { servers: {} };
  }
}

export function toolApproval(
  policy: McpApprovalPolicy,
  server: string,
  tool: string,
  fallback: boolean,
): boolean {
  return policy.servers[server]?.[tool] ?? fallback;
}

export function setToolApproval(
  userDataDir: string,
  server: string,
  tool: string,
  enabled: boolean | null,
): McpApprovalPolicy {
  const policy = readApprovalPolicy(userDataDir);
  const tools = { ...(policy.servers[server] ?? {}) };
  if (enabled === null) delete tools[tool];
  else tools[tool] = enabled;
  const servers = { ...policy.servers };
  if (Object.keys(tools).length > 0) servers[server] = tools;
  else delete servers[server];
  writeApprovalPolicy(userDataDir, { servers });
  return { servers };
}

export function clearServerToolApprovals(userDataDir: string, server: string): McpApprovalPolicy {
  const policy = readApprovalPolicy(userDataDir);
  const servers = { ...policy.servers };
  delete servers[server];
  writeApprovalPolicy(userDataDir, { servers });
  return { servers };
}

/** Drop exceptions for tools that disappeared or are no longer marked high-impact. */
export function retainServerToolApprovals(
  userDataDir: string,
  server: string,
  toolNames: ReadonlySet<string>,
): McpApprovalPolicy {
  const policy = readApprovalPolicy(userDataDir);
  const tools = Object.fromEntries(
    Object.entries(policy.servers[server] ?? {}).filter(([tool]) => toolNames.has(tool)),
  );
  const servers = { ...policy.servers };
  if (Object.keys(tools).length > 0) servers[server] = tools;
  else delete servers[server];
  writeApprovalPolicy(userDataDir, { servers });
  return { servers };
}

function writeApprovalPolicy(userDataDir: string, policy: McpApprovalPolicy): void {
  const file = fileName(userDataDir);
  if (Object.keys(policy.servers).length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
}
