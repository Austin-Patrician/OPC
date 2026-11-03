import type { DecisionQuestion, TriggerEvent } from '@opc/shared/domain';
import type { DecisionService } from '../models/decisionService';
import { spillText } from './inline';
import { bodyOf } from './triage';

/**
 * 语义层的前置门（§3.1 Slow Path 的第一半）。
 *
 * 语义判断被拆成两个问题，因为它们该由不同的东西回答：
 *
 *   ① **这值得惊动 Router 吗？** —— 廉价、可以批量、不需要全局上下文。
 *      它由分类器回答（`decisions.classify`，一次调用判一整批）。
 *   ② **要不要开线、派给谁、怎么跟你说？** —— 需要连续上下文和全局视野。
 *      这永远是 Router 会话的事。
 *
 * 把 ① 交给分类器，省的是 Router 的上下文窗口和一轮推理；把 ② 也交给分类器则会
 * 得到"判断得很便宜但毫无连续性"的调度，那是把双层压成半层。
 *
 * **这一层没有丢活的权力**：模型没配、调用失败、答案缺失、概率不够——一律放行。
 * 一个省钱的门判错方向只能错在"多花一次 Router 的 token"，不能错在"这件事再也没人管"。
 */

export interface SemanticScreenResult {
  keep: TriggerEvent[];
  dropped: TriggerEvent[];
  /** 门没判成的原因（配了 decision 却没有可用模型之类）。事件全部放行。 */
  error?: string;
}

export type SemanticScreener = (events: readonly TriggerEvent[]) => Promise<SemanticScreenResult>;

/** 没开语义门时用它：全部放行（也就等于"让 Router 自己判"）。 */
export const keepAll: SemanticScreener = async (events) => ({
  keep: [...events],
  dropped: [],
});

export interface DecisionGateDeps {
  decisions: DecisionService;
  /** 每次都重新读：设置里调了阈值，下一批就按新阈值判。 */
  threshold: () => number;
  /**
   * **判噪策略本身**——一段用户可编辑的提示词。每次重新读，改完下一批就按新策略。
   *
   * 它放在 `state` 而不是塞进每一道 question 里：一批十条事件共用一份策略，写一遍
   * 就够；写十遍只会让每条判断更贵，而且十条之间还可能被抄得不一样。
   */
  policy?: () => string;
  /** 一次调用判几条。太多会让单条判断变糙，太少则摊不薄调用成本。 */
  chunkSize?: number;
}

const DEFAULT_CHUNK = 10;
/** 分类看的正文上限。比 Router 的每条预算小：判"是不是噪声"不需要读全。 */
const CLASSIFY_INLINE = 300;

export function createDecisionGate(deps: DecisionGateDeps): SemanticScreener {
  const chunkSize = deps.chunkSize ?? DEFAULT_CHUNK;

  return async (events) => {
    const keep: TriggerEvent[] = [];
    const dropped: TriggerEvent[] = [];
    let error: string | undefined;

    for (let start = 0; start < events.length; start += chunkSize) {
      const chunk = events.slice(start, start + chunkSize);
      const verdicts = await classifyChunk(deps, chunk, deps.policy?.() ?? '');

      if (!verdicts.ok) {
        // 门失败 = 全放行。这里不留"退回程序层"的分支：程序层已经判过了。
        error ??= verdicts.error;
        keep.push(...chunk);
        continue;
      }

      const threshold = deps.threshold();
      chunk.forEach((event, index) => {
        const probability = verdicts.probabilities[index];
        if (typeof probability === 'number' && probability >= threshold) dropped.push(event);
        else keep.push(event);
      });
    }

    return { keep, dropped, ...(error ? { error } : {}) };
  };
}

/**
 * 一批事件一次调用。
 *
 * 一批一个 question（而不是一条一个调用）：state 只发一次，N 条判断摊在同一份
 * 文档上，这是文章 §2.1 批处理在这里的落地方式。
 */
async function classifyChunk(
  deps: DecisionGateDeps,
  chunk: readonly TriggerEvent[],
  policy: string,
): Promise<{ ok: true; probabilities: number[] } | { ok: false; error: string }> {
  const questions: Record<string, DecisionQuestion> = {};
  chunk.forEach((_, index) => {
    questions[`noise_${index}`] = {
      type: 'bool',
      instructions: `第 ${index} 条事件是不是噪声？按下面这份策略判：${policy}`,
      criteria: {
        true: '噪声：按策略，这里没有需要动手的事',
        false: '不是噪声：按策略，可能有人想要一个结果',
      },
    };
  });

  let result;
  try {
    result = await deps.decisions.classify({ state: describe(chunk, policy), questions });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result.ok || !result.answers) {
    return { ok: false, error: result.error ?? '决策模型没有返回答案' };
  }

  const probabilities = chunk.map((_, index) => {
    const answer = result.answers?.[`noise_${index}`];
    return answer?.type === 'bool' ? answer.probability : Number.NaN;
  });
  return { ok: true, probabilities };
}

function describe(chunk: readonly TriggerEvent[], policy: string): string {
  const lines = [
    // 策略放在最前面：模型读到的第一段话就是"什么算噪声"，而不是先看十条事件再猜。
    ...(policy ? ['## 判噪策略', policy, ''] : []),
    `以下是 ${chunk.length} 条进入工作台的环境事件，按顺序编号。`,
    '',
  ];
  chunk.forEach((event, index) => {
    // 用同一个 spillText：分类看到的与 Router 看到的必须是同一段东西，
    // 否则两层的判断会对不上（"去重看的是 path、注入看的是 text"那种）。
    const body = bodyOf(event.payload);
    lines.push(`[${index}] ${event.source}/${event.kind}`);
    if (body) {
      lines.push(`    ${spillText(body, `recall ${event.id}`, CLASSIFY_INLINE).replace(/\n/g, ' ')}`);
    }
  });
  return lines.join('\n');
}
