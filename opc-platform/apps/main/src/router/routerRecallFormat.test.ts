import type { TaskTrace, WorkReport, WorkTask } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import { MEMORY_REFLECTION_SYSTEM_PROMPT } from '../memory/memoryReflector';
import {
  formatReportLine,
  formatReportStatusTag,
  summarizeThreadLatestActivity,
} from './routerRecallFormat';

function makeReport(overrides: Partial<WorkReport> = {}): WorkReport {
  return {
    id: 'rep-1',
    threadId: 'th-1',
    taskId: 'task-1',
    kind: 'approval',
    level: 'silent',
    subject: 'bash',
    title: '要你点头：在工作区执行终端命令',
    body: '命令：ls -la inputs/',
    createdAt: 1000,
    readAt: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 'task-1',
    title: '英文简历翻译',
    brief: '翻译 PDF',
    deliverableSpec: 'resume.pdf',
    assigneeId: 'worker-1',
    assigneeName: '文档助手',
    priority: 'P2',
    labels: [],
    blockedBy: [],
    isReview: false,
    depth: 0,
    childCount: 0,
    estTokens: 10_000,
    acceptanceCommand: [],
    acceptanceTemplate: 'http-ok',
    status: 'running',
    workspaceRelPath: 'threads/th-1',
    createdAt: 1000,
    updatedAt: 2000,
    artifacts: [],
    attempts: 1,
    tokensUsed: 0,
    costUsd: 0,
    steps: [],
    ...overrides,
  };
}

function makeTrace(overrides: Partial<TaskTrace> = {}): TaskTrace {
  return {
    id: 'tr-1',
    taskId: 'task-1',
    seq: 1,
    at: 1500,
    kind: 'tool',
    name: 'bash',
    argsDigest: 'python build.py',
    ok: true,
    ...overrides,
  };
}

describe('routerRecallFormat', () => {
  it('distinguishes pending vs resolved approvals and questions', () => {
    expect(formatReportStatusTag({ kind: 'approval', readAt: null })).toBe('[审批·等待用户确认]');
    expect(formatReportStatusTag({ kind: 'approval', readAt: 12345 })).toBe('[审批·已处理，不再阻塞]');
    expect(formatReportStatusTag({ kind: 'question', readAt: null })).toBe('[请示·等待用户回复]');
    expect(formatReportStatusTag({ kind: 'question', readAt: 12345 })).toBe('[请示·已回复]');
    expect(formatReportStatusTag({ kind: 'report', readAt: null })).toBe('[汇报]');

    expect(formatReportLine(makeReport({ readAt: 12345 }))).toContain('[审批·已处理，不再阻塞]');
  });

  it('shows live running trace instead of stale resolved approval on active threads', () => {
    const resolvedApproval = makeReport({ readAt: 12345 });
    const summary = summarizeThreadLatestActivity({
      reports: [resolvedApproval],
      latestTask: makeTask({ id: 'task-3d7e', status: 'running' }),
      recentTrace: [makeTrace({ name: 'bash', ok: true }), makeTrace({ seq: 2, name: 'write', ok: true })],
    });

    expect(summary).toContain('运行中（task-3d7e，最近动作：');
    expect(summary).toContain('bash(✓)');
    expect(summary).toContain('write(✓)');
    expect(summary).not.toContain('要你点头');
  });

  it('prioritizes unresolved approval or question over running trace', () => {
    const pendingApproval = makeReport({ readAt: null });
    const summary = summarizeThreadLatestActivity({
      reports: [pendingApproval],
      latestTask: makeTask({ status: 'running' }),
      recentTrace: [makeTrace({ name: 'bash', ok: true })],
    });

    expect(summary).toContain('[审批·等待用户确认]');
    expect(summary).toContain('要你点头：在工作区执行终端命令');
  });

  it('keeps resolved tag when task is settled and only resolved approvals exist', () => {
    const summary = summarizeThreadLatestActivity({
      reports: [makeReport({ readAt: 12345 })],
      latestTask: makeTask({ status: 'accepted' }),
      recentTrace: [],
    });

    expect(summary).toContain('[审批·已处理，不再阻塞]');
  });

  it('forbids promoting internal runtime/approval assumptions into RULES.md or USER.md', () => {
    expect(MEMORY_REFLECTION_SYSTEM_PROMPT).toContain('用户端看不到授权弹窗');
    expect(MEMORY_REFLECTION_SYSTEM_PROMPT).toContain('rulesRemove');
  });
});
