import { useCallback, useEffect, useState } from 'react';
import type { AppInfo } from '@opc/shared/ipc';
import type {
  AgentCandidate,
  DepartmentNode,
  ModelDefaults,
  ProviderConfig,
} from '@opc/shared/domain';
import type { BudgetView } from '@opc/shared/ipc';

/**
 * Everything the guide shows that already exists in the product: the seeded
 * organisation, imported market candidates, configured providers, the company
 * budget row and the app version.
 *
 * Read-only: every write goes through the same bridge call the settings / market
 * pages use, and then this hook is reloaded, so the guide never invents state.
 */
export interface OnboardingData {
  departments: DepartmentNode[];
  candidates: AgentCandidate[];
  providers: ProviderConfig[];
  defaults: ModelDefaults;
  thinking: string;
  companyBudget: BudgetView | null;
  info: AppInfo | null;
}

const EMPTY: OnboardingData = {
  departments: [],
  candidates: [],
  providers: [],
  defaults: { llm: null, image: null },
  thinking: 'medium',
  companyBudget: null,
  info: null,
};

export function useOnboardingData() {
  const [data, setData] = useState<OnboardingData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const bridge = window.opc;
    if (!bridge) {
      setLoading(false);
      return;
    }
    try {
      const [departments, candidates, providers, defaults, thinking, budget, info] = await Promise.all([
        bridge.org.list(),
        bridge.market.candidates(),
        bridge.models.list(),
        bridge.models.getDefaults(),
        bridge.models.getThinking(),
        bridge.budget.overview(),
        bridge.app.getInfo(),
      ]);
      setData({
        departments,
        candidates,
        providers,
        defaults,
        thinking,
        companyBudget: budget.budgets.find((row) => row.scope === 'company') ?? null,
        info,
      });
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  /** Cheap refresh after an import / hire / limit change inside the guide. */
  const refreshOrgAndMarket = useCallback(async () => {
    const bridge = window.opc;
    if (!bridge) return;
    const [departments, candidates] = await Promise.all([bridge.org.list(), bridge.market.candidates()]);
    setData((previous) => ({ ...previous, departments, candidates }));
  }, []);

  /** `market.importPackage` already returns the remaining list; no refetch needed. */
  const setCandidates = useCallback((candidates: AgentCandidate[]) => {
    setData((previous) => ({ ...previous, candidates }));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const departmentCount = data.departments.length;
  const agentCount = data.departments.reduce((total, node) => total + node.members.length, 0);

  return { ...data, departmentCount, agentCount, loading, error, reload, refreshOrgAndMarket, setCandidates };
}
