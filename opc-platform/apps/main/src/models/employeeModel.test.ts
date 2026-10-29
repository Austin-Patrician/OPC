import { describe, expect, it, vi } from 'vitest';
import type { ModelRef } from '@opc/shared/domain';
import type { OrgService } from '../org/orgService';
import type { ModelConfigService } from './modelConfigService';
import { resolveEmployeeModelRef } from './employeeModel';

const DEFAULT: ModelRef = { providerId: 'openai', modelId: 'gpt-5' };

function fakeOrg(ref: ModelRef | undefined): OrgService {
  return { modelRefOf: () => ref } as unknown as OrgService;
}

const modelConfig = {
  getDefaults: () => ({ llm: DEFAULT }),
  listProviders: () => [
    {
      id: 'anthropic',
      name: 'Anthropic',
      models: [
        { id: 'claude-sonnet-4-5', name: 'Sonnet', capability: 'chat' },
        { id: 'claude-haiku-4-5', name: 'Haiku', capability: 'chat' },
      ],
    },
    { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5', capability: 'chat' }] },
  ],
} as unknown as ModelConfigService;

/**
 * A saved override must survive only while it still identifies a real model.
 * Otherwise a removed provider would make every task fail with "not found"
 * instead of falling back to the company default.
 */
describe('resolveEmployeeModelRef', () => {
  it('uses the company default when the employee has no override', () => {
    expect(resolveEmployeeModelRef(modelConfig, fakeOrg(undefined), 'agent-1')).toEqual(DEFAULT);
  });

  it('honours a saved override that still exists', () => {
    expect(
      resolveEmployeeModelRef(
        modelConfig,
        fakeOrg({ providerId: 'anthropic', modelId: 'claude-haiku-4-5' }),
        'agent-1',
      ),
    ).toEqual({ providerId: 'anthropic', modelId: 'claude-haiku-4-5' });
  });

  it('falls back when the provider or model was removed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      resolveEmployeeModelRef(
        modelConfig,
        fakeOrg({ providerId: 'anthropic', modelId: 'retired-model' }),
        'agent-1',
      ),
    ).toEqual(DEFAULT);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('returns null when nothing is configured at all', () => {
    expect(resolveEmployeeModelRef(undefined, undefined, 'agent-1')).toBeNull();
  });
});
