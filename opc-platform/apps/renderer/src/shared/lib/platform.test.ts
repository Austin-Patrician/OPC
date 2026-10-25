import { describe, expect, it } from 'vitest';
import { detectPlatform, primaryModifier } from './platform';

describe('detectPlatform', () => {
  it('detects the three supported desktop platforms', () => {
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macos');
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });

  it('uses the platform hint when the UA is reduced', () => {
    expect(detectPlatform('', 'Win32')).toBe('windows');
    expect(detectPlatform('', 'MacIntel')).toBe('macos');
  });

  it('falls back to unknown for unrecognised agents', () => {
    expect(detectPlatform('curl/8.0')).toBe('unknown');
  });

  it('gives the right primary modifier per platform', () => {
    expect(primaryModifier('macos')).toBe('⌘');
    expect(primaryModifier('windows')).toBe('Ctrl');
    expect(primaryModifier('linux')).toBe('Ctrl');
  });
});
