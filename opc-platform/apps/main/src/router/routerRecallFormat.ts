import type { TaskTrace, WorkReport, WorkTask } from '@opc/shared/domain';

export function formatReportStatusTag(
  report: Pick<WorkReport, 'kind' | 'readAt'>,
): string {
  if (report.kind === 'approval') {
    return report.readAt === null ? '[审批·等待用户确认]' : '[审批·已处理，不再阻塞]';
  }
  if (report.kind === 'question') {
    return report.readAt === null ? '[请示·等待用户回复]' : '[请示·已回复]';
  }
  return '[汇报]';
}

export function formatReportLine(
  report: Pick<WorkReport, 'id' | 'level' | 'kind' | 'readAt' | 'title' | 'body'>,
): string {
  return `${report.id} · ${formatReportStatusTag(report)} · ${report.level} · ${report.title}${report.body ? `：${report.body}` : ''}`;
}

export function summarizeThreadLatestActivity(input: {
  reports: readonly WorkReport[];
  latestTask?: WorkTask | null;
  recentTrace?: readonly TaskTrace[];
  renderTraceLines?: (trace: readonly TaskTrace[]) => string[];
}): string | null {
  const pending = input.reports.find(
    (report) =>
      report.readAt === null && (report.kind === 'approval' || report.kind === 'question'),
  );
  if (pending) {
    return `${formatReportStatusTag(pending)} ${pending.title}${pending.body ? `：${pending.body}` : ''}`;
  }

  const latestTask = input.latestTask;
  if (latestTask && (latestTask.status === 'running' || latestTask.status === 'open')) {
    const trace = input.recentTrace ?? [];
    if (trace.length > 0) {
      const rendered = input.renderTraceLines
        ? input.renderTraceLines(trace)
        : trace.map((entry) => `${entry.name}(${entry.ok === false ? '✗' : '✓'})`);
      if (rendered.length > 0) {
        return `运行中（${latestTask.id}，最近动作：${rendered.join(' → ')}）`;
      }
    }
    return `运行中（${latestTask.id}，已启动）`;
  }

  const nonResolvedApproval = input.reports.find(
    (report) => !(report.kind === 'approval' && report.readAt !== null),
  );
  const chosen = nonResolvedApproval ?? input.reports[0];
  if (!chosen) return null;
  return `${formatReportStatusTag(chosen)} ${chosen.title}${chosen.body ? `：${chosen.body}` : ''}`;
}
