import type { ModelDefaults } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import { pickRouterModel } from './routerModel';

/**
 * Router 的模型档。
 *
 * 这里锁的是**回退方向**：没配 `router` 时必须落到 `llm` 上，而不是落到 `null`。
 * 否则所有已经装好的工作台在升级后都会突然"没有模型"——那是一个只在真实机器上
 * 出现、用例里看不出来的故障。
 */
const defaults = (patch: Partial<ModelDefaults> = {}): ModelDefaults => ({
  llm: { providerId: 'main', modelId: 'big' },
  router: null,
  image: null,
  asr: null,
  tts: null,
  decision: null,
  ...patch,
});

describe('Router 用哪个模型', () => {
  it('没配 router 就跟随执行体的默认模型（升级后行为不变）', () => {
    expect(pickRouterModel(defaults())).toEqual({ providerId: 'main', modelId: 'big' });
  });

  it('配了 router 就用它——轻模型给 Router、强模型给执行体', () => {
    expect(
      pickRouterModel(defaults({ router: { providerId: 'cheap', modelId: 'small' } })),
    ).toEqual({ providerId: 'cheap', modelId: 'small' });
  });

  it('两档都没有时返回 null，交给会话层安静地掉一轮', () => {
    expect(pickRouterModel(defaults({ llm: null }))).toBeNull();
    expect(pickRouterModel(undefined)).toBeNull();
    expect(pickRouterModel(null)).toBeNull();
  });
});
