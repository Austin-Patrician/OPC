import { describe, expect, it } from 'vitest';
import { desktopCommandOptions, desktopSessionId, desktopSessionName } from './broker';

describe('desktop CLI behavior', () => {
  it('passes arbitrary application identifiers through to agent-desktop', () => {
    expect(desktopCommandOptions('snapshot', 'com.example.AnyApp')).toEqual(['--app', 'com.example.AnyApp']);
  });

  it('places application and window selectors only on commands that support them', () => {
    expect(desktopCommandOptions('snapshot', 'TextEdit', 'window-1')).toEqual(['--app', 'TextEdit', '--window-id', 'window-1']);
    expect(desktopCommandOptions('focus-window', 'TextEdit', 'window-1')).toEqual(['--app', 'TextEdit', '--window-id', 'window-1']);
    expect(desktopCommandOptions('click', 'TextEdit', 'window-1')).toEqual([]);
  });

  it('accepts only a successful native session id', () => {
    expect(desktopSessionId({ ok: true, text: '', data: { session_id: 'native-123' } })).toBe('native-123');
    expect(desktopSessionId({ ok: true, text: '', data: { session_id: '  ' } })).toBeUndefined();
    expect(desktopSessionId({ ok: true, text: '', data: {} })).toBeUndefined();
    expect(desktopSessionId({ ok: false, text: 'runtime unavailable', data: { session_id: 'native-123' } })).toBeUndefined();
  });

  it('keeps native session names isolated when task ids sanitize to the same prefix', () => {
    expect(desktopSessionName('a/b')).not.toBe(desktopSessionName('a_b'));
    expect(desktopSessionName('a/b')).toMatch(/^opc-a_b-[a-f0-9]{12}$/);
  });
});
