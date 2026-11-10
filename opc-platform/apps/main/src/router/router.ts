import type { AttentionLevel, ChatAttachmentRef, TriggerEvent, WorkReport, WorkThread } from '@opc/shared/domain';
import type { FaultSink } from '../data/systemEventRepository';
import { messageOf } from '../data/systemEventRepository';
import type { ThreadRepository } from '../data/threadRepository';
import type { TriggerReplyTarget } from '../trigger/types';
import type { SemanticScreener } from './semanticGate';
import { DEFAULT_INLINE_BUDGET, perItemBudget, spillText, type InlineBudget } from './inline';
import { isValidThreadKey } from './threadKey';
import { bodyOf } from './triage';

/**
 * 调度循环：**一条流水线，Router 只在最后一段**。
 *
 * ```
 *   事件 ──► ① 程序层过滤 ──► ② 归属查表 ──► ③ 语义门 ──► ④ 冷启动交给 Router
 *             零 token         零 token        一次分类调用        一轮推理
 *                                  │
 *                                  └──► 有订阅者：直接派给执行体（不经过 Router）
 * ```
 *
 * 这个顺序是整篇设计的负载答案：**Router 的调用次数不随事件量线性增长，只随"新的
 * 事件流"和"需要说出口的汇报"增长**。同一份 PR 的第 50 条评论和第一条一样便宜——
 * 它走的是 ② 那条支路。
 *
 * 每段的职责都是单一的，而且失败方向都是"往上交"：
 *
 * - **① 程序层过滤**（§3.1 Fast Path，`triage.ts`）。噪声在这里就死掉，永远见不到
 *   模型。它只挡确定是噪声的三类，拿不准就放行。
 * - **② 归属查表**（§3.2 Fast Path）。事件带着环境身份（`threadKey`）来，这个身份上
 *   已经有一条活跃的线、线也已经有执行体在盯 → 直接发给它。原文 7.1 量过：去掉直通
 *   后完成时间几乎不变，但 Router 的决策数与读缓存 token 各涨约 30%，所以它省的是
 *   **成本与延迟**，不是正确性——关掉它活的照样能干，只是贵一些。
 * - **③ 语义门**（可选，`semanticGate.ts`）。只对"没有归属"的事件问一个问题：
 *   值不值得占用 Router 的上下文。它是省钱的一层，所以**没有丢活的权力**：模型没配、
 *   调用失败、答案缺失，一律放行。
 * - **④ 冷启动 / 协调**。到这里的只有两种东西：**没有归属的新事件流**和**要开口说
 *   的汇报**。这正是 Router 该管的两件事——开新线、跨线协调。一次成功交付的
 *   `silent` 汇报根本不进这一层（它是记录，不是话），否则每干完一件正常的事就要花
 *   一次推理去得出"不用说"这个恒定的答案。
 *
 * 攒批（§2.1）不是这里实现的：`deliver` 把一条输入交给会话，会话忙的时候 pi 的
 * inbox 会把它排到下一个 boundary。这一层只管**拼**，不管**等**。
 */

export type PrefilterVerdict = 'keep' | 'drop';

/**
 * 事件的环境身份。适配器在 payload 里放 `threadKey`，没放就永远不并线。
 *
 * 键要过 `isValidThreadKey`：它也可能来自外部数据（webhook 正文），一个半截键
 * 不该被当成身份——那种键会把不相关的东西并成一条线。判不过就当没有身份，
 * 事件照旧进 Slow Path。
 */
export function threadKeyOf(event: TriggerEvent): string | null {
  const key = event.payload.threadKey;
  return isValidThreadKey(key) ? key.trim() : null;
}

export interface Intent {
  event: TriggerEvent;
  thread: WorkThread;
  workerId: string;
}

export interface RouterDeps {
  threads: ThreadRepository;
  /** 系统故障的去处。没有就只打到控制台（探针与测试走这条）。 */
  faults?: FaultSink;
  /** 程序层。默认全留，配错了会很明显（每一条都进模型）。 */
  prefilter?: (event: TriggerEvent) => PrefilterVerdict;
  /**
   * 语义层的前置门（可选的分类器）。不传 = 不经过任何门，全部交给 Router 判。
   *
   * 它是 `async` 的：这里允许一次网络往返，因为省下来的正是 Router 那一轮推理。
   * 门失败时约定返回"全部放行"，所以这条路径不会丢事件。
   */
  semantic?: SemanticScreener;
  /** 未订阅 → Slow Path：交给 Router 会话判断。 */
  deliver: (
    text: string,
    replyTargets?: readonly TriggerReplyTarget[],
    context?: { attachments: readonly ChatAttachmentRef[] },
  ) => unknown | Promise<unknown>;
  /**
   * 已订阅 → Fast Path：直接发给盯这条线的执行体。
   *
   * 不存在时退化成"全部交给 Router"，功能不丢，只是贵一些——这也正好说明直通
   * 是优化而不是正确性。
   */
  passthrough?: (intent: Intent) => unknown | Promise<unknown>;
  /** 工作台长期有效的规矩（`fact` 的 global 那几条），每轮带进上下文。 */
  rules?: () => readonly string[];
  /**
   * 常驻约束（记忆里的 `standing` 层）。
   *
   * 和 `rules` 分开而不是合并：`rules` 是人**写**在设置里的，`standing` 是从使用里
   * **习得**的。两者都长期有效，但来源不同——合并之后就再也分不清"这条是谁定的"。
   * 它不参与检索、不看相关度、不衰减：每一轮原样在场。
   */
  standing?: () => readonly string[];
  /** 一轮最多看多少条事件。 */
  batchSize?: number;
  now?: () => number;
}

export interface TickReport {
  /** 程序层丢掉、没花一个 token 的。 */
  dropped: number;
  /**
   * 语义层（分类器）判掉噪声的。和 `dropped` 分开计数：一个是"没花 token 就确定"
   * 的，一个是"花了一点 token 才确定"的，混在一起就看不出去噪到底靠的是哪一层。
   */
  gated: number;
  /** 直通给订阅者的（没花 Router 一个 token）。 */
  passthrough: number;
  /** 交给 Router 会话的事件数。 */
  routed: number;
  /** 一并带过去的待播报汇报数。 */
  reports: number;
  /** 出异常的事件。它们留在 pending，下一轮重试。 */
  failed: number;
}

const DEFAULT_BATCH = 40;

export class Router {
  private readonly batchSize: number;
  private inFlight: Promise<TickReport> | null = null;
  private rerunRequested = false;

  constructor(private readonly deps: RouterDeps) {
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH;
  }

  /**
   * 一轮。可以按定时器调用，也可以连着调两次。
   *
   * 任何一步抛异常，那条事件就留在 `pending`：静默丢工作比慢一轮糟得多，
   * 而队列是"它确实来过"的唯一证据。
   *
   * `async` 只有一个原因：语义门是一次模型调用。程序层、直通、攒批仍然是同步的，
   * 所以"没有开语义门"的配置下这一轮只是多了一个 await 一个立即 resolve 的 Promise。
   */
  tick = (): Promise<TickReport> => {
    if (this.inFlight) {
      this.rerunRequested = true;
      return this.inFlight;
    }
    const run = this.runTick();
    this.inFlight = run;
    void run.then(
      () => {
        if (this.inFlight === run) this.inFlight = null;
        this.scheduleRerun();
      },
      () => {
        if (this.inFlight === run) this.inFlight = null;
        this.scheduleRerun();
      },
    );
    return run;
  };

  private scheduleRerun(): void {
    if (!this.rerunRequested) return;
    this.rerunRequested = false;
    queueMicrotask(() => void this.tick());
  }

  private runTick = async (): Promise<TickReport> => {
    const report: TickReport = {
      dropped: 0,
      gated: 0,
      passthrough: 0,
      routed: 0,
      reports: 0,
      failed: 0,
    };

    const pending = this.deps.threads.listPendingEvents(this.batchSize);
    let slow: TriggerEvent[] = [];
    const scheduled: TriggerEvent[] = [];

    for (const event of pending) {
      try {
        if (event.kind === 'schedule.due') {
          scheduled.push(event);
          continue;
        }
        if ((this.deps.prefilter?.(event) ?? 'keep') === 'drop') {
          this.deps.threads.triageEvent(event.id, 'dropped');
          report.dropped += 1;
          continue;
        }

        const intent = this.intentFor(event);
        if (intent && this.deps.passthrough) {
          const accepted = await this.deps.passthrough(intent);
          if (accepted !== false) {
            // 归属已经确定，这条事件不必再出现在 Router 的上下文里。
            this.deps.threads.triageEvent(event.id, 'accepted', intent.thread.id);
            this.deps.threads.touch(intent.thread.id);
            report.passthrough += 1;
            continue;
          }
          // 直通没有真正创建任务：不要伪装成 accepted，继续走 Slow Path。
        }

        slow.push(event);
      } catch {
        report.failed += 1;
      }
    }

    // 语义门：只判"值得占用 Router 上下文吗"，判完还是交给 Router 做决定。
    if (slow.length > 0 && this.deps.semantic) {
      try {
        const screened = await this.deps.semantic(slow);
        for (const event of screened.dropped) {
          this.deps.threads.triageEvent(event.id, 'dropped');
          report.gated += 1;
        }
        if (screened.error) console.warn('[router] 语义门没判成，这批全部放行', screened.error);
        slow = screened.keep;
      } catch (error) {
        // 门自己炸了：当作没开，全部放行。
        console.warn('[router] 语义门异常，这批全部放行', error);
      }
    }
    slow = [...scheduled, ...slow];

    // 只剩"要开口说的"汇报：`silent` 是记录，不是话，不该占 Router 的一轮推理。
    const reports = this.deps.threads.listUnannouncedReports(20);
    report.reports = reports.length;

    if (slow.length === 0 && reports.length === 0) return report;

    // 先把它们标成"已经交给 Router 了"，再真的交。反过来的话，一次崩溃就会
    // 让同一批事件被讲两遍。
    // `routed` 而不是 `accepted`：交出去不等于归了线，归线是 Router 下一轮的事。
    for (const event of slow) this.deps.threads.triageEvent(event.id, 'routed', event.threadId);
    this.deps.threads.markAnnounced(reports.map((row) => row.id));
    report.routed = slow.length;

    try {
      await this.deps.deliver(
        composeInput(
          slow,
          reports,
          this.deps.rules?.() ?? [],
          this.deps.standing?.() ?? [],
        ),
        collectReplyTargets(slow, reports),
        { attachments: collectAttachments(slow) },
      );
    } catch (error) {
      // 交不进去就把标记撤回，下一轮重来。宁可重复一次，不可丢一次。
      this.deps.threads.resetTriage(slow.map((event) => event.id));
      this.deps.threads.unmarkAnnounced(reports.map((row) => row.id));
      report.routed = 0;
      report.reports = 0;
      report.failed += slow.length;
      console.error('[router] 交给会话失败', error);
      // 这一条以前只活在这一行日志里：Watchdog 读库，看不到"整个轮次都在失败"。
      this.deps.faults?.recordSafely({
        kind: 'router.session_failed',
        severity: 'error',
        subjectType: 'router',
        summary: `Router 这一轮没交进去，${slow.length} 条事件回到队列等待重试。`,
        detail: { events: slow.length, reports: reports.length, reason: messageOf(error) },
      });
    }

    return report;
  };

  /**
   * 这条事件是不是已经有主了。
   *
   * 取订阅者里的**第一个**：一条线一个主执行体。`subscription` 表本身是
   * `(thread_id, worker_id)` 多对多，但那个多对多的意思是"一个执行体可以盯多条线"，
   * 不是"一条线找一堆人抢同一份活"——真让多个执行体同时接手，等于把一条线拆成
   * 互不知情的几份。要改这个口径，得先有"一条线内部怎么分工"的设计。
   */
  private intentFor(event: TriggerEvent): Intent | null {
    const key = threadKeyOf(event);
    if (!key) return null;
    const thread = this.deps.threads.threadByKey(key);
    if (!thread) return null;
    const [worker] = this.deps.threads.subscribersOf(thread.id);
    return worker ? { event, thread, workerId: worker.id } : null;
  }
}

/**
 * 把一批事件与汇报拼成**一条**输入。
 *
 * 一条而不是多条，是因为 Router 的上下文窗口就是缓存：一次调用处理十条，
 * prefill 共享，单条决定的成本比逐条低得多（§2.1 批处理）。
 *
 * 每个对象都带 id 并内联了相邻对象的 id，这样模型可以顺着引用图往下跳
 * （§3.3 链式召回）——它不需要一开始就把全文装进窗口。
 *
 * `rules` 是工作台长期有效的规矩（`fact` 的 global 那几条）。放在输入里而不是稳定
 * 前缀里：前缀要稳定才能吃到 provider 的提示词缓存，而规矩是会变的。它通常只有
 * 几条，每轮带上比让模型为此多调一次工具便宜。
 */
export function composeInput(
  events: readonly TriggerEvent[],
  reports: readonly WorkReport[],
  rules: readonly string[] = [],
  standing: readonly string[] = [],
  budget: InlineBudget = DEFAULT_INLINE_BUDGET,
): string {
  const lines: string[] = [];
  // 预算按"要内联的对象数"分摊，不是每条一个定值：3 条时给足，40 条时压低。
  const perItem = perItemBudget(budget, events.length + reports.length);

  if (rules.length > 0) {
    lines.push(`## 工作台的规矩（${rules.length}，长期有效）`);
    for (const rule of rules) lines.push(`- ${spillText(rule, 'list_lines', budget.ceiling)}`);
    lines.push('');
  }

  if (standing.length > 0) {
    lines.push(`## 用户要求过、一直有效的（${standing.length} 条，违反就是错）`);
    for (const rule of standing) lines.push(`- ${spillText(rule, 'recall_memory', budget.ceiling)}`);
    lines.push('');
  }

  if (events.length > 0) {
    lines.push(`## 新事件（${events.length}）`);
    for (const event of events) {
      const key = threadKeyOf(event);
      lines.push(
        `- ${event.id} · ${event.source}/${event.kind}` + (key ? ` · 并线键 ${key}` : ''),
      );
      if (event.threadId) lines.push(`  已预建工作线：${event.threadId}（派活时使用 thread_id，不要新开线）`);
      const replyTarget = replyTargetOf(event.payload);
      if (replyTarget) lines.push(`  原始信道回复地址（只能原样使用）：${replyTarget}`);
      const body = bodyOf(event.payload);
      if (event.kind === 'schedule.due') {
        lines.push(indent(`这是用户提前创建的定时请求，到期时间 ${new Date(Number(event.payload.scheduledFor)).toISOString()}（时区 ${String(event.payload.timezone ?? '')}）。请按当时上下文判断是否派发；若信息不足再询问用户。`));
      }
      if (body) lines.push(indent(spillText(body, `recall ${event.id}`, perItem)));
      const attachments = attachmentsOfPayload(event.payload);
      if (attachments.length > 0) {
        lines.push(indent(`已授权附件（只读）：${attachments.map((attachment) => `${attachment.name} · ${attachment.path}`).join('；')}`));
      }
    }
  }

  if (reports.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`## 执行体汇报（${reports.length}，都还没告诉用户）`);
    for (const report of reports) {
      lines.push(`- ${report.id} · 线 ${report.threadId} · ${report.level} · ${report.title}`);
      if (report.replyTarget) lines.push(`  原始信道回复地址（只能原样使用）：${report.replyTarget.address}`);
      if (report.body.trim()) {
        lines.push(indent(spillText(report.body, `recall ${report.id}`, perItem)));
      }
      if (report.result) {
        lines.push(indent(`结构化结果：${report.result.status} · ${report.result.conclusion}`));
        if (report.result.artifacts.length > 0) {
          lines.push(indent(`产物：${report.result.artifacts.map((artifact) => `${report.result?.taskId}/${artifact.relPath}`).join('、')}`));
        }
      }
    }
  }

  lines.push('');
  lines.push(
    '判断：这些里有哪些需要用户知道？哪些该派活（open_line_of_work）？' +
      '哪些直接不管？任何用户可见的最终回复都必须调用 reply_to_user，并提交按顺序排列的 blocks；' +
      '普通文字使用 markdown block，媒体和文件使用对应 block。不要把工具调用、思考或中间文本当成回复。' +
      '面向用户只写结果、状态和下一步：不要解释派活、工作线、执行体、工具、模型、验收或内部能力。' +
      '成功派发后台任务且尚无结果时，不发送开始确认；若用户同时提出了可立即回答的问题，只回答该问题。' +
      '任务已有结果时直接交付结果；失败只说已确认的原因和下一步。',
  );

  return lines.join('\n');
}

/** Only targets explicitly present in this input may be selected by reply_to_user. */
function collectReplyTargets(
  events: readonly TriggerEvent[],
  reports: readonly WorkReport[],
): TriggerReplyTarget[] {
  const found = new Map<string, TriggerReplyTarget>();
  for (const event of events) {
    const value = event.payload.replyTarget;
    if (!value || typeof value !== 'object') continue;
    const target = value as Partial<TriggerReplyTarget>;
    if (
      typeof target.adapterId !== 'string' ||
      typeof target.source !== 'string' ||
      typeof target.address !== 'string' ||
      !target.address.trim()
    ) {
      continue;
    }
    found.set(target.address, {
      adapterId: target.adapterId,
      source: target.source,
      address: target.address,
      ...(typeof target.messageId === 'string' ? { messageId: target.messageId } : {}),
    });
  }
  for (const report of reports) {
    if (report.replyTarget) found.set(report.replyTarget.address, report.replyTarget);
  }
  return [...found.values()];
}

/** Only carry attachment references that were explicitly supplied by the user. */
function collectAttachments(events: readonly TriggerEvent[]): ChatAttachmentRef[] {
  const found = new Map<string, ChatAttachmentRef>();
  for (const event of events) {
    // Attachment paths are authorized by the chat IPC boundary. Do not let an
    // arbitrary webhook/folder payload smuggle a filesystem path into a Worker
    // contract.
    if (event.source !== 'im') continue;
    const values = event.payload.attachments;
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (!value || typeof value !== 'object') continue;
      const item = value as Partial<ChatAttachmentRef>;
      if (
        typeof item.id !== 'string' ||
        typeof item.name !== 'string' ||
        typeof item.path !== 'string' ||
        typeof item.size !== 'number' ||
        (item.source !== 'file' && item.source !== 'clipboard')
      ) continue;
      const key = item.id || item.path;
      if (!found.has(key)) found.set(key, {
        id: item.id,
        name: item.name,
        path: item.path,
        size: item.size,
        ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}),
        source: item.source,
        ...(item.availability === 'available' || item.availability === 'missing' ? { availability: item.availability } : {}),
      });
    }
  }
  return [...found.values()];
}

function attachmentsOfPayload(payload: Record<string, unknown>): ChatAttachmentRef[] {
  const values = payload.attachments;
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is ChatAttachmentRef => {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<ChatAttachmentRef>;
    return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.path === 'string' &&
      typeof item.size === 'number' && (item.source === 'file' || item.source === 'clipboard');
  });
}

function replyTargetOf(payload: Record<string, unknown>): string | null {
  const value = payload.replyTarget;
  if (!value || typeof value !== 'object') return null;
  const address = (value as { address?: unknown }).address;
  return typeof address === 'string' && address.trim() ? address.trim() : null;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

/** 注意力三级的说明，设置/首页共用。 */
export const ATTENTION_COPY: Record<AttentionLevel, string> = {
  decide: '需要你拍板',
  notify: '知道一下就行',
  silent: '干完了，只在记录里',
};
