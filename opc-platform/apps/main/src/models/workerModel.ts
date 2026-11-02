import type { ModelRef, Worker } from '@opc/shared/domain';
import type { OrgService } from '../org/orgService';
import type { ModelConfigService } from './modelConfigService';
import { resolveEmployeeModelRef } from './employeeModel';

/**
 * 执行体用哪个模型。
 *
 * v2 的方向是**模型跟着执行体走**，不是跟着人走：一条工作线的运行环境在被创建
 * 的那一刻就定了，包括用哪个模型。所以顺序是
 *
 *   worker.model  →  employee.model  →  公司默认
 *
 * 中间那一层是迁移期留下的：等 B4 把 `employee` 从运行时里摘掉，它会消失，
 * 这里就剩「执行体自己的模型，否则公司默认」。
 *
 * 和 `resolveEmployeeModelRef` 一样，不盲信存下来的值：provider 可能被删、
 * 模型可能被下线，那时回退并且说清楚原因，而不是让任务死在"找不到模型"上。
 */
export function resolveWorkerModelRef(input: {
  /** The execution body, when the task runs in one. */
  worker: Worker | null;
  modelConfig: ModelConfigService | undefined;
  org: OrgService | undefined;
  /** Whose tools/policy apply — the fallback source of a model. */
  employeeId: string;
}): ModelRef | null {
  const { worker, modelConfig, org, employeeId } = input;
  const pinned = worker?.modelProvider && worker.modelId
    ? { providerId: worker.modelProvider, modelId: worker.modelId }
    : null;

  if (pinned && isUsable(modelConfig, pinned)) return pinned;
  if (pinned) {
    console.warn(`执行体 ${worker?.id} 配置的模型已不存在，回退到该员工的模型`);
  }
  return resolveEmployeeModelRef(modelConfig, org, employeeId);
}

/** Whether that provider still exists and still carries that model. */
export function isUsable(
  modelConfig: ModelConfigService | undefined,
  ref: { providerId: string; modelId: string },
): boolean {
  if (!modelConfig) return false;
  return Boolean(
    modelConfig
      .listProviders()
      .find((provider) => provider.id === ref.providerId)
      ?.models.some((model) => model.id === ref.modelId),
  );
}
