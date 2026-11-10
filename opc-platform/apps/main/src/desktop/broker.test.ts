import { describe, expect, it } from 'vitest';
import { desktopAppAllowed, desktopClickApprovalCategory, desktopCommandOptions, desktopRequiresApproval, desktopSessionId, desktopSessionName } from './broker';
import type { DesktopSettings } from '@opc/shared/ipc';

const settings: DesktopSettings = {
  enabled: true,
  allowedApps: [
    { id: 'com.apple.TextEdit', label: 'TextEdit', platform: 'darwin', enabled: true, source: 'user' },
    { id: 'notepad.exe', label: 'Notepad', platform: 'win32', enabled: true, source: 'user' },
    { id: 'disabled-app', label: 'Disabled', platform: 'darwin', enabled: false, source: 'user' },
  ],
  requireApprovalFor: ['external-submit'],
  maxOutputBytes: 64_000,
};

describe('desktop policy', () => {
  it('matches enabled app ids and labels on the current platform', () => {
    const current = process.platform === 'darwin' ? settings : { ...settings, allowedApps: [settings.allowedApps[1]!] };
    expect(desktopAppAllowed(current, process.platform === 'darwin' ? 'com.apple.TextEdit' : 'notepad.exe')).toBe(true);
    expect(desktopAppAllowed(current, 'disabled-app')).toBe(false);
    expect(desktopAppAllowed(current, 'unlisted')).toBe(false);
    expect(desktopAppAllowed({ ...current, allowedApps: [...current.allowedApps, { id: 'Terminal', label: 'Terminal', platform: process.platform, enabled: true, source: 'user' }] }, 'Terminal')).toBe(false);
  });

  it('checks approval requirements against the configured categories', () => {
    expect(desktopRequiresApproval(settings, 'external-submit')).toBe(true);
    expect(desktopRequiresApproval(settings, 'physical-input')).toBe(false);
  });

  it('separates destructive clicks from other consequential clicks', () => {
    expect(desktopClickApprovalCategory('Send message')).toBe('external-submit');
    expect(desktopClickApprovalCategory('Delete item')).toBe('destructive');
    expect(desktopClickApprovalCategory('Open menu')).toBeUndefined();
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
