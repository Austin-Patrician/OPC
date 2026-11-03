import type { ToolPolicy, Worker, WorkerTemplate } from '@opc/shared/domain';
import { parseToolPolicy } from './toolPolicy';

/**
 * 运行时为谁而建。
 *
 * 主体是 **worker**，不是人：工具、模型、策略、任务归属都挂在它身上。
 *
 * `employee` 表已经删了（V31），这里不再有"按人兜底"的第二条路径。唯一还带着
 * `ownerId` 的是老 worker 行上的遗留值——它只用于让旧任务继续对上原来的
 * `agents/<id>.sqlite`，不参与任何查表。
 */
export interface RegistrySubject {
  /** 记忆作用域 / 按执行体查当前任务，都用它。 */
  id: string;
  name: string;
  template: WorkerTemplate;
  skills: readonly string[];
  /**
   * 这个执行体装了哪些工具、开了哪些开关。
   *
   * §2.2：Worker 挂载完整的执行工具。所以这是**执行体自己的属性**，不是某个人的。
   * 空表示全开（缺省即完整工具集）。
   */
  policy?: ToolPolicy;
  /**
   * 老 worker 行上的遗留值（`worker.employee_id`）。新数据为空；留着它是因为
   * 旧任务的运行目录仍以它命名。
   */
  ownerId?: string;
}

export function subjectOfWorker(worker: Worker): RegistrySubject {
  return {
    id: worker.id,
    name: worker.name,
    template: worker.template,
    skills: worker.skills,
    policy: parseToolPolicy(worker.policyJson),
    ...(worker.ownerId ? { ownerId: worker.ownerId } : {}),
  };
}
