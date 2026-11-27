import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import type {
  ChannelTargetView,
  ChatContentBlock,
  RouterResponse,
  TaskContract,
} from '@opc/shared/domain';
import type { RouterSchedule, RouterScheduleDraft, RouterSchedulePatch } from '@opc/shared/domain';
import { recallView } from './inline';
import { renderRouterWorkerCapabilities, type RouterWorkerCapability } from './routerCapabilities';
import { createAssistantToolsExtension } from '../assistant/assistantTools';
import type { AssistantToolsService } from '../assistant/assistantTools';
import { createGitHubToolsExtension } from '../channels/github/githubTools';
import type { ChannelStore } from '../channels/store';

/**
 * Router 的工具带。
 *
 * Router 是**序点**，不是人手：它承接人类交互、维持全局上下文、把活派出去，
 * 自己**不执行**具体任务。所以这里没有 bash、读写文件、代码执行——那套工具属于
 * Worker（§2.1「甚至可以不配备 Bash 工具」）。
 *
 * Router 工具带覆盖协调、记忆与定时计划：
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
   * 等它开跑/重试时带上。若线程刚完成也可无缝续跑。
   */
  steerLine(
    threadId: string,
    note: string,
    options?: { updatedObjective?: string; updatedOutputs?: TaskContract['outputs'] },
  ): Promise<{ ok: boolean; reason?: string; live: number; queued: number; continuedTaskId?: string }>;

  /** 在已有工作线（运行中或 WarmIdle）上继续追加改动或转向，复用同一工作区和上下文。 */
  continueLine?(input: {
    threadId: string;
    instruction: string;
    mode: 'append' | 'pivot';
    updatedOutputs?: TaskContract['outputs'];
    acceptance?: TaskContract['acceptance'];
  }): Promise<
    | { ok: true; threadId: string; taskId: string | null; workerId?: string; mode: 'append' | 'pivot' | 'steered' }
    | { ok: false; reason: string }
  >;

  /** 立即中止一条工作线上正在运行或排队的任务。 */
  abortLine?(
    threadId: string,
    reason: string,
    options?: { closeThread?: boolean },
  ): Promise<{ ok: boolean; abortedTasks?: number; reason?: string }>;

  askUser(threadId: string | null, question: string): { ok: boolean; reason?: string };

  closeLine(threadId: string, summary: string): { ok: boolean; reason?: string };

  /** Dynamic standing/preferences/rules prompt section (replaces per-turn user-message duplication). */
  standingSection?: () => string | undefined | Promise<string | undefined>;
  /** Dynamic workspace rules prompt section. */
  rulesSection?: () => string | undefined | Promise<string | undefined>;
  /** Dynamic 1-line summary board of active and recently warm threads. */
  activeLinesBoard?: () => string | undefined | Promise<string | undefined>;

  /** 记一件关于你的事（偏好、铁律、避坑经验或专题事实）。 */
  remember(
    text: string,
    options?: { standing?: boolean; kind?: string; subject?: string },
  ): Promise<{ ok: boolean; id?: string; reason?: string }>;

  /** 撤掉一条记忆（用户说"以后别这样了"）。 */ 
  forget(id: string): Promise<{ ok: boolean; reason?: string }>;

  /** 按一句话回想以前记过什么。带 id，别人才追得回出处。 */
  recallMemory(query: string): Promise<{ ok: boolean; items?: MemoryHit[]; reason?: string }>;

  /** Dynamic metadata-only view of tools available to Workers. */
  workerCapabilities?: () => readonly RouterWorkerCapability[] | Promise<readonly RouterWorkerCapability[]>;
  assistantTools?: AssistantToolsService;
  channelStore?: ChannelStore;
  schedules?: {
    create(draft: RouterScheduleDraft): RouterSchedule;
    list(): RouterSchedule[];
    update(id: string, patch: RouterSchedulePatch): RouterSchedule;
    cancel(id: string): RouterSchedule;
  };
  channels?: {
    listTargets(): ChannelTargetView[];
    sendMessage(input: {
      address: string;
      text: string;
      filePaths?: string[];
    }): Promise<{ ok: boolean; messageId?: string; error?: string }>;
  };
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
  const githubExtension = deps.channelStore ? createGitHubToolsExtension(deps.channelStore) : undefined;
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
          '用户基于已有工作线的产物/代码/页面追加需求、小改或换方案时，优先用 continue_line（mode="append" 追加，mode="pivot" 放弃当前跑偏路线并在同一工作区转向），不要重新 open_line_of_work。',
          '用户明确要求停下或放弃某件正在跑的活时，立即调用 abort_line，不要等它跑完。',
          '用户通过聊天上传的附件，在调用 open_line_of_work / continue_line / steer_line 时系统会自动复制文件本体到目标工作区的 inputs/ 目录，执行体可直接读取；不要向用户声称“只收到本地路径/无法访问 D 盘”或要求用户手动拖文件到工作区。',
          '用户明确要求未来某个时间提醒或重复检查时，用 create_schedule 建立计划；用户没有给出必要日期、时间或时区时先询问。',
          '定时请求到期后视作用户预先安排的输入，结合届时上下文决定是否 open_line_of_work；不要只因为计划到期就盲目执行过时或失去意义的请求。',
          '收到来自飞书、钉钉、Slack 等外部渠道的消息且带有 reply_target 时，调用 reply_to_user 并传入对应的 reply_target 即可原路回复该会话；如需主动向外部群/频道或联系人推送消息（例如定时汇报），先用 channel_list_targets 查询真实已知地址，再用 channel_send_message 发送，禁止编造外部会话地址。',
          '',
          '## 你要记得',
          '你的系统上下文里每轮都带有用户画像（USER.md）、长期铁律（RULES.md）和专题目录，输入里也会自动附带相关的避坑提醒（PLAYBOOK.md）与专题片段。',
          '听到用户明确说“以后都这样”“别再做 X”时，用 remember 记下来；发现某条规则过时或用户否决时，先 recall_memory 查出引用 id（如 memory:RULES.md#1），再 forget_memory。',
          '遇到与专题/过往经历相关但当前输入未附带的细节，主动用 recall_memory 或 recall 读取（memory:topics/<slug>.md 等），不要用猜测填空。',
          '输入或系统段里如果带着“工作台的规矩”与“长期铁律”，那是长期有效的约定，优先于你的临时判断。',
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
          '重试失败任务前先核对已确认的阻塞原因：只有用户提供的信息可能改变该原因时才重试；若新信息没有解决或未涉及阻塞原因，先做一次有上限的只读预检，仍未改变就询问用户或说明替代路径。',
          '同一结果已经告诉用户后，除非出现新状态、新证据或新的可执行下一步，不要重复播报。',
          '回答先给结论，通常一到三句；不复述用户原话，不使用“主人”“莉莉丝”等角色化称呼，除非用户明确要求。',
          '用户问「怎么样了/进展到哪里/做了挺久」时，必须先用 recall 核对最新任务的实际最近动作（trace）与待审批状态；标记为「审批·已处理，不再阻塞」的历史记录说明用户早已放行。只要最近动作仍在正常推进，就如实告知正在处理哪一步，严禁臆断“卡死/看不到授权弹窗”而用 steer_line 打断正在正常工作的执行体。',
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
      ...(deps.rulesSection
        ? [
            section('workspace-rules', async () => {
              try {
                return (await deps.rulesSection!()) || undefined;
              } catch {
                return undefined;
              }
            }),
          ]
        : []),
      ...(deps.standingSection
        ? [
            section('user-standing', async () => {
              try {
                return (await deps.standingSection!()) || undefined;
              } catch {
                return undefined;
              }
            }),
          ]
        : []),
      ...(deps.activeLinesBoard
        ? [
            section('active-lines-board', async () => {
              try {
                return (await deps.activeLinesBoard!()) || undefined;
              } catch {
                return undefined;
              }
            }),
          ]
        : []),
      ...(githubExtension?.sections ?? []),
    ],
    tools: [
      ...(deps.assistantTools ? createAssistantToolsExtension(deps.assistantTools).tools ?? [] : []),
      ...(githubExtension?.tools ?? []),
      ...(deps.schedules ? scheduleTools(deps.schedules) : []),
      ...(deps.channels ? channelTools(deps.channels) : []),
      defineTool({
        name: 'open_line_of_work',
        description:
          '开一条全新的工作线（适合独立新主题）。如果是在已有工作线的代码/文件/页面上追加改动或调整方向，请优先使用 continue_line 或 steer_line。' +
          '启动后台任务后立即返回，不会等它跑完；成功启动本身不需要聊天确认。' +
          '任务结束或需要用户输入时再反馈。返回的 id 是内部引用，不能原样放进用户回复。',
        parameters: Type.Object({
          contract: Type.Object({
            objective: Type.String({
              description:
                '要解决的问题或要达成的目标。写清目标、事实与交付标准即可，不要替执行体规定逐页 read 大图或串行步骤等内部实现方式。',
            }),
            deliverable: Type.String({ description: '完成后交付物的一句话概括，简洁明了，不要照抄 objective 全文。' }),
            outputs: Type.Optional(
              Type.Array(
                Type.Union([
                  Type.Object({
                    kind: Type.Literal('text'),
                    description: Type.String({ description: '文本回答的内容和形状。' }),
                  }),
                  Type.Object({
                    kind: Type.Literal('file'),
                    description: Type.String({ description: '最终文件交付物的内容和用途。' }),
                    path: Type.String({
                      description:
                        '工作区内的 POSIX 相对路径（必须用 / 分隔）；推荐统一放在 output/ 目录下（不要混用 output/ 与 outputs/）。',
                    }),
                  }),
                ]),
                {
                  minItems: 1,
                  description:
                    '可选：声明需要验收的最终文本或文件输出；只为最终交付物声明 file（不要把中间脚本或临时文件列入），省略时默认接受文本结论。',
                },
              ),
            ),
            attachments: Type.Optional(Type.Array(Type.Object({
              id: Type.String(), name: Type.String(), path: Type.String(), size: Type.Number(),
              mimeType: Type.Optional(Type.String()), source: Type.Union([Type.Literal('file'), Type.Literal('clipboard')]),
            }), { description: '可选：用户上传的附件引用；省略时默认附带当前输入里的附件，如果该新任务与当前输入附件无关请显式传 []。系统会自动将文件本体复制到执行体工作区的 inputs/ 目录供安全读取。' })),
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
          const outputs = args.contract.outputs?.length
            ? args.contract.outputs
            : [{ kind: 'text' as const, description: args.contract.deliverable || '完成后的结论与交付结果' }];
          const result = deps.openLine({
            contract: { ...args.contract, outputs },
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
          '用户中途改了方向或追加小需求：把这句话带到一条工作线上，并可同步更新目标/产出清单。' +
          '正在跑的活在这一轮之后就能看到它；如果该线刚完成，会自动在同一工作区和上下文续跑。' +
          '不要为此开第二条线——同一件事换个方向还是同一件事。',
        parameters: Type.Object({
          thread_id: Type.String(),
          note: Type.String({ description: '改什么、为什么改。执行体会把它当成最高优先级的说明。' }),
          updated_objective: Type.Optional(Type.String({ description: '可选：更新后的活目标（LivingGoal）。' })),
          updated_outputs: Type.Optional(
            Type.Array(
              Type.Union([
                Type.Object({
                  kind: Type.Literal('text'),
                  description: Type.String(),
                }),
                Type.Object({
                  kind: Type.Literal('file'),
                  description: Type.String(),
                  path: Type.String({ description: '工作区内的 POSIX 相对路径（用 / 分隔，推荐统一放在 output/ 目录）。' }),
                }),
              ]),
              { description: '可选：同步更新后的最终交付物清单。' },
            ),
          ),
        }),
        execute: async (args) => {
          const result = await deps.steerLine(args.thread_id, args.note, {
            ...(args.updated_objective ? { updatedObjective: args.updated_objective } : {}),
            ...(args.updated_outputs ? { updatedOutputs: args.updated_outputs } : {}),
          });
          if (!result.ok) return fail(`没带上：${result.reason ?? '未知原因'}`);
          if (result.continuedTaskId) {
            return ok('已在该工作线的原有上下文和工作区上继续执行新要求；不要发送开始确认。', {
              threadId: args.thread_id,
              taskId: result.continuedTaskId,
            });
          }
          return ok(
            result.live > 0
              ? `已经插到正在跑的活上（${result.live} 条），它这一轮就能看到。`
              : `记在这条线上了（${result.queued} 条活还没开跑），它开跑时会看到。`,
          );
        },
      }),

      ...(deps.continueLine
        ? [
            defineTool({
              name: 'continue_line',
              description:
                '在已有工作线（无论正在运行还是刚完成/待机）的同一工作区和同一执行体上下文里继续干活。' +
                'mode="append" 用于追加功能、顺手修改细节、继续调研；' +
                'mode="pivot" 用于推翻当前跑偏的路线：会自动中止旧任务、清理错路上下文，再从干净检查点按新方向继续。' +
                '用户在对话中新上传或引用过的附件会自动复制到该工作线的 inputs/ 目录供执行体读取。' +
                '不要为了增量改动去 open_line_of_work。',
              parameters: Type.Object({
                thread_id: Type.String({ description: '已有工作线的 id。' }),
                instruction: Type.String({
                  description:
                    '这次追加的新要求或转向后的具体指令。写清目标、事实与交付标准即可，不要替执行体规定逐页 read 大图或串行步骤等内部实现方式。',
                }),
                mode: Type.Optional(
                  Type.Union([Type.Literal('append'), Type.Literal('pivot')], {
                    description: 'append（默认）：在当前成果上增量修改；pivot：中止旧路线并从干净检查点转向。',
                  }),
                ),
                updated_outputs: Type.Optional(
                  Type.Array(
                    Type.Union([
                      Type.Object({ kind: Type.Literal('text'), description: Type.String() }),
                      Type.Object({
                        kind: Type.Literal('file'),
                        description: Type.String(),
                        path: Type.String({ description: '工作区内的 POSIX 相对路径（用 / 分隔，推荐统一放在 output/ 目录）。' }),
                      }),
                    ]),
                    { description: '可选：更新后的最终交付物清单。' },
                  ),
                ),
                acceptance: Type.Optional(
                  Type.Object({
                    command: Type.Array(Type.String(), { minItems: 1 }),
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
              execute: async (args) => {
                const mode = args.mode ?? 'append';
                const result = await deps.continueLine!({
                  threadId: args.thread_id,
                  instruction: args.instruction,
                  mode,
                  ...(args.updated_outputs ? { updatedOutputs: args.updated_outputs } : {}),
                  ...(args.acceptance ? { acceptance: args.acceptance } : {}),
                });
                if (!result.ok) return fail(`没续上：${result.reason}`);
                return ok(
                  result.mode === 'steered'
                    ? '已将增量改动注入当前正在运行的执行体；不要发送开始确认。'
                    : mode === 'pivot'
                      ? '已中止原路线并从干净上下文转向继续执行；不要发送开始确认。'
                      : '已在原工作区与上下文中启动增量修改；不要发送开始确认。',
                  { threadId: result.threadId, taskId: result.taskId, workerId: result.workerId ?? null },
                );
              },
            }),
          ]
        : []),

      ...(deps.abortLine
        ? [
            defineTool({
              name: 'abort_line',
              description:
                '立即中止某条工作线上正在运行或排队的后台任务。当用户说“先停下”“别做了”“方向错了先中止”时使用。',
              parameters: Type.Object({
                thread_id: Type.String({ description: '要中止的工作线 id。' }),
                reason: Type.String({ description: '中止原因，简短一句话。' }),
                close_thread: Type.Optional(
                  Type.Boolean({ description: '是否同时关闭这条工作线（默认 false，保留工作区供后续 continue_line）。' }),
                ),
              }),
              execute: async (args) => {
                const result = await deps.abortLine!(args.thread_id, args.reason, {
                  closeThread: args.close_thread === true,
                });
                if (!result.ok) return fail(`没停成：${result.reason ?? '未知原因'}`);
                return ok(`已中止工作线上的后台任务（${result.abortedTasks ?? 0} 个）。`, {
                  threadId: args.thread_id,
                });
              },
            }),
          ]
        : []),

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
        name: 'forget_memory',
        description:
          '撤掉一条记忆。用户说「以后别这样了」「那条不算」的时候用它。' +
          '可传 memory:RULES.md#1、memory:PLAYBOOK.md#场景、memory:topics/<slug>.md 或规则原句/关键词。',
        parameters: Type.Object({
          id: Type.String({ description: '要撤掉的记忆引用（如 memory:RULES.md#1）或对应关键词/原句。' }),
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

function scheduleTools(service: NonNullable<RouterToolDeps['schedules']>) {
  const rule = Type.Union([
    Type.Object({ kind: Type.Literal('once'), at: Type.String({ description: 'ISO 8601 日期时间，必须包含 UTC 偏移，如 2026-06-20T09:00:00+08:00。' }) }),
    Type.Object({ kind: Type.Literal('daily'), time: Type.String({ description: '24 小时制 HH:mm。' }) }),
    Type.Object({ kind: Type.Literal('weekdays'), time: Type.String({ description: '24 小时制 HH:mm。' }) }),
    Type.Object({ kind: Type.Literal('weekly'), time: Type.String(), daysOfWeek: Type.Array(Type.Number(), { minItems: 1 }) }),
    Type.Object({ kind: Type.Literal('monthly'), time: Type.String(), dayOfMonth: Type.Number() }),
  ]);
  const normalizeRule = (value: unknown): RouterScheduleDraft['rule'] => {
    const candidate = value as Record<string, unknown>;
    if (candidate?.kind !== 'once') return value as RouterScheduleDraft['rule'];
    if (typeof candidate.at !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(candidate.at)) {
      throw new Error('单次计划时间必须是包含时区偏移的 ISO 日期时间');
    }
    const at = Date.parse(candidate.at);
    if (!Number.isFinite(at)) throw new Error('单次计划日期时间无效');
    return { kind: 'once', at };
  };
  return [
    defineTool({
      name: 'create_schedule',
      description: '创建用户授权的定时请求。使用用户时区，时间不明确时先询问；不得凭空猜测时间。到期后 Router 会再次判断并决定是否派发。',
      parameters: Type.Object({
        title: Type.String({ description: '计划列表中显示的简短名称。' }),
        instruction: Type.String({ description: '到期时需要 Router 评估并处理的请求。' }),
        rule,
        timezone: Type.Optional(Type.String({ description: 'IANA 时区，如 Asia/Shanghai；省略则使用系统时区。' })),
      }),
      execute: async (args) => {
        try {
          const raw = args as unknown as { title: string; instruction: string; timezone?: string; rule: unknown };
          const normalized: RouterScheduleDraft = { ...raw, rule: normalizeRule(raw.rule) };
          const created = service.create(normalized);
          return ok(`已创建定时计划「${created.title}」，下次执行：${new Date(created.nextRunAt!).toLocaleString('zh-CN', { timeZone: created.timezone })}（${created.timezone}）。`, { scheduleId: created.id });
        } catch (error) {
          return fail(`创建计划失败：${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),
    defineTool({
      name: 'list_schedules',
      description: '查看定时计划及其下次执行时间。',
      parameters: Type.Object({ include_finished: Type.Optional(Type.Boolean()) }),
      execute: async (args) => {
        const rows = service.list().filter((row) => args.include_finished || ['active', 'paused'].includes(row.status));
        return ok(rows.length ? rows.map((row) => `${row.id} · ${row.title} · ${row.status} · ${row.nextRunAt ? new Date(row.nextRunAt).toLocaleString('zh-CN', { timeZone: row.timezone }) : '无下次执行'} (${row.timezone})\n  ${row.instruction}`).join('\n') : '没有定时计划。');
      },
    }),
    defineTool({
      name: 'update_schedule',
      description: '修改定时计划的内容或规则，也可以暂停或恢复。',
      parameters: Type.Object({
        schedule_id: Type.String(),
        title: Type.Optional(Type.String()),
        instruction: Type.Optional(Type.String()),
        rule: Type.Optional(rule),
        timezone: Type.Optional(Type.String()),
        status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('paused')])),
      }),
      execute: async (args) => {
        try {
          const { schedule_id: id, ...patch } = args;
          const normalizedPatch = { ...patch, ...(patch.rule ? { rule: normalizeRule(patch.rule) } : {}) };
          const updated = service.update(id, normalizedPatch as RouterSchedulePatch);
          return ok(`已更新「${updated.title}」，状态：${updated.status}。`);
        } catch (error) {
          return fail(`更新计划失败：${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),
    defineTool({
      name: 'cancel_schedule',
      description: '取消一个尚未完成的定时计划。',
      parameters: Type.Object({ schedule_id: Type.String() }),
      execute: async (args) => {
        try {
          const cancelled = service.cancel(args.schedule_id);
          return ok(`已取消「${cancelled.title}」。`);
        } catch (error) {
          return fail(`取消计划失败：${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),
  ];
}

function channelTools(service: NonNullable<RouterToolDeps['channels']>) {
  return [
    defineTool({
      name: 'channel_list_targets',
      description:
        '列出已连接的外部应用渠道（如飞书、钉钉、Slack、企业微信、Telegram、GitHub）近期活跃的会话目标，返回真实可用的 address（例如 feishu:chat:oc_...、dingtalk:dm:...、slack:channel:C...、wecom:dm:...、telegram:chat:...、github:owner/repo#12）、会话类型与标题。',
      parameters: Type.Object({}),
      execute: async () => {
        const targets = service.listTargets();
        if (targets.length === 0) {
          return ok('暂无外部渠道会话记录。请先让用户在飞书、钉钉、Slack、企业微信、Telegram 或 GitHub 里向机器人发送一条消息，或确认应用渠道已开启连接。');
        }
        const lines = targets.map(
          (t) =>
            `- ${t.address} · ${t.channelId} · ${t.chatKind === 'group' ? '群聊/频道' : '私聊'} · ${t.title} · 最近活跃：${new Date(t.lastActiveAt).toLocaleString('zh-CN')}`,
        );
        return ok(lines.join('\n'));
      },
    }),
    defineTool({
      name: 'channel_send_message',
      description:
        '主动向外部应用渠道（如飞书、钉钉、Slack、企业微信、Telegram 或 GitHub Issue/PR）发送消息，可选附带工作区内的文件。address 必须来自 channel_list_targets 或当前事件的 reply_target。',
      parameters: Type.Object({
        address: Type.String({
          description:
            '目标会话地址，例如 feishu:chat:oc_xxx、dingtalk:dm:staff123、slack:channel:Cxxx、wecom:dm:userid、telegram:chat:123456 或 github:owner/repo#12。',
        }),
        text: Type.String({ description: '要发送的文本或 Markdown 内容。' }),
        file_paths: Type.Optional(
          Type.Array(Type.String({ description: '工作区内的文件路径（可选）。' })),
        ),
      }),
      execute: async (args) => {
        const result = await service.sendMessage({
          address: args.address,
          text: args.text,
          ...(args.file_paths?.length ? { filePaths: args.file_paths } : {}),
        });
        if (!result.ok) {
          return fail(`外部渠道发送失败：${result.error ?? '未知错误'}`);
        }
        return ok(`已发送到 ${args.address}。`, {
          ...(result.messageId ? { messageId: result.messageId } : {}),
        });
      },
    }),
  ];
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
