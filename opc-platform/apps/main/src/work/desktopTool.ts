import { Type } from 'typebox';
import { defineExtension, defineTool, type ToolExecutionResult } from '@earendil-works/pi-durable';
import type { DesktopBroker, DesktopSessionInput } from '../desktop/broker';

export interface DesktopToolDeps {
  broker: DesktopBroker;
  taskId: () => string | undefined;
  workerId: string;
  userId: string;
  authorize?: (tool: string, title: string, metadata?: { action: string; appId?: string; windowId?: string; preview?: string; sessionId?: string }) => boolean;
}

function fail(text: string): ToolExecutionResult { return { isError: true, output: [{ type: 'text', text }] }; }

export function createDesktopToolExtension(deps: DesktopToolDeps) {
  const session = (appId?: string, windowId?: string): DesktopSessionInput => {
    const taskId = deps.taskId();
    if (!taskId) throw new Error('桌面工具只能在任务执行期间使用');
    return { taskId, workerId: deps.workerId, userId: deps.userId, ...(appId ? { appId } : {}), ...(windowId ? { windowId } : {}) };
  };
  const gate = (tool: string, title: string, metadata: { action: string; appId?: string; windowId?: string; preview?: string } ): boolean => deps.authorize?.(tool, title, metadata) ?? true;
  const output = (result: { ok: boolean; text: string; data?: unknown }): ToolExecutionResult => result.ok
    ? { output: [{ type: 'text', text: result.data === undefined ? result.text : `${result.text}\n${JSON.stringify(result.data)}` }] }
    : fail(result.text);

  return defineExtension({
    name: 'opc.desktop',
    tools: [
      defineTool({ name: 'desktop_list_apps', description: '列出当前桌面应用。只返回应用名和进程标识，不操作任何应用。', deferred: true, parameters: Type.Object({}), execute: async () => { try { const apps = await deps.broker.listApps(); return { output: [{ type: 'text', text: JSON.stringify(apps) }] }; } catch (error) { return fail(error instanceof Error ? error.message : String(error)); } } }),
      defineTool({ name: 'desktop_list_windows', description: '列出当前桌面窗口。', deferred: true, parameters: Type.Object({}), execute: async () => { try { const windows = await deps.broker.listWindows(); return { output: [{ type: 'text', text: JSON.stringify(windows) }] }; } catch (error) { return fail(error instanceof Error ? error.message : String(error)); } } }),
      defineTool({ name: 'desktop_snapshot', description: '读取白名单应用的 Accessibility Snapshot。先观察，再使用同一 snapshot 中的 ref 操作，界面变化后必须重新读取。', deferred: true, parameters: Type.Object({ appId: Type.String(), windowId: Type.Optional(Type.String()), interactiveOnly: Type.Optional(Type.Boolean()) }), execute: async (args) => {
        const current = session(args.appId, args.windowId);
        if (!gate(`desktop.access:${args.appId}`, `访问桌面应用 ${args.appId}`, { action: 'desktop-access', appId: args.appId, windowId: args.windowId })) return fail('访问该桌面应用需要用户授权。');
        try { return output(await deps.broker.execute(current, 'snapshot', args.interactiveOnly ? ['-i'] : [], { appId: args.appId, windowId: args.windowId })); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      } }),
      defineTool({ name: 'desktop_find', description: '在白名单应用的 Accessibility Snapshot 中按名称、角色或文本查找控件。', deferred: true, parameters: Type.Object({ appId: Type.String(), query: Type.String(), windowId: Type.Optional(Type.String()) }), execute: async (args) => {
        const current = session(args.appId, args.windowId);
        if (!gate(`desktop.access:${args.appId}`, `访问桌面应用 ${args.appId}`, { action: 'desktop-access', appId: args.appId, windowId: args.windowId })) return fail('访问该桌面应用需要用户授权。');
        try { return output(await deps.broker.execute(current, 'find', [args.query], { appId: args.appId, windowId: args.windowId })); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      } }),
      defineTool({ name: 'desktop_click', description: '点击 Accessibility Snapshot 中的 ref。提交、发送、删除、购买等动作会单独请求审批。', deferred: true, parameters: Type.Object({ appId: Type.String(), ref: Type.String(), windowId: Type.Optional(Type.String()), consequential: Type.Optional(Type.Boolean()) }), execute: async (args) => {
        const current = session(args.appId, args.windowId);
        const risk = await deps.broker.clickRisk(current, args.ref, { appId: args.appId, windowId: args.windowId });
        if (!risk.verified) return fail('无法验证控件仍属于当前 Snapshot。请重新读取界面后再操作。');
        if ((args.consequential || risk.consequential) && !gate('desktop.click.consequential', `点击 ${args.appId} 中的控件 ${args.ref}`, { action: 'external-submit', appId: args.appId, windowId: args.windowId, preview: risk.preview ?? args.ref })) return fail('此桌面操作需要用户审批。');
        try { return output(await deps.broker.execute(current, 'click', [args.ref], { appId: args.appId, windowId: args.windowId })); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      } }),
      defineTool({ name: 'desktop_get', description: '读取当前 Accessibility Snapshot 中某个 ref 的属性。', deferred: true, parameters: Type.Object({ appId: Type.String(), ref: Type.String(), property: Type.Optional(Type.String()), windowId: Type.Optional(Type.String()) }), execute: async (args) => {
        const current = session(args.appId, args.windowId);
        if (!gate(`desktop.access:${args.appId}`, `访问桌面应用 ${args.appId}`, { action: 'desktop-access', appId: args.appId, windowId: args.windowId })) return fail('访问该桌面应用需要用户授权。');
        if (!await deps.broker.refVerified(current, args.ref, { appId: args.appId, windowId: args.windowId })) return fail('无法验证控件仍属于当前 Snapshot。请重新读取界面后再操作。');
        try { return output(await deps.broker.execute(current, 'get', [args.ref, ...(args.property ? [args.property] : [])], { appId: args.appId, windowId: args.windowId })); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      } }),
      defineTool({ name: 'desktop_toggle', description: '切换当前 Accessibility Snapshot 中控件的开关状态。', deferred: true, parameters: Type.Object({ appId: Type.String(), ref: Type.String(), windowId: Type.Optional(Type.String()) }), execute: async (args) => {
        const current = session(args.appId, args.windowId);
        if (!await deps.broker.refVerified(current, args.ref, { appId: args.appId, windowId: args.windowId })) return fail('无法验证控件仍属于当前 Snapshot。请重新读取界面后再操作。');
        if (!gate('desktop.toggle', `切换 ${args.appId} 中的控件`, { action: 'desktop-action', appId: args.appId, windowId: args.windowId, preview: args.ref })) return fail('此桌面操作需要用户审批。');
        try { return output(await deps.broker.execute(current, 'toggle', [args.ref], { appId: args.appId, windowId: args.windowId })); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      } }),
      defineTool({ name: 'desktop_select', description: '选择当前 Accessibility Snapshot 中下拉控件的选项。', deferred: true, parameters: Type.Object({ appId: Type.String(), ref: Type.String(), value: Type.String(), windowId: Type.Optional(Type.String()) }), execute: async (args) => {
        const current = session(args.appId, args.windowId);
        if (!await deps.broker.refVerified(current, args.ref, { appId: args.appId, windowId: args.windowId })) return fail('无法验证控件仍属于当前 Snapshot。请重新读取界面后再操作。');
        if (!gate('desktop.select', `选择 ${args.appId} 中的选项`, { action: 'desktop-action', appId: args.appId, windowId: args.windowId, preview: args.value })) return fail('此桌面操作需要用户审批。');
        try { return output(await deps.broker.execute(current, 'select', [args.ref, args.value], { appId: args.appId, windowId: args.windowId })); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      } }),
      defineTool({ name: 'desktop_scroll', description: '滚动白名单应用的当前窗口。', deferred: true, parameters: Type.Object({ appId: Type.String(), direction: Type.Optional(Type.Union([Type.Literal('up'), Type.Literal('down')])), amount: Type.Optional(Type.Integer()), windowId: Type.Optional(Type.String()) }), execute: async (args) => {
        const current = session(args.appId, args.windowId);
        try { return output(await deps.broker.execute(current, 'scroll', [args.direction ?? 'down', ...(args.amount === undefined ? [] : [String(args.amount)])], { appId: args.appId, windowId: args.windowId })); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      } }),
      defineTool({ name: 'desktop_focus_window', description: '将指定白名单应用窗口设为当前目标。', deferred: true, parameters: Type.Object({ appId: Type.String(), windowId: Type.String() }), execute: async (args) => {
        const current = session(args.appId, args.windowId);
        if (!gate('desktop.focus-window', `聚焦 ${args.appId} 窗口`, { action: 'desktop-action', appId: args.appId, windowId: args.windowId })) return fail('聚焦窗口需要用户审批。');
        try { return output(await deps.broker.execute(current, 'focus-window', [], { appId: args.appId, windowId: args.windowId })); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      } }),
      defineTool({ name: 'desktop_launch', description: '启动白名单中的桌面应用。系统高危应用不会被允许。', deferred: true, parameters: Type.Object({ appId: Type.String() }), execute: async (args) => {
        const current = session(args.appId);
        if (!gate('desktop.launch', `启动桌面应用 ${args.appId}`, { action: 'desktop-launch', appId: args.appId })) return fail('启动桌面应用需要用户审批。');
        try { return output(await deps.broker.execute(current, 'launch', [args.appId], { appId: args.appId })); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      } }),
      defineTool({ name: 'desktop_clipboard_read', description: '读取系统剪贴板。剪贴板内容可能包含隐私数据，需要用户审批。', deferred: true, parameters: Type.Object({ appId: Type.String() }), execute: async (args) => {
        const current = session(args.appId);
        if (!gate('desktop.clipboard-read', `读取系统剪贴板（由 ${args.appId} 触发）`, { action: 'clipboard-read', appId: args.appId })) return fail('读取剪贴板需要用户审批。');
        try { return output(await deps.broker.execute(current, 'clipboard-get', [], { appId: args.appId })); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      } }),
      defineTool({ name: 'desktop_clipboard_write', description: '写入系统剪贴板。需要用户审批。', deferred: true, parameters: Type.Object({ appId: Type.String(), text: Type.String() }), execute: async (args) => {
        const current = session(args.appId);
        if (!gate('desktop.clipboard-write', `写入系统剪贴板（由 ${args.appId} 触发）`, { action: 'clipboard-write', appId: args.appId, preview: args.text.slice(0, 120) })) return fail('写入剪贴板需要用户审批。');
        try { return output(await deps.broker.execute(current, 'clipboard-set', ['--stdin'], { appId: args.appId, stdin: args.text })); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      } }),
      defineTool({ name: 'desktop_set_value', description: '设置 Accessibility 控件的值。密码、验证码、支付和密钥字段不能由模型填写。', deferred: true, parameters: Type.Object({ appId: Type.String(), ref: Type.String(), value: Type.String(), windowId: Type.Optional(Type.String()), sensitive: Type.Optional(Type.Boolean()) }), execute: async (args) => {
        const current = session(args.appId, args.windowId);
        const sensitive = await deps.broker.sensitiveField(current, args.ref, { appId: args.appId, windowId: args.windowId });
        if (args.sensitive || sensitive === true) return fail('敏感字段必须由用户在桌面应用中手动填写。');
        if (sensitive === undefined) return fail('无法确认控件是否为敏感字段。请重新读取界面后再操作。');
        if (!gate('desktop.set-value', `在 ${args.appId} 中填写控件`, { action: 'physical-input', appId: args.appId, windowId: args.windowId, preview: args.ref })) return fail('填写桌面控件需要用户审批。');
        try { return output(await deps.broker.execute(current, 'set-value', [args.ref, '--stdin'], { appId: args.appId, windowId: args.windowId, stdin: args.value })); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      } }),
      defineTool({ name: 'desktop_press', description: '向白名单应用发送按键。可能改变外部状态的按键需要审批。', deferred: true, parameters: Type.Object({ appId: Type.String(), key: Type.String(), windowId: Type.Optional(Type.String()) }), execute: async (args) => {
        const current = session(args.appId, args.windowId);
        if (!gate('desktop.press', `在 ${args.appId} 中按键 ${args.key}`, { action: 'physical-input', appId: args.appId, windowId: args.windowId, preview: args.key })) return fail('键盘操作需要用户审批。');
        try { return output(await deps.broker.execute(current, 'press', [args.key], { appId: args.appId, windowId: args.windowId })); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      } }),
      defineTool({ name: 'desktop_screenshot', description: '截取白名单应用当前窗口，用于用户查看或任务产物；不会默认上传。', deferred: true, parameters: Type.Object({ appId: Type.String(), windowId: Type.Optional(Type.String()) }), execute: async (args) => {
        const current = session(args.appId, args.windowId);
        if (!gate('desktop.screenshot', `截取 ${args.appId} 窗口`, { action: 'screenshot', appId: args.appId, windowId: args.windowId })) return fail('截图需要用户审批。');
        try { return output(await deps.broker.execute(current, 'screenshot', [], { appId: args.appId, windowId: args.windowId })); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
      } }),
    ],
  });
}
