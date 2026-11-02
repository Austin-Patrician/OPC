import { useCallback, useEffect, useState } from 'react';
import type { AppInfo } from '@opc/shared/ipc';
import type { DepartmentNode, ModelDefaults, ProviderConfig } from '@opc/shared/domain';
import type { BudgetView } from '@opc/shared/ipc';

/**
 * Everything the guide shows that already exists in the product: the seeded
 * organisation, configured providers, the company budget row and the app version.
 *
 * Read-only: every write goes through the same bridge call the settings / org
 * pages use, and then this hook is reloaded, so the guide never invents state.
 *
 * The talent market used to be read here. It is gone (docs/v2/00-audit.md §5.4):
 * a personal assistant does not interview its workers, it instantiates them.
 */
export interface OnboardingData {
  departments: DepartmentNode[];
  providers: ProviderConfig[];
  defaults: ModelDefaults;
  thinking: string;
  companyBudget: BudgetView | null;
  info: AppInfo | null;
}

const EMPTY: OnboardingData = {
  departments: [],
  providers: [],
  defaults: { llm: null, image: null, asr: null, tts: null, decision: null },
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
      const [departments, providers, defaults, thinking, budget, info] = await Promise.all([
        bridge.org.list(),
        bridge.models.list(),
        bridge.models.getDefaults(),
        bridge.models.getThinking(),
        bridge.budget.overview(),
        bridge.app.getInfo(),
      ]);
      setData({
        departments,
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

  /** Cheap refresh after a limit change or an org edit inside the guide. */
  const refreshOrg = useCallback(async () => {
    const bridge = window.opc;
    if (!bridge) return;
    const departments = await bridge.org.list();
    setData((previous) => ({ ...previous, departments }));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const departmentCount = data.departments.length;
  const agentCount = data.departments.reduce((total, node) => total + node.members.length, 0);

  return { ...data, departmentCount, agentCount, loading, error, reload, refreshOrg };
}
