import type { TaskFailureKind } from '@opc/shared/domain';

/**
 * 失败分类（`09-worker-spec.md` §3.7）。
 *
 * 为什么要分类，而不是只留一句 `error`：同一句「任务失败」背后是四种完全不同的处境，
 * 而它们该做的事彼此矛盾——
 *
 * | 处境 | 该做什么 |
 * |---|---|
 * | 模型 5xx / 运行时被打断 | 值得再跑一次 |
 * | 闸门没过 | 带反馈重试，用尽就停下等人 |
 * | 没有闸门 | 重试没有意义，判据本身缺失 |
 * | 没模型 / 前置未完成 | 重试一万次也不会好 |
 *
 * 混在一起时，用户看到的是一个**反复失败的任务**，而它其实一次都没真正跑起来。
 * 分类不是给日志好看，是决定「要不要重试、线停在哪个状态、要不要打扰人」。
 */

/** 这一类的失败，再跑一次有没有意义。 */
export function isRetryable(kind: TaskFailureKind | undefined): boolean {
  return kind === 'retryable' || kind === 'rejected';
}

/** 这一类失败是不是"根本没能开始"。 */
export function isBlockedBeforeStart(kind: TaskFailureKind | undefined): boolean {
  return kind === 'blocked';
}

export interface TerminalInput {
  /** durable 任务的终态。 */
  outcome: 'completed' | 'failed' | 'aborted' | 'orphaned' | 'faulted';
  /** `completed` 时的判定。 */
  verdict?: 'pass' | 'fail';
  /** 这条任务有没有可执行的闸门（`acceptanceGate.isUnverified`）。 */
  unverified?: boolean;
}

/**
 * 一次终态该归到哪一类；`null` = 这不是失败（闸门过了）。
 *
 * 三个判断都不看模型、不看时间，所以它们可以在用例里被钉死——分类是产品承诺的一部分，
 * 不该靠观察日志猜。
 */
export function classifyTerminal(input: TerminalInput): TaskFailureKind | null {
  if (input.outcome === 'completed') {
    if (input.verdict === 'pass') return null;
    // 「跑完了但判不了对错」和「跑完了、判了、没过」是两件事：前者缺的是判据，
    // 后者缺的是工作。重试只对后者有意义。
    return input.unverified ? 'unverified' : 'rejected';
  }

  // 被中止 = 线被收 / 人取消，不该算它一笔失败。
  if (input.outcome === 'aborted') return 'cancelled';

  // 其余都是运行时层面的问题：faulted（某个阶段抛了）、orphaned（跑它的进程没了）、
  // failed（durable 自己判的失败）。这些换一次重跑常常就好了。
  return 'retryable';
}

/** 一句话的人话标签。界面与汇报共用一份，避免两处措辞漂移。 */
export const FAILURE_LABEL: Record<TaskFailureKind, string> = {
  retryable: '运行中断',
  rejected: '验收未通过',
  unverified: '无法判定',
  needs_decision: '等你拍板',
  handed_back: '已交回',
  blocked: '起不来',
  cancelled: '已取消',
};

/**
 * 给这一类的建议：人看到之后知道该做什么。
 *
 * 这不是错误信息的一部分——错误信息说"发生了什么"，建议说"所以呢"。
 */
export const FAILURE_ADVICE: Record<TaskFailureKind, string> = {
  retryable: '这是运行层面的问题，再跑一次通常就好了。',
  rejected: '交付物没通过闸门：按上一次的退出码与输出修，或者改验收条件。',
  unverified: '这条任务没有可执行的验收条件，所以跑完了我也判不了对错——需要你看一眼。',
  needs_decision: '我卡在一个只能你拍板的地方。',
  handed_back: '这件事不该由我接，我把它交回去了。',
  blocked: '这不是重试能解决的：先把缺的东西补上（模型、前置任务），再让它跑。',
  cancelled: '这条线已经收了。',
};
