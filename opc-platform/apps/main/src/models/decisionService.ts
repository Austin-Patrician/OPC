import type {
  DecisionAnswer,
  DecisionClassifyInput,
  DecisionClassifyResult,
  ModelOption,
} from '@opc/shared/domain';
import type { ModelConfigService } from './modelConfigService';

/**
 * Structured decisions (TypeSafe Jev and the other System One classifiers pi
 * knows about).
 *
 * Resolution mirrors `SpeechService`: an explicit model wins, then the
 * configured default, then any enabled model on a provider that has a key. The
 * provider key never leaves the main process.
 *
 * The wire protocol is **not** OpenAI chat completions. pi's `classify()` does
 * the translation: `state` + `questions` in, typed answers with probabilities
 * out. Nothing here ever sees a text completion.
 */
export class DecisionService {
  constructor(private readonly models: ModelConfigService) {}

  classify = async (input: DecisionClassifyInput): Promise<DecisionClassifyResult> => {
    const resolved = this.resolveTarget(input.modelId);
    if ('error' in resolved) return { ok: false, error: resolved.error };

    const state = input.state.trim();
    if (!state) return { ok: false, error: 'state 不能为空' };
    if (Object.keys(input.questions).length === 0) return { ok: false, error: '至少需要一个 question' };

    try {
      // pi's ClassifierContext takes a JSON object; Jev also accepts a bare
      // string on the wire. Wrapping keeps the call typed and explicit about
      // which part of the JSON is the document.
      const result = await this.models.runtime.classify(resolved.providerId, resolved.modelId, {
        state: { text: state },
        questions: input.questions,
      });

      if (result.stopReason !== 'stop') {
        return { ok: false, error: result.errorMessage ?? '决策模型没有返回答案', model: result.model };
      }

      return {
        ok: true,
        model: result.model,
        answers: normalizeAnswers(result.answers),
        usage: result.usage
          ? { inputTokens: result.usage.input, outputTokens: result.usage.output }
          : undefined,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  /** True when at least one enabled decision model has credentials. */
  isAvailable = (): boolean =>
    this.models
      .listProviders()
      .some((provider) => provider.hasKey && provider.models.some(isEnabled));

  private resolveTarget(
    requestedModelId?: string,
  ): { providerId: string; modelId: string } | { error: string } {
    const providers = this.models.listProviders();
    const defaults = this.models.getDefaults().decision;

    const explicit = requestedModelId
      ? providers.find((provider) =>
          provider.models.some((model) => model.id === requestedModelId && isEnabled(model)),
        )
      : undefined;
    // When the id is stored but switched off, report that on the provider that
    // owns it instead of blaming whatever provider holds the default.
    const owner = requestedModelId
      ? providers.find((provider) => provider.models.some((model) => model.id === requestedModelId))
      : undefined;
    const fallbackProvider =
      providers.find((provider) => provider.hasKey && provider.models.some(isEnabled)) ??
      providers.find((provider) => provider.models.some(isEnabled));

    const providerId = explicit?.id ?? owner?.id ?? defaults?.providerId ?? fallbackProvider?.id;
    const modelId =
      requestedModelId ??
      (providerId === defaults?.providerId ? defaults?.modelId : undefined) ??
      providers.find((provider) => provider.id === providerId)?.models.find(isEnabled)?.id;

    if (!providerId || !modelId) {
      return { error: '请先添加并选择一个决策模型（设置 → 模型 → Decision）' };
    }

    const provider = providers.find((entry) => entry.id === providerId);
    if (!provider?.hasKey) return { error: `请先在 Decision 页配置 ${providerId} 的凭证` };

    const model = provider.models.find((entry) => entry.id === modelId);
    if (!model || !isEnabled(model)) {
      return { error: `所选决策模型 ${modelId} 未启用（设置 → 模型 → Decision）` };
    }

    return { providerId, modelId };
  }
}

/** A stored row is not enough: the Decision page's explicit switch must be on. */
function isEnabled(model: ModelOption): boolean {
  return model.capability === 'classifier' && model.decisionEnabled === true;
}

/**
 * pi's public answer contract already matches the shared one; this exists so an
 * unknown answer type from a future service is dropped instead of leaking an
 * untyped object into the renderer.
 */
function normalizeAnswers(answers: Record<string, unknown>): Record<string, DecisionAnswer> {
  const normalized: Record<string, DecisionAnswer> = {};
  for (const [name, raw] of Object.entries(answers)) {
    if (!isRecord(raw)) continue;
    if (raw.type === 'choice' && typeof raw.choice === 'string') {
      normalized[name] = {
        type: 'choice',
        choice: raw.choice,
        confidence: numberOr(raw.confidence, 0),
        probabilities: probabilities(raw.probabilities),
      };
    } else if (raw.type === 'score' && typeof raw.score === 'number') {
      normalized[name] = {
        type: 'score',
        score: raw.score,
        confidence: numberOr(raw.confidence, 0),
        ...(isRecord(raw.legend)
          ? { legend: Object.fromEntries(Object.entries(raw.legend).map(([k, v]) => [k, String(v)])) }
          : {}),
        ...(isRecord(raw.probabilities) ? { probabilities: probabilities(raw.probabilities) } : {}),
      };
    } else if (raw.type === 'bool') {
      normalized[name] = { type: 'bool', probability: numberOr(raw.probability, 0) };
    }
  }
  return normalized;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function probabilities(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}
