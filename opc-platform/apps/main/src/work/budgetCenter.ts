import type { BudgetScope } from '@opc/shared/domain';
import type {
  BudgetAlertView,
  BudgetOverview,
  BudgetView,
  PausedAssignmentView,
} from '@opc/shared/ipc';
import { forecastPeriod, periodKeyOf } from './budgetMath';
import type { BudgetService } from './budgetService';
import type { OrgService } from '../org/orgService';
import type { ProjectService } from '../org/projectService';

/** The reason string written by the hard stop, so resuming finds the same people. */
export function pauseReasonFor(scope: BudgetScope): string {
  if (scope === 'project') return 'project_budget_exceeded';
  if (scope === 'department') return 'department_budget_exceeded';
  return 'employee_budget_exceeded';
}

export interface BudgetCenterDeps {
  budgets: BudgetService;
  org: OrgService;
  projects: ProjectService;
  now?: () => number;
}

/**
 * 预算中心 (§8): the read model behind `/budget`, plus the one write the boss needs.
 *
 * Every number is a row: `budget` for the totals, `budget_alert` for what was crossed
 * and when, `assignment` for who is currently stopped by it. The only derived value is
 * the month-end projection, and it is labelled as a projection.
 */
export class BudgetCenter {
  constructor(private readonly deps: BudgetCenterDeps) {}

  overview = (): BudgetOverview => {
    const now = this.deps.now?.() ?? Date.now();
    const periodKey = periodKeyOf(now);

    // Projects and departments get a row before they spend, so the boss can set a cap
    // up front instead of discovering the axis after the first charge.
    for (const project of this.deps.projects.list()) this.deps.budgets.ensureForProject(project.id);
    for (const department of this.deps.org.list()) this.deps.budgets.ensureForDepartment(department.id);

    const labelOf = (scope: BudgetScope, scopeId: string): string => {
      switch (scope) {
        case 'company':
          return '公司';
        case 'employee':
          return this.deps.org.everyone().find((member) => member.id === scopeId)?.name ?? scopeId;
        case 'department':
          return this.deps.org.list().find((node) => node.id === scopeId)?.name ?? scopeId;
        case 'project':
          return this.deps.projects.list({ includeArchived: true }).find((item) => item.id === scopeId)?.name ?? scopeId;
      }
    };

    const budgets: BudgetView[] = this.deps.budgets.list().map((budget) => {
      const forecast = forecastPeriod({
        usedTokens: budget.usedTokens,
        limitTokens: budget.limitTokens,
        periodKey: budget.periodKey,
        now,
      });
      return {
        scope: budget.scope,
        scopeId: budget.scopeId,
        label: labelOf(budget.scope, budget.scopeId),
        periodKey: budget.periodKey,
        limitTokens: budget.limitTokens,
        usedTokens: budget.usedTokens,
        reservedTokens: budget.reservedTokens,
        availableTokens: budget.availableTokens,
        state: budget.state,
        warnAt: budget.warnAt,
        hardStopAt: budget.hardStopAt,
        projectedTokens: forecast.projectedTokens,
        willExceed: forecast.willExceed,
      };
    });

    const alerts: BudgetAlertView[] = this.deps.budgets.alerts().map((alert) => ({
      id: alert.id,
      scope: alert.scope,
      scopeId: alert.scopeId,
      label: labelOf(alert.scope, alert.scopeId),
      level: alert.level,
      usedTokens: alert.usedTokens,
      limitTokens: alert.limitTokens,
      ratio: alert.ratio,
      periodKey: alert.periodKey,
      createdAt: alert.createdAt,
    }));

    const paused: PausedAssignmentView[] = this.deps.projects
      .list({ includeArchived: true })
      .flatMap((project) =>
        project.members
          .filter((member) => member.status === 'paused')
          .map((member) => ({
            projectId: project.id,
            projectName: project.name,
            employeeId: member.employeeId,
            employeeName: member.name,
            reason: member.pauseReason ?? '',
          })),
      );

    return { generatedAt: now, periodKey, budgets, alerts, paused };
  };

  /**
   * 老板调整额度。
   *
   * Raising a limit above the stop threshold is also the only way back for a paused
   * assignment, so this is where F8 is undone: the same reason string that paused
   * them is used to find and resume them.
   */
  setLimit = (input: { scope: BudgetScope; scopeId: string; limitTokens: number }): BudgetOverview => {
    this.deps.budgets.setLimit(input.scope, input.scopeId, input.limitTokens);

    const after = this.deps.budgets
      .list()
      .find((budget) => budget.scope === input.scope && budget.scopeId === input.scopeId);

    if (after && after.state !== 'stopped') {
      const reason = pauseReasonFor(input.scope);
      if (input.scope === 'project') {
        this.deps.projects.resumeAssignments({ projectId: input.scopeId }, reason);
      } else if (input.scope === 'employee') {
        this.deps.projects.resumeAssignments({ employeeId: input.scopeId }, reason);
      }
      // A department stop pauses nothing today (§5.6 pauses assignments only for
      // project/employee stops), so there is nothing to resume for it.
    }

    return this.overview();
  };
}
