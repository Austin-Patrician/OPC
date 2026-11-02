import type { Worker, WorkerTemplate } from '@opc/shared/domain';

/**
 * 运行时为谁而建。
 *
 * 主体是 **worker**，不是人：工具、模型、策略、任务归属都挂在它身上。
 *
 * `employeeId` 是迁移期遗留字段。它的存在与否就是整个 v2 的分界线：
 *
 * - 有它 → 沿用旧的按人查表（同事列表、工具策略、按人查当前任务）
 * - 没有它 → 各处自然降级：没有同事可聊、没有活可拆、策略为空
 *
 * 也就是说，`employee` 从运行时里消失的那一天，不需要再改一次这里——
 * 只是所有 worker 都不再有 `employeeId` 而已。
 */
export interface RegistrySubject {
  /** 通讯身份 / 记忆作用域 / 按执行体查当前任务，都用它。 */
  id: string;
  name: string;
  template: WorkerTemplate;
  skills: readonly string[];
  /** 迁移期遗留：这个人行还在的时候填上。 */
  employeeId?: string;
}

export function subjectOfWorker(worker: Worker): RegistrySubject {
  return {
    id: worker.id,
    name: worker.name,
    template: worker.template,
    skills: worker.skills,
    ...(worker.employeeId ? { employeeId: worker.employeeId } : {}),
  };
}

/** 迁移期：还没有执行体的旧任务，退回按人建。 */
export function subjectOfPerson(person: {
  id: string;
  name?: string;
  skills?: readonly string[];
  template?: WorkerTemplate;
}): RegistrySubject {
  return {
    id: person.id,
    name: person.name ?? person.id,
    template: person.template ?? 'research',
    skills: person.skills ?? [],
    employeeId: person.id,
  };
}
