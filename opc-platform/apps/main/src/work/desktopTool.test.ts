import { describe, expect, it, vi } from 'vitest';
import type { DesktopSettings } from '@opc/shared/ipc';
import type { DesktopBroker } from '../desktop/broker';
import { createDesktopToolExtension, type DesktopToolDeps } from './desktopTool';

interface ToolResult {
  isError?: boolean;
  output?: { text: string }[];
}

interface FakeTool {
  name: string;
  execute: (args: unknown, api: unknown, context: unknown) => Promise<ToolResult>;
}

const baseSettings: DesktopSettings = {
  enabled: true,
  allowedApps: [],
  requireApprovalFor: ['external-submit', 'destructive', 'clipboard-read', 'clipboard-write'],
  approvalPolicyVersion: 1,
  maxOutputBytes: 64_000,
};

function pressTool(settings: DesktopSettings, authorize: DesktopToolDeps['authorize'], execute: DesktopBroker['execute']) {
  const extension = createDesktopToolExtension({
    broker: {
      settings: () => settings,
      execute,
    } as unknown as DesktopBroker,
    taskId: () => 'task-1',
    workerId: 'worker-1',
    authorize,
  });
  return ((extension.tools ?? []) as unknown as FakeTool[]).find((tool) => tool.name === 'desktop_press')!;
}

describe('desktop approval settings', () => {
  it('executes common keyboard input without opening an approval when its category is off', async () => {
    const authorize = vi.fn((_tool: string, _title: string, _metadata?: { action: string; appId?: string; windowId?: string; preview?: string }) => false);
    const execute = vi.fn(async () => ({ ok: true, text: 'pressed' }));
    const tool = pressTool(baseSettings, authorize, execute as unknown as DesktopBroker['execute']);

    const result = await tool.execute({ appId: 'Chrome', key: 'Ctrl+V' }, {}, {});

    expect(result.isError).toBeUndefined();
    expect(authorize).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1' }), 'press', ['Ctrl+V'], expect.any(Object));
  });

  it('requires approval when keyboard input is enabled in the approval list', async () => {
    const authorize = vi.fn((_tool: string, _title: string, _metadata?: { action: string; appId?: string; windowId?: string; preview?: string }) => false);
    const execute = vi.fn(async () => ({ ok: true, text: 'pressed' }));
    const tool = pressTool({ ...baseSettings, requireApprovalFor: [...baseSettings.requireApprovalFor, 'physical-input'] }, authorize, execute as unknown as DesktopBroker['execute']);

    const result = await tool.execute({ appId: 'Chrome', key: 'Ctrl+T' }, {}, {});

    expect(result.isError).toBe(true);
    expect(authorize).toHaveBeenCalledWith('desktop.press', expect.any(String), expect.objectContaining({ action: 'physical-input' }));
    expect(execute).not.toHaveBeenCalled();
  });
});
