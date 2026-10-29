import { describe, expect, it, vi } from 'vitest';
import type { ClassifierResult } from '@earendil-works/pi-ai';
import type { ModelDefaults, ModelOption, ProviderConfig } from '@opc/shared/domain';
import { DecisionService } from './decisionService';
import type { ModelConfigService } from './modelConfigService';

const decisionModel = (over: Partial<ModelOption> = {}): ModelOption => ({
  id: 'jev-latest',
  name: 'Jev',
  capability: 'classifier',
  api: 'typesafe-system-one',
  decisionEnabled: true,
  ...over,
});

const provider = (models: ModelOption[], over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'typesafe',
  name: 'TypeSafe',
  baseUrl: 'https://api.typesafe.ai/v1',
  api: 'typesafe-system-one',
  isCustom: false,
  hasKey: true,
  models,
  updatedAt: 0,
  ...over,
});

const defaults = (over: Partial<ModelDefaults> = {}): ModelDefaults => ({
  llm: null,
  image: null,
  asr: null,
  tts: null,
  decision: null,
  ...over,
});

const classifierResult = (over: Partial<ClassifierResult> = {}): ClassifierResult => ({
  api: 'typesafe-system-one',
  provider: 'typesafe',
  model: 'jev-latest',
  answers: {
    category: {
      type: 'choice',
      choice: 'billing',
      confidence: 0.91,
      probabilities: { billing: 0.91, technical: 0.09 },
    },
    severity: {
      type: 'score',
      score: 2,
      confidence: 0.7,
    },
    urgent: { type: 'bool', probability: 0.82 },
  },
  usage: {
    input: 120,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: 0,
  ...over,
});

function service(providers: ProviderConfig[], values: ModelDefaults, result: ClassifierResult) {
  const classify = vi.fn(async () => result);
  const models = {
    listProviders: () => providers,
    getDefaults: () => values,
    runtime: { classify },
  } as unknown as ModelConfigService;
  return { decisions: new DecisionService(models), classify };
}

const input = {
  state: 'The invoice charged twice.',
  questions: {
    category: {
      type: 'choice' as const,
      instructions: 'Classify the message.',
      criteria: { billing: 'Billing', technical: 'Technical' },
    },
  },
};

describe('DecisionService resolution', () => {
  it('refuses a stored row that was never switched on for decisions', async () => {
    const { decisions, classify } = service(
      [provider([decisionModel({ decisionEnabled: false })])],
      defaults({ decision: { providerId: 'typesafe', modelId: 'jev-latest' } }),
      classifierResult(),
    );

    const result = await decisions.classify(input);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('未启用');
    expect(classify).not.toHaveBeenCalled();
  });

  it('asks for a credential before calling the provider', async () => {
    const { decisions, classify } = service(
      [provider([decisionModel()], { hasKey: false })],
      defaults({ decision: { providerId: 'typesafe', modelId: 'jev-latest' } }),
      classifierResult(),
    );

    const result = await decisions.classify(input);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('凭证');
    expect(classify).not.toHaveBeenCalled();
  });

  it('explains that no decision model is configured at all', async () => {
    const { decisions } = service([], defaults(), classifierResult());

    const result = await decisions.classify(input);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('决策模型');
  });

  it('uses the configured default, wraps the state for pi, and normalizes answers', async () => {
    const { decisions, classify } = service(
      [provider([decisionModel()])],
      defaults({ decision: { providerId: 'typesafe', modelId: 'jev-latest' } }),
      classifierResult(),
    );

    const result = await decisions.classify(input);

    expect(classify).toHaveBeenCalledWith('typesafe', 'jev-latest', {
      state: { text: 'The invoice charged twice.' },
      questions: input.questions,
    });
    expect(result).toEqual({
      ok: true,
      model: 'jev-latest',
      answers: {
        category: {
          type: 'choice',
          choice: 'billing',
          confidence: 0.91,
          probabilities: { billing: 0.91, technical: 0.09 },
        },
        severity: { type: 'score', score: 2, confidence: 0.7 },
        urgent: { type: 'bool', probability: 0.82 },
      },
      usage: { inputTokens: 120, outputTokens: 0 },
    });
  });

  it('drops an answer type the shared contract does not know', async () => {
    const { decisions } = service(
      [provider([decisionModel()])],
      defaults({ decision: { providerId: 'typesafe', modelId: 'jev-latest' } }),
      classifierResult({
        answers: {
          category: { type: 'choice', choice: 'billing', confidence: 0.9, probabilities: {} },
          // A future service could add a new answer kind; the renderer must not
          // receive an object it cannot render.
          future: { type: 'ranking', ranking: ['a', 'b'] } as never,
        },
      }),
    );

    const result = await decisions.classify(input);

    expect(result.ok).toBe(true);
    expect(Object.keys(result.answers ?? {})).toEqual(['category']);
  });

  it('prefers an explicitly requested model over the default', async () => {
    const { decisions, classify } = service(
      [
        provider([decisionModel()]),
        provider([decisionModel({ id: 'jev-1.14', name: 'Jev 1.14' })], {
          id: 'openrouter',
          name: 'OpenRouter',
          baseUrl: 'https://openrouter.ai/api/v1',
        }),
      ],
      defaults({ decision: { providerId: 'typesafe', modelId: 'jev-latest' } }),
      classifierResult(),
    );

    await decisions.classify({ ...input, modelId: 'jev-1.14' });

    expect(classify).toHaveBeenCalledWith('openrouter', 'jev-1.14', expect.anything());
  });

  it('falls back to any enabled model that has a key', async () => {
    const { decisions, classify } = service(
      [
        provider([decisionModel({ decisionEnabled: undefined })]),
        provider([decisionModel({ id: 'jev-1.14', name: 'Jev 1.14' })], {
          id: 'openrouter',
          name: 'OpenRouter',
          baseUrl: 'https://openrouter.ai/api/v1',
        }),
      ],
      defaults(),
      classifierResult(),
    );

    await decisions.classify(input);

    expect(classify).toHaveBeenCalledWith('openrouter', 'jev-1.14', expect.anything());
  });

  it('blames the provider that owns an explicitly requested model', async () => {
    const { decisions, classify } = service(
      [
        provider([decisionModel()]),
        provider([decisionModel({ id: 'jev-1.14', name: 'Jev 1.14', decisionEnabled: false })], {
          id: 'openrouter',
          name: 'OpenRouter',
          baseUrl: 'https://openrouter.ai/api/v1',
        }),
      ],
      defaults({ decision: { providerId: 'typesafe', modelId: 'jev-latest' } }),
      classifierResult(),
    );

    const result = await decisions.classify({ ...input, modelId: 'jev-1.14' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('jev-1.14');
    expect(result.error).not.toContain('typesafe');
    expect(classify).not.toHaveBeenCalled();
  });

  it('rejects an empty state and an empty question set without calling out', async () => {
    const { decisions, classify } = service([provider([decisionModel()])], defaults(), classifierResult());

    expect((await decisions.classify({ ...input, state: '   ' })).error).toContain('state');
    expect((await decisions.classify({ ...input, questions: {} })).error).toContain('question');
    expect(classify).not.toHaveBeenCalled();
  });

  it('surfaces a provider error result instead of pretending it answered', async () => {
    const { decisions } = service(
      [provider([decisionModel()])],
      defaults({ decision: { providerId: 'typesafe', modelId: 'jev-latest' } }),
      classifierResult({
        answers: {},
        usage: undefined,
        stopReason: 'error',
        errorMessage: 'TypeSafe error 401: invalid key',
      }),
    );

    const result = await decisions.classify(input);

    expect(result).toEqual({
      ok: false,
      error: 'TypeSafe error 401: invalid key',
      model: 'jev-latest',
    });
  });

  it('reports availability only for providers that have a key and an enabled row', () => {
    expect(service([provider([decisionModel()])], defaults(), classifierResult()).decisions.isAvailable()).toBe(
      true,
    );
    expect(
      service([provider([decisionModel()], { hasKey: false })], defaults(), classifierResult()).decisions
        .isAvailable(),
    ).toBe(false);
    expect(
      service(
        [provider([decisionModel({ decisionEnabled: undefined })])],
        defaults(),
        classifierResult(),
      ).decisions.isAvailable(),
    ).toBe(false);
  });
});
