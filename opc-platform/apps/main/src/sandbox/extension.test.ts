import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HookApi, ToolHookCall } from '@earendil-works/pi-durable';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSandboxExtension, type SandboxExtensionOptions } from './extension';
import { registerSandboxWorkspace } from './workspaces';

type BeforeToolHandler = (
  call: ToolHookCall,
  api: HookApi,
  context: unknown,
) => { block?: string; arguments?: Record<string, unknown> } | undefined;

function makeCall(id: string, name: string, args: Record<string, string>): ToolHookCall {
  return { type: 'toolCall', id, name, arguments: args };
}

function hookOf(options: SandboxExtensionOptions = {}): BeforeToolHandler {
  const extension = createSandboxExtension({ enforce: true, ...options });
  const handlers = extension.hooks?.[0]?.handlers as { beforeTool?: BeforeToolHandler } | undefined;
  if (!handlers?.beforeTool) throw new Error('missing sandbox beforeTool hook');
  return handlers.beforeTool;
}

describe('createSandboxExtension', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function setupWorkspace() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-sandbox-ext-'));
    tempRoots.push(base);
    const workspace = path.join(base, 'workspace');
    const externalDir = path.join(base, 'external-docs');
    const skillDir = path.join(base, 'skills-managed');
    fs.mkdirSync(path.join(workspace, 'inputs'), { recursive: true });
    fs.mkdirSync(externalDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });
    const stagedInput = path.join(workspace, 'inputs', 'resume.pdf');
    const externalFile = path.join(externalDir, 'secret.txt');
    const skillDoc = path.join(skillDir, 'office-pdf', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillDoc), { recursive: true });
    fs.writeFileSync(stagedInput, 'pdf-bytes');
    fs.writeFileSync(externalFile, 'forbidden');
    fs.writeFileSync(skillDoc, '# PDF Skill');
    return { base, workspace, stagedInput, externalFile, skillDir, skillDoc };
  }

  it('confines read to workspace (including inputs/) and readOnlyRoots while blocking external paths', () => {
    const { workspace, stagedInput, externalFile, skillDir, skillDoc } = setupWorkspace();
    const convId = `conv-ext-${Date.now()}`;
    registerSandboxWorkspace(convId, workspace);

    const beforeTool = hookOf({ readOnlyRoots: () => [skillDir] });
    const api = { conversationId: convId } as unknown as HookApi;

    expect(beforeTool(makeCall('1', 'read', { path: 'inputs/resume.pdf' }), api, {})).toBeUndefined();
    expect(beforeTool(makeCall('2', 'read', { path: stagedInput }), api, {})).toBeUndefined();
    expect(beforeTool(makeCall('3', 'read', { path: skillDoc }), api, {})).toBeUndefined();

    // Arbitrary external files stay strictly rejected for read/write/edit.
    expect(beforeTool(makeCall('4', 'read', { path: externalFile }), api, {})?.block).toContain('拒绝越界访问');
    expect(beforeTool(makeCall('5', 'write', { path: externalFile, content: 'x' }), api, {})?.block).toContain('拒绝越界访问');
    expect(beforeTool(makeCall('6', 'edit', { path: skillDoc }), api, {})?.block).toContain('拒绝越界访问');
    expect(beforeTool(makeCall('7', 'write', { path: 'output.docx', content: 'ok' }), api, {})).toBeUndefined();
  });

  it('enforces Windows shell policy modes: disabled, auto, and ask approval gate', () => {
    const { workspace, skillDir } = setupWorkspace();
    const convId = `conv-win-${Date.now()}`;
    registerSandboxWorkspace(convId, workspace);
    const api = { conversationId: convId } as unknown as HookApi;
    const winBackend = { backend: 'windows-guarded' as const, detail: 'test', supported: true };

    const disabledHook = hookOf({
      backend: winBackend,
      readOnlyRoots: () => [skillDir],
      windowsShellMode: () => 'disabled',
    });
    expect(
      disabledHook(makeCall('1', 'bash', { command: 'python scripts/build.py inputs/resume.pdf' }), api, {})?.block,
    ).toContain('禁用');

    const authorizeSpy = vi.fn(() => true);
    const autoHook = hookOf({
      backend: winBackend,
      windowsShellMode: () => 'auto',
      authorizeShell: authorizeSpy,
    });
    expect(autoHook(makeCall('2', 'bash', { command: 'python scripts/build.py' }), api, {})).toBeUndefined();
    expect(authorizeSpy).not.toHaveBeenCalled();

    let allowed = false;
    const askAuth = vi.fn(() => allowed);
    const askHook = hookOf({
      backend: winBackend,
      windowsShellMode: () => 'ask',
      authorizeShell: askAuth,
    });
    expect(askHook(makeCall('3', 'bash', { command: 'python scripts/build.py' }), api, {})?.block).toContain('按任务审批');
    expect(askAuth).toHaveBeenCalledTimes(1);

    allowed = true;
    expect(askHook(makeCall('4', 'bash', { command: 'python scripts/build.py' }), api, {})).toBeUndefined();
    expect(askAuth).toHaveBeenCalledTimes(2);
  });

  it('isolates workspaces by scopeKey when concurrent Workers share the same numeric conversationId', () => {
    const first = setupWorkspace();
    const second = setupWorkspace();
    fs.writeFileSync(path.join(first.workspace, 'only-first.txt'), '1');
    fs.writeFileSync(path.join(second.workspace, 'only-second.txt'), '2');

    registerSandboxWorkspace('14', first.workspace, 'worker-ppt');
    registerSandboxWorkspace('14', second.workspace, 'worker-whale');

    const hookFirst = hookOf({ scopeKey: 'worker-ppt' });
    const hookSecond = hookOf({ scopeKey: 'worker-whale' });
    const api = { conversationId: '14' } as unknown as HookApi;

    expect(hookFirst(makeCall('1', 'read', { path: path.join(first.workspace, 'only-first.txt') }), api, {})).toBeUndefined();
    expect(hookFirst(makeCall('2', 'read', { path: path.join(second.workspace, 'only-second.txt') }), api, {})?.block).toContain('拒绝越界访问');

    expect(hookSecond(makeCall('3', 'read', { path: path.join(second.workspace, 'only-second.txt') }), api, {})).toBeUndefined();
    expect(hookSecond(makeCall('4', 'read', { path: path.join(first.workspace, 'only-first.txt') }), api, {})?.block).toContain('拒绝越界访问');
  });
});
