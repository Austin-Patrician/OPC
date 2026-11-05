import type { ModelConfigService } from '../models/modelConfigService';
import { buildJudgePrompt, parseVerdict } from './prompt';
import type { JudgePayload, JudgeResult } from './protocol';

/**
 * 语义判断的**兜底路径**（`11-watchdog-spec.md` W5）。
 *
 * 主路径已经在子进程里跑了（`modelRunner.ts`）：那边拿着一个 provider 的凭据，
 * 自己出题、自己判。这里只在两种情况下被用到：
 *
 * - provider 只有 OAuth、没有静态 key（钥匙没法交过去）；
 * - 子进程那边建不起来或调用失败。
 *
 * 两条路共用同一份提示词与解析（`prompt.ts`），否则同一个证据会给出两套说法。
 */
export function createWatchdogJudge(
  models: ModelConfigService,
  resolveRef: () => { providerId: string; modelId: string } | null = () => null,
) {
  return async (payload: JudgePayload): Promise<JudgeResult> => {
    // 优先用它自己配的模型；没配才退回默认 LLM——那是兜底，不是等价方案。
    const target = resolveRef() ?? models.getDefaults().llm;
    if (!target) return { ok: false, error: '没有可用的判断模型（设置 → 进展监督 → 模型）' };

    try {
      const runtime = await models.runtime.createModels();
      const model = await models.runtime.resolveModel(target.providerId, target.modelId);
      if (!model) return { ok: false, error: '找不到配置的判断模型' };

      const text = [
        buildJudgePrompt({
          title: payload.title,
          goal: payload.goal,
          candidateKind: payload.candidate.kind,
          candidateSummary: payload.candidate.summary,
          candidateDetail: payload.candidate.detail,
          trace: payload.trace,
        }),
      ].join('');

      const answer = await runtime.complete(model, {
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      } as never);

      const content = ((answer as { content?: { type: string; text?: string }[] }).content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');

      return {
        ...parseVerdict(content),
        model: `${target.providerId}/${target.modelId}`,
        ok: true,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}
