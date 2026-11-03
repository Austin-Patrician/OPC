import type { AttentionLevel, TriggerEvent, WorkReport, WorkThread } from '@opc/shared/domain';
import type { ThreadRepository } from '../data/threadRepository';
import type { SemanticScreener } from './semanticGate';
import { bodyOf } from './triage';

/**
 * 调度循环。
 *
 * 这里**不含模型调用**，也不做语义判断——那是 Router 会话的事
 * （`routerSession.ts`）。这一层只做三件确定性的活，因为它们不该花 token：
 *
 *   ① **程序层过滤**（§3.1 Fast Path）。噪声在这里就死掉，永远见不到模型。
 *   ② **直通判定**（§3.2 Fast Path）。事件带着环境身份（`threadKey`）来，
 *      这个身份上已经有一条活跃的线、线也已经有 worker 在盯，就直接发给它，
 *      不必再让 Router 判一次。原文 7.1 量过：去掉直通后完成时间几乎不变，但
 *      Router 的决策数与读缓存 token 各涨约 30%，所以它省的是**成本与延迟**。
 *   ③ **攒批**（§2.1）。剩下的事件和待播报的汇报合成一条输入交给 Router 会话。
 *      会话忙的时候 pi 自己会把输入排队到下一个 boundary，所以这里只管交，
 *      不管攒——批处理是运行时给的，不是我们模拟的。
 *
 * 语义层（"这件事值不值得做"）由 Router 会话判断，于是这个循环里没有 `judge`。
 * 原来那个"一次调用判一批 accept/reject"的注入点是照抄文章批处理的样子搭的骨架，
 * 现在模型真的在了，骨架该拆了。
 *
 * 唯一会花 token 的地方是 `semantic`：一个可选的**前置门**（分类器），它只回答
 * "这批里哪些不值得占用 Router 的上下文"。开不开是设置里的事（`TriagePolicy`），
 * 关掉就是"全部交给 Router 自己判"——两种都能跑，区别只是花多少钱。
 */

export type PrefilterVerdict = 'keep' | 'drop';

/** 事件的环境身份。适配器在 payload 里放 `threadKey`，没放就永远不并线。 */
export function threadKeyOf(event: TriggerEvent): string | null {
  const key = event.payload.threadKey;
  return typeof key === 'string' && key.trim().length > 0 ? key.trim() : null;
}

export interface Intent {
  event: TriggerEvent;
  thread: WorkThread;
  workerId: string;
}

export interface RouterDeps {
  threads: ThreadRepository;
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
  deliver: (text: string) => void;
  /**
   * 已订阅 → Fast Path：直接发给盯这条线的执行体。
   *
   * 不存在时退化成"全部交给 Router"，功能不丢，只是贵一些——这也正好说明直通
   * 是优化而不是正确性。
   */
  passthrough?: (intent: Intent) => void;
  /** 工作台长期有效的规矩（`fact` 的 global 那几条），每轮带进上下文。 */
  rules?: () => readonly string[];
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
/** Inline & Spill 的长度上限：超过就截断并留一个 recall 入口（§3.3）。 */
const INLINE_LIMIT = 600;

export class Router {
  private readonly batchSize: number;

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
  tick = async (): Promise<TickReport> => {
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

    for (const event of pending) {
      try {
        if ((this.deps.prefilter?.(event) ?? 'keep') === 'drop') {
          this.deps.threads.triageEvent(event.id, 'dropped');
          report.dropped += 1;
          continue;
        }

        const intent = this.intentFor(event);
        if (intent && this.deps.passthrough) {
          this.deps.passthrough(intent);
          // 归属已经确定，这条事件不必再出现在 Router 的上下文里。
          this.deps.threads.triageEvent(event.id, 'accepted', intent.thread.id);
          this.deps.threads.touch(intent.thread.id);
          report.passthrough += 1;
          continue;
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

    // 汇报不需要经过 Router 判断——它是既成事实，只需要被讲出去。
    const reports = this.deps.threads.listUnannouncedReports(20);
    report.reports = reports.length;

    if (slow.length === 0 && reports.length === 0) return report;

    // 先把它们标成"已经交给 Router 了"，再真的交。反过来的话，一次崩溃就会
    // 让同一批事件被讲两遍。
    // `routed` 而不是 `accepted`：交出去不等于归了线，归线是 Router 下一轮的事。
    for (const event of slow) this.deps.threads.triageEvent(event.id, 'routed');
    this.deps.threads.markAnnounced(reports.map((row) => row.id));
    report.routed = slow.length;

    try {
      this.deps.deliver(composeInput(slow, reports, this.deps.rules?.() ?? []));
    } catch (error) {
      // 交不进去就把标记撤回，下一轮重来。宁可重复一次，不可丢一次。
      this.deps.threads.resetTriage(slow.map((event) => event.id));
      this.deps.threads.unmarkAnnounced(reports.map((row) => row.id));
      report.routed = 0;
      report.reports = 0;
      report.failed += slow.length;
      console.error('[router] 交给会话失败', error);
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
): string {
  const lines: string[] = [];

  if (rules.length > 0) {
    lines.push(`## 工作台的规矩（${rules.length}，长期有效）`);
    for (const rule of rules) lines.push(`- ${rule}`);
    lines.push('');
  }

  if (events.length > 0) {
    lines.push(`## 新事件（${events.length}）`);
    for (const event of events) {
      const key = threadKeyOf(event);
      lines.push(
        `- ${event.id} · ${event.source}/${event.kind}` + (key ? ` · 并线键 ${key}` : ''),
      );
      const body = bodyOf(event.payload);
      if (body) lines.push(indent(spill(body, `recall ${event.id}`)));
    }
  }

  if (reports.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`## 执行体汇报（${reports.length}，都还没告诉用户）`);
    for (const report of reports) {
      lines.push(`- ${report.id} · 线 ${report.threadId} · ${report.level} · ${report.title}`);
      if (report.body.trim()) lines.push(indent(spill(report.body, `recall ${report.id}`)));
    }
  }

  lines.push('');
  lines.push(
    '判断：这些里有哪些需要用户知道？哪些该派活（open_line_of_work）？' +
      '哪些直接不管？要说话就调用 reply_to_user——不调用它，用户听不到你。',
  );

  return lines.join('\n');
}

/** Inline & Spill：短的全放，长的截断并留一个按需读取的入口。 */
export function spill(text: string, hint: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= INLINE_LIMIT) return trimmed;
  return `${trimmed.slice(0, INLINE_LIMIT)}…（已截断，全文用 ${hint}）`;
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
