import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { Type } from 'typebox';

/**
 * Router 的工具带。
 *
 * Router 是**序点**，不是人手：它承接人类交互、维持全局上下文、把活派出去，
 * 自己**不执行**具体任务。所以这里没有 bash、读写文件、代码执行——那套工具属于
 * Worker（§2.1「甚至可以不配备 Bash 工具」）。
 *
 * 留下的七个工具正好是 Super-agent 里 Router 的全部动作：
 *
 *   open_line_of_work  派活（开线 + 建 worker + 订阅 + 跑第一个任务）
 *   reply_to_boss      唯一的外观信道（§2.2：Worker 不直接与人交互，由 Router 统一回复）
 *   recall             链式召回（§3.3：任何对象都能顺着 id 往下跳）
 *   list_lines         看一眼全局：哪条线在动、哪条线卡住
 *   steer_line         中途改方向（老板改主意了，下一轮 worker 会看到）
 *   ask_boss           需要拍板时进注意力队列
 *   close_line         收线
 *
 * 工具全都**立即返回**。派活不会等任务跑完——那是 §4.1 的全双工：Router 立刻
 * 收到「已启动」，结果之后作为一条新事件回到它这里。这就是为什么 Router 一轮
 * 推理可以很短，而活可以跑很久。
 */

export interface LineSummary {
  threadId: string;
  title: string;
  state: string;
  attention: string;
  lastActivityAt: number;
  /** 最近一条汇报的一句话，没有就是空。 */
  latestReport: string | null;
}

export interface RouterToolDeps {
  /** 派活。同步返回 id；任务在后台跑，结果之后作为汇报回来。 */
  openLine(input: {
    goal: string;
    title?: string;
    /** 环境身份：同一个 key 的后续事件会并到这条线上。 */
    threadKey?: string | null;
    /** 由哪个执行体干；不指定就按目标挑一个模板。 */
    template?: 'research' | 'code' | 'ops';
  }): { ok: true; threadId: string; workerId: string; taskId: string | null } | { ok: false; reason: string };

  /** 对老板说话。这是 Router 唯一能让人看见它的方式。 */
  reply(text: string): void;

  /** 链式召回：返回一个对象的压缩视图 + 相邻对象的 id（Inline & Spill）。 */
  recall(id: string): string;

  lines(state?: 'active' | 'all'): LineSummary[];

  steerLine(threadId: string, note: string): { ok: boolean; reason?: string };

  askBoss(threadId: string | null, question: string): { ok: boolean; reason?: string };

  closeLine(threadId: string, summary: string): { ok: boolean; reason?: string };
}

const ok = (text: string, details?: Record<string, string | null>) => ({
  output: [{ type: 'text' as const, text }],
  ...(details ? { details } : {}),
});

const fail = (text: string) => ({
  isError: true,
  output: [{ type: 'text' as const, text }],
});

export function createRouterTools(deps: RouterToolDeps) {
  return defineExtension({
    name: 'opc.router',
    sections: [
      /**
       * 角色、边界、以及那条最容易违反的禁令。
       *
       * 用 `section` 而不是把这段话塞进每条消息里：系统前缀稳定，provider 的
       * 提示词缓存才能命中（§3.3 把上下文窗口当 Cache 管）。
       */
      section('router-role', () =>
        [
          '你是这个工作台的调度者，也是老板唯一对话的对象。',
          '',
          '## 你做什么',
          '你把老板的话接住，判断该不该派活，把活派出去，然后把结果收回来告诉他。',
          '你负责的是**任务之间**的关系：哪件事和哪件事是同一件、哪件事该先做、',
          '哪件事卡住了要不要说。你不介入单件事内部怎么拆。',
          '',
          '## 你不做什么',
          '你没有文件读写、没有 shell、没有代码执行。活不是你干的。',
          '所以：**绝不声称自己读过文件、跑过命令、改过代码、查过资料**——你没做。',
          '绝不编造执行结果。手上没有证据时，就说没有，或者去开一条线查。',
          '',
          '## 怎么说话',
          '老板用聊天跟你说话。他问「怎么样了」，就照实说手上有哪几条线、各到哪一步；',
          '他不知道进度时不要用猜测填空。回答简短、具体，不复述他的原话。',
          '',
          '## 打扰的纪律',
          '大部分事情不需要他知道。干完了就安静地记在线上，只有两种情形值得开口：',
          '需要他拍板（ask_boss），或者他要的那件事完成了（reply_to_boss）。',
          '每一次打扰都要有理由；没有理由的汇报是噪音。',
        ].join('\n'),
      ),
    ],
    tools: [
      defineTool({
        name: 'open_line_of_work',
        description:
          '把一件事派出去：开一条工作线，起一个执行体，让它去跑。立即返回 id，不会等它跑完。' +
          '需要知道结果时用 recall 查，或者等它自己汇报回来。',
        parameters: Type.Object({
          goal: Type.String({ description: '要达成什么。写清目标和验收标准，执行体只看得到这些。' }),
          title: Type.Optional(Type.String({ description: '一句话的线名，给人看的。' })),
          thread_key: Type.Optional(
            Type.String({
              description:
                '环境身份（如 im:某个话题、github:owner/repo#12、folder:inbox/x.md）。' +
                '填了之后同一话题的后续事件会自动并到这条线上，不必再经过你。',
            }),
          ),
          template: Type.Optional(
            Type.Union([Type.Literal('research'), Type.Literal('code'), Type.Literal('ops')], {
              description: '执行体类型：查资料 / 写代码 / 运维操作。不确定就用 research。',
            }),
          ),
        }),
        execute: async (args) => {
          const result = deps.openLine({
            goal: args.goal,
            ...(args.title ? { title: args.title } : {}),
            ...(args.thread_key ? { threadKey: args.thread_key } : {}),
            ...(args.template ? { template: args.template } : {}),
          });
          if (!result.ok) return fail(`没派出去：${result.reason}`);
          return ok(
            `已派出去并启动。\nthread=${result.threadId}\nworker=${result.workerId}\n` +
              (result.taskId ? `task=${result.taskId}\n` : '') +
              `跑完会回来汇报；想看进度用 recall ${result.threadId}。`,
            { threadId: result.threadId, workerId: result.workerId, taskId: result.taskId },
          );
        },
      }),

      defineTool({
        name: 'reply_to_boss',
        description:
          '对老板说一句话。这是老板唯一能看到你的途径——不调用它，你等于没说话。' +
          '简短、具体、只说你知道的。',
        parameters: Type.Object({
          text: Type.String({ description: '要说的话。' }),
        }),
        execute: async (args) => {
          deps.reply(args.text);
          return ok('已发出。');
        },
      }),

      defineTool({
        name: 'recall',
        description:
          '按 id 取回一个对象的压缩视图：工作线、执行体、任务、事件、汇报都可以。' +
          '返回里会带上下一个可跳的 id（关联的任务、同线的汇报、执行体），' +
          '需要更细就继续 recall 那个 id。',
        parameters: Type.Object({
          id: Type.String({ description: 'thread / worker / task / event / report 的 id' }),
        }),
        execute: async (args) => ok(deps.recall(args.id)),
      }),

      defineTool({
        name: 'list_lines',
        description: '看一眼全局：现在有哪些工作线，各自在什么状态，最近一条汇报说了什么。',
        parameters: Type.Object({
          state: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('all')])),
        }),
        execute: async (args) => {
          const rows = deps.lines(args.state ?? 'active');
          if (rows.length === 0) return ok('现在没有在推进的线。');
          return ok(
            rows
              .map(
                (row) =>
                  `${row.threadId} · ${row.title} · ${row.state}` +
                  (row.latestReport ? `\n  最近：${row.latestReport}` : ''),
              )
              .join('\n'),
          );
        },
      }),

      defineTool({
        name: 'steer_line',
        description:
          '老板中途改了方向：给一条正在跑的线加一句话。执行体下一轮会看到它，' +
          '不需要重开一条线。',
        parameters: Type.Object({
          thread_id: Type.String(),
          note: Type.String({ description: '要改什么、为什么改。' }),
        }),
        execute: async (args) => {
          const result = deps.steerLine(args.thread_id, args.note);
          return result.ok ? ok('已经带到那条线上。') : fail(`没带上：${result.reason}`);
        },
      }),

      defineTool({
        name: 'ask_boss',
        description:
          '需要老板拍板时用。这会进他的注意力队列并打断他——只在真的需要一个人做决定时才用；' +
          '能自己判断的一律自己判断。',
        parameters: Type.Object({
          thread_id: Type.Optional(Type.String()),
          question: Type.String({ description: '一个可以直接回答的问题，带上下文。' }),
        }),
        execute: async (args) => {
          const result = deps.askBoss(args.thread_id ?? null, args.question);
          return result.ok ? ok('已经进队列。') : fail(`没进队列：${result.reason}`);
        },
      }),

      defineTool({
        name: 'close_line',
        description: '收线：这件事结束了。写清最后的结果，那是这条线留给以后的记忆。',
        parameters: Type.Object({
          thread_id: Type.String(),
          summary: Type.String({ description: '结果是什么、交付物在哪。' }),
        }),
        execute: async (args) => {
          const result = deps.closeLine(args.thread_id, args.summary);
          return result.ok ? ok('已收线。') : fail(`没收成：${result.reason}`);
        },
      }),
    ],
  });
}
