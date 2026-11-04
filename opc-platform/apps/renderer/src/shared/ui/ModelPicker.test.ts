import type { CatalogProvider, ProviderConfig } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import { pickerGroups } from './ModelPicker';

/**
 * 选择器收数据的两条规则：不能用的 Provider 不出现；思考档位听 pi 的。
 * 这两件事都在 `pickerGroups` 里，组件本身只负责画。
 */
const provider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'p',
  name: 'Provider',
  baseUrl: '',
  api: 'openai-completions',
  isCustom: false,
  hasKey: true,
  models: [],
  updatedAt: 0,
  ...over,
});

const chat = (id: string, reasoning?: boolean) => ({
  id,
  name: id,
  capability: 'chat' as const,
  ...(reasoning === undefined ? {} : { reasoning }),
});

describe('模型选择器的分组', () => {
  it('没有密钥的 Provider 不出现', () => {
    const groups = pickerGroups(
      [
        provider({ id: 'no-key', hasKey: false, models: [chat('a', true)] }),
        provider({ id: 'ready', models: [chat('b', true)] }),
      ],
      () => true,
    );
    expect(groups.map((group) => group.providerId)).toEqual(['ready']);
  });

  it('筛完一个模型都不剩的 Provider 不出现', () => {
    const groups = pickerGroups(
      [provider({ id: 'chat-only', models: [chat('a', true)] })],
      (model) => model.capability === 'classifier',
    );
    expect(groups).toEqual([]);
  });

  it('思考档位来自 pi 的目录，而不是默认三档', () => {
    const catalog: CatalogProvider[] = [
      {
        id: 'p',
        baseUrl: '',
        apis: [],
        counts: { chat: 1, image: 0, classifier: 0, asr: 0, tts: 0 },
        models: [
          {
            id: 'a',
            name: 'A',
            type: 'chat',
            api: 'openai-completions',
            reasoning: true,
            thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        ],
      },
    ];
    const groups = pickerGroups([provider({ models: [chat('a', true)] })], () => true, catalog);
    expect(groups[0]?.models[0]?.thinkingLevels).toContain('xhigh');
  });

  it('目录里没有的模型退回默认三档；不支持思考的模型一个档位都不给', () => {
    const groups = pickerGroups(
      [
        provider({
          models: [chat('hand-added', true), chat('plain', false)],
        }),
      ],
      () => true,
    );
    expect(groups[0]?.models[0]?.thinkingLevels).toEqual(['low', 'medium', 'high']);
    expect(groups[0]?.models[1]?.thinkingLevels).toEqual([]);
  });
});
