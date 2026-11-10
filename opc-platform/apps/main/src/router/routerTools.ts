import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import type { ChatContentBlock, RouterResponse, TaskContract } from '@opc/shared/domain';
import { recallView } from './inline';
import { renderRouterWorkerCapabilities, type RouterWorkerCapability } from './routerCapabilities';
import { AssistantToolsService, createAssistantToolsExtension } from '../assistant/assistantTools';

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
 *   ask_user           在当前对话发起问题卡片（不进入注意力队列）
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
    contract: TaskContract;
    title?: string;
    /** 环境身份：同一个 key 的后续事件会并到这条线上。 */
    threadKey?: string | null;
    /** 由哪个执行体干；不指定就按目标挑一个模板。 */
    template?: 'research' | 'code' | 'ops';
    replyTarget?: string;
    threadId?: string;
  }): { ok: true; threadId: string; workerId: string; taskId: string | null } | { ok: false; reason: string };

  /** 对你说话。这是 Router 唯一能让人看见它的方式。 */
  /** `replyTarget` 是输入里提供的原始信道地址；不传则回桌面助手。 */
  reply(response: RouterResponse | string, replyTarget?: string, content?: ChatContentBlock[]): unknown | Promise<unknown>;

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
    options?: { standing?: boolean; kind?: string; subject?: string },
  ): Promise<{ ok: boolean; id?: string; reason?: string }>;

  /** 撤掉一条记忆（用户说"以后别这样了"）。 */ 
  forget(id: string): Promise<{ ok: boolean; reason?: string }>;

  /** 按一句话回想以前记过什么。带 id，别人才追得回出处。 */
  recallMemory(query: string): Promise<{ ok: boolean; items?: MemoryHit[]; reason?: string }>;

  /** Durable, evidence-backed write boundary for ontology actions. */
  ontologyCommand?(input: {
    objectType: string;
    objectId: string;
    action: string;
    args?: Record<string, unknown>;
    expectedVersion?: number;
    idempotencyKey: string;
  }): Promise<{ ok: boolean; command: { commandId: string; status: string; approvalId: string | null; error: string | null }; error?: string }>;

  /** Dynamic metadata-only view of tools available to Workers. */
  workerCapabilities?: () => readonly RouterWorkerCapability[] | Promise<readonly RouterWorkerCapability[]>;
  assistantTools?: AssistantToolsService;
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
          '较大的任务由后台执行体完成，你不直接读写文件、跑命令或改代码；时间、天气、网页检索与计算可使用本机提供的常用工具直接处理。',
          '所以：**绝不声称自己做过尚未完成的事，也绝不编造执行结果**。',
          '这是内部边界，不是给用户的解释。手上没有证据时，去开一条线查，或简短说明确实缺什么。',
          '',
          '## 怎么说话',
          '你是一个自然、可靠、简洁的助手。用户只关心结果、当前状态和下一步，不关心你的工具、模型、工作线、执行体或内部协议。',
          '不要向用户解释你如何派活、如何调工具、如何验收，也不要暴露 thread、worker、task、工具名或内部能力边界；除非用户明确询问系统实现。',
          '执行体汇报是供你判断的内部材料，不是可直接转发的对话稿；不要照抄它的第一人称、自我介绍、借口、情绪、工具过程或失败预案，只提炼有证据的结果。',
          '刚启动后台任务但还没有结果时，不要发送开始确认；顶部状态会显示处理中。若用户同时提出了可立即回答的问题，只回答该问题。',
          '有结果时直接交付结果和产物；失败时只说明已经确认的具体原因和一个可执行的下一步。',
          '回答先给结论，通常一到三句；不复述用户原话，不使用“主人”“莉莉丝”等角色化称呼，除非用户明确要求。',
          '用户问「怎么样了」时，只说对用户有用的状态；不要把内部工作线清单或运行日志抄给他。',
          '',
          '## 打扰的纪律',
          '大部分事情不需要他知道。后台任务刚成功派发时保持安静；只有任务完成、需要用户拍板，或需要用户补充信息时才开口。' +
            '任何面向用户的最终回复都必须调用 reply_to_user；' +
            '普通文字放进 markdown block，媒体和文件按顺序放进对应 block。工具调用、思考和中间文字不会展示给用户。',
          '每一次打扰都要有理由；没有理由的汇报是噪音。',
        ].join('\n'),
      ),
      ...(deps.workerCapabilities
        ? [
            section('worker-capabilities', async () => {
              try {
                return renderRouterWorkerCapabilities(await deps.workerCapabilities!());
              } catch (error) {
                console.warn('[router] Worker 能力目录读取失败', error);
                return [
                  '暂时无法读取 Worker 工具目录。',
                  '不要把 Router 自己的工具列表当成整个系统的能力；需要执行时先尝试派发，并依据实际汇报说明失败原因。',
                ].join('\n');
              }
            }),
          ]
        : []),
    ],
    tools: [
      ...(deps.assistantTools ? createAssistantToolsExtension(deps.assistantTools).tools ?? [] : []),
      defineTool({
        name: 'open_line_of_work',
        description:
          '把一件事派出去：提供明确的 objective、deliverable、outputs 和可选验收条件，' +
          '启动后台任务后立即返回，不会等它跑完；成功启动本身不需要聊天确认。' +
          '任务结束或需要用户输入时再反馈。返回的 id 是内部引用，不能原样放进用户回复。',
        parameters: Type.Object({
          contract: Type.Object({
            objective: Type.String({ description: '要解决的问题或要达成的目标。' }),
            deliverable: Type.String({ description: '完成后必须交付什么。' }),
            outputs: Type.Array(
              Type.Union([
                Type.Object({
                  kind: Type.Literal('text'),
                  description: Type.String({ description: '文本回答的内容和形状。' }),
                }),
                Type.Object({
                  kind: Type.Literal('file'),
                  description: Type.String({ description: '文件交付物的内容和用途。' }),
                  path: Type.String({ description: '工作区内的相对路径。' }),
                }),
              ]),
              { minItems: 1, description: '声明需要验收的文本或文件输出；不限制 Worker 的实现方式。' },
            ),
            attachments: Type.Optional(Type.Array(Type.Object({
              id: Type.String(), name: Type.String(), path: Type.String(), size: Type.Number(),
              mimeType: Type.Optional(Type.String()), source: Type.Union([Type.Literal('file'), Type.Literal('clipboard')]),
            }), { description: '用户提供的附件路径引用；只读使用，不要复制到工作区。' })),
            acceptance: Type.Optional(
              Type.Object({
                command: Type.Array(Type.String(), { minItems: 1, description: 'argv 形式的验收命令。' }),
                template: Type.Optional(
                  Type.Union([
                    Type.Literal('http-ok'),
                    Type.Literal('node-test'),
                    Type.Literal('image-200'),
                    Type.Literal('review-verdict'),
                  ]),
                ),
              }),
            ),
          }),
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
          speculative: Type.Optional(
            Type.Boolean({
              description:
                '静默线：这条线跑通了才告诉你，没跑通就当没发生。用在"值得跑，但值不值得让他知道' +
                '还不确定"的事上（例如群里有人报了个错）。它不会打扰他，所以也不要拿它派他明确要的活。',
            }),
          ),
          reply_target: Type.Optional(
            Type.String({ description: '可选：输入事件提供的原始信道地址，必须原样复制。' }),
          ),
          thread_id: Type.Optional(
            Type.String({ description: '手工目标已预建的工作线 id；输入里出现时必须原样使用。' }),
          ),
        }),
        execute: async (args) => {
          const result = deps.openLine({
            contract: args.contract,
            ...(args.title ? { title: args.title } : {}),
            ...(args.thread_key ? { threadKey: args.thread_key } : {}),
            ...(args.template ? { template: args.template } : {}),
            ...(args.speculative ? { speculative: true } : {}),
            ...(args.reply_target ? { replyTarget: args.reply_target } : {}),
            ...(args.thread_id ? { threadId: args.thread_id } : {}),
          });
          if (!result.ok) return fail(`没派出去：${result.reason}`);
          return ok(
            '后台任务已启动；不要发送开始确认，完成或需要用户输入时再反馈。',
            // IDs remain in structured details for the Router to use with recall;
            // keeping them out of prose reduces the chance they leak into chat.
            { threadId: result.threadId, workerId: result.workerId, taskId: result.taskId },
          );
        },
      }),

      defineTool({
        name: 'reply_to_user',
        description:
          '提交本轮唯一的最终用户回复。必须用 blocks 按顺序混排 markdown、图片、视频、音频和文件；' +
          '工具调用、思考和中间文本不会展示给用户。markdown 只写面向用户的结论、状态、产物或下一步，' +
          '通常一到三句；不要写派活过程、工作线/执行体/工具/模型/验收细节、自我介绍或失败预案。' +
          '可选 reply_target 只能使用当前输入里明确出现过的地址。',
        parameters: Type.Object({
            blocks: Type.Array(Type.Union([
              Type.Object({ type: Type.Literal('markdown'), text: Type.String() }),
              Type.Object({
                type: Type.Union([Type.Literal('image'), Type.Literal('video'), Type.Literal('audio')]),
                source: Type.Union([
                  Type.Object({ type: Type.Literal('url'), url: Type.String() }),
                  Type.Object({ type: Type.Literal('artifact'), taskId: Type.String(), relPath: Type.String() }),
                ]),
                alt: Type.Optional(Type.String()), title: Type.Optional(Type.String()),
              }),
              Type.Object({
                type: Type.Literal('file'),
                source: Type.Object({ type: Type.Literal('artifact'), taskId: Type.String(), relPath: Type.String() }),
                name: Type.Optional(Type.String()), title: Type.Optional(Type.String()),
              }),
            ]), { minItems: 1, description: '按顺序混排的最终内容块。' }),
            reply_target: Type.Optional(
              Type.String({
                description:
                  '可选：输入事件提供的原始信道地址。只有输入里明确出现过的地址才能使用；' +
                  '没有就省略，回桌面助手。',
              }),
            ),
          }),
          execute: async (args) => {
            const legacy = args as typeof args & { text?: string; content?: unknown };
            const blocks = normalizeReplyBlocks(args.blocks, legacy.text, legacy.content);
            if (blocks.length === 0) return fail('最终回复不能为空：请提交至少一个 markdown block。');
            // The dependency adapter accepts the legacy triplet while the tool
            // protocol itself remains blocks-only. RouterHost converts it into
            // the atomic RouterResponse before any delivery occurs.
            await deps.reply(
              legacy.text ?? blocks.filter((block): block is Extract<ChatContentBlock, { type: 'markdown' }> => block.type === 'markdown').map((block) => block.text).join('\n\n'),
              args.reply_target,
              blocks,
            );
            return ok('已提交最终回复。');
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
          '需要用户回复时用。这会在当前对话里发一张问题卡片——只在真的需要一个人做决定时才用；' +
          '能自己判断的一律自己判断。',
        parameters: Type.Object({
          thread_id: Type.Optional(Type.String()),
          question: Type.String({ description: '一个可以直接回答的问题，带上下文。' }),
        }),
        execute: async (args) => {
          const result = deps.askUser(args.thread_id ?? null, args.question);
          return result.ok ? ok('已在当前对话发出问题卡片。') : fail(`问题卡片发送失败：${result.reason}`);
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
          subject: Type.Optional(
            Type.String({
              description:
                '这条讲的是哪件事，用一个稳定的短名字（如 output.format、称呼、accent.color）。' +
                '同一个名字上只留最新的一条，旧的自动留档——**改主意时用同一个名字再记一遍**，' +
                '不要换成新名字，否则两条会同时存在、互相矛盾。',
            }),
          ),
          kind: Type.Optional(
            Type.Union(
              [
                'preference',
                'constraint',
                'format',
                'workflow',
                'person',
                'term',
                'fact',
              ].map((value) => Type.Literal(value)),
              {
                description:
                  '这条是哪一类。format / workflow 会被执行体也看到（写东西的规矩），' +
                  'person / term 只在被问到的时候才有意义。默认 preference。',
              },
            ),
          ),
        }),
        execute: async (args) => {
          const result = await deps.remember(args.text, {
            standing: args.standing === true,
            ...(args.subject ? { subject: args.subject } : {}),
            ...(args.kind ? { kind: args.kind } : {}),
          });
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
        name: 'ontology_command',
        description:
          '通过个人本体的唯一写入边界执行结构化动作。用于更新 Goal、Preference、Project，' +
          '或撤回一条有证据的断言。动作会幂等记录；高风险动作会在当前对话展示审批卡，' +
          '批准后继续执行同一条命令。不要用它替代普通的 open_line_of_work。',
        parameters: Type.Object({
          object_type: Type.String({ description: '对象类型，例如 Goal、Project、User。' }),
          object_id: Type.String({ description: '对象 id；新建 Project 时可使用临时标识。' }),
          action: Type.String({ description: '动作，例如 update_goal、update_preference、create_project、retract_assertion。' }),
          args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          expected_version: Type.Optional(Type.Number()),
          idempotency_key: Type.String({ description: '同一业务动作的稳定幂等键。' }),
        }),
        execute: async (args) => {
          if (!deps.ontologyCommand) return fail('当前运行环境没有启用本体命令服务。');
          const result = await deps.ontologyCommand({
            objectType: args.object_type,
            objectId: args.object_id,
            action: args.action,
            ...(args.args ? { args: args.args as Record<string, unknown> } : {}),
            ...(typeof args.expected_version === 'number' ? { expectedVersion: args.expected_version } : {}),
            idempotencyKey: args.idempotency_key,
          });
          if (!result.ok) return fail(`本体命令未执行：${result.error ?? result.command.error ?? '未知原因'}`);
          return ok(`本体命令 ${result.command.commandId} 当前状态：${result.command.status}`, {
            commandId: result.command.commandId,
            approvalId: result.command.approvalId,
          });
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
        description:
          '收线：这件事结束了。写清最后的结果，那是这条线留给以后的记忆。' +
          '**线上还有活没跑完时收不了**——先等它们结束（或者让它们失败），再收。' +
          '收早了，那些任务会变成没人认领的后台任务，跑完也没有线可以汇报。',
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

/** Normalize the current protocol and the two pre-structured-response shapes. */
function normalizeReplyBlocks(
  blocks: unknown,
  text?: string,
  legacyContent?: unknown,
): ChatContentBlock[] {
  if (Array.isArray(blocks)) {
    return blocks.filter(isReplyBlock);
  }
  if (Array.isArray(legacyContent)) {
    const converted: ChatContentBlock[] = [];
    for (const value of legacyContent) {
      if (!value || typeof value !== 'object') continue;
      const block = value as Record<string, unknown>;
      const type = block.type;
      if (type === 'markdown' && typeof block.text === 'string') { converted.push({ type: 'markdown', text: block.text }); continue; }
      if (type === 'image' || type === 'video' || type === 'audio') {
        if (typeof block.url === 'string') { converted.push({ type, source: { type: 'url', url: block.url }, ...(typeof block.alt === 'string' ? { alt: block.alt } : {}), ...(typeof block.title === 'string' ? { title: block.title } : {}) }); continue; }
        if (typeof block.taskId === 'string' && typeof block.relPath === 'string') { converted.push({ type, source: { type: 'artifact', taskId: block.taskId, relPath: block.relPath }, ...(typeof block.alt === 'string' ? { alt: block.alt } : {}), ...(typeof block.title === 'string' ? { title: block.title } : {}) }); continue; }
      }
    }
    return converted;
  }
  return typeof text === 'string' && text.trim() ? [{ type: 'markdown', text }] : [];
}

function isReplyBlock(value: unknown): value is ChatContentBlock {
  if (!value || typeof value !== 'object') return false;
  const block = value as Record<string, unknown>;
  if (block.type === 'markdown') return typeof block.text === 'string';
  if (block.type === 'file') {
    const source = block.source;
    return Boolean(source && typeof source === 'object' && (source as Record<string, unknown>).type === 'artifact' && typeof (source as Record<string, unknown>).taskId === 'string' && typeof (source as Record<string, unknown>).relPath === 'string');
  }
  if (block.type === 'image' || block.type === 'video' || block.type === 'audio') {
    const source = block.source;
    if (!source || typeof source !== 'object') return false;
    const sourceRecord = source as Record<string, unknown>;
    return (sourceRecord.type === 'url' && typeof sourceRecord.url === 'string') ||
      (sourceRecord.type === 'artifact' && typeof sourceRecord.taskId === 'string' && typeof sourceRecord.relPath === 'string');
  }
  return false;
}
