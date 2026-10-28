import type { Budget, BudgetScope } from '@opc/shared/domain';
import type {
  CostCenterLine,
  CostCentersOverview,
  PayrollLine,
  PayrollOverview,
} from '@opc/shared/ipc';
import { forecastPeriod, periodKeyOf } from './budgetMath';
import type { BudgetService } from './budgetService';
import type { OrgService } from '../org/orgService';
import type { CompanyDatabase } from '../data/companyDatabase';

/**
 * 薪酬与成本中心：把 token 预算翻译成"这个月花了多少钱"。
 *
 * 设计文档 §8 把成本当薪酬（"paid model is the real salary grade"），所以这不是一个新的
 * 数据模型，而是一个读模型 —— 每一行都由已有的两张表算出来：
 *
 * - `budget_ledger`（`kind='settle'`）：真实花掉的钱与 token；
 * - `budget`：老板给某个维度设的月度上限，以及这笔钱属于哪个月。
 *
 * 四个刻意的取舍：
 *
 * 1. **每条轴只读自己那一行**。一次任务会同时结算 project / department / employee /
 *    company 四个预算，四条账本行的 token 与金额完全相同；把几条加起来会把同一次花费
 *    算四遍。所以员工视图读 `scope='employee'`，部门视图读 `scope='department'`。
 * 2. **必须按月过滤**。`budget_ledger` 自己没有 `period_key`，它挂在 `budget_id` 上，
 *    所以查询要 join `budget` —— 否则"本月"会把上个月的钱一起算进来。
 * 3. **"月薪"是折算值，不是事实**。库里没有单价，所以金额上限只能用**已观测到的**
 *    `cost_usd / tokens` 折算；一次都没花过就没有单价，字段留空而不是填 0 ——
 *    0 会被读成"这个人是免费的"。
 * 4. **对账差额显式给出**。部门/项目轴只在"结算时知道它"时才会记账，所以两条轴的合计
 *    通常小于员工合计；差额是"无法归属的花费"，不是错误，藏起来会让两份报表永远对不上。
 */
export interface PayrollDeps {
  db: CompanyDatabase;
  budgets: BudgetService;
  org: OrgService;
  now?: () => number;
}

/** One settled row of the ledger, already scoped to the period. */
interface SpendRow {
  scope_id: string;
  tokens: number;
  cost: number;
}

export class PayrollService {
  constructor(private readonly deps: PayrollDeps) {}

  /**
   * Settled spend for one axis in one period.
   *
   * `budget_ledger` carries no period of its own — the month lives on `budget` — so the
   * join is what makes "本月" true instead of "since the beginning of time".
   */
  private spendByScope = (scope: BudgetScope, periodKey: string): SpendRow[] =>
    this.deps.db
      .prepare(
        `SELECT l.scope_id AS scope_id, SUM(l.tokens) AS tokens, SUM(l.cost_usd) AS cost
           FROM budget_ledger l
           JOIN budget b ON b.id = l.budget_id
          WHERE l.kind = 'settle' AND l.scope = ? AND b.period_key = ?
          GROUP BY l.scope_id`,
      )
      .all(scope, periodKey) as SpendRow[];

  /** Current-period budgets for one axis, keyed by scope id. */
  private budgetsByScope = (scope: BudgetScope, periodKey: string): Map<string, Budget> =>
    new Map(
      this.deps.budgets
        .list()
        .filter((budget: Budget) => budget.scope === scope && budget.periodKey === periodKey)
        .map((budget: Budget) => [budget.scopeId, budget]),
    );

  overview = (): PayrollOverview => {
    const now = this.deps.now?.() ?? Date.now();
    const periodKey = periodKeyOf(now);

    const spent = this.spendByScope('employee', periodKey);
    const spentById = new Map(spent.map((row) => [row.scope_id, row]));
    const budgets = this.budgetsByScope('employee', periodKey);

    const departments = this.deps.org.list();
    const members = this.deps.org.everyone().filter((member) => member.status === 'active');
    const totalSpent = spent.reduce((sum, row) => sum + row.cost, 0);

    const lines: PayrollLine[] = members.map((member) => {
      const usage = spentById.get(member.id);
      const budget = budgets.get(member.id);
      const tokensUsed = usage?.tokens ?? 0;
      const spentUsd = usage?.cost ?? 0;
      const limitTokens = budget?.limitTokens ?? 0;

      const forecast = forecastPeriod({ usedTokens: tokensUsed, limitTokens, periodKey, now });
      // Only meaningful when this person has actually burned tokens: without a price
      // there is nothing to convert the token cap into.
      const unitCost = tokensUsed > 0 ? spentUsd / tokensUsed : 0;
      const budgetUsd = tokensUsed > 0 && limitTokens > 0 ? limitTokens * unitCost : undefined;

      return {
        employeeId: member.id,
        name: member.name,
        title: member.title,
        level: member.level,
        departmentId: member.departmentId,
        departmentName: departments.find((node) => node.id === member.departmentId)?.name ?? '',
        status: member.status,
        tokensUsed,
        spentUsd,
        limitTokens,
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
        projectedUsd: tokensUsed > 0 ? forecast.projectedTokens * unitCost : 0,
        share: totalSpent > 0 ? spentUsd / totalSpent : 0,
      };
    });

    lines.sort((a, b) => b.spentUsd - a.spentUsd);

    return {
      generatedAt: now,
      periodKey,
      lines,
      totalSpentUsd: totalSpent,
      totalProjectedUsd: lines.reduce((sum, line) => sum + line.projectedUsd, 0),
      headcount: lines.length,
    };
  };

  /**
   * 成本中心：按部门、按项目各看一次这个月的花费。
   *
   * Names come from the org tables rather than from the ledger: a department that has
   * since been archived still owns its spend, so its name is looked up among *all*
   * departments, not only the live ones — otherwise an archived team would show up as
   * a raw id in a money report.
   */
  costCenters = (): CostCentersOverview => {
    const now = this.deps.now?.() ?? Date.now();
    const periodKey = periodKeyOf(now);

    const employeeSpend = this.spendByScope('employee', periodKey);
    const totalSpent = employeeSpend.reduce((sum, row) => sum + row.cost, 0);

    const departmentNames = new Map(
      (this.deps.db.prepare('SELECT id, name FROM department').all() as { id: string; name: string }[]).map(
        (row) => [row.id, row.name],
      ),
    );
    const projectNames = new Map(
      (this.deps.db.prepare('SELECT id, name FROM project_group').all() as { id: string; name: string }[]).map(
        (row) => [row.id, row.name],
      ),
    );

    const seated = new Map<string, number>();
    for (const member of this.deps.org.everyone()) {
      if (member.status !== 'active' || !member.departmentId) continue;
      seated.set(member.departmentId, (seated.get(member.departmentId) ?? 0) + 1);
    }

    const assigned = new Map<string, number>();
    const projectMembers = this.deps.db
      .prepare(
        `SELECT project_group_id, COUNT(*) AS n FROM assignment
          WHERE status IN ('active','paused') GROUP BY project_group_id`,
      )
      .all() as { project_group_id: string; n: number }[];
    for (const row of projectMembers) assigned.set(row.project_group_id, row.n);

    const build = (kind: 'department' | 'project'): CostCenterLine[] => {
      const scope: BudgetScope = kind;
      const spend = this.spendByScope(scope, periodKey);
      const budgets = this.budgetsByScope(scope, periodKey);
      const names = kind === 'department' ? departmentNames : projectNames;
      const counts = kind === 'department' ? seated : assigned;

      return spend
        .map((row) => {
          const budget = budgets.get(row.scope_id);
          const limitTokens = budget?.limitTokens ?? 0;
          const forecast = forecastPeriod({
            usedTokens: row.tokens,
            limitTokens,
            periodKey,
            now,
          });
          const unitCost = row.tokens > 0 ? row.cost / row.tokens : 0;
          return {
            id: row.scope_id,
            // An id with no row behind it would be a dangling budget; label it as such
            // rather than pretending it is a real cost centre.
            name: names.get(row.scope_id) ?? row.scope_id,
            kind,
            spentUsd: row.cost,
            tokensUsed: row.tokens,
            share: totalSpent > 0 ? row.cost / totalSpent : 0,
            headcount: counts.get(row.scope_id) ?? 0,
            limitTokens,
            ...(row.tokens > 0 && limitTokens > 0
              ? { budgetUsd: limitTokens * unitCost }
              : {}),
            projectedUsd: row.tokens > 0 ? forecast.projectedTokens * unitCost : 0,
          };
        })
        .sort((a, b) => b.spentUsd - a.spentUsd);
    };

    const departments = build('department');
    const projects = build('project');

    return {
      generatedAt: now,
      periodKey,
      departments,
      projects,
      totalSpentUsd: totalSpent,
      // The gap is spend no axis recorded — shown, never rounded away.
      unattributedDepartmentUsd: Math.max(
        0,
        totalSpent - departments.reduce((sum, line) => sum + line.spentUsd, 0),
      ),
      unattributedProjectUsd: Math.max(
        0,
        totalSpent - projects.reduce((sum, line) => sum + line.spentUsd, 0),
      ),
    };
  };
}
