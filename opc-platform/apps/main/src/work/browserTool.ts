import { Type } from 'typebox';
import fs from 'node:fs';
import path from 'node:path';
import type { Context } from '@earendil-works/chord/context';
import { defineExtension, defineTool, section, type ToolExecutionResult } from '@earendil-works/pi-durable';
import type { BrowserBroker, BrowserSessionInput, QrLoginSwitchResult } from '../browser/broker';
import { compressImageForToolOutput, createWorkerImageProcessor, type ImageProcessor } from './imageProcessor';

export type BrowserTakeoverKind = 'login' | 'captcha' | 'registration' | 'payment' | 'other';

export interface BrowserTakeoverRequest {
  taskId: string;
  title: string;
  instructions: string;
  kind: BrowserTakeoverKind;
  url?: string;
  sessionId?: string;
  screenshot?: { taskId: string; relPath: string };
  screenshotSelector?: string;
  signal?: AbortSignal;
}

export interface BrowserToolDeps {
  broker: BrowserBroker;
  taskId: () => string | undefined;
  threadId?: () => string | undefined;
  workerId: string;
  userId: string;
  workspace: () => string | undefined;
  imageProcessor?: ImageProcessor;
  requestTakeover?: (input: BrowserTakeoverRequest) => Promise<{ completed: boolean; note?: string }>;
  authorize?: (
    tool: string,
    title: string,
    metadata?: { action: string; url?: string; preview?: string; sessionId?: string },
  ) => boolean;
}

const MAX_INLINE_SCREENSHOT_BYTES = 10 * 1024 * 1024;

function fail(text: string): ToolExecutionResult {
  return { isError: true, output: [{ type: 'text' as const, text }] };
}

function extractCurrentUrl(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^https?:\/\//i.test(line) || line === 'about:blank');
}

export function createBrowserToolExtension(deps: BrowserToolDeps) {
  const session = (): BrowserSessionInput => {
    const taskId = deps.taskId();
    if (!taskId) throw new Error('浏览器工具只能在任务执行期间使用');
    const threadId = deps.threadId?.();
    return { taskId, ...(threadId ? { threadId } : {}), workerId: deps.workerId, userId: deps.userId };
  };
  const gated = (
    tool: string,
    title: string,
    metadata?: { action: string; url?: string; preview?: string; sessionId?: string },
  ): boolean => deps.authorize?.(tool, title, metadata) ?? true;

  return defineExtension({
    name: 'opc.browser',
    sections: [
      section('browser-guidance', () =>
        [
          '## Personal Agent 真实浏览器操作规范',
          '当前工作台运行的是真实桌面浏览器（带持久化登录态或直连用户日常 Chrome 专属标签页）：',
          '1. **高效合并**：打开页面后先用 `browser_snapshot` 获取 `@e...` ref；多步填表/点击尽量使用 `browser_batch` 在 1 次调用内串行执行并带回最新快照。搜索框或 SPA 富文本输入请优先使用 `browser_type`（触发真实按键事件）。',
          '2. **账号注册 / 登录 / 扫码 / 验证码 / 支付（严禁猜密码或强行绕过）**：一旦页面出现未登录态、二维码登录、短信/邮箱验证码、人机校验（CAPTCHA）、账号注册最后确认或支付环节，**立即调用 `browser_request_takeover`**。如果登录页默认展示账号/密码/短信输入框但页面顶部或右上角有「扫码登录 / 二维码图标」，**优先先切换到扫码视图后再请求接管**（`snapshot -i` 未看到角落图标时可用 `browser_screenshot({ annotate: true })` 识别，或直接调用 `browser_request_takeover(kind: "login")` 自动切换）。工具默认会在聊天接管卡片里附带当前视口截图（传 `screenshotSelector` 可直接截二维码特写），用户无需切窗即可扫码；用户点“我已完成，继续执行”后你会立刻收到最新 URL 与交互快照。',
        ].join('\n'),
      ),
    ],
    tools: [
      defineTool({
        name: 'browser_open',
        description: '在真实浏览器（或当前连接会话的专属标签页）中打开网页。未在允许域名列表时需先经用户审批。',
        deferred: true,
        parameters: Type.Object({ url: Type.String({ description: '要打开的完整 URL' }) }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const settings = deps.broker.settings();
          const current = session();
          const needsApproval =
            !deps.broker.isUrlAllowed(args.url) || settings.requireApprovalFor.includes('navigation');
          const approved = needsApproval
            ? gated('browser_open', `打开网页 ${args.url}`, {
                action: 'navigation',
                url: args.url,
                preview: args.url,
                sessionId: deps.broker.sessionId(current),
              })
            : false;
          try {
            const result = await deps.broker.open(current, args.url, { allowUnlisted: approved });
            return result.ok ? { output: [{ type: 'text', text: result.text }] } : fail(result.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'browser_snapshot',
        description: '读取当前网页的 Accessibility Snapshot（默认仅交互元素，可用 interactiveOnly: false 查看全树）及 @ref。',
        deferred: true,
        parameters: Type.Object({ interactiveOnly: Type.Optional(Type.Boolean()) }),
        execute: async (args): Promise<ToolExecutionResult> => {
          try {
            const result = await deps.broker.command(
              session(),
              'snapshot',
              args.interactiveOnly === false ? [] : ['-i'],
            );
            return result.ok ? { output: [{ type: 'text', text: result.text }] } : fail(result.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'browser_read',
        description: '读取当前页面的正文文本或 URL。',
        deferred: true,
        parameters: Type.Object({ target: Type.Optional(Type.Union([Type.Literal('text'), Type.Literal('url')])) }),
        execute: async (args): Promise<ToolExecutionResult> => {
          try {
            const result =
              args.target === 'url'
                ? await deps.broker.command(session(), 'get', ['url'])
                : await deps.broker.command(session(), 'read');
            return result.ok ? { output: [{ type: 'text', text: result.text }] } : fail(result.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'browser_click',
        description: '点击当前 Accessibility Snapshot 中的元素 ref（例如 @e1）。提交、发送、购买、删除等副作用动作需审批。',
        deferred: true,
        parameters: Type.Object({
          ref: Type.String({ description: '例如 @e1' }),
          consequential: Type.Optional(Type.Boolean()),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const current = session();
          const risk = await deps.broker.clickRisk(current, args.ref);
          const consequential = args.consequential === true || risk.consequential;
          if (
            consequential &&
            !gated('browser_click', `点击可能产生外部影响的元素 ${args.ref}`, {
              action: risk.consequential ? 'external-submit' : 'destructive',
              preview: risk.preview,
              sessionId: deps.broker.sessionId(current),
            })
          ) {
            return fail('此点击需要用户审批。');
          }
          try {
            const result = await deps.broker.command(current, 'click', [args.ref]);
            return result.ok ? { output: [{ type: 'text', text: result.text }] } : fail(result.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'browser_hover',
        description: '将鼠标悬停到指定元素 ref，用于展开下拉菜单或查看悬浮提示。',
        deferred: true,
        parameters: Type.Object({ ref: Type.String({ description: '例如 @e2' }) }),
        execute: async (args): Promise<ToolExecutionResult> => {
          try {
            const result = await deps.broker.command(session(), 'hover', [args.ref]);
            return result.ok ? { output: [{ type: 'text', text: result.text }] } : fail(result.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'browser_select',
        description: '选择当前页面下拉框的选项。',
        deferred: true,
        parameters: Type.Object({ ref: Type.String(), value: Type.String() }),
        execute: async (args): Promise<ToolExecutionResult> => {
          try {
            const result = await deps.broker.command(session(), 'select', [args.ref, args.value]);
            return result.ok ? { output: [{ type: 'text', text: result.text }] } : fail(result.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'browser_fill',
        description: '清空并填写非敏感表单字段。密码、支付信息、验证码和密钥必须改用 browser_request_takeover 由用户在真实窗口中填写。',
        deferred: true,
        parameters: Type.Object({
          ref: Type.String(),
          value: Type.String(),
          sensitive: Type.Optional(Type.Boolean()),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          if (args.sensitive) {
            return fail('密码、支付信息、验证码和密钥字段必须由用户在浏览器窗口中手动填写，请调用 browser_request_takeover。');
          }
          try {
            const result = await deps.broker.command(session(), 'fill', [args.ref, args.value]);
            return result.ok ? { output: [{ type: 'text', text: result.text }] } : fail(result.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'browser_type',
        description: '使用真实键盘按键事件向元素逐字输入（适用于搜索框联想、Rich Input、React/Vue 受控组件）。同样禁止填写敏感凭据。',
        deferred: true,
        parameters: Type.Object({
          ref: Type.String({ description: '目标输入框 ref' }),
          value: Type.String({ description: '要输入的文本' }),
          sensitive: Type.Optional(Type.Boolean()),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          if (args.sensitive) {
            return fail('密码、支付信息、验证码和密钥字段必须由用户在浏览器窗口中手动填写，请调用 browser_request_takeover。');
          }
          try {
            const result = await deps.broker.command(session(), 'type', [args.ref, args.value]);
            return result.ok ? { output: [{ type: 'text', text: result.text }] } : fail(result.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'browser_press',
        description: '在当前页面发送键盘按键（例如 Enter、Tab、Escape、Control+a）。',
        deferred: true,
        parameters: Type.Object({ key: Type.String() }),
        execute: async (args): Promise<ToolExecutionResult> => {
          try {
            const result = await deps.broker.command(session(), 'press', [args.key]);
            return result.ok ? { output: [{ type: 'text', text: result.text }] } : fail(result.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'browser_scroll',
        description: '滚动当前页面。',
        deferred: true,
        parameters: Type.Object({
          direction: Type.Optional(Type.Union([Type.Literal('up'), Type.Literal('down')])),
          amount: Type.Optional(Type.Integer()),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          try {
            const result = await deps.broker.command(session(), 'scroll', [
              args.direction ?? 'down',
              ...(args.amount === undefined ? [] : [String(args.amount)]),
            ]);
            return result.ok ? { output: [{ type: 'text', text: result.text }] } : fail(result.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'browser_tabs',
        description: '列出、新建、切换或关闭当前浏览器会话中的标签页。',
        deferred: true,
        parameters: Type.Object({
          action: Type.Optional(
            Type.Union([Type.Literal('list'), Type.Literal('new'), Type.Literal('switch'), Type.Literal('close')]),
          ),
          target: Type.Optional(Type.String()),
          url: Type.Optional(Type.String()),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const action = args.action ?? 'list';
          const command =
            action === 'list'
              ? ['tab']
              : action === 'new'
                ? ['tab', 'new', ...(args.url ? [args.url] : [])]
                : action === 'switch'
                  ? ['tab', ...(args.target ? [args.target] : [])]
                  : ['tab', 'close', ...(args.target ? [args.target] : [])];
          const current = session();
          let allowUnlisted = false;
          if (action === 'new' && args.url && !deps.broker.isUrlAllowed(args.url)) {
            allowUnlisted = gated('browser_tabs', `打开新标签页 ${args.url}`, {
              action: 'navigation',
              url: args.url,
              preview: args.url,
              sessionId: deps.broker.sessionId(current),
            });
            if (!allowUnlisted) return fail('打开新标签页需要用户审批。');
          }
          try {
            const result = await deps.broker.command(current, command[0]!, command.slice(1), { allowUnlisted });
            return result.ok ? { output: [{ type: 'text', text: result.text }] } : fail(result.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'browser_wait',
        description: '等待页面元素出现或等待指定毫秒数。',
        deferred: true,
        parameters: Type.Object({ value: Type.String() }),
        execute: async (args): Promise<ToolExecutionResult> => {
          try {
            const result = await deps.broker.command(session(), 'wait', [args.value]);
            return result.ok ? { output: [{ type: 'text', text: result.text }] } : fail(result.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'browser_batch',
        description:
          '在单次工具调用中顺序执行多步已知的浏览器操作（例如 填关键词 + 点击搜索 + 等待 + 自动返回最新交互快照），大幅减少模型回合数。',
        deferred: true,
        parameters: Type.Object({
          steps: Type.Array(
            Type.Object({
              action: Type.Union([
                Type.Literal('open'),
                Type.Literal('click'),
                Type.Literal('fill'),
                Type.Literal('type'),
                Type.Literal('press'),
                Type.Literal('select'),
                Type.Literal('hover'),
                Type.Literal('scroll'),
                Type.Literal('wait'),
              ]),
              url: Type.Optional(Type.String()),
              ref: Type.Optional(Type.String()),
              value: Type.Optional(Type.String()),
              direction: Type.Optional(Type.Union([Type.Literal('up'), Type.Literal('down')])),
              amount: Type.Optional(Type.Integer({ description: '滚动像素量（scroll）或等待毫秒数（wait）' })),
              sensitive: Type.Optional(Type.Boolean()),
            }),
            { minItems: 1, maxItems: 15 },
          ),
          snapshotAfter: Type.Optional(Type.Boolean({ description: '是否在批量操作结束后自动附带一次 snapshot -i，默认 true' })),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const current = session();
          const settings = deps.broker.settings();
          let allowUnlisted = false;
          const commands: string[][] = [];

          for (const step of args.steps) {
            if (step.sensitive) {
              return fail('敏感字段（密码/验证码/支付）禁止传入 browser_batch，请改用 browser_request_takeover。');
            }
            if (step.action === 'open') {
              const targetUrl = step.url?.trim() ?? '';
              if (!targetUrl) return fail('batch 中 open 步骤缺少 url');
              const needsApproval =
                !deps.broker.isUrlAllowed(targetUrl) || settings.requireApprovalFor.includes('navigation');
              if (needsApproval) {
                const approved = gated('browser_open', `打开网页 ${targetUrl}`, {
                  action: 'navigation',
                  url: targetUrl,
                  preview: targetUrl,
                  sessionId: deps.broker.sessionId(current),
                });
                if (!approved) return fail(`打开未允许域名 ${targetUrl} 需要用户审批。`);
                allowUnlisted = true;
              }
              commands.push(['open', targetUrl]);
            } else if (step.action === 'click') {
              const ref = step.ref?.trim() ?? '';
              if (!ref) return fail('batch 中 click 步骤缺少 ref');
              const risk = await deps.broker.clickRisk(current, ref);
              if (
                risk.consequential &&
                !gated('browser_click', `点击可能产生外部影响的元素 ${ref}`, {
                  action: 'external-submit',
                  preview: risk.preview,
                  sessionId: deps.broker.sessionId(current),
                })
              ) {
                return fail(`批量操作中的高风险点击 ${ref} 需要用户审批。`);
              }
              commands.push(['click', ref]);
            } else if (step.action === 'fill') {
              if (!step.ref?.trim()) return fail('batch 中 fill 步骤缺少 ref');
              commands.push(['fill', step.ref.trim(), step.value ?? '']);
            } else if (step.action === 'type') {
              if (!step.ref?.trim()) return fail('batch 中 type 步骤缺少 ref');
              commands.push(['type', step.ref.trim(), step.value ?? '']);
            } else if (step.action === 'press') {
              commands.push(['press', step.value?.trim() || 'Enter']);
            } else if (step.action === 'select') {
              if (!step.ref?.trim()) return fail('batch 中 select 步骤缺少 ref');
              commands.push(['select', step.ref.trim(), step.value ?? '']);
            } else if (step.action === 'hover') {
              if (!step.ref?.trim()) return fail('batch 中 hover 步骤缺少 ref');
              commands.push(['hover', step.ref.trim()]);
            } else if (step.action === 'scroll') {
              commands.push([
                'scroll',
                step.direction ?? 'down',
                ...(step.amount !== undefined ? [String(step.amount)] : []),
              ]);
            } else if (step.action === 'wait') {
              const waitMs =
                step.value?.trim() ||
                (step.amount !== undefined && step.amount > 0 ? String(step.amount) : '1000');
              commands.push(['wait', waitMs]);
            }
          }

          try {
            const batchRes = await deps.broker.batch(current, commands, { allowUnlisted, bail: true });
            if (!batchRes.ok) return fail(batchRes.text);
            if (args.snapshotAfter === false) {
              return { output: [{ type: 'text', text: batchRes.text || '批量操作执行完成。' }] };
            }
            const snap = await deps.broker.command(current, 'snapshot', ['-i']);
            const parts = [batchRes.text || '批量操作执行完成。'];
            if (snap.ok && snap.text.trim()) {
              parts.push(`最新页面快照：\n${snap.text}`);
            }
            return { output: [{ type: 'text', text: parts.join('\n\n') }] };
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'browser_request_takeover',
        description:
          '当遇到需要用户本人处理的环节（如账号登录、微信/App扫码、手机短信验证码、人机验证 CAPTCHA、账号注册提交确认或支付）时调用。' +
          '工具默认截取当前页面（或指定二维码区域）在聊天接管卡片中展示以便用户直接扫码，必要时置顶真实浏览器窗口并暂停等待；用户在扫码或浏览器内操作完毕点击「我已完成，继续执行」后，工具会立刻返回操作后的最新 URL 与交互快照。',
        deferred: true,
        parameters: Type.Object({
          reason: Type.String({ description: '简短标题，例如「需要登录小红书账号」或「请完成手机号注册验证」' }),
          instructions: Type.String({
            description: '给用户的明确操作指引（1-3句话，说明现在已经在浏览器打开了什么页面、需要用户完成哪几步，完成后点击卡片上的继续按钮）。',
          }),
          kind: Type.Optional(
            Type.Union([
              Type.Literal('login'),
              Type.Literal('captcha'),
              Type.Literal('registration'),
              Type.Literal('payment'),
              Type.Literal('other'),
            ]),
          ),
          preferQrLogin: Type.Optional(
            Type.Boolean({
              description:
                '当 kind 为 login 时是否优先自动将密码/短信登录页切换至扫码登录视图后再截图（默认 true）。仅当用户明确要求账密/邮箱登录时设为 false。',
            }),
          ),
          captureScreenshot: Type.Optional(
            Type.Boolean({
              description: '是否自动截取当前页面/二维码图片附带在接管卡片中（默认 true，扫码登录建议开启）。',
            }),
          ),
          screenshotSelector: Type.Optional(
            Type.String({
              description:
                '可选：二维码或弹窗区域元素 ref（如 @e12）或 CSS 选择器；传入后会优先截取元素特写以便清晰扫码，失败自动回退当前视口截图。',
            }),
          ),
        }),
        execute: async (args, _api, context?: Context): Promise<ToolExecutionResult> => {
          const current = session();
          const kind: BrowserTakeoverKind = args.kind ?? 'other';
          try {
            const selector = args.screenshotSelector?.trim() || undefined;
            const qrOutcome: QrLoginSwitchResult =
              kind === 'login' &&
              args.preferQrLogin !== false &&
              !selector &&
              typeof deps.broker.trySwitchToQrLogin === 'function'
                ? await deps.broker.trySwitchToQrLogin(current).catch(() => ({ switched: false }))
                : { switched: false };

            const urlBeforeRes = await deps.broker.command(current, 'get', ['url']).catch(() => undefined);
            const urlBefore = urlBeforeRes?.ok ? extractCurrentUrl(urlBeforeRes.text) : undefined;

            let screenshot: { taskId: string; relPath: string } | undefined;
            if (args.captureScreenshot !== false) {
              let shot = await deps.broker
                .screenshot(current, selector ? { selector } : {})
                .catch(() => ({ ok: false, text: '', path: undefined, relPath: undefined }));
              if (!shot.ok && selector) {
                shot = await deps.broker
                  .screenshot(current)
                  .catch(() => ({ ok: false, text: '', path: undefined, relPath: undefined }));
              }
              let relPath = shot.ok ? shot.relPath : undefined;
              if (!relPath && shot.ok && shot.path) {
                const workspaceRoot = deps.workspace();
                if (workspaceRoot) {
                  const resolvedRoot = path.resolve(workspaceRoot);
                  const resolvedShot = path.resolve(shot.path);
                  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
                  if (resolvedShot.startsWith(prefix)) {
                    relPath = path.relative(resolvedRoot, resolvedShot).replace(/\\/g, '/');
                  }
                }
              }
              if (shot.ok && relPath) {
                screenshot = { taskId: current.taskId, relPath };
              }
            }

            if (!(kind === 'login' && Boolean(screenshot) && !qrOutcome.passwordOnly)) {
              await deps.broker.show(current.taskId).catch(() => undefined);
            }

            if (!deps.requestTakeover) {
              return fail('当前宿主环境未挂载浏览器人工接管通道，请通过 escalate 请示用户手动操作。');
            }

            const baseInstructions = args.instructions.trim();
            const effectiveInstructions =
              qrOutcome.switched && !/扫码|二维码|qr/i.test(baseInstructions)
                ? `${baseInstructions}\n（已自动切换至扫码登录视图，可直接手机扫码；如需改用密码登录请点击下方「打开 / 聚焦浏览器」。）`
                : baseInstructions;

            const outcome = await deps.requestTakeover({
              taskId: current.taskId,
              title: args.reason.trim(),
              instructions: effectiveInstructions,
              kind,
              ...(urlBefore ? { url: urlBefore } : {}),
              sessionId: deps.broker.sessionId(current),
              ...(screenshot ? { screenshot } : {}),
              ...(selector ? { screenshotSelector: selector } : {}),
              ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
            });

            if (!outcome.completed) {
              return {
                output: [
                  {
                    type: 'text',
                    text: `用户未继续本次浏览器接管（${args.reason}）${outcome.note ? `：${outcome.note}` : ''}。请勿自行绕过或重试，如实向用户汇报当前状态或调整方案。`,
                  },
                ],
              };
            }

            const afterUrlRes = await deps.broker.command(current, 'get', ['url']).catch(() => undefined);
            const afterUrl = (afterUrlRes?.ok ? extractCurrentUrl(afterUrlRes.text) : undefined) ?? urlBefore ?? '';
            const afterSnap = await deps.broker.command(current, 'snapshot', ['-i']).catch(() => undefined);

            const summaryLines = [
              `用户在真实浏览器中已完成「${args.reason}」操作${outcome.note ? `（用户附言：${outcome.note}）` : ''}。`,
              ...(afterUrl ? [`当前页面 URL：${afterUrl}`] : []),
              ...(afterSnap?.ok && afterSnap.text.trim() ? [`\n当前页面可交互元素快照：\n${afterSnap.text}`] : []),
            ];
            return { output: [{ type: 'text', text: summaryLines.join('\n') }] };
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'browser_screenshot',
        description: '截取当前浏览器页面并保存为任务产物，同时返回图像内容供模型查看。支持 annotate（带 @ref 编号框标注）和 fullPage（整页长截图）。',
        deferred: true,
        parameters: Type.Object({
          annotate: Type.Optional(Type.Boolean({ description: '是否在图上标注交互元素编号及图例，便于视觉定位' })),
          fullPage: Type.Optional(Type.Boolean({ description: '是否截取完整页面高度' })),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          try {
            const shotOptions =
              args.annotate !== undefined || args.fullPage !== undefined
                ? {
                    ...(args.annotate !== undefined ? { annotate: args.annotate } : {}),
                    ...(args.fullPage !== undefined ? { fullPage: args.fullPage } : {}),
                  }
                : undefined;
            const result = shotOptions
              ? await deps.broker.screenshot(session(), shotOptions)
              : await deps.broker.screenshot(session());
            if (!result.ok) return fail(result.text);
            const output: NonNullable<ToolExecutionResult['output']> = [
              { type: 'text', text: `${result.text}\n产物：${result.path ?? ''}` },
            ];
            if (result.path) {
              try {
                const stat = await fs.promises.stat(result.path);
                if (stat.isFile() && stat.size > 0 && stat.size <= MAX_INLINE_SCREENSHOT_BYTES) {
                  const bytes = await fs.promises.readFile(result.path);
                  const compressed = await compressImageForToolOutput(
                    bytes,
                    'image/png',
                    deps.imageProcessor ?? createWorkerImageProcessor(),
                  );
                  if (compressed) {
                    output.unshift({ type: 'image', data: compressed.data, mimeType: compressed.mimeType });
                  } else {
                    output.unshift({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' });
                  }
                }
              } catch {
                // Keep text fallback if file could not be read.
              }
            }
            return { output, details: { artifact: result.path ?? '' } };
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'browser_download',
        description: '下载当前页面文件到任务产物目录，需要用户审批。',
        deferred: true,
        parameters: Type.Object({ selector: Type.String({ description: '触发下载的链接或按钮选择器/ref' }), filename: Type.Optional(Type.String()) }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const current = session();
          if (
            deps.broker.settings().requireApprovalFor.includes('download') &&
            !gated('browser_download', '下载网页文件', {
              action: 'download',
              preview: args.selector,
              sessionId: deps.broker.sessionId(current),
            })
          ) {
            return fail('下载需要用户审批。');
          }
          try {
            const result = await deps.broker.download(current, args.selector, args.filename);
            return result.ok
              ? { output: [{ type: 'text', text: `${result.text}\n产物：${result.path ?? ''}` }], details: { artifact: result.path ?? '' } }
              : fail(result.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),

      defineTool({
        name: 'browser_upload',
        description: '将当前任务工作区内的文件上传到网页，需要用户审批。不能访问工作区之外的路径。',
        deferred: true,
        parameters: Type.Object({ selector: Type.String(), path: Type.String() }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const root = deps.workspace();
          if (!root) return fail('当前任务没有可用工作区');
          const target = path.resolve(root, args.path);
          const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
          if (target !== root && !target.startsWith(prefix)) return fail('上传路径必须位于当前任务工作区内');
          try {
            const [realRoot, realTarget] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(target)]);
            if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) {
              return fail('上传路径不能通过符号链接离开当前任务工作区');
            }
            const stat = await fs.promises.stat(target);
            if (!stat.isFile()) return fail('上传路径不是文件');
            const current = session();
            if (
              deps.broker.settings().requireApprovalFor.includes('upload') &&
              !gated('browser_upload', `上传文件 ${args.path}`, {
                action: 'upload',
                preview: args.path,
                sessionId: deps.broker.sessionId(current),
              })
            ) {
              return fail('上传需要用户审批。');
            }
            const result = await deps.broker.upload(current, args.selector, target);
            return result.ok ? { output: [{ type: 'text', text: result.text }] } : fail(result.text);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        },
      }),
    ],
  });
}
