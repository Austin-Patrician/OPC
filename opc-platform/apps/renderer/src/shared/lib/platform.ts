export type Platform = 'macos' | 'windows' | 'linux' | 'unknown';

/**
 * Pure UA detection. The shell runs on macOS, Windows and Linux, so window
 * chrome, shortcut hints and default font stacks are chosen from this value
 * instead of being hard-coded per platform.
 */
export function detectPlatform(userAgent: string, platformHint = ''): Platform {
  const haystack = `${userAgent} ${platformHint}`.toLowerCase();

  if (/mac|darwin|iphone|ipad/.test(haystack)) return 'macos';
  if (/win/.test(haystack)) return 'windows';
  if (/linux|x11|ubuntu|fedora/.test(haystack)) return 'linux';
  return 'unknown';
}

export function getPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown';
  return detectPlatform(navigator.userAgent, navigator.platform ?? '');
}

/** Primary modifier label for shortcut hints (⌘ on macOS, Ctrl elsewhere). */
export function primaryModifier(platform: Platform): string {
  return platform === 'macos' ? '⌘' : 'Ctrl';
}

export function isMacLike(platform: Platform): boolean {
  return platform === 'macos';
}

/**
 * True inside the desktop shell, where the OS draws the window buttons.
 *
 * Read from the `<html>` dataset that `bootstrap()` sets: the platform UA string
 * alone cannot tell whether the traffic lights are ours or the system's, and the
 * two cases need different title-bar padding.
 */
export function isDesktopShell(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.shell === 'electron';
}
