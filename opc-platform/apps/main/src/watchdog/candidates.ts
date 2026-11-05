/**
 * 程序层候选（`11-watchdog-spec.md` W4）。
 *
 * 这一层的活儿只有一件：**用最便宜的方式，把"看起来不对劲"缩小到几条**。
 * 它不下结论，也不叫模型——判断"还在不在原目标上"是 W5 的事。把候选做得
 * 准一点，W5 就能少看很多健康的运行；做得不准，就等于给模型喂噪音。
 *
 * 判据从 `task.steps` 换到 `task_trace`：`steps` 是写给人看的叙述（"重试一下"），
 * 每轮措辞都不一样；`trace` 记的是**真实动作**（工具名、参数摘要、成败、耗时）。
 * 旧规则数"同一句话说了几遍"，所以像"改一行再跑还是失败"这种最典型的打转，
 * 它一次都抓不到——那几步的文字全不相同。
 */

/**
 * 一件事的候选。`kind` 就是 incident 的 kind：
 * 同一种症状在同一个任务上只会有一条活跃记录。
 */
export type CandidateKind = 'repeat_failure' | 'no_progress';

export interface TraceRow {
  seq: number;
  at: number;
  kind: string;
  name: string;
  argsDigest: string;
  /** 三态：`null` = 无法判定（pi 会发不带结果的结束事件）。 */
  ok: boolean | null;
}

export interface TaskView {
  id: string;
  title: string;
  /** 最后一次落库的时间；没有 trace 时的兜底。 */
  updatedAt: number;
  startedAt: number | null;
}

export interface Candidate {
  kind: CandidateKind;
  taskId: string;
  title: string;
  summary: string;
  detail: Record<string, unknown>;
}

export interface CandidateThresholds {
  /** 只看最近这么多步。更早的不代表现在。 */
  window: number;
  /** 同一个动作失败几次算"没打转出来"。 */
  repeatFailure: number;
  /** 多久没有任何新动作算停住。 */
  idleMs: number;
}

export const DEFAULT_CANDIDATES: CandidateThresholds = {
  window: 20,
  repeatFailure: 3,
  idleMs: 30 * 60_000,
};

/** 同一动作的身份：工具 + 参数摘要。分开看会把"改完再跑"当成两个不同动作。 */
function actionKey(row: TraceRow): string {
  return `${row.name}\u0000${row.argsDigest}`;
}

function clip(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 同一个动作**反复失败**。
 *
 * 这是"打转"最可靠的形状：它一直在动、每一步的叙述都不同，但世界没有变化
 * （同样的输入、同样的失败）。只看文本的规则看不见它，看 `ok` 就能看见。
 */
export function repeatedFailure(
  task: TaskView,
  trace: readonly TraceRow[],
  thresholds: CandidateThresholds = DEFAULT_CANDIDATES,
): Candidate | null {
  const recent = trace.slice(-thresholds.window);
  const failures = new Map<string, TraceRow[]>();

  for (const row of recent) {
    if (row.ok !== false) continue;
    const key = actionKey(row);
    const list = failures.get(key);
    if (list) list.push(row);
    else failures.set(key, [row]);
  }

  for (const rows of failures.values()) {
    if (rows.length < thresholds.repeatFailure) continue;
    const first = rows[0];
    if (!first) continue;
    return {
      kind: 'repeat_failure',
      taskId: task.id,
      title: task.title,
      summary: `同一个动作失败了 ${rows.length} 次（${first.name} ${clip(first.argsDigest)}），期间没有任何一次成功。它可能在原地打转。`,
      detail: {
        tool: first.name,
        action: first.argsDigest,
        attempts: rows.length,
        seqs: rows.map((row) => row.seq),
        window: recent.length,
      },
    };
  }

  return null;
}

/**
 * 停住了：还在 `running`，但很久没有新的动作。
 *
 * 优先看 trace 的最后一步，因为 `task.updated_at` 会被与"进展"无关的写入刷新
 * （比如一次状态重写）。只有从来没有 trace 的任务才退回 `updatedAt`。
 */
export function noProgress(
  task: TaskView,
  trace: readonly TraceRow[],
  now: number,
  thresholds: CandidateThresholds = DEFAULT_CANDIDATES,
): Candidate | null {
  const last = trace[trace.length - 1];
  const lastActivityAt = last?.at ?? task.startedAt ?? task.updatedAt;
  const idleMs = now - lastActivityAt;
  if (idleMs < thresholds.idleMs) return null;

  return {
    kind: 'no_progress',
    taskId: task.id,
    title: task.title,
    summary: `已经 ${Math.round(idleMs / 60_000)} 分钟没有任何新动作。可能卡在一个不会返回的命令上，也可能在等一个不会来的响应。`,
    detail: {
      idleMs,
      lastTool: last?.name ?? null,
      lastSeq: last?.seq ?? null,
      traceRows: trace.length,
    },
  };
}

/** 一个任务的全部候选。规则少而准，宁可漏一条也不要每轮都喊。 */
export function evaluateTask(
  task: TaskView,
  trace: readonly TraceRow[],
  now: number,
  thresholds: CandidateThresholds = DEFAULT_CANDIDATES,
): Candidate[] {
  const candidates: Candidate[] = [];
  const repeat = repeatedFailure(task, trace, thresholds);
  if (repeat) candidates.push(repeat);
  // 已经判出"打转"就不再判"停滞"：它们是同一个问题的两种描述，
  // 同时开两条 incident 只会让人看两遍同一件事。
  if (!repeat) {
    const stalled = noProgress(task, trace, now, thresholds);
    if (stalled) candidates.push(stalled);
  }
  return candidates;
}
