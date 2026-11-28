import fs from 'node:fs';
import { Type } from 'typebox';
import type { Context } from '@earendil-works/chord/context';
import {
  defineExtension,
  defineTool,
  section,
  type ToolExecutionResult,
} from '@earendil-works/pi-durable';
import { formatDesktopScreenshotError, type DesktopBroker, type DesktopSessionInput } from '../desktop/broker';
import { classifyDesktopActionRisk, isAppBlocked } from '../desktop/policy';
import { prepareDesktopScreenshot, resolveVisualCoordinates } from '../desktop/vision';
import type { ImageProcessor } from './imageProcessor';

export type DesktopTakeoverKind = 'login' | 'captcha' | 'confirm' | 'payment' | 'other';

export interface DesktopTakeoverRequest {
  taskId: string;
  title: string;
  instructions: string;
  kind: DesktopTakeoverKind;
  appId?: string;
  windowId?: string;
  sessionId?: string;
  screenshot?: { taskId: string; relPath: string };
  signal?: AbortSignal;
}

export interface DesktopApprovalMetadata {
  action: string;
  kind?: DesktopTakeoverKind;
  appId?: string;
  windowId?: string;
  preview?: string;
  instructions?: string;
  sessionId?: string;
  screenshot?: { taskId: string; relPath: string };
}

export interface DesktopToolDeps {
  broker: DesktopBroker;
  taskId: () => string | undefined;
  workerId: string;
  imageProcessor?: ImageProcessor;
  requestTakeover?: (
    input: DesktopTakeoverRequest,
  ) => Promise<{ completed: boolean; note?: string }>;
  authorize?: (
    tool: string,
    title: string,
    metadata?: DesktopApprovalMetadata,
  ) => boolean;
}

function fail(text: string): ToolExecutionResult {
  return { isError: true, output: [{ type: 'text' as const, text }] };
}

function formatTypeError(rawText: string, ref?: string): string {
  const trimmed = rawText.trim() || '桌面文本输入失败';
  if (/Post-action state does not match|ACTION_NOT_SUPPORTED/i.test(trimmed)) {
    return `${trimmed}${ref ? `（控件 ${ref}）` : ''}（Electron / 终端 / 富文本输入框通常不支持无头语义写值校验；请先确认界面是否已写入，未写入时请改用 method: "paste" 或 desktop_batch 的 action: "paste" 粘贴输入，避免重复语义 type。）`;
  }
  return trimmed;
}

function formatHotkeyError(rawText: string, combo: string): string {
  const trimmed = rawText.trim() || '桌面快捷键发送失败';
  if (/No unmodified key types/i.test(trimmed)) {
    return `${trimmed}（当前输入法/键盘布局下「${combo}」中的标点键无法直接映射，请改用英文键名如 grave 代替 \`、切换英文输入法，或通过菜单/命令面板触发。）`;
  }
  return trimmed;
}

function formatPlatformHint(): string {
  if (process.platform === 'darwin') {
    return 'macOS（主键使用 `cmd`，如 `cmd+c`、`cmd+v`）';
  }
  if (process.platform === 'win32') {
    return 'Windows（主键使用 `ctrl`，如 `ctrl+c`、`ctrl+v`）';
  }
  return 'Linux（主键使用 `ctrl`，如 `ctrl+c`、`ctrl+v`）';
}

export function createDesktopToolExtension(deps: DesktopToolDeps) {
  const pasteKey = process.platform === 'darwin' ? 'cmd+v' : 'ctrl+v';
  const selectAllKey = process.platform === 'darwin' ? 'cmd+a' : 'ctrl+a';

  const session = (): DesktopSessionInput => {
    const taskId = deps.taskId();
    if (!taskId) throw new Error('桌面工具只能在任务执行期间使用');
    return { taskId, workerId: deps.workerId };
  };

  const pasteIntoTarget = async (
    current: DesktopSessionInput,
    text: string,
    opts: { ref?: string; appId?: string; windowId?: string; clearFirst?: boolean },
  ) => {
    if (deps.broker.settings().controlMode !== 'hybrid') {
      return {
        ok: false,
        text: '剪贴板粘贴输入（paste 模式或无 @ref 聚焦态输入）需要「混合全能模式」，请在「设置 → 电脑操作 → 桌面应用」开启，或改传具体控件 @ref。',
      };
    }
    const execOpts = {
      ...(opts.appId ? { appId: opts.appId } : {}),
      ...(opts.windowId ? { windowId: opts.windowId } : {}),
    };
    if (opts.ref) {
      const focused = await deps.broker.execute(current, 'focus', [opts.ref], execOpts);
      if (!focused.ok) return focused;
    } else if (opts.appId || opts.windowId) {
      const focused = await deps.broker.execute(current, 'focus-window', [], execOpts);
      if (!focused.ok) return focused;
    }
    if (opts.clearFirst) {
      const selected = await deps.broker.execute(current, 'press', [selectAllKey], { ...execOpts, headed: true });
      if (!selected.ok) return selected;
    }
    const copied = await deps.broker.execute(current, 'clipboard-set', ['--stdin'], { stdin: text });
    if (!copied.ok) return copied;
    return deps.broker.execute(current, 'press', [pasteKey], { ...execOpts, headed: true });
  };

  const authorizeAction = (
    tool: string,
    input: Parameters<typeof classifyDesktopActionRisk>[0],
    explicitWindowId?: string,
  ): ToolExecutionResult | null => {
    const risk = classifyDesktopActionRisk(input, deps.broker.settings().requireApprovalFor);
    if (!risk.risky || !risk.title) return null;
    const targetApp = input.app ?? input.refMeta?.app;
    const windowId = explicitWindowId ?? input.refMeta?.windowId;
    const allowed =
      deps.authorize?.(tool, risk.title, {
        action: risk.category ?? input.action,
        ...(targetApp ? { appId: targetApp } : {}),
        ...(windowId ? { windowId } : {}),
        ...(risk.preview ? { preview: risk.preview } : {}),
      }) ?? true;
    if (!allowed) {
      return fail(`桌面高风险操作需要用户确认：${risk.title}${risk.preview ? `（${risk.preview}）` : ''}`);
    }
    return null;
  };

  return defineExtension({
    name: 'opc.desktop',
    sections: [
      section('desktop-guidance', () => {
        const mode = deps.broker.settings().controlMode;
        const modeLine =
          mode === 'hybrid'
            ? '当前为「混合全能模式」：优先使用 Accessibility `@ref` 后台语义操作；遇到微信/飞书/Canvas 等自绘界面树不全或语义点击无响应时，**调用 `desktop_screenshot` 查看带 `0–1000` 网格的截图并用 `desktop_visual_act({ nx, ny })` 坐标点击/拖拽**。'
            : '当前为「纯后台无打扰模式」：仅可执行语义与窗口操作，无法调用物理鼠标坐标点击 (`desktop_visual_act`)。';
        return [
          '## Personal Agent 桌面应用控制规范',
          `运行平台：${formatPlatformHint()}。${modeLine}`,
          '1. **清晰分工**：文件/文档处理优先用办公技能或 `bash`；网页任务优先使用 `browser_*`；只有操作本机桌面软件时才使用 `desktop_*`。',
          '2. **骨架下钻，避免刷爆上下文**：先用 `desktop_list(kind: "windows")` 或 `desktop_observe(mode: "skeleton", app: "...")` 拿概览 `@ref`，再用 `desktop_observe(mode: "interactive", root: "@...")` 下钻局部区域。弹窗/下拉菜单出现后改用 `surface: "menu" | "sheet" | "popover" | "alert"` 观察。',
          `3. **高效执行与中文/富文本/终端输入**：多步连续操作优先合并到 \`desktop_batch\`（\`hybrid\` 模式下支持无 \`@ref\` 的聚焦态 \`type\` 以及 \`action: "paste"\` 粘贴输入）；遇到 Electron、VS Code 终端或 IM 富文本输入框等不支持无头语义写值校验的场景，优先使用 \`desktop_type({ method: "paste" })\` 或 \`desktop_batch\` 的 \`action: "paste"\`（内部自动写剪贴板并发送 \`${pasteKey}\`）。`,
          '4. **安全与人工接管（严禁私自绕过）**：严禁猜测密码或绕过校验；遇到账号登录、微信扫码、短信验证码、人机验证、支付确认或需要人拍板的发送前检查，**立即调用 `desktop_request_takeover`** 并附带清晰指引，等待用户点“我已完成，继续执行”。',
        ].join('\n');
      }),
    ],
    tools: [
      defineTool({
        name: 'desktop_list',
        description:
          '列出当前运行的桌面应用、可见窗口、显示器或指定应用的可访问性浮层（surfaces），自动剔除受保护黑名单应用。',
        deferred: true,
        parameters: Type.Object({
          kind: Type.Optional(
            Type.Union([
              Type.Literal('apps'),
              Type.Literal('windows'),
              Type.Literal('displays'),
              Type.Literal('surfaces'),
            ]),
          ),
          app: Type.Optional(Type.String({ description: '可选：按应用名筛选 windows，或指定 surfaces 目标应用' })),
          windowId: Type.Optional(Type.String({ description: '可选：kind 为 surfaces 时的窗口 ID' })),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const kind = args.kind ?? 'windows';
          const blocked = deps.broker.settings().blockedApps;
          try {
            if (args.app) deps.broker.assertAppAllowed(args.app);

            if (kind === 'apps') {
              const apps = (await deps.broker.listApps())
                .filter((app) => !isAppBlocked(app, blocked))
                .map(({ icon: _icon, ...rest }) => rest);
              return { output: [{ type: 'text', text: JSON.stringify({ apps }, null, 2) }] };
            }

            if (kind === 'windows') {
              const windows = (await deps.broker.listWindowDetails(args.app))
                .filter((win) => !win.app || !isAppBlocked({ app: win.app, ...(win.process ? { process: win.process } : {}) }, blocked));
              return { output: [{ type: 'text', text: JSON.stringify({ windows }, null, 2) }] };
            }

            if (kind === 'displays') {
              const displays = await deps.broker.listDisplays();
              return { output: [{ type: 'text', text: JSON.stringify({ displays }, null, 2) }] };
            }

            const res = await deps.broker.execute(session(), 'list-surfaces', [], {
              ...(args.app ? { appId: args.app } : {}),
              ...(args.windowId ? { windowId: args.windowId } : {}),
            });
            return res.ok ? { output: [{ type: 'text', text: res.text }] } : fail(res.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'desktop_observe',
        description:
          '读取桌面应用界面控件树或检索控件 @ref。建议先用 mode: "skeleton" 拿目录，再用 mode: "interactive" 配合 root 下钻。',
        deferred: true,
        parameters: Type.Object({
          mode: Type.Optional(
            Type.Union([
              Type.Literal('skeleton'),
              Type.Literal('interactive'),
              Type.Literal('full'),
              Type.Literal('find'),
              Type.Literal('inspect'),
            ]),
          ),
          app: Type.Optional(Type.String({ description: '目标应用名称或 Bundle ID' })),
          windowId: Type.Optional(Type.String({ description: '可选：目标窗口 ID（如 w-1234）' })),
          root: Type.Optional(Type.String({ description: '可选：从指定 @ref 子树开始观察' })),
          surface: Type.Optional(
            Type.Union([
              Type.Literal('window'),
              Type.Literal('focused'),
              Type.Literal('menu'),
              Type.Literal('menubar'),
              Type.Literal('sheet'),
              Type.Literal('popover'),
              Type.Literal('alert'),
              Type.Literal('dock'),
              Type.Literal('menu-bar-extras'),
            ]),
          ),
          query: Type.Optional(Type.String({ description: 'mode 为 find 时按名称/值/文本检索的关键词' })),
          role: Type.Optional(Type.String({ description: 'mode 为 find 时筛选控件角色（如 button, textfield）' })),
          ref: Type.Optional(Type.String({ description: 'mode 为 inspect 时要读取详情的 @ref' })),
          includeBounds: Type.Optional(Type.Boolean({ description: '是否在树中包含坐标 bounds（默认 false）' })),
          maxDepth: Type.Optional(Type.Integer({ description: '最大遍历深度（默认 10）' })),
          waitFor: Type.Optional(Type.String({ description: '可选：等待满足 role:text 的元素出现后再返回快照' })),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const current = session();
          const mode = args.mode ?? 'skeleton';
          try {
            if (args.app) deps.broker.assertAppAllowed(args.app);
            const refMeta = (args.ref ?? args.root)
              ? deps.broker.lookupRefMeta(current.taskId, (args.ref ?? args.root)!)
              : undefined;
            if (refMeta?.app) deps.broker.assertAppAllowed(refMeta.app);

            if (mode === 'inspect') {
              if (!args.ref?.trim()) return fail('mode 为 inspect 时必须传入 ref');
              const res = await deps.broker.execute(current, 'get', [args.ref.trim()], {
                ...(args.app ? { appId: args.app } : {}),
                ...(args.windowId ? { windowId: args.windowId } : {}),
              });
              return res.ok ? { output: [{ type: 'text', text: res.text }] } : fail(res.text);
            }

            if (mode === 'find') {
              const findArgs: string[] = [];
              if (args.role?.trim()) findArgs.push('--role', args.role.trim());
              if (args.query?.trim()) findArgs.push('--text', args.query.trim());
              if (findArgs.length === 0) return fail('mode 为 find 时请至少提供 query 或 role');
              const res = await deps.broker.execute(current, 'find', findArgs, {
                ...(args.app ? { appId: args.app } : {}),
                ...(args.windowId ? { windowId: args.windowId } : {}),
              });
              return res.ok ? { output: [{ type: 'text', text: res.text }] } : fail(res.text);
            }

            const snapArgs: string[] = [];
            if (mode === 'skeleton') snapArgs.push('--skeleton', '-i', '--compact');
            else if (mode === 'interactive') snapArgs.push('-i', '--compact');
            else snapArgs.push('--compact');

            if (args.root?.trim()) snapArgs.push('--root', args.root.trim());
            if (args.surface) snapArgs.push('--surface', args.surface);
            if (args.includeBounds) snapArgs.push('--include-bounds');
            if (args.maxDepth !== undefined) snapArgs.push('--max-depth', String(args.maxDepth));
            if (args.waitFor?.trim()) snapArgs.push('--wait-for', args.waitFor.trim());

            const res = await deps.broker.execute(current, 'snapshot', snapArgs, {
              ...(args.app ? { appId: args.app } : {}),
              ...(args.windowId ? { windowId: args.windowId } : {}),
            });
            return res.ok ? { output: [{ type: 'text', text: res.text }] } : fail(res.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'desktop_screenshot',
        description:
          '截取指定桌面应用窗口或屏幕画面并自动压缩（默认叠加 0-1000 归一化坐标网格），便于视觉理解与 desktop_visual_act 精准定位。',
        deferred: true,
        parameters: Type.Object({
          app: Type.Optional(Type.String({ description: '可选：仅截取指定应用窗口' })),
          windowId: Type.Optional(Type.String({ description: '可选：指定窗口 ID' })),
          screen: Type.Optional(Type.Integer({ description: '可选：显示器序号（0 为主屏）' })),
          grid: Type.Optional(Type.Boolean({ description: '是否叠加 0-1000 坐标网格标注（默认 true）' })),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const current = session();
          try {
            const shot = await deps.broker.captureScreenshot(current, {
              ...(args.app ? { app: args.app } : {}),
              ...(args.windowId ? { windowId: args.windowId } : {}),
              ...(args.screen !== undefined ? { screen: args.screen } : {}),
            });
            if (!shot.ok || !shot.path) return fail(formatDesktopScreenshotError(shot.text));

            const bytes = await fs.promises.readFile(shot.path);
            const useGrid = args.grid !== false;
            const prepared = await prepareDesktopScreenshot(bytes, {
              annotateGrid: useGrid,
              ...(deps.imageProcessor ? { imageProcessor: deps.imageProcessor } : {}),
            });

            const lines: string[] = [];
            if (shot.frame) {
              lines.push(
                `逻辑区域：origin=(${shot.frame.originX}, ${shot.frame.originY}), size=${shot.frame.width}×${shot.frame.height}, scale=${shot.frame.scaleFactor}` +
                  (shot.frame.app ? `, app=${shot.frame.app}` : '') +
                  (shot.frame.windowId ? `, windowId=${shot.frame.windowId}` : ''),
              );
            }
            if (useGrid) {
              lines.push('坐标网格：已按 0–1000 归一化坐标标注，可直接传给 desktop_visual_act({ nx, ny })。');
            }
            lines.push(`产物：${shot.path}`);

            const output: NonNullable<ToolExecutionResult['output']> = [{ type: 'text', text: lines.join('\n') }];
            if (prepared) {
              output.unshift({ type: 'image', data: prepared.data, mimeType: prepared.mimeType });
            }
            return { output, details: { artifact: shot.path } };
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'desktop_act',
        description:
          '对 Accessibility Snapshot 中的 @ref 执行语义交互（点击、双击、右键、选择下拉、切换勾选、展开收起、滚动、聚焦）。遇到发送/删除/支付等高风险控件会自动弹窗请求确认。',
        deferred: true,
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('click'),
            Type.Literal('double_click'),
            Type.Literal('right_click'),
            Type.Literal('select'),
            Type.Literal('toggle'),
            Type.Literal('check'),
            Type.Literal('uncheck'),
            Type.Literal('expand'),
            Type.Literal('collapse'),
            Type.Literal('scroll'),
            Type.Literal('scroll_to'),
            Type.Literal('focus'),
          ]),
          ref: Type.String({ description: '目标控件 @ref（来自 desktop_observe）' }),
          value: Type.Optional(Type.String({ description: 'action 为 select 时的目标选项文本' })),
          direction: Type.Optional(
            Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('left'), Type.Literal('right')]),
          ),
          amount: Type.Optional(Type.Integer({ description: 'action 为 scroll 时的滚动格数' })),
          physical: Type.Optional(Type.Boolean({ description: '仅 hybrid 模式：强制使用物理鼠标点击（用于语义点击无效的控件）' })),
          consequential: Type.Optional(Type.Boolean({ description: '是否属于会产生外部影响的高风险交互' })),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const current = session();
          const ref = args.ref.trim();
          try {
            const refMeta = deps.broker.lookupRefMeta(current.taskId, ref);
            if (refMeta?.app) deps.broker.assertAppAllowed(refMeta.app);

            const cliCommand =
              args.action === 'double_click'
                ? 'double-click'
                : args.action === 'right_click'
                  ? 'right-click'
                  : args.action === 'scroll_to'
                    ? 'scroll-to'
                    : args.action;

            const blockedResult = authorizeAction(
              'desktop_act',
              {
                action: cliCommand,
                ...(refMeta ? { refMeta } : {}),
                ...(args.value ? { text: args.value } : {}),
                ...(args.consequential !== undefined ? { consequential: args.consequential } : {}),
              },
              refMeta?.windowId,
            );
            if (blockedResult) return blockedResult;

            const cmdArgs: string[] = [ref];
            if (args.action === 'select') {
              if (!args.value?.trim()) return fail('action 为 select 时必须传入 value');
              cmdArgs.push(args.value);
            } else if (args.action === 'scroll') {
              if (args.direction) cmdArgs.push('--direction', args.direction);
              if (args.amount !== undefined) cmdArgs.push('--amount', String(args.amount));
            }

            const needsHeaded = args.action === 'double_click' || args.physical === true;
            const res = await deps.broker.execute(current, cliCommand, cmdArgs, {
              ...(needsHeaded ? { headed: true } : {}),
            });
            return res.ok ? { output: [{ type: 'text', text: res.text }] } : fail(res.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'desktop_type',
        description:
          '向指定输入框 @ref（或在 hybrid 模式下向当前聚焦窗口）填入文本（支持 semantic / physical / paste 三种输入方式，可选先清空或输入后按回车）。遇到 Electron / 终端 / 富文本输入框建议传 method: "paste"。禁止用于密码、密钥、验证码或支付信息——必须改用 desktop_request_takeover。',
        deferred: true,
        parameters: Type.Object({
          ref: Type.Optional(
            Type.String({ description: '目标输入框 @ref；省略时会在 hybrid 模式下向当前聚焦输入框粘贴' }),
          ),
          text: Type.String({ description: '要输入的文本' }),
          app: Type.Optional(Type.String({ description: '可选：目标应用名（无 ref 或需要限定窗口时传入）' })),
          windowId: Type.Optional(Type.String({ description: '可选：目标窗口 ID' })),
          method: Type.Optional(
            Type.Union([
              Type.Literal('semantic'),
              Type.Literal('physical'),
              Type.Literal('paste'),
            ]),
          ),
          clearFirst: Type.Optional(Type.Boolean({ description: '输入前是否先清空现有内容' })),
          pressEnter: Type.Optional(Type.Boolean({ description: '输入完成后是否自动按下回车' })),
          sensitive: Type.Optional(Type.Boolean({ description: '若为密码/密钥/验证码等敏感字段须传 true（将被拦截并指引人工接管）' })),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          if (args.sensitive) {
            return fail('密码、密钥、验证码及支付等敏感字段严禁由模型代填，请立即调用 desktop_request_takeover 由用户亲自输入。');
          }
          const current = session();
          const ref = args.ref?.trim() || undefined;
          try {
            if (args.app) deps.broker.assertAppAllowed(args.app);
            const refMeta = ref ? deps.broker.lookupRefMeta(current.taskId, ref) : undefined;
            if (refMeta?.app) deps.broker.assertAppAllowed(refMeta.app);

            const blockedResult = authorizeAction(
              'desktop_type',
              {
                action: 'type',
                text: args.text,
                ...(args.app ? { app: args.app } : {}),
                ...(refMeta ? { refMeta } : {}),
              },
              args.windowId ?? refMeta?.windowId,
            );
            if (blockedResult) return blockedResult;

            const method = args.method ?? (ref ? 'semantic' : 'paste');
            const execOpts = {
              ...(args.app ? { appId: args.app } : {}),
              ...(args.windowId ? { windowId: args.windowId } : {}),
            };

            let typed;
            if (method === 'paste') {
              typed = await pasteIntoTarget(current, args.text, {
                ...(ref ? { ref } : {}),
                ...execOpts,
                ...(args.clearFirst ? { clearFirst: true } : {}),
              });
              if (!typed.ok) return fail(typed.text);
            } else {
              if (!ref) {
                return fail('method 为 semantic 或 physical 时必须传入 ref；省略 ref 请使用 method: "paste"');
              }
              if (args.clearFirst) {
                const cleared = await deps.broker.execute(current, 'clear', [ref], execOpts);
                if (!cleared.ok) return fail(cleared.text);
              }
              typed = await deps.broker.execute(current, 'type', [ref, args.text], {
                ...execOpts,
                ...(method === 'physical' ? { headed: true } : {}),
              });
              if (!typed.ok) return fail(formatTypeError(typed.text, ref));
            }

            if (args.pressEnter) {
              const pressed = await deps.broker.execute(current, 'press', ['return'], {
                ...execOpts,
                ...(method !== 'semantic' ? { headed: true } : {}),
              });
              if (!pressed.ok) return fail(formatHotkeyError(pressed.text, 'return'));
            }
            return { output: [{ type: 'text', text: typed.text }] };
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'desktop_hotkey',
        description: '向目标桌面应用发送快捷键组合（例如 cmd+c、cmd+v、return、escape）。危险退出或发送快捷键会触发确认。',
        deferred: true,
        parameters: Type.Object({
          combo: Type.String({ description: '按键或组合键，如 cmd+c、ctrl+v、return、escape' }),
          app: Type.Optional(Type.String({ description: '可选：目标应用名' })),
          windowId: Type.Optional(Type.String({ description: '可选：目标窗口 ID' })),
          consequential: Type.Optional(Type.Boolean()),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const current = session();
          const combo = args.combo.trim();
          if (!combo) return fail('combo 不能为空');
          try {
            if (args.app) deps.broker.assertAppAllowed(args.app);

            const risk = classifyDesktopActionRisk(
              {
                action: 'press',
                combo,
                ...(args.app ? { app: args.app } : {}),
                ...(args.consequential !== undefined ? { consequential: args.consequential } : {}),
              },
              deps.broker.settings().requireApprovalFor,
            );
            if (risk.risky && risk.title) {
              const allowed =
                deps.authorize?.('desktop_hotkey', risk.title, {
                  action: risk.category ?? 'press',
                  ...(args.app ? { appId: args.app } : {}),
                  ...(args.windowId ? { windowId: args.windowId } : {}),
                  ...(risk.preview ? { preview: risk.preview } : {}),
                }) ?? true;
              if (!allowed) {
                return fail(`快捷键「${combo}」需要用户确认后才能发送。`);
              }
            }

            const pressArgs = [combo, ...(risk.category === 'quit-app' ? ['--force'] : [])];
            const res = await deps.broker.execute(current, 'press', pressArgs, {
              ...(args.app ? { appId: args.app } : {}),
              ...(args.windowId ? { windowId: args.windowId } : {}),
            });
            return res.ok ? { output: [{ type: 'text', text: res.text }] } : fail(formatHotkeyError(res.text, combo));
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'desktop_visual_act',
        description:
          '视觉坐标兜底操作（仅 hybrid 模式可用）：当自绘界面（微信/飞书/Canvas 等）缺少 @ref 时，依据 desktop_screenshot 网格直接按归一化坐标 (nx, ny: 0–1000) 或逻辑坐标 (x, y) 点击、双击、右键、悬停、拖拽或滚动。',
        deferred: true,
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('click'),
            Type.Literal('double_click'),
            Type.Literal('right_click'),
            Type.Literal('hover'),
            Type.Literal('drag'),
            Type.Literal('scroll'),
          ]),
          nx: Type.Optional(Type.Number({ description: '相对最近一次截图左边缘的横向坐标 (0-1000)' })),
          ny: Type.Optional(Type.Number({ description: '相对最近一次截图上边缘的纵向坐标 (0-1000)' })),
          x: Type.Optional(Type.Number({ description: '可选：绝对屏幕逻辑 X 坐标' })),
          y: Type.Optional(Type.Number({ description: '可选：绝对屏幕逻辑 Y 坐标' })),
          toNx: Type.Optional(Type.Number({ description: 'action 为 drag 时的终点 nx (0-1000)' })),
          toNy: Type.Optional(Type.Number({ description: 'action 为 drag 时的终点 ny (0-1000)' })),
          toX: Type.Optional(Type.Number({ description: 'action 为 drag 时的终点绝对逻辑 X' })),
          toY: Type.Optional(Type.Number({ description: 'action 为 drag 时的终点绝对逻辑 Y' })),
          direction: Type.Optional(Type.Union([Type.Literal('up'), Type.Literal('down'), Type.Literal('left'), Type.Literal('right')])),
          amount: Type.Optional(Type.Integer({ description: 'action 为 scroll 时的滚动强度（默认 5）' })),
          app: Type.Optional(Type.String({ description: '可选：提示当前操作目标应用（用于黑名单与审计记录）' })),
          consequential: Type.Optional(Type.Boolean({ description: '是否会触发发送/删除/付款等不可逆后果' })),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const current = session();
          const settings = deps.broker.settings();
          if (settings.controlMode !== 'hybrid') {
            return fail('当前处于「纯后台无打扰模式」，无法执行基于视觉坐标的物理操作。请让用户在「设置 → 电脑操作 → 桌面应用」开启「混合全能模式」。');
          }

          try {
            const frame = deps.broker.lastCaptureFrame(current.taskId);
            const targetApp = args.app?.trim() || frame?.app;
            if (targetApp) deps.broker.assertAppAllowed(targetApp);

            const origin = resolveVisualCoordinates(frame, {
              ...(args.nx !== undefined ? { nx: args.nx } : {}),
              ...(args.ny !== undefined ? { ny: args.ny } : {}),
              ...(args.x !== undefined ? { x: args.x } : {}),
              ...(args.y !== undefined ? { y: args.y } : {}),
            });
            if ('error' in origin) return fail(origin.error);

            const blockedResult = authorizeAction(
              'desktop_visual_act',
              {
                action: args.action,
                ...(targetApp ? { app: targetApp } : {}),
                ...(args.consequential !== undefined ? { consequential: args.consequential } : {}),
              },
              frame?.windowId,
            );
            if (blockedResult) return blockedResult;

            if (args.action === 'drag') {
              const dest = resolveVisualCoordinates(frame, {
                ...(args.toNx !== undefined ? { nx: args.toNx } : {}),
                ...(args.toNy !== undefined ? { ny: args.toNy } : {}),
                ...(args.toX !== undefined ? { x: args.toX } : {}),
                ...(args.toY !== undefined ? { y: args.toY } : {}),
              });
              if ('error' in dest) return fail(`drag 终点坐标无效：${dest.error}`);
              const res = await deps.broker.execute(
                current,
                'drag',
                [`--from-xy=${origin.x},${origin.y}`, `--to-xy=${dest.x},${dest.y}`],
                { headed: true, ...(targetApp ? { appId: targetApp } : {}) },
              );
              return res.ok ? { output: [{ type: 'text', text: res.text }] } : fail(res.text);
            }

            if (args.action === 'hover') {
              const res = await deps.broker.execute(
                current,
                'hover',
                [`--xy=${origin.x},${origin.y}`],
                { headed: true, ...(targetApp ? { appId: targetApp } : {}) },
              );
              return res.ok ? { output: [{ type: 'text', text: res.text }] } : fail(res.text);
            }

            if (args.action === 'scroll') {
              const units = Math.max(1, args.amount ?? 5);
              const dir = args.direction ?? 'down';
              const dx = dir === 'left' ? units : dir === 'right' ? -units : 0;
              const dy = dir === 'up' ? units : dir === 'down' ? -units : 0;
              const wheelArgs = [`--x=${origin.x}`, `--y=${origin.y}`, `--dy=${dy}`, `--dx=${dx}`];
              const res = await deps.broker.execute(current, 'mouse-wheel', wheelArgs, {
                headed: true,
                ...(targetApp ? { appId: targetApp } : {}),
              });
              return res.ok ? { output: [{ type: 'text', text: res.text }] } : fail(res.text);
            }

            const clickArgs = [`--xy=${origin.x},${origin.y}`];
            if (args.action === 'double_click') clickArgs.push('--count', '2');
            else if (args.action === 'right_click') clickArgs.push('--button', 'right');
            const res = await deps.broker.execute(current, 'mouse-click', clickArgs, {
              headed: true,
              ...(targetApp ? { appId: targetApp } : {}),
            });
            return res.ok ? { output: [{ type: 'text', text: res.text }] } : fail(res.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'desktop_batch',
        description:
          '单次调用顺序执行多步已知桌面操作（最多 15 步），并可选自动附带最新交互快照，大幅减少模型往返耗时。hybrid 模式下支持无 ref 的聚焦输入与 action: "paste"（适用于 Electron/终端/富文本输入框）。',
        deferred: true,
        parameters: Type.Object({
          steps: Type.Array(
            Type.Object({
              action: Type.Union([
                Type.Literal('click'),
                Type.Literal('type'),
                Type.Literal('paste'),
                Type.Literal('press'),
                Type.Literal('select'),
                Type.Literal('toggle'),
                Type.Literal('focus'),
                Type.Literal('focus_window'),
                Type.Literal('wait'),
              ]),
              ref: Type.Optional(Type.String()),
              text: Type.Optional(Type.String()),
              value: Type.Optional(Type.String()),
              combo: Type.Optional(Type.String()),
              app: Type.Optional(Type.String()),
              windowId: Type.Optional(Type.String()),
              method: Type.Optional(
                Type.Union([
                  Type.Literal('semantic'),
                  Type.Literal('physical'),
                  Type.Literal('paste'),
                ]),
              ),
              clearFirst: Type.Optional(Type.Boolean()),
              ms: Type.Optional(Type.Integer()),
              sensitive: Type.Optional(Type.Boolean()),
              consequential: Type.Optional(Type.Boolean()),
            }),
            { minItems: 1, maxItems: 15 },
          ),
          app: Type.Optional(Type.String({ description: '可选：默认作用的应用名称' })),
          windowId: Type.Optional(Type.String({ description: '可选：默认作用的窗口 ID' })),
          snapshotAfter: Type.Optional(Type.Boolean({ description: '是否在结束时自动返回最新交互快照（默认 true）' })),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const current = session();
          try {
            if (args.app) deps.broker.assertAppAllowed(args.app);

            // Validate every step before executing the first side effect.
            for (const step of args.steps) {
              if (step.sensitive) {
                return fail('密码、密钥或验证码字段禁止放入 desktop_batch，请改用 desktop_request_takeover。');
              }
              const stepApp = step.app ?? args.app;
              if (stepApp) deps.broker.assertAppAllowed(stepApp);
              const refMeta = step.ref ? deps.broker.lookupRefMeta(current.taskId, step.ref) : undefined;
              if (refMeta?.app) deps.broker.assertAppAllowed(refMeta.app);

              const blockedResult = authorizeAction(
                'desktop_batch',
                {
                  action: step.action === 'paste' ? 'type' : step.action,
                  ...(stepApp || refMeta?.app ? { app: stepApp ?? refMeta?.app } : {}),
                  ...(step.combo ? { combo: step.combo } : {}),
                  ...(step.text ?? step.value ? { text: step.text ?? step.value } : {}),
                  ...(refMeta ? { refMeta } : {}),
                  ...(step.consequential !== undefined ? { consequential: step.consequential } : {}),
                },
                step.windowId ?? args.windowId ?? refMeta?.windowId,
              );
              if (blockedResult) return blockedResult;
            }

            const stepOutputs: string[] = [];
            for (const [index, step] of args.steps.entries()) {
              const stepApp = step.app ?? args.app;
              const stepWin = step.windowId ?? args.windowId;
              const execOpts = {
                ...(stepApp ? { appId: stepApp } : {}),
                ...(stepWin ? { windowId: stepWin } : {}),
              };
              const stepRef = step.ref?.trim();

              let res: { ok: boolean; text: string };
              if (step.action === 'wait') {
                const ms = Math.max(50, Math.min(10_000, step.ms ?? 500));
                res = await deps.broker.execute(current, 'wait', [String(ms)], execOpts);
              } else if (step.action === 'focus_window') {
                res = await deps.broker.execute(current, 'focus-window', [], execOpts);
              } else if (step.action === 'press') {
                const combo = step.combo?.trim() || 'return';
                res = await deps.broker.execute(current, 'press', [combo], execOpts);
              } else if (step.action === 'paste') {
                res = await pasteIntoTarget(current, step.text ?? step.value ?? '', {
                  ...(stepRef ? { ref: stepRef } : {}),
                  ...execOpts,
                  ...(step.clearFirst ? { clearFirst: true } : {}),
                });
              } else if (step.action === 'type') {
                const method = step.method ?? (stepRef ? 'semantic' : 'paste');
                const value = step.text ?? step.value ?? '';
                if (method === 'paste') {
                  res = await pasteIntoTarget(current, value, {
                    ...(stepRef ? { ref: stepRef } : {}),
                    ...execOpts,
                    ...(step.clearFirst ? { clearFirst: true } : {}),
                  });
                } else if (!stepRef) {
                  res = {
                    ok: false,
                    text: `method 为 ${method} 时必须传入 ref；省略 ref 请使用 action: "paste" 或在 hybrid 模式下由系统自动聚焦粘贴`,
                  };
                } else {
                  let clearedOk = true;
                  if (step.clearFirst) {
                    const cleared = await deps.broker.execute(current, 'clear', [stepRef], execOpts);
                    if (!cleared.ok) {
                      res = cleared;
                      clearedOk = false;
                    }
                  }
                  if (clearedOk) {
                    res = await deps.broker.execute(current, 'type', [stepRef, value], {
                      ...execOpts,
                      ...(method === 'physical' ? { headed: true } : {}),
                    });
                  }
                }
              } else if (step.action === 'select') {
                if (!stepRef) {
                  res = { ok: false, text: 'batch 中 select 步骤缺少 ref' };
                } else {
                  res = await deps.broker.execute(current, 'select', [stepRef, step.value ?? step.text ?? ''], execOpts);
                }
              } else if (!stepRef) {
                res = { ok: false, text: `batch 中 ${step.action} 步骤缺少 ref` };
              } else {
                res = await deps.broker.execute(current, step.action, [stepRef], execOpts);
              }

              if (!res!.ok) {
                const errorText =
                  step.action === 'type'
                    ? formatTypeError(res!.text, stepRef)
                    : step.action === 'press'
                      ? formatHotkeyError(res!.text, step.combo?.trim() || 'return')
                      : res!.text;
                const detailLines = [`desktop_batch 第 ${index + 1}/${args.steps.length} 步 (${step.action}) 失败：${errorText}`];
                if (stepOutputs.length > 0) {
                  detailLines.push(`已完成的前置步骤（请勿盲目重复已生效操作）：${stepOutputs.join(' -> ')}`);
                }
                return fail(detailLines.join('\n'));
              }
              stepOutputs.push(`#${index + 1} ${step.action}: ok`);
            }

            const summary = [`已完成 ${stepOutputs.length} 步操作。`];
            if (args.snapshotAfter !== false) {
              const snap = await deps.broker.execute(current, 'snapshot', ['-i', '--compact'], {
                ...(args.app ? { appId: args.app } : {}),
                ...(args.windowId ? { windowId: args.windowId } : {}),
              });
              if (snap.ok && snap.text.trim()) {
                summary.push(`最新界面快照：\n${snap.text}`);
              }
            }
            return { output: [{ type: 'text', text: summary.join('\n\n') }] };
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'desktop_app',
        description: '管理桌面应用与窗口生命周期：启动应用、聚焦前置窗口、调整尺寸位置、最小化/最大化或关闭应用。',
        deferred: true,
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal('launch'),
            Type.Literal('focus'),
            Type.Literal('close'),
            Type.Literal('minimize'),
            Type.Literal('maximize'),
            Type.Literal('restore'),
            Type.Literal('resize'),
            Type.Literal('move'),
          ]),
          app: Type.Optional(Type.String({ description: '应用名称或 Bundle ID' })),
          windowId: Type.Optional(Type.String({ description: '可选：目标窗口 ID' })),
          width: Type.Optional(Type.Integer({ description: 'action 为 resize 时的宽度' })),
          height: Type.Optional(Type.Integer({ description: 'action 为 resize 时的高度' })),
          x: Type.Optional(Type.Integer({ description: 'action 为 move 时的 X 坐标' })),
          y: Type.Optional(Type.Integer({ description: 'action 为 move 时的 Y 坐标' })),
          force: Type.Optional(Type.Boolean({ description: 'action 为 close 时是否强制结束进程' })),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const current = session();
          try {
            if (args.app) deps.broker.assertAppAllowed(args.app);

            if (args.action === 'close') {
              if (!args.app?.trim()) return fail('close 操作必须指定 app');
              const blockedResult = authorizeAction('desktop_app', {
                action: 'close-app',
                app: args.app.trim(),
              });
              if (blockedResult) return blockedResult;
              const closeArgs = [args.app.trim(), ...(args.force ? ['--force'] : [])];
              const res = await deps.broker.execute(current, 'close-app', closeArgs);
              return res.ok ? { output: [{ type: 'text', text: res.text }] } : fail(res.text);
            }

            if (args.action === 'launch') {
              if (!args.app?.trim()) return fail('launch 操作必须指定 app');
              const res = await deps.broker.execute(current, 'launch', [args.app.trim(), '--activate']);
              return res.ok ? { output: [{ type: 'text', text: res.text }] } : fail(res.text);
            }

            if (args.action === 'resize') {
              if (args.width === undefined || args.height === undefined) {
                return fail('resize 操作必须提供 width 与 height');
              }
              const res = await deps.broker.execute(
                current,
                'resize-window',
                ['--width', String(args.width), '--height', String(args.height)],
                {
                  ...(args.app ? { appId: args.app } : {}),
                  ...(args.windowId ? { windowId: args.windowId } : {}),
                },
              );
              return res.ok ? { output: [{ type: 'text', text: res.text }] } : fail(res.text);
            }

            if (args.action === 'move') {
              if (args.x === undefined || args.y === undefined) {
                return fail('move 操作必须提供 x 与 y');
              }
              const res = await deps.broker.execute(
                current,
                'move-window',
                [`--x=${args.x}`, `--y=${args.y}`],
                {
                  ...(args.app ? { appId: args.app } : {}),
                  ...(args.windowId ? { windowId: args.windowId } : {}),
                },
              );
              return res.ok ? { output: [{ type: 'text', text: res.text }] } : fail(res.text);
            }

            const cliCommand = args.action === 'focus' ? 'focus-window' : args.action;
            const res = await deps.broker.execute(current, cliCommand, [], {
              ...(args.app ? { appId: args.app } : {}),
              ...(args.windowId ? { windowId: args.windowId } : {}),
            });
            return res.ok ? { output: [{ type: 'text', text: res.text }] } : fail(res.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'desktop_clipboard',
        description: '读取或写入系统剪贴板文本（常用于稳定粘贴长段落、代码或中文消息到桌面软件输入框）。',
        deferred: true,
        parameters: Type.Object({
          action: Type.Union([Type.Literal('get'), Type.Literal('set')]),
          text: Type.Optional(Type.String({ description: 'action 为 set 时写入剪贴板的文本' })),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const current = session();
          try {
            if (args.action === 'get') {
              const res = await deps.broker.execute(current, 'clipboard-get', []);
              return res.ok ? { output: [{ type: 'text', text: res.text }] } : fail(res.text);
            }
            if (args.text === undefined) return fail('action 为 set 时必须传入 text');
            const res = await deps.broker.execute(current, 'clipboard-set', ['--stdin'], {
              stdin: args.text,
            });
            return res.ok ? { output: [{ type: 'text', text: '已写入系统剪贴板' }] } : fail(res.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'desktop_request_takeover',
        description:
          '当桌面软件遇到账号登录、扫码、短信验证码、人机校验、付款确认或需要人工把关的操作时调用。将在聊天里展示当前画面截图并暂停，等待用户在真实桌面完成并点「我已完成，继续执行」后恢复返回最新快照。',
        deferred: true,
        parameters: Type.Object({
          reason: Type.String({ description: '简短标题，例如「需要扫码登录微信桌面端」或「请确认是否发送该邮件」' }),
          instructions: Type.String({ description: '给用户的 1-3 句清晰指引' }),
          kind: Type.Optional(
            Type.Union([
              Type.Literal('login'),
              Type.Literal('captcha'),
              Type.Literal('confirm'),
              Type.Literal('payment'),
              Type.Literal('other'),
            ]),
          ),
          app: Type.Optional(Type.String({ description: '目标应用名（用于前置聚焦与截图）' })),
          windowId: Type.Optional(Type.String({ description: '可选：目标窗口 ID' })),
          captureScreenshot: Type.Optional(Type.Boolean({ description: '是否附带当前画面截图，默认 true' })),
        }),
        execute: async (args, _api, context?: Context): Promise<ToolExecutionResult> => {
          const current = session();
          const kind: DesktopTakeoverKind = args.kind ?? 'other';
          try {
            if (args.app) deps.broker.assertAppAllowed(args.app);

            let screenshot: { taskId: string; relPath: string } | undefined;
            if (args.captureScreenshot !== false) {
              const shot = await deps.broker
                .captureScreenshot(current, {
                  ...(args.app ? { app: args.app } : {}),
                  ...(args.windowId ? { windowId: args.windowId } : {}),
                })
                .catch(() => ({ ok: false, text: '', path: undefined, relPath: undefined }));
              if (shot.ok && shot.relPath) {
                screenshot = { taskId: current.taskId, relPath: shot.relPath };
              }
            }

            if (args.app || args.windowId) {
              await deps.broker
                .execute(current, 'focus-window', [], {
                  ...(args.app ? { appId: args.app } : {}),
                  ...(args.windowId ? { windowId: args.windowId } : {}),
                })
                .catch(() => undefined);
            }

            if (!deps.requestTakeover) {
              return fail('当前宿主环境未挂载桌面人工接管通道，请通过 escalate 请示用户手动操作。');
            }

            const outcome = await deps.requestTakeover({
              taskId: current.taskId,
              title: args.reason.trim(),
              instructions: args.instructions.trim(),
              kind,
              ...(args.app ? { appId: args.app } : {}),
              ...(args.windowId ? { windowId: args.windowId } : {}),
              ...(screenshot ? { screenshot } : {}),
              ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
            });

            if (!outcome.completed) {
              return {
                output: [
                  {
                    type: 'text',
                    text: `用户未继续本次桌面接管（${args.reason}）${outcome.note ? `：${outcome.note}` : ''}。请勿自行绕过或重试，如实向用户汇报或调整方案。`,
                  },
                ],
              };
            }

            const afterSnap = await deps.broker
              .execute(current, 'snapshot', ['-i', '--compact'], {
                ...(args.app ? { appId: args.app } : {}),
                ...(args.windowId ? { windowId: args.windowId } : {}),
              })
              .catch(() => undefined);

            const summary = [
              `用户已在桌面应用完成「${args.reason}」${outcome.note ? `（用户附言：${outcome.note}）` : ''}。`,
              ...(afterSnap?.ok && afterSnap.text.trim() ? [`\n当前界面可交互元素快照：\n${afterSnap.text}`] : []),
            ];
            return { output: [{ type: 'text', text: summary.join('\n') }] };
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),
    ],
  });
}
