import type { Budget, CreateTaskInput, CreateTaskResult, WorkTask } from '@opc/shared/domain';
import type { WorkBridge } from '@opc/shared/ipc';
import type { WorkTransport } from './workTransport';

/** Mirrors the chat transport: a cached immutable list plus a change event. */
export class IpcWorkTransport implements WorkTransport {
  private tasks: readonly WorkTask[] = [];
  private budgets: readonly Budget[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: (() => void)[] = [];

  constructor(private readonly bridge: WorkBridge) {
    this.unsubscribers.push(
      bridge.onBudgetsChanged((budgets) => {
        this.budgets = budgets;
        this.emit();
      }),
    );

    this.unsubscribers.push(bridge.onTaskChanged((task) => {
      const index = this.tasks.findIndex((item) => item.id === task.id);
      this.tasks =
        index === -1
          ? [task, ...this.tasks]
          : this.tasks.map((item) => (item.id === task.id ? task : item));
      this.emit();
    }));

    void Promise.all([bridge.listTasks(), bridge.listBudgets()]).then(([tasks, budgets]) => {
      this.tasks = tasks;
      this.budgets = budgets;
      this.emit();
    });
  }

  getTasks = (): readonly WorkTask[] => this.tasks;

  getBudgets = (): readonly Budget[] => this.budgets;

  getSubtasks = (taskId: string): Promise<readonly WorkTask[]> => this.bridge.subtasks(taskId);

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  createTask = async (input: CreateTaskInput): Promise<CreateTaskResult> => {
    const result = await this.bridge.createTask(input);
    if (result.ok) await this.bridge.runTask(result.task.id);
    return result;
  };

  runTask = async (taskId: string): Promise<void> => {
    await this.bridge.runTask(taskId);
  };

  dispose = (): void => {
    this.unsubscribers.forEach((off) => off());
    this.unsubscribers.length = 0;
    this.listeners.clear();
  };

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}
