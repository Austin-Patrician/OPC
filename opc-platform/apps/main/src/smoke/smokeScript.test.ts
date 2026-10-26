import { describe, expect, it } from 'vitest';
import { loadSmokeScript } from './index';

/**
 * Guards the failure mode we actually hit: a template-embedded script that only
 * failed at runtime, inside Electron, after a full build.
 */
describe('smoke script', () => {
  const script = loadSmokeScript();

  it('is syntactically valid JavaScript', () => {
    expect(() => new Function(`return ${script}`)).not.toThrow();
  });

  it('is a self-invoking async function that returns a report', () => {
    expect(script.trimStart().startsWith('(async () =>')).toBe(true);
    expect(script).toContain('orgMembers');
    expect(script).toContain('diagnosticsOk');
  });
});
