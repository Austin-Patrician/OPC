import type { Worker } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import type { ModelConfigService } from './modelConfigService';
import { resolveWorkerModelRef } from './workerModel';

/**
 * 模型跟着执行体走。
 *
 * 一条工作线的运行环境在被创建那一刻就定了，包括用哪个模型——所以这层优先级
 * （worker → employee → 默认）是 v2 的语义，不只是实现细节。
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
    employeeId: 'emp-1',
    modelProvider: null,
    modelId: null,
    status: 'idle',
    spentTokens: 0,
    createdAt: 0,
    retiredAt: null,
    ...overrides,
  };
}

const orgWith = (model: { providerId: string; modelId: string } | null) =>
  ({ modelRefOf: () => model }) as never;

describe('resolveWorkerModelRef', () => {
  it("prefers the execution body's own model", () => {
    const modelConfig = config([
      { providerId: 'worker-provider', modelId: 'small' },
      { providerId: 'default', modelId: 'big' },
    ]);
    const resolved = resolveWorkerModelRef({
      worker: worker({ modelProvider: 'worker-provider', modelId: 'small' }),
      modelConfig,
      org: orgWith(null),
      employeeId: 'emp-1',
    });
    expect(resolved).toEqual({ providerId: 'worker-provider', modelId: 'small' });
  });

  it("falls back to the person's model when the worker has none", () => {
    const modelConfig = config([{ providerId: 'default', modelId: 'big' }]);
    const resolved = resolveWorkerModelRef({
      worker: worker(),
      modelConfig,
      org: orgWith({ providerId: 'personal', modelId: 'mine' }),
      employeeId: 'emp-1',
    });
    // `personal/mine` is not in the catalogue, so the employee path falls through
    // to the company default — the same rule as before, reached through here.
    expect(resolved).toEqual({ providerId: 'default', modelId: 'big' });
  });

  it('falls back when the pinned model was removed from the catalogue', () => {
    const modelConfig = config([{ providerId: 'default', modelId: 'big' }]);
    const resolved = resolveWorkerModelRef({
      worker: worker({ modelProvider: 'gone-provider', modelId: 'gone-model' }),
      modelConfig,
      org: orgWith(null),
      employeeId: 'emp-1',
    });
    // A deleted provider must not fail the task with "model not found".
    expect(resolved).toEqual({ providerId: 'default', modelId: 'big' });
  });

  it('works when there is no worker at all (legacy tasks)', () => {
    const modelConfig = config([{ providerId: 'default', modelId: 'big' }]);
    const resolved = resolveWorkerModelRef({
      worker: null,
      modelConfig,
      org: orgWith(null),
      employeeId: 'emp-1',
    });
    expect(resolved).toEqual({ providerId: 'default', modelId: 'big' });
  });
});
