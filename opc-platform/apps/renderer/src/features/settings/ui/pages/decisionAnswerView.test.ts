import { describe, expect, it } from 'vitest';
import type { DecisionQuestion } from '@opc/shared/domain';
import { describeAnswer, formatPercent } from './decisionAnswerView';

const bool: DecisionQuestion = {
  type: 'bool',
  instructions: '是否需要人工回复？',
  criteria: { true: '提出了问题', false: '通知类内容' },
};

const choice: DecisionQuestion = {
  type: 'choice',
  instructions: '主要意图？',
  criteria: { refund: '要求退款', bug: '报告缺陷' },
};

const score: DecisionQuestion = {
  type: 'score',
  instructions: '有多紧急？',
  criteria: ['可以等', '本周内', '今天必须处理'],
};

describe('describeAnswer', () => {
  it('turns a bool probability into a verdict plus the number behind it', () => {
    // The console used to print "是 / 否 · 0.980", which reads as a type label and
    // says nothing about the actual answer.
    const view = describeAnswer({ type: 'bool', probability: 0.98 }, bool);

    expect(view).toMatchObject({
      kind: 'bool',
      yes: true,
      confidence: 0.98,
      probabilistic: true,
      threshold: 0.5,
      distribution: [],
    });
    expect(formatPercent(view.confidence)).toBe('98.0%');
  });

  it('reports the negative verdict below the cutoff', () => {
    expect(describeAnswer({ type: 'bool', probability: 0.49 }, bool).yes).toBe(false);
    expect(describeAnswer({ type: 'bool', probability: 0.5 }, bool).yes).toBe(true);
  });

  it('honours an explicit threshold', () => {
    const answer = { type: 'bool' as const, probability: 0.8 };

    expect(describeAnswer(answer, bool, 0.9)).toMatchObject({ yes: false, threshold: 0.9 });
  });

  it('carries the chosen label and its meaning for a choice', () => {
    const view = describeAnswer(
      {
        type: 'choice',
        choice: 'bug',
        confidence: 0.72,
        probabilities: { refund: 0.08, bug: 0.72, other: 0.2 },
      },
      choice,
    );

    expect(view).toMatchObject({
      kind: 'choice',
      yes: null,
      value: 'bug',
      meaning: '报告缺陷',
      confidence: 0.72,
      probabilistic: false,
    });
    // Most likely first, so the bar list reads top-down.
    expect(view.distribution).toEqual([
      { label: 'bug', probability: 0.72 },
      { label: 'other', probability: 0.2 },
      { label: 'refund', probability: 0.08 },
    ]);
  });

  it('names the score level from the service legend, then the rubric', () => {
    const withLegend = describeAnswer(
      { type: 'score', score: 2, confidence: 0.6, legend: { '2': '今天必须处理' } },
      score,
    );
    expect(withLegend).toMatchObject({ value: '2', meaning: '今天必须处理', probabilistic: false });

    // No legend: fall back to the rubric the caller asked with.
    expect(describeAnswer({ type: 'score', score: 1, confidence: 0.5 }, score).meaning).toBe('本周内');
  });

  it('keeps a fractional score readable', () => {
    expect(describeAnswer({ type: 'score', score: 1.37, confidence: 0.4 }, score).value).toBe('1.37');
  });

  it('works without the question (a raw answer from the API)', () => {
    const view = describeAnswer({
      type: 'choice',
      choice: 'bug',
      confidence: 0.5,
      probabilities: {},
    });

    expect(view.meaning).toBeUndefined();
    expect(view.distribution).toEqual([]);
  });
});

describe('formatPercent', () => {
  it('keeps one decimal and survives junk', () => {
    expect(formatPercent(0.9804)).toBe('98.0%');
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(1)).toBe('100.0%');
    expect(formatPercent(Number.NaN)).toBe('—');
  });
});
