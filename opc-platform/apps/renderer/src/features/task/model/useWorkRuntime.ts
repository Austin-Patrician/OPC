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

  return {
    tasks,
    getSubtasks: transport.getSubtasks,
    createTask: transport.createTask,
    runTask: transport.runTask,
  };
}
