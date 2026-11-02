import type { Worker } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import type { ModelConfigService } from './modelConfigService';
import { resolveWorkerModelRef } from './workerModel';

/**
 * 模型跟着执行体走。
 *
 * §2.2：执行体通常配置能力最强的模型。一条工作线的运行环境在创建那一刻就定了，
 * 包括用哪个模型——所以「执行体自己的模型 → 公司默认」是 v2 的语义，不只是实现
 * 细节。中间那层「某个人的模型覆盖」已经随 `employee` 一起消失。
 */
function config(available: { providerId: string; modelId: string }[]): ModelConfigService {
  const providers = new Map<string, { id: string; models: { id: string }[] }>();
  for (const entry of available) {
    const provider = providers.get(entry.providerId) ?? { id: entry.providerId, models: [] };
    provider.models.push({ id: entry.modelId });
    providers.set(entry.providerId, provider);
  }
  return {
    getDefaults: () => ({ llm: { providerId: 'default', modelId: 'big' } }),
    listProviders: () => [...providers.values()],
  } as unknown as ModelConfigService;
}

function worker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: 'w-1',
    name: '小助手',
    template: 'research',
    skills: [],
    threadId: 'th-1',
    employeeId: null,
    modelProvider: null,
    modelId: null,
    policyJson: '{}',
    status: 'idle',
    spentTokens: 0,
    createdAt: 0,
    retiredAt: null,
    ...overrides,
  };
}

describe('resolveWorkerModelRef', () => {
  it('执行体自己的模型优先', () => {
    const modelConfig = config([
      { providerId: 'worker-provider', modelId: 'small' },
      { providerId: 'default', modelId: 'big' },
    ]);
    expect(
      resolveWorkerModelRef({
        worker: worker({ modelProvider: 'worker-provider', modelId: 'small' }),
        modelConfig,
      }),
    ).toEqual({ providerId: 'worker-provider', modelId: 'small' });
  });

  it('没配就用公司默认', () => {
    const modelConfig = config([{ providerId: 'default', modelId: 'big' }]);
    expect(resolveWorkerModelRef({ worker: worker(), modelConfig })).toEqual({
      providerId: 'default',
      modelId: 'big',
    });
  });

  it('配了一个已经下线的模型时回退到默认，并说明原因', () => {
    const modelConfig = config([{ providerId: 'default', modelId: 'big' }]);
    expect(
      resolveWorkerModelRef({
        worker: worker({ modelProvider: 'gone', modelId: 'gone' }),
        modelConfig,
      }),
    ).toEqual({ providerId: 'default', modelId: 'big' });
  });

  it('既没有执行体也没有目录时返回 null——宁可拒绝跑，不用猜的模型', () => {
    expect(resolveWorkerModelRef({ worker: null, modelConfig: undefined })).toBeNull();
  });
});
