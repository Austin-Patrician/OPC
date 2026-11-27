import { describe, expect, it, vi } from 'vitest';

const { registerSchemesAsPrivileged } = vi.hoisted(() => ({
  registerSchemesAsPrivileged: vi.fn(),
}));

vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged },
}));

import { APP_PRIVILEGED_SCHEMES, registerAppSchemes } from './registerSchemes';

describe('registerAppSchemes', () => {
  it('registers all custom protocols in a single privileged batch with fetch and stream support', () => {
    registerAppSchemes();

    expect(registerSchemesAsPrivileged).toHaveBeenCalledTimes(1);
    expect(APP_PRIVILEGED_SCHEMES.map((entry) => entry.scheme)).toEqual([
      'opc-ocr',
      'opc-media',
      'opc-doc',
      'opc-wallpaper',
    ]);
    for (const entry of APP_PRIVILEGED_SCHEMES) {
      expect(entry.privileges).toEqual({
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      });
    }
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([...APP_PRIVILEGED_SCHEMES]);
  });
});
