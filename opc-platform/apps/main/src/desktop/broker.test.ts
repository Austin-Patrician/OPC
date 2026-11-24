import { describe, expect, it } from 'vitest';
import {
  desktopCommandOptions,
  desktopSessionId,
  desktopSessionName,
  extractExecErrorOutput,
  parseCurrentUserSid,
} from './broker';

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

  it('preserves child_process JSON stdout when an agent-desktop command fails', () => {
    const err = Object.assign(new Error('Command failed: agent-desktop.exe session start'), {
      stdout: '{"ok":false,"error":{"code":"INTERNAL","message":"private file DACL grants an untrusted principal"}}',
      stderr: '',
    });
    const extracted = extractExecErrorOutput(err);
    expect(extracted.stdout).toContain('private file DACL grants an untrusted principal');
    expect(extracted.stderr).toContain('Command failed');
  });

  it('parses the Windows user SID from whoami CSV output', () => {
    expect(parseCurrentUserSid('"DESKTOP-0PQNUUF\\admin","S-1-5-21-12345-67890-1001"\r\n')).toBe('S-1-5-21-12345-67890-1001');
    expect(parseCurrentUserSid('')).toBeUndefined();
  });
});
