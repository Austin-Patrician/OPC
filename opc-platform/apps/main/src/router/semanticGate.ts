import type { DecisionQuestion, TriggerEvent } from '@opc/shared/domain';
import type { DecisionService } from '../models/decisionService';
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
  /** 一次调用判几条。太多会让单条判断变糙，太少则摊不薄调用成本。 */
  chunkSize?: number;
}

const DEFAULT_CHUNK = 10;
const INLINE = 300;

export function createDecisionGate(deps: DecisionGateDeps): SemanticScreener {
  const chunkSize = deps.chunkSize ?? DEFAULT_CHUNK;

  return async (events) => {
    const keep: TriggerEvent[] = [];
    const dropped: TriggerEvent[] = [];
    let error: string | undefined;

    for (let start = 0; start < events.length; start += chunkSize) {
      const chunk = events.slice(start, start + chunkSize);
      const verdicts = await classifyChunk(deps, chunk);

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
): Promise<{ ok: true; probabilities: number[] } | { ok: false; error: string }> {
  const questions: Record<string, DecisionQuestion> = {};
  chunk.forEach((_, index) => {
    questions[`noise_${index}`] = {
      type: 'bool',
      instructions:
        `第 ${index} 条事件是不是噪声？噪声 = 里面没有一件需要动手的事：` +
        '通知/心跳/状态回执、流水线自己写出来的回环、同一件事的重复投递。' +
        '只要它可能意味着"有人想要某个结果"，就不是噪声。',
      criteria: {
        true: '噪声：没有任何需要动手的事',
        false: '不是噪声：可能有人想要一个结果',
      },
    };
  });

  let result;
  try {
    result = await deps.decisions.classify({ state: describe(chunk), questions });
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

function describe(chunk: readonly TriggerEvent[]): string {
  const lines = [`以下是 ${chunk.length} 条进入工作台的环境事件，按顺序编号。`, ''];
  chunk.forEach((event, index) => {
    const body = bodyOf(event.payload).slice(0, INLINE);
    lines.push(`[${index}] ${event.source}/${event.kind}`);
    if (body) lines.push(`    ${body.replace(/\n/g, ' ')}`);
  });
  return lines.join('\n');
}
