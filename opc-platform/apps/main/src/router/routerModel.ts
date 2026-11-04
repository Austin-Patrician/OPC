import type { ModelDefaults, ModelRef } from '@opc/shared/domain';

/**
 * Router 会话用哪个模型。
 *
 * 两档，按顺序取：
 *
 *   ① `default.router` —— 设置里显式配了就用它。原文 §2.1 说 Router 常判断、
 *      读的是短事件批次，所以「轻模型给 Router、强模型给执行体」是一种很实际
 *      的搭配。
 *   ② `default.llm` —— 没配就跟随执行体的默认模型。这是加这一档**之前**的行为，
 *      保持它意味着升级不会因为"没配"而突然换模型，也不会在只有一个模型时不工作。
 *
 * 两档都没有就返回 `null`：会话层会跳过 `configure`，真实调用在模型解析那一步
 * 失败并落成一条日志——和以前没有模型时一样，安静地掉一轮，调度循环继续活着。
 */
export function pickRouterModel(
  defaults: ModelDefaults | null | undefined,
): ModelRef | null {
  if (!defaults) return null;
  return defaults.router ?? defaults.llm;
}
