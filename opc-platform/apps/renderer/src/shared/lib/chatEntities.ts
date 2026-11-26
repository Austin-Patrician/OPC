export interface UrlEntityMeta {
  type: 'url';
  raw: string;
  href: string;
  domain: string;
  displayPath: string;
}

export interface EmailEntityMeta {
  type: 'email';
  raw: string;
  email: string;
  href: string;
}

export interface FilePathEntityMeta {
  type: 'file';
  raw: string;
  path: string;
  fileName: string;
  ext?: string;
  line?: number;
  col?: number;
  isAbsolute: boolean;
  isDirectory: boolean;
  fromFileUrl: boolean;
}

export type InlineEntityMeta = UrlEntityMeta | EmailEntityMeta | FilePathEntityMeta;

export type ProseEntitySegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; value: string }
  | { type: 'link'; value: string; href: string; entity: UrlEntityMeta }
  | { type: 'email'; value: string; email: string; href: string }
  | { type: 'file'; value: string; file: FilePathEntityMeta };

const EMAIL_EXACT_RE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

const POSIX_ROOT_PREFIX_RE =
  /^\/(?:Users|home|tmp|var|opt|etc|Applications|Volumes|mnt|srv|root|private|System|Library|workspace)\/[^\s]+/;

const POSIX_DEEP_PATH_RE =
  /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._@-]+)+(?::\d+(?::\d+)?)?$/;

const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/][^\s<>"'|?*]/;
const HOME_TILDE_RE = /^~[\\/][^\s<>"'|?*]/;
const EXPLICIT_REL_RE = /^\.{1,2}[\\/][^\s<>"'|?*]/;

const MIME_OR_VENDOR_PREFIX_RE =
  /^(?:application|text|image|audio|video|font|multipart|message|model)\//i;

const SCOPED_PACKAGE_ONLY_RE = /^@[a-z0-9._-]+\/[a-z0-9._-]+$/i;

const TRAIL_PUNCT_CHAR_RE = /[.,;:!?，。；：！？、】」』》”’"']/;

export function isValidEmail(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 254 || /\s/.test(trimmed)) return false;
  return EMAIL_EXACT_RE.test(trimmed);
}

export function extractEmailFromMailto(href: string): string | null {
  if (!/^mailto:/i.test(href)) return null;
  const rawAddress = href.slice('mailto:'.length).split(/[?#]/)[0]?.trim() ?? '';
  if (!rawAddress) return null;
  let decoded = rawAddress;
  try {
    decoded = decodeURIComponent(rawAddress);
  } catch {
    // Keep raw if malformed percent-encoding.
  }
  return isValidEmail(decoded) ? decoded : null;
}

export function normalizeExternalUrl(raw: string): UrlEntityMeta | null {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    return null;
  }
  const domain = parsed.hostname.replace(/^www\./i, '');
  const pathPart = `${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`;
  const displayPath =
    pathPart.length > 34 ? `${pathPart.slice(0, 31)}…` : pathPart;
  return {
    type: 'url',
    raw: trimmed,
    href: parsed.href,
    domain,
    displayPath,
  };
}

function splitPathAndLineCol(value: string): {
  basePath: string;
  line?: number;
  col?: number;
} {
  const match = /^(.+?):(\d+)(?::(\d+))?$/.exec(value);
  if (!match?.[1]) return { basePath: value };
  const base = match[1];
  // Never strip `C:` drive prefix or `dir/:12`.
  if (base.length <= 2 || base.endsWith('/') || base.endsWith('\\')) {
    return { basePath: value };
  }
  const line = Number(match[2]);
  const col = match[3] ? Number(match[3]) : undefined;
  return {
    basePath: base,
    line: Number.isFinite(line) ? line : undefined,
    col: col !== undefined && Number.isFinite(col) ? col : undefined,
  };
}

function decodeFileUrl(raw: string): { fsPath: string; ok: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { fsPath: '', ok: false };
  }
  if (parsed.protocol !== 'file:') return { fsPath: '', ok: false };
  if (parsed.hostname && parsed.hostname.toLowerCase() !== 'localhost') {
    return { fsPath: '', ok: false };
  }
  let pathname = parsed.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return { fsPath: '', ok: false };
  }
  // Convert `/C:/foo/bar` to Windows `C:/foo/bar` cleanly without Node `url`.
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) {
    pathname = pathname.slice(1);
  }
  if (!pathname) return { fsPath: '', ok: false };
  return { fsPath: pathname, ok: true };
}

function extractFileNameAndExt(targetPath: string, isDirectory: boolean): {
  fileName: string;
  ext?: string;
} {
  const clean = targetPath.replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? clean;
  if (isDirectory) return { fileName: last || targetPath };
  const dot = last.lastIndexOf('.');
  const ext = dot > 0 && dot < last.length - 1 ? last.slice(dot + 1) : undefined;
  return { fileName: last || targetPath, ext };
}

/**
 * Classifies strings representing `file://` URIs, Windows/POSIX absolute paths, `~/` home paths,
 * or explicit project/relative file paths while filtering out MIME types, URLs, and JS dots.
 */
export function parseFilePathEntity(rawInput: string): FilePathEntityMeta | null {
  const trimmed = rawInput.trim();
  if (!trimmed || trimmed.length > 512 || /[\r\n\0]/.test(trimmed)) return null;
  if (/^(?:https?|mailto|javascript|data|vbscript):/i.test(trimmed)) return null;

  if (/^file:\/\//i.test(trimmed)) {
    const decoded = decodeFileUrl(trimmed);
    if (!decoded.ok) return null;
    const { basePath, line, col } = splitPathAndLineCol(decoded.fsPath);
    const isDirectory = /[\\/]$/.test(basePath);
    const { fileName, ext } = extractFileNameAndExt(basePath, isDirectory);
    return {
      type: 'file',
      raw: trimmed,
      path: basePath,
      fileName,
      ...(ext ? { ext } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(col !== undefined ? { col } : {}),
      isAbsolute: true,
      isDirectory,
      fromFileUrl: true,
    };
  }

  // Reject UNC network paths, comments `//...`, MIME types, scoped npm names, numeric ratios.
  if (
    trimmed.startsWith('\\\\') ||
    trimmed.startsWith('//') ||
    MIME_OR_VENDOR_PREFIX_RE.test(trimmed) ||
    SCOPED_PACKAGE_ONLY_RE.test(trimmed) ||
    /^\d+(?:\/\d+)+$/.test(trimmed)
  ) {
    return null;
  }

  const { basePath, line, col } = splitPathAndLineCol(trimmed);
  const isWindowsAbs = WINDOWS_ABS_RE.test(basePath);
  const isHomePath = HOME_TILDE_RE.test(basePath);
  const isPosixAbs =
    POSIX_ROOT_PREFIX_RE.test(basePath) || POSIX_DEEP_PATH_RE.test(basePath);
  const isExplicitRel = EXPLICIT_REL_RE.test(basePath);

  const hasSeparator = basePath.includes('/') || basePath.includes('\\');
  const hasFileExt = /\.[A-Za-z0-9]{1,8}$/.test(basePath);
  const endsWithSlash = /[\\/]$/.test(basePath);
  const isWorkspaceSubpath =
    hasSeparator &&
    !/\s/.test(basePath) &&
    !basePath.startsWith('<') &&
    (hasFileExt || (endsWithSlash && !basePath.startsWith('</')));

  if (!isWindowsAbs && !isHomePath && !isPosixAbs && !isExplicitRel && !isWorkspaceSubpath) {
    return null;
  }

  const isAbsolute = isWindowsAbs || isHomePath || isPosixAbs;
  const isDirectory = endsWithSlash;
  const { fileName, ext } = extractFileNameAndExt(basePath, isDirectory);

  return {
    type: 'file',
    raw: trimmed,
    path: basePath,
    fileName,
    ...(ext ? { ext } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(col !== undefined ? { col } : {}),
    isAbsolute,
    isDirectory,
    fromFileUrl: false,
  };
}

/** Classifies single-line inline code content as Email, URL, or File Path when applicable. */
export function classifyInlineEntity(raw: string): InlineEntityMeta | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('\n')) return null;
  if (isValidEmail(trimmed)) {
    return {
      type: 'email',
      raw: trimmed,
      email: trimmed,
      href: `mailto:${trimmed}`,
    };
  }
  const urlMeta = normalizeExternalUrl(trimmed);
  if (urlMeta) return urlMeta;
  return parseFilePathEntity(trimmed);
}

function trimBalancedUrlSuffix(rawUrl: string): { url: string; trailing: string } {
  let end = rawUrl.length;
  while (end > 0) {
    const ch = rawUrl[end - 1]!;
    if (TRAIL_PUNCT_CHAR_RE.test(ch)) {
      end -= 1;
      continue;
    }
    if (ch === ')' || ch === ']') {
      const open = ch === ')' ? '(' : '[';
      let balance = 0;
      for (let i = 0; i < end; i += 1) {
        if (rawUrl[i] === open) balance += 1;
        else if (rawUrl[i] === ch) balance -= 1;
      }
      if (balance < 0) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return {
    url: rawUrl.slice(0, end),
    trailing: rawUrl.slice(end),
  };
}

function trimTrailingSentencePunct(rawToken: string): { value: string; trailing: string } {
  let end = rawToken.length;
  while (end > 0 && /[.,;:!?，。；：！？、）)】」』》”’"']/.test(rawToken[end - 1]!)) {
    end -= 1;
  }
  return {
    value: rawToken.slice(0, end),
    trailing: rawToken.slice(end),
  };
}

const PROSE_TOKEN_RE = new RegExp(
  [
    // 1. http(s)://, file:///, or mailto: URLs (stop before fullwidth CJK punctuation)
    String.raw`((?:https?:\/\/|file:\/\/\/|mailto:)[^\s<>"'` + '`' + String.raw`，。；：！？、（）【】「」『』《》“”‘’]+)`,
    // 2. Standalone emails (boundary ensures `foo@bar.com` is NOT mistaken for `@bar.com`)
    String.raw`(?<![A-Za-z0-9._%+-])([A-Za-z0-9.!#$%&'*+/=?^_` + '`' + String.raw`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})`,
    // 3. Windows drive paths (`C:\foo\bar.ts` / `D:/dir/file`)
    String.raw`([A-Za-z]:[\\/][^\s<>"'|?*，。；：！？、（）()【】「」『』]+)`,
    // 4. Home-relative `~/...` or well-known POSIX root paths
    String.raw`((?:~|\/(?:Users|home|tmp|var|opt|etc|Applications|Volumes|mnt|srv|root|private|System|Library|workspace))\/[^\s<>"'|?*，。；：！？、（）()【】「」『』]+)`,
    // 5. Explicit `./...` or `../...` relative paths with file extension or trailing slash
    String.raw`(\.{1,2}[\\/][^\s<>"'|?*，。；：！？、（）()【】「」『』]+(?:\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?|\/))`,
    // 6. Chat @mentions (cannot follow word/email identifier chars)
    String.raw`(?<![A-Za-z0-9._%+-])(@[^\s@]+)`,
  ].join('|'),
  'g',
);

/**
 * Splits plain text into prose, @mentions, emails, URLs, and file paths without HTML injection.
 * Trailing punctuation is stripped cleanly and emails never mis-tokenize as @mentions.
 */
export function tokenizeProseEntities(
  input: string,
  options: { enableMentions?: boolean } = {},
): ProseEntitySegment[] {
  if (!input) return [];
  const enableMentions = options.enableMentions ?? true;
  const segments: ProseEntitySegment[] = [];
  let lastIndex = 0;

  const pushText = (value: string) => {
    if (!value) return;
    const prev = segments[segments.length - 1];
    if (prev && prev.type === 'text') {
      prev.value += value;
    } else {
      segments.push({ type: 'text', value });
    }
  };

  for (const match of input.matchAll(PROSE_TOKEN_RE)) {
    const [raw, urlToken, emailToken, winPath, posixPath, relPath, mentionToken] = match;
    const index = match.index ?? 0;

    if (index > lastIndex) {
      pushText(input.slice(lastIndex, index));
    }

    if (urlToken) {
      const { url, trailing } = trimBalancedUrlSuffix(urlToken);
      if (/^mailto:/i.test(url)) {
        const email = extractEmailFromMailto(url);
        if (email) {
          segments.push({ type: 'email', value: url, email, href: `mailto:${email}` });
        } else {
          pushText(url);
        }
      } else if (/^file:\/\//i.test(url)) {
        const file = parseFilePathEntity(url);
        if (file) {
          segments.push({ type: 'file', value: url, file });
        } else {
          pushText(url);
        }
      } else {
        const meta = normalizeExternalUrl(url);
        if (meta) {
          segments.push({ type: 'link', value: url, href: meta.href, entity: meta });
        } else {
          pushText(url);
        }
      }
      pushText(trailing);
    } else if (emailToken) {
      segments.push({
        type: 'email',
        value: emailToken,
        email: emailToken,
        href: `mailto:${emailToken}`,
      });
    } else if (winPath || posixPath || relPath) {
      const rawPath = (winPath ?? posixPath ?? relPath)!;
      const { value, trailing } = trimTrailingSentencePunct(rawPath);
      const file = parseFilePathEntity(value);
      if (file) {
        segments.push({ type: 'file', value, file });
      } else {
        pushText(value);
      }
      pushText(trailing);
    } else if (mentionToken) {
      if (enableMentions) {
        const { value, trailing } = trimTrailingSentencePunct(mentionToken);
        if (value.length > 1) {
          segments.push({ type: 'mention', value });
        } else {
          pushText(value);
        }
        pushText(trailing);
      } else {
        pushText(mentionToken);
      }
    } else {
      pushText(raw);
    }

    lastIndex = index + raw.length;
  }

  if (lastIndex < input.length) {
    pushText(input.slice(lastIndex));
  }

  return segments;
}
