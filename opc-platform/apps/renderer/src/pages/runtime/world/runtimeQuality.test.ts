import { describe, expect, it } from 'vitest';
import { RUNTIME_RENDER_CONFIG } from './runtimeQuality';

describe('runtime quality control', () => {
  it('keeps the original high-fidelity render contract', () => {
    expect(RUNTIME_RENDER_CONFIG).toEqual({
      dpr: [1, 1.75],
      shadowMapSize: 4096,
      shadows: true,
      bloom: true,
      ao: true,
      multisampling: 4,
    });
  });
});
