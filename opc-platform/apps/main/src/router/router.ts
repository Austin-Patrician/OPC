import type { AttentionLevel, TriggerEvent, WorkReport, WorkThread } from '@opc/shared/domain';
import type { ThreadRepository } from '../data/threadRepository';

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
  /** 未订阅 → Slow Path：交给 Router 会话判断。 */
  deliver: (text: string) => void;
  /**
   * 已订阅 → Fast Path：直接发给盯这条线的执行体。
   *
   * 不存在时退化成"全部交给 Router"，功能不丢，只是贵一些——这也正好说明直通
   * 是优化而不是正确性。
   */
  passthrough?: (intent: Intent) => void;
  /** 一轮最多看多少条事件。 */
  batchSize?: number;
  now?: () => number;
}

export interface TickReport {
  /** 程序层丢掉、没花一个 token 的。 */
  dropped: number;
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
   */
  tick = (): TickReport => {
    const report: TickReport = { dropped: 0, passthrough: 0, routed: 0, reports: 0, failed: 0 };

    const pending = this.deps.threads.listPendingEvents(this.batchSize);
    const slow: TriggerEvent[] = [];

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
      this.deps.deliver(composeInput(slow, reports));
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

  /** 这条事件是不是已经有主了。 */
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
 */
export function composeInput(
  events: readonly TriggerEvent[],
  reports: readonly WorkReport[],
): string {
  const lines: string[] = [];

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
    lines.push(`## 执行体汇报（${reports.length}，都还没告诉老板）`);
    for (const report of reports) {
      lines.push(`- ${report.id} · 线 ${report.threadId} · ${report.level} · ${report.title}`);
      if (report.body.trim()) lines.push(indent(spill(report.body, `recall ${report.id}`)));
    }
  }

  lines.push('');
  lines.push(
    '判断：这些里有哪些需要老板知道？哪些该派活（open_line_of_work）？' +
      '哪些直接不管？要说话就调用 reply_to_boss——不调用它，老板听不到你。',
  );

  return lines.join('\n');
}

/** 事件里最像"内容"的那个字段。适配器约定：`text` / `goal` / `path`。 */
function bodyOf(payload: Record<string, unknown>): string {
  for (const field of ['text', 'goal', 'path', 'summary', 'brief'] as const) {
    const value = payload[field];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  const keys = Object.keys(payload).filter((key) => key !== 'threadKey');
  if (keys.length === 0) return '';
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, payload[key]])));
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
