import type { WorkReport, WorkTask, WorkThread } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import { shouldPromoteManualCompletion, shouldWakeRouterForReport } from './reportPolicy';

const report = (overrides: Partial<WorkReport> = {}): WorkReport => ({
  id: 'report-1',
  threadId: 'thread-1',
  taskId: 'task-1',
  subject: null,
  kind: 'report',
  level: 'silent',
  title: '完成',
  body: '结果',
  createdAt: 1,
  readAt: null,
  ...overrides,
});

const thread = (overrides: Partial<WorkThread> = {}): WorkThread => ({
  id: 'thread-1',
  title: '请求',
  goal: '请求',
  threadKey: null,
  source: 'manual',
  externalId: null,
  state: 'done',
  attention: 'silent',
  speculative: false,
  budgetTokens: null,
  spentTokens: 0,
  createdAt: 1,
  lastActivityAt: 1,
  closedAt: null,
  ...overrides,
});

const task = (overrides: Partial<WorkTask> = {}): WorkTask => ({
  id: 'task-1',
  parentTaskId: undefined,
  ...overrides,
}) as unknown as WorkTask;

describe('manual completion visibility', () => {
  it('promotes a successful root-task completion', () => {
    expect(shouldPromoteManualCompletion(report(), thread(), task())).toBe(true);
  });

  it('keeps child-task results silent for the root to summarize', () => {
    expect(shouldPromoteManualCompletion(report(), thread(), task({ parentTaskId: 'parent-1' }))).toBe(false);
  });

  it('does not promote speculative, non-manual, or non-silent reports', () => {
    expect(shouldPromoteManualCompletion(report(), thread({ speculative: true }), task())).toBe(false);
    expect(shouldPromoteManualCompletion(report(), thread({ source: 'folder' }), task())).toBe(false);
    expect(shouldPromoteManualCompletion(report({ level: 'notify' }), thread(), task())).toBe(false);
  });

  it('keeps taskless line summaries as audit records', () => {
    expect(shouldPromoteManualCompletion(report({ taskId: null }), thread(), undefined)).toBe(false);
  });
});

describe('report wake policy', () => {
  it('wakes Router for actionable reports only', () => {
    expect(shouldWakeRouterForReport(report({ level: 'decide' }))).toBe(true);
    expect(shouldWakeRouterForReport(report({ level: 'notify' }))).toBe(true);
    expect(shouldWakeRouterForReport(report({ level: 'silent' }))).toBe(false);
    expect(shouldWakeRouterForReport(report({ kind: 'question', level: 'decide' }))).toBe(false);
  });
});
