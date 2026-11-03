import crypto from 'node:crypto';
import type { CompanyDatabase } from '../data/companyDatabase';

/**
 * 偏好信号的收集箱。
 *
 * 这里只做一件小事：把"用户表达偏好最可靠的两个时刻"原样收下来。为什么是这两个：
 *
 * | 信号 | 从哪来 | 为什么它比聊天的可信 |
 * |---|---|---|
 * | `rework` | 用户点「重做」时写的那句 | 他说的是"这版不对，应该是 X"——一个明确的对错判定 |
 * | `steering` | `steer_line` 的 note | 同上，而且是"原来的方向错了" |
 *
 * 以前这两句话都被**冲掉了**：返工理由被拼进下一版任务的 `brief`（于是和原始交代混在
 * 一起，谁读都分不出来），改方向存在 `task.steering` 里只影响那一次重试。
 *
 * 收是同步的、幂等的、不许失败（用户刚点完"重做"，不能因为收集失败而报错）；
 * 处理是异步的、批量的、允许失败的。所以它是自己的一张表，不是一张临时清单。
 */

export type SignalOrigin = 'rework' | 'steering';

export interface MemorySignal {
  id: string;
  origin: SignalOrigin;
  threadId: string | null;
  text: string;
  at: number;
}

/**
 * 信号指纹。
 *
 * 用内容算，不用自增 id：同一条返工理由被记两次（用户点了两下、或者重放）必须是
 * 一个信号，否则同一句话会被抽两次、写成两条记忆。
 */
export function signalId(origin: SignalOrigin, threadId: string | null, text: string): string {
  const digest = crypto
    .createHash('sha1')
    .update(`${origin}\u0000${threadId ?? ''}\u0000${text.trim()}`)
    .digest('hex');
  return `sig-${digest.slice(0, 16)}`;
}

/**
 * 太短的一句话不值得抽：「重做」「不行」没有内容可提取。
 *
 * 三个字起：两个字的回执（"好的""可以"）在返工框里很常见，而它们既没有信息，
 * 又会白占一个抽取名额。
 */
const MIN_TEXT = 3;

export class SignalStore {
  constructor(private readonly db: CompanyDatabase) {}

  /**
   * 收一条。已经收过就什么都不做。
   *
   * 空白的、太短的直接丢：它们没有信息，进队列只是给抽取管线添噪声。
   */
  record = (input: { origin: SignalOrigin; threadId?: string | null; text: string; at?: number }): string | null => {
    const text = input.text.trim();
    if (text.length < MIN_TEXT) return null;
    const threadId = input.threadId ?? null;
    const id = signalId(input.origin, threadId, text);
    this.db
      .prepare(
        `INSERT INTO memory_signal (id, origin, thread_id, text, at, processed_at)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, input.origin, threadId, text, input.at ?? Date.now());
    return id;
  };

  /** 还没处理过的，最早的在前——抽取看的是"用户这一次的不满"，不是"最新的那次"。 */
  pending = (limit = 20): MemorySignal[] => {
    const rows = this.db
      .prepare(
        `SELECT id, origin, thread_id, text, at FROM memory_signal
          WHERE processed_at IS NULL ORDER BY at ASC LIMIT ?`,
      )
      .all(limit) as {
      id: string;
      origin: SignalOrigin;
      thread_id: string | null;
      text: string;
      at: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      origin: row.origin,
      threadId: row.thread_id,
      text: row.text,
      at: row.at,
    }));
  };

  countPending = (): number =>
    (this.db.prepare('SELECT COUNT(*) AS n FROM memory_signal WHERE processed_at IS NULL').get() as {
      n: number;
    }).n;

  /**
   * 标成处理过。
   *
   * 只在**抽取真的成功**之后调：失败时保持 NULL，下一轮重来。和事件队列同一条规矩——
   * 宁可多处理一遍，不可漏掉一次。
   */
  markProcessed = (ids: readonly string[], at = Date.now()): void => {
    if (ids.length === 0) return;
    const run = this.db.prepare('UPDATE memory_signal SET processed_at = ? WHERE id = ?');
    const tx = this.db.transaction(() => {
      for (const id of ids) run.run(at, id);
    });
    tx();
  };
}
