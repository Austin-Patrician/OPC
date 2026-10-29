import type { DecisionAnswer, DecisionQuestion } from '@opc/shared/domain';

/**
 * The cutoff the console uses to turn a bool probability into 是 / 否.
 *
 * Same value as the `decide` tool's default: showing a different verdict here
 * would make the console disagree with what an agent gets from the same model.
 */
export const BOOL_THRESHOLD = 0.5;

/**
 * One answer, ready to render.
 *
 * `DecisionAnswer` is a wire shape (`{ type: 'bool', probability: 0.98 }`); a
 * person reading the console needs "是 · 概率 98.0%" instead. Keeping the
 * translation here — not in JSX — is what lets it be unit-tested and reused by
 * any future result view.
 */
export interface DecisionAnswerView {
  kind: DecisionAnswer['type'];
  /** bool: the verdict at `threshold`. `null` for the other kinds. */
  yes: boolean | null;
  /** choice: the chosen label. score: the number. bool: empty (the verdict is `yes`). */
  value: string;
  /** What that label or score means, taken from the question the caller asked. */
  meaning?: string;
  /** Probability for bool, confidence for choice and score. */
  confidence: number;
  /** True when `confidence` is a probability, so the label must say so. */
  probabilistic: boolean;
  /** choice only: every option, most likely first. */
  distribution: { label: string; probability: number }[];
  /** bool only: the cutoff behind `yes`. */
  threshold?: number;
}

export function describeAnswer(
  answer: DecisionAnswer,
  question?: DecisionQuestion,
  threshold: number = BOOL_THRESHOLD,
): DecisionAnswerView {
  if (answer.type === 'bool') {
    return {
      kind: 'bool',
      yes: answer.probability >= threshold,
      value: '',
      confidence: answer.probability,
      probabilistic: true,
      distribution: [],
      threshold,
    };
  }

  if (answer.type === 'choice') {
    return {
      kind: 'choice',
      yes: null,
      value: answer.choice,
      meaning: question?.type === 'choice' ? question.criteria[answer.choice] : undefined,
      confidence: answer.confidence,
      probabilistic: false,
      distribution: Object.entries(answer.probabilities)
        .sort(([, left], [, right]) => right - left)
        .map(([label, probability]) => ({ label, probability })),
    };
  }

  // Score is a number, not necessarily an array index: a rubric question can
  // answer 1.37. Prefer the service's own legend, then the rubric level nearest
  // to it, so the number always carries a meaning.
  const level = Math.round(answer.score);
  const legend = answer.legend?.[String(level)];
  const rubric = question?.type === 'score' ? question.criteria[level] : undefined;

  return {
    kind: 'score',
    yes: null,
    value: formatScore(answer.score),
    meaning: legend ?? rubric,
    confidence: answer.confidence,
    probabilistic: false,
    distribution: [],
  };
}

/** Whole numbers stay whole; fractional expectations keep two decimals. */
function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(2);
}

/** `0.98` → `98.0%`. One decimal is enough to compare two answers. */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}
