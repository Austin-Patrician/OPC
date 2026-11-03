import type { ModelRef, Worker } from '@opc/shared/domain';
import type { ModelConfigService } from './modelConfigService';

/**
 * 执行体用哪个模型。
 *
 * 两层，不是三层了：**执行体自己的 → 工作台默认**。
 *
 * 中间那一层曾经是「某个人的模型覆盖」。`employee` 从运行时里摘掉之后它自然消失，
 * 这也正是 v2 想说的：一条工作线的运行环境在它被创建的那一刻就定了，包括用哪个
 * 模型；而跑这条线的执行体是它自己，不是某个人的替身。
 *
 * 不盲信存下来的值：provider 可能被删、模型可能被下线，那时回退到默认并说清楚
 * 原因，而不是让任务死在"找不到模型"上。
 */
export function resolveWorkerModelRef(input: {
  /** 这个执行体，可能为空（旧任务没有 worker 行）。 */
  worker: Worker | null;
  modelConfig: ModelConfigService | undefined;
}): ModelRef | null {
  const { worker, modelConfig } = input;
  const fallback = modelConfig?.getDefaults().llm ?? null;
  const pinned =
    worker?.modelProvider && worker.modelId
      ? { providerId: worker.modelProvider, modelId: worker.modelId }
      : null;
  if (!pinned) return fallback;

  if (isUsable(modelConfig, pinned)) return pinned;
  console.warn(`执行体 ${worker?.id} 配置的模型已不存在，回退到工作台默认模型`);
  return fallback;
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
