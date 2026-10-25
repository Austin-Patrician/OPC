import type { Budget, CreateTaskInput, CreateTaskResult, WorkTask } from '@opc/shared/domain';

export interface WorkTransport {
  getTasks(): readonly WorkTask[];
  getBudgets(): readonly Budget[];
  getSubtasks(taskId: string): Promise<readonly WorkTask[]>;
  subscribe(listener: () => void): () => void;
  createTask(input: CreateTaskInput): Promise<CreateTaskResult>;
  runTask(taskId: string): Promise<void>;
  dispose(): void;
}

let current: WorkTransport | null = null;

export function setWorkTransport(transport: WorkTransport): void {
  current?.dispose();
  current = transport;
}

export function getWorkTransport(): WorkTransport {
  if (!current) throw new Error('WorkTransport 未初始化：应用必须由 Electron 主进程启动。');
  return current;
}
