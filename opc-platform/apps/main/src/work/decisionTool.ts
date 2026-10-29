import { defineExtension, defineTool, type ToolExecutionResult } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import type {
  DecisionAnswer,
  DecisionClassifyResult,
  DecisionQuestion,
} from '@opc/shared/domain';

/**
 * Jev's context is 64k tokens; Chinese costs roughly one token per character, so
 * 24k characters of evidence plus the questions still leaves ample headroom.
 * A longer state is refused rather than truncated: a silently shortened document
 * changes the decision.
 */
const MAX_STATE_CHARS = 24_000;

/** More than this is usually several decisions pretending to be one. */
const MAX_QUESTIONS = 8;

/** Answers are small; this only stops a model from pasting a document into criteria. */
const MAX_QUESTION_CHARS = 8_000;
const MAX_INSTRUCTIONS_CHARS = 400;
const MAX_CRITERION_CHARS = 200;
const MIN_CHOICE_LABELS = 2;
const MAX_CHOICE_LABELS = 12;
const MAX_CHOICE_LABEL_CHARS = 40;
const MIN_SCORE_LEVELS = 2;
const MAX_SCORE_LEVELS = 10;
const MAX_SCORE_LEVEL_CHARS = 120;
const DEFAULT_THRESHOLD = 0.5;

/** Stable, machine-readable ids: the answer map is keyed by them. */
const NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

export interface DecisionToolDeps {
  /** `DecisionService.classify`: resolves the configured model and credentials. */
  classify: (input: { state: string; questions: Record<string, DecisionQuestion> }) => Promise<DecisionClassifyResult>;
}

type DecideQuestion =
  | {
      name: string;
      type: 'bool';
      instructions: string;
      criteria: { true: string; false: string };
    }
  | {
      name: string;
      type: 'choice';
      instructions: string;
      criteria: Record<string, string>;
    }
  | {
      name: string;
      type: 'score';
      instructions: string;
      criteria: string[];
    };

const QUESTION_NAME = Type.String({
  pattern: '^[a-z][a-z0-9_]{0,31}$',
  description:
    'Stable id for this answer, e.g. needs_reply. Lowercase letters, digits and underscores; starts with a letter.',
});

const QUESTION_INSTRUCTIONS = Type.String({
  description: 'The question itself, phrased so a yes/no, a label or a score answers it.',
});

/**
 * `decide`: structured judgement through the configured System One model.
 *
 * The model only supplies evidence and typed questions; provider resolution,
 * credentials, limits and the wire call all stay in the host. One call answers
 * every question, because System One bills the same `state` once per request and
 * the questions usually describe the same piece of evidence.
 */
export function createDecisionToolExtension(deps: DecisionToolDeps) {
  return defineExtension({
    name: 'opc.decision',
    tools: [
      defineTool({
        name: 'decide',
        description:
          'Answer bounded questions about a piece of text with the configured System One decision model (TypeSafe Jev or another classifier). Use it when the output is a label, a score or a yes/no judgement: triage, routing, risk or quality gates, deduplication, "does this meet the brief". Not for open-ended reasoning or writing — use the chat model for that. Send the smallest state that carries the evidence and 1–8 typed questions; all of them are answered in one request. Booleans return a probability, and true is reported only when p ≥ threshold (default 0.5).',
        parameters: Type.Object({
          state: Type.String({
            description:
              'The evidence to judge: the text, diff, ticket, transcript or extracted facts. ' +
              `Up to ${MAX_STATE_CHARS} characters. Include only what the questions need; it is sent to the decision model verbatim.`,
          }),
          questions: Type.Array(
            Type.Union([
              Type.Object({
                name: QUESTION_NAME,
                type: Type.Literal('bool'),
                instructions: QUESTION_INSTRUCTIONS,
                criteria: Type.Object({
                  true: Type.String({ description: 'What true means for this question.' }),
                  false: Type.String({ description: 'What false means for this question.' }),
                }),
              }),
              Type.Object({
                name: QUESTION_NAME,
                type: Type.Literal('choice'),
                instructions: QUESTION_INSTRUCTIONS,
                criteria: Type.Record(Type.String(), Type.String(), {
                  description: 'Label → what that label means. 2–12 labels.',
                }),
              }),
              Type.Object({
                name: QUESTION_NAME,
                type: Type.Literal('score'),
                instructions: QUESTION_INSTRUCTIONS,
                criteria: Type.Array(Type.String(), {
                  description: 'Ordered rubric, index 0 = lowest. 2–10 levels.',
                }),
              }),
            ]),
            { minItems: 1, maxItems: MAX_QUESTIONS },
          ),
          threshold: Type.Optional(
            Type.Number({
              minimum: 0,
              maximum: 1,
              description: 'Probability above which a bool question is reported as true. Default 0.5.',
            }),
          ),
        }),
        execute: async (args): Promise<ToolExecutionResult> => {
          const threshold = args.threshold ?? DEFAULT_THRESHOLD;
          if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
            return fail(`threshold 必须在 0 到 1 之间，收到 ${String(args.threshold)}`);
          }

          const state = args.state.trim();
          if (!state) return fail('state 不能为空：请把要判断的材料放进去');
          if (state.length > MAX_STATE_CHARS) {
            return fail(
              `state 过长（${state.length} 字符），单次上限 ${MAX_STATE_CHARS}。请只保留与判断直接相关的片段，或分几次调用。`,
            );
          }

          const prepared = prepareQuestions(args.questions ?? []);
          if (!prepared.ok) return fail(prepared.error);

          let result: DecisionClassifyResult;
          try {
            result = await deps.classify({ state, questions: prepared.questions });
          } catch (error) {
            return fail(`决策模型调用失败：${messageOf(error)}`);
          }
          if (!result.ok) return fail(`决策失败：${result.error ?? '未知错误'}`);

          const answers = result.answers ?? {};
          const missing = prepared.names.filter((name) => !answers[name]);
          if (missing.length > 0) {
            return fail(`决策模型没有回答这些问题：${missing.join('、')}。请调整问题后重试。`);
          }

          const model = result.model ?? 'unknown';
          const usage = result.usage ? `，输入 ${result.usage.inputTokens} tokens` : '';
          const lines = prepared.names.map((name) =>
            renderAnswer(name, answers[name]!, threshold),
          );
          const askedBool = prepared.names.some((name) => answers[name]?.type === 'bool');
          const note = askedBool
            ? `\n\nbool 的 p 是模型给出的概率；true/false 只是按阈值 ${formatNumber(threshold)} 折叠后的展示值。`
            : '';

          return {
            output: [
              {
                type: 'text' as const,
                text: `决策完成（${model}${usage}）\n${lines.join('\n')}${note}`,
              },
            ],
            details: {
              model,
              threshold,
              answers,
              usage: result.usage ?? null,
            },
          };
        },
      }),
    ],
  });
}

interface PreparedQuestions {
  ok: true;
  names: string[];
  questions: Record<string, DecisionQuestion>;
}

/**
 * Turns the flat, model-friendly array into the provider's name → question map
 * and enforces the business rules JSON Schema cannot express (uniqueness, size).
 */
function prepareQuestions(
  raw: readonly DecideQuestion[],
): PreparedQuestions | { ok: false; error: string } {
  if (raw.length === 0) return { ok: false, error: '至少需要一个问题' };
  if (raw.length > MAX_QUESTIONS) {
    return { ok: false, error: `一次最多 ${MAX_QUESTIONS} 个问题，收到 ${raw.length} 个` };
  }

  const questions: Record<string, DecisionQuestion> = {};
  const names: string[] = [];

  for (const question of raw) {
    const name = typeof question.name === 'string' ? question.name.trim() : '';
    if (!NAME_PATTERN.test(name)) {
      return {
        ok: false,
        error: `问题名 "${name}" 不合法：只能用小写字母、数字和下划线，以字母开头，最长 32 个字符`,
      };
    }
    if (questions[name]) return { ok: false, error: `问题名 "${name}" 重复` };

    const instructions =
      typeof question.instructions === 'string' ? question.instructions.trim() : '';
    if (!instructions) return { ok: false, error: `问题 "${name}" 缺少 instructions` };
    if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
      return {
        ok: false,
        error: `问题 "${name}" 的 instructions 过长（上限 ${MAX_INSTRUCTIONS_CHARS} 字符）`,
      };
    }

    const built = buildQuestion(name, question, instructions);
    if ('error' in built) return { ok: false, error: built.error };

    questions[name] = built.question;
    names.push(name);
  }

  const serialized = JSON.stringify(questions);
  if (serialized.length > MAX_QUESTION_CHARS) {
    return {
      ok: false,
      error: `问题定义过长（${serialized.length} 字符），上限 ${MAX_QUESTION_CHARS}。请缩短 criteria 或拆成两次调用。`,
    };
  }

  return { ok: true, names, questions };
}

function buildQuestion(
  name: string,
  question: DecideQuestion,
  instructions: string,
): { question: DecisionQuestion } | { error: string } {
  switch (question.type) {
    case 'bool': {
      const truthy = textOf(question.criteria?.true);
      const falsy = textOf(question.criteria?.false);
      if (!truthy || !falsy) {
        return { error: `问题 "${name}" 需要 true 和 false 各自的含义` };
      }
      if (truthy === falsy) {
        return { error: `问题 "${name}" 的 true 和 false 含义不能相同` };
      }
      if (truthy.length > MAX_CRITERION_CHARS || falsy.length > MAX_CRITERION_CHARS) {
        return { error: `问题 "${name}" 的 criteria 每项上限 ${MAX_CRITERION_CHARS} 字符` };
      }
      return {
        question: { type: 'bool', instructions, criteria: { true: truthy, false: falsy } },
      };
    }

    case 'choice': {
      const entries = Object.entries(question.criteria ?? {});
      if (entries.length < MIN_CHOICE_LABELS || entries.length > MAX_CHOICE_LABELS) {
        return {
          error: `问题 "${name}" 需要 ${MIN_CHOICE_LABELS}–${MAX_CHOICE_LABELS} 个选项，收到 ${entries.length} 个`,
        };
      }
      const pairs: [string, string][] = [];
      const labels = new Set<string>();
      for (const [rawLabel, rawMeaning] of entries) {
        const label = rawLabel.trim();
        const meaning = textOf(rawMeaning);
        if (!label) return { error: `问题 "${name}" 有空白选项名` };
        if (label.length > MAX_CHOICE_LABEL_CHARS) {
          return { error: `问题 "${name}" 的选项名 "${label}" 过长（上限 ${MAX_CHOICE_LABEL_CHARS} 字符）` };
        }
        if (labels.has(label)) {
          return { error: `问题 "${name}" 的选项名 "${label}" 重复` };
        }
        if (!meaning) return { error: `问题 "${name}" 的选项 "${label}" 缺少含义` };
        if (meaning.length > MAX_CRITERION_CHARS) {
          return { error: `问题 "${name}" 的选项 "${label}" 含义过长（上限 ${MAX_CRITERION_CHARS} 字符）` };
        }
        labels.add(label);
        pairs.push([label, meaning]);
      }
      // `Object.fromEntries` defines own properties, so a label like `__proto__`
      // cannot mutate the object instead of becoming a label.
      return {
        question: { type: 'choice', instructions, criteria: Object.fromEntries(pairs) },
      };
    }

    case 'score': {
      const levels = (question.criteria ?? []).map((level) => textOf(level));
      if (levels.length < MIN_SCORE_LEVELS || levels.length > MAX_SCORE_LEVELS) {
        return {
          error: `问题 "${name}" 需要 ${MIN_SCORE_LEVELS}–${MAX_SCORE_LEVELS} 个评分档位，收到 ${levels.length} 个`,
        };
      }
      if (levels.some((level) => !level)) {
        return { error: `问题 "${name}" 的评分档位不能为空` };
      }
      if (levels.some((level) => level.length > MAX_SCORE_LEVEL_CHARS)) {
        return { error: `问题 "${name}" 的评分档位上限 ${MAX_SCORE_LEVEL_CHARS} 字符` };
      }
      return { question: { type: 'score', instructions, criteria: levels } };
    }

    default:
      return { error: `问题 "${name}" 的 type 必须是 bool、choice 或 score` };
  }
}

function renderAnswer(name: string, answer: DecisionAnswer, threshold: number): string {
  switch (answer.type) {
    case 'bool': {
      const value = answer.probability >= threshold;
      return `- ${name}: bool ${value}，p=${formatNumber(answer.probability)}（阈值 ${formatNumber(threshold)}）`;
    }
    case 'choice': {
      const probabilities = Object.entries(answer.probabilities)
        .map(([label, value]) => `${label}:${formatNumber(value)}`)
        .join(', ');
      const tail = probabilities ? `  {${probabilities}}` : '';
      return `- ${name}: choice ${answer.choice}，confidence=${formatNumber(answer.confidence)}${tail}`;
    }
    case 'score': {
      const legend = answer.legend
        ? `  [${Object.entries(answer.legend)
            .map(([level, meaning]) => `${level}=${meaning}`)
            .join(', ')}]`
        : '';
      return `- ${name}: score ${formatNumber(answer.score)}，confidence=${formatNumber(answer.confidence)}${legend}`;
    }
  }
}

/** Three decimals is enough for a probability and keeps the transcript compact. */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return 'n/a';
  const fixed = value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return fixed === '-0' ? '0' : fixed;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(text: string): ToolExecutionResult {
  return { isError: true, output: [{ type: 'text' as const, text }] };
}
