import { useSyncExternalStore } from 'react';
import { getWorkTransport } from '@/shared/api/workTransport';

/** Subscribes the tree to task state; identical shape to `useChatRuntime`. */
export function useWorkRuntime() {
  const transport = getWorkTransport();
  const tasks = useSyncExternalStore(
    transport.subscribe,
    transport.getTasks,
    transport.getTasks,
  );
  const budgets = useSyncExternalStore(
    transport.subscribe,
    transport.getBudgets,
    transport.getBudgets,
  );

  return {
    tasks,
    budgets,
    budgetFor: (employeeId: string) =>
      budgets.find((budget) => budget.scope === 'employee' && budget.scopeId === employeeId),
    getSubtasks: transport.getSubtasks,
    createTask: transport.createTask,
    runTask: transport.runTask,
  };
}
