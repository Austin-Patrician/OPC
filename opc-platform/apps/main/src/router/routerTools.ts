import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { recallView } from './inline';

/**
 * Router 的工具带。
 *
 * Router 是**序点**，不是人手：它承接人类交互、维持全局上下文、把活派出去，
 * 自己**不执行**具体任务。所以这里没有 bash、读写文件、代码执行——那套工具属于
 * Worker（§2.1「甚至可以不配备 Bash 工具」）。
 *
 * 留下的九个工具正好是 Super-agent 里 Router 的全部动作：
 *
 *   open_line_of_work  派活（开线 + 建 worker + 订阅 + 跑第一个任务）
 *   reply_to_user      唯一的外观信道（§2.2：Worker 不直接与人交互，由 Router 统一回复）
 *   recall             链式召回（§3.3：任何对象都能顺着 id 往下跳）
 *   list_lines         看一眼全局：哪条线在动、哪条线卡住
 *   steer_line         中途改方向（你改主意了，下一轮 worker 会看到）
 *   ask_user           需要拍板时进注意力队列
 *   close_line         收线
 *   remember           记住一件关于你的事（§2.1：Router 是"序点、协调点和记忆"）
 *   recall_memory      回想以前记过什么
 *
 * 最后两个是记忆，不是执行：它们只在 Router 自己的名下读写几行文本，不碰文件、
 * 不碰代码。没有它们，`memory` 表里那批 `owner_id='router'` 的行就永远没人读——
 * 一条完整的记忆生产链，收件人从来不拆信。
 *
 * 工具全都**立即返回**。派活不会等任务跑完——那是 §4.1 的全双工：Router 立刻
 * 收到「已启动」，结果之后作为一条新事件回到它这里。这就是为什么 Router 一轮
 * 推理可以很短，而活可以跑很久。
 */

/**
 * 一条被回忆起的记忆。
 *
 * 带 id 不是装饰：模型看到「他说文档放 README 里就够了」，如果不知道这条从哪来，
 * 就没法核对、也没法顺着它去读全文。事件链路早就是这么做的（`recall <id>`）。
 */
export interface MemoryHit {
  id: string;
  kind: string;
  content: string;
  createdAt: number;
  sourceType: string;
  /** 相关度。用它判断「真对上了」与「我记得最牢的几条」，不要用排序分。 */
  relevance: number;
}

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

  /** 对你说话。这是 Router 唯一能让人看见它的方式。 */
  reply(text: string): void;

  /** 链式召回：返回一个对象的压缩视图 + 相邻对象的 id（Inline & Spill）。 */
  recall(id: string): string;

  lines(state?: 'active' | 'all'): LineSummary[];

  /**
   * 你中途改方向。`live` = 真的插进了正在跑的会话；`queued` = 记在这条线上，
   * 等它开跑/重试时带上。`ok: false` 表示这条线已经收尾，改方向得开新线。
   */
  steerLine(
    threadId: string,
    note: string,
  ): Promise<{ ok: boolean; reason?: string; live: number; queued: number }>;

  askUser(threadId: string | null, question: string): { ok: boolean; reason?: string };

  closeLine(threadId: string, summary: string): { ok: boolean; reason?: string };

  /** 记一件关于你的事（偏好、否决过的方向、要求的格式）。 */
  /**
   * 记一条。
   *
   * `standing` 是"每轮都要在场"的那一层：称呼、语气、格式禁令。只有用户明说
   * 「以后都这样」时才该用它——常驻层有硬上限，塞满了会挤掉真正重要的。
   */
  remember(
    text: string,
    options?: { standing?: boolean },
  ): Promise<{ ok: boolean; id?: string; reason?: string }>;

  /** 撤掉一条记忆（用户说"以后别这样了"）。 */ 
  forget(id: string): Promise<{ ok: boolean; reason?: string }>;

  /** 按一句话回想以前记过什么。带 id，别人才追得回出处。 */
  recallMemory(query: string): Promise<{ ok: boolean; items?: MemoryHit[]; reason?: string }>;
}

const ok = (text: string, details?: Record<string, string | null>) => ({
  output: [{ type: 'text' as const, text }],
  ...(details ? { details } : {}),
});

/** 记忆里只存毫秒时间戳；给人看需要的是"哪一天"。 */
function formatDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

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
          '你是这个工作台的调度者，也是用户唯一对话的对象。',
          '',
          '## 你做什么',
          '用户说的话由你接住，判断该不该派活，把活派出去，然后把结果收回来讲给他。',
          '你负责的是**任务之间**的关系：哪件事和哪件事是同一件、哪件事该先做、',
          '哪件事卡住了要不要说。你不介入单件事内部怎么拆。',
          '用户在活还没干完时改主意，用 steer_line 把那句话带到那条线上——那仍然是同一件事，',
          '不要为此开第二条线。',
          '',
          '## 你要记得',
          '你是一个跨天、跨工作线连续的存在：他说过什么、否决过什么，不该每次重新问。',
          '听到"以后都这样""别再做 X"这类要求，用 remember 记下来；',
          '拿不准他以前的偏好时，先 recall_memory，别用猜测填空。',
          '输入里如果带着"工作台的规矩"，那是长期有效的约定，优先于你这一次的临时判断。',
          '',
          '## 你不做什么',
          '你没有文件读写、没有 shell、没有代码执行。活不是你干的。',
          '所以：**绝不声称自己读过文件、跑过命令、改过代码、查过资料**——你没做。',
          '绝不编造执行结果。手上没有证据时，就说没有，或者去开一条线查。',
          '',
          '## 怎么说话',
          '用户在聊天窗口里跟你说话。他问「怎么样了」，就照实说手上有哪几条线、各到哪一步；',
          '不知道进度时不要用猜测填空。回答简短、具体，不复述他的原话。',
          '',
          '## 打扰的纪律',
          '大部分事情不需要他知道。干完了就安静地记在线上，只有两种情形值得开口：',
          '需要他拍板（ask_user），或者他要的那件事完成了（reply_to_user）。',
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
        name: 'reply_to_user',
        description:
          '对用户说一句话。这是用户唯一能看到你的途径——不调用它，你等于没说话。' +
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
          '需要更细就继续 recall 那个 id。' +
          '内容长的时候只回一页，末尾会告诉你还有几页、下一段怎么取——' +
          '把全文一次倒进上下文，等于把 Inline & Spill 做的预算白扔掉。',
        parameters: Type.Object({
          id: Type.String({ description: 'thread / worker / task / event / report 的 id' }),
          page: Type.Optional(
            Type.Number({ description: '第几段（从 1 开始）。上一页的末尾会告诉你下一页是几。' }),
          ),
        }),
        execute: async (args) => ok(recallView(deps.recall(args.id), args.id, args.page ?? 1)),
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
          '用户中途改了方向：把这句话带到一条**还没收尾**的线上。' +
          '正在跑的活在这一轮之后就能看到它；还没开跑的活会在开跑时看到它。' +
          '不要为此开第二条线——同一件事换个方向还是同一件事。',
        parameters: Type.Object({
          thread_id: Type.String(),
          note: Type.String({ description: '改什么、为什么改。执行体会把它当成最高优先级的说明。' }),
        }),
        execute: async (args) => {
          const result = await deps.steerLine(args.thread_id, args.note);
          if (!result.ok) return fail(`没带上：${result.reason ?? '未知原因'}`);
          return ok(
            result.live > 0
              ? `已经插到正在跑的活上（${result.live} 条），它这一轮就能看到。`
              : `记在这条线上了（${result.queued} 条活还没开跑），它开跑时会看到。`,
          );
        },
      }),

      defineTool({
        name: 'ask_user',
        description:
          '需要用户拍板时用。这会进他的注意力队列并打断他——只在真的需要一个人做决定时才用；' +
          '能自己判断的一律自己判断。',
        parameters: Type.Object({
          thread_id: Type.Optional(Type.String()),
          question: Type.String({ description: '一个可以直接回答的问题，带上下文。' }),
        }),
        execute: async (args) => {
          const result = deps.askUser(args.thread_id ?? null, args.question);
          return result.ok ? ok('已经进队列。') : fail(`没进队列：${result.reason}`);
        },
      }),

      defineTool({
        name: 'remember',
        description:
          '记一件关于用户的事：他的偏好、他否决过的方向、他要求过的格式。' +
          '记的是**跨工作线**仍然成立的事；某条线内部的进展不属于这里。只是记下来，不必为此回话。' +
          '以后都成立的规矩（称呼、语气、格式禁令）用 standing 记——那种每轮都会生效，位置有限。',
        parameters: Type.Object({
          text: Type.String({
            description:
              '一句话，写清是谁的什么偏好。例如「他说文档放 README 里就够了，别单开 wiki」。' +
              'standing 时要写成可执行的约束，不是描述：「回答不要客套」而不是「他好像喜欢简洁」。',
          }),
          standing: Type.Optional(
            Type.Boolean({
              description:
                '这条要每轮都生效吗。只有用户明说「以后都这样」「记住」时才设 true；' +
                '常驻层位置有限（20 条），满了会被拒绝。',
            }),
          ),
        }),
        execute: async (args) => {
          const result = await deps.remember(args.text, { standing: args.standing === true });
          // id 放进 details 而不是正文：模型需要它去 recall，用户不需要在聊天里看到它。
          return result.ok
            ? ok(args.standing ? '记住了，以后都按这个来。' : '记住了。', { memoryId: result.id ?? null })
            : fail(`没记上：${result.reason ?? '未知原因'}`);
        },
      }),

      defineTool({
        name: 'recall_memory',
        description:
          '按一句话回想以前记过什么。开工前想知道"他说过什么"时用它——' +
          '上下文里没有的东西不代表没发生过。什么都没有就如实说没有。',
        parameters: Type.Object({
          query: Type.String({ description: '要回想的事，用自己的话写。' }),
        }),
        execute: async (args) => {
          const result = await deps.recallMemory(args.query);
          if (!result.ok) return fail(`没想起来：${result.reason ?? '未知原因'}`);
          if (!result.items || result.items.length === 0) return ok('没有相关的记录。');

          const lines = result.items.map(
            (item) =>
              `- ${item.id} · ${item.kind} · ${formatDay(item.createdAt)} · ${item.sourceType} · ${item.content}`,
          );
          // 一条都对不上时如实说，而不是把"我记得最牢的几条"伪装成"这就是你要的"。
          const matched = result.items.some((item) => item.relevance > 0.02);
          return ok(
            (matched ? [] : ['（没有直接对得上的记录，以下按我记得的强度列出）'])
              .concat(lines)
              .join('\n'),
          );
        },
      }),

      defineTool({
        name: 'forget_memory',
        description:
          '撤掉一条记忆。用户说「以后别这样了」「那条不算」的时候用它。' +
          '不知道是哪一条，先 recall_memory 找到 id。撤掉是归档，不是销毁。',
        parameters: Type.Object({
          id: Type.String({ description: '要撤掉的那条记忆的 id（mem-…）。' }),
        }),
        execute: async (args) => {
          const result = await deps.forget(args.id);
          return result.ok ? ok('撤掉了。') : fail(`没撤掉：${result.reason ?? '未知原因'}`);
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
