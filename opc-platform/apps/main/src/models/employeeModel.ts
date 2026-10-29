import type { ModelRef } from '@opc/shared/domain';
import type { OrgService } from '../org/orgService';
import type { ModelConfigService } from './modelConfigService';

/**
 * The model an employee actually runs with.
 *
 * `employee.model` used to be a display string only, and every task used the
 * company default. Now the row can carry a structured override, but it must not
 * be trusted blindly: a provider can be removed or a model disabled after the
 * choice was saved. Resolution therefore falls back to the default and says why,
 * instead of failing a task with "model not found".
 *
 * Both the task loop and 1v1 chat call this, so "改模型立即生效" has one meaning.
 */
export function resolveEmployeeModelRef(
  modelConfig: ModelConfigService | undefined,
  org: OrgService | undefined,
  employeeId: string,
): ModelRef | null {
  const fallback = modelConfig?.getDefaults().llm ?? null;
  const override = org?.modelRefOf(employeeId);
  if (!override) return fallback;

  const provider = modelConfig
    ?.listProviders()
    .find((entry) => entry.id === override.providerId);
  if (!provider?.models.some((entry) => entry.id === override.modelId)) {
    console.warn(`员工 ${employeeId} 配置的模型已不存在，回退到公司默认模型`);
    return fallback;
  }
  return override;
}
