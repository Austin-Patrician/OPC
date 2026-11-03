import type { TaskRecord } from '@opc/shared/domain';
import {
  DEFAULT_INLINE_BUDGET,
  perItemBudget,
  spillText,
  type InlineBudget,
} from '../router/inline';

/**
 * 执行体看到的原始记录（§3.3）。
 *
 * 这一层要解决的不是"信息不够"，是**信息是二手的**。`workDispatch` 建任务时
 * `brief = goal`——Router 用自己的话重写了一遍目标，执行体只看得到那段重写。于是：
 *
 * - 用户原话里的端口、路径、报错原文，在转述里被压掉了，执行体"按要求做了"，
 *   做的是转述后的那个要求；
 * - Router 把 A 理解成 B 时，执行体是唯一有机会发现的人，而它手里没有 A；
 * - 它没有 ID，所以也回不到这条线之前发生过什么。
 *
 * 修法不是"注入更多"（那会挤掉它真正需要的窗口，§3.3 那句话是硬的），而是
 * **ID + 摘要 + 按需展开**。摘要用的是 Router 那一侧的同一个 `spillText`：两层看到
 * 同一段文字，是 `05-router-real.md` §5 已经立下的原则，执行体这侧之前根本没被 spill 过。
 */

/** 一条记录的原料：从库里读到的东西，还没 spill。 */
export interface RecordSource {
  kind: TaskRecord['kind'];
  id: string;
  title: string;
  /** 全文。可能在库里很长，摘要在 `buildRecords` 里生成。 */
  body: string;
  at: number;
}

/**
 * 一次注入最多几条。
 *
 * 记录是**背景**，不是任务本身。八条以上，执行体的第一步就变成读历史而不是干活；
 * 而真正需要的那一条，`recall` 随时能取。
 */
export const MAX_RECORDS = 8;

/**
 * 按时间顺序取最近的几条，并逐条生成摘要。
 *
 * 升序而不是降序：这是一条线的时间线，读下来才连贯（先发生了什么、后改了什么）。
 * 预算按条数分摊——条数越多每条越短，和 Router 那边是同一个判断。
 */
export function buildRecords(
  sources: readonly RecordSource[],
  budget: InlineBudget = DEFAULT_INLINE_BUDGET,
): TaskRecord[] {
  const kept = [...sources].sort((left, right) => left.at - right.at).slice(-MAX_RECORDS);
  const perItem = perItemBudget(budget, kept.length);
  return kept.map((source) => ({
    kind: source.kind,
    id: source.id,
    title: source.title,
    // 短文本原样给，长了才切头尾并标出"略去多少、全文怎么取"。
    excerpt: spillText(source.body, `recall ${source.id}`, perItem),
  }));
}
