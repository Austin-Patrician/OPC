import fs from 'node:fs';
import path from 'node:path';

/**
 * Disk discovery for agent skills (`SKILL.md` folders).
 *
 * A skill is a folder with a `SKILL.md`: YAML frontmatter (`name`,
 * `description`, optional `license` / `compatibility`) plus a Markdown body of
 * instructions, and usually some `scripts/` and `references/` next to it.
 *
 * Unlike a Pi extension, a skill is **data**: reading it cannot run anything.
 * That is why this module parses the file eagerly while `extensions/scanner.ts`
 * refuses to import anything it finds. The only execution a skill causes is the
 * agent deciding to run a script it was told about, and that goes through the
 * normal `bash` tool and its sandbox.
 *
 * Layout: `<root>/<name>/SKILL.md`, one level deep, scanning only OPC's
 * curated built-in roots (`resources/skills` and `<userData>/skills-managed`).
 */

const SKILL_FILE = 'SKILL.md';
const MAX_FILES = 200;
const MAX_DEPTH = 4;

export type SkillScope = 'bundled' | 'managed' | 'global' | 'project';
export type SkillCategory = 'office' | 'creative';

export interface ScannedSkill {
  /** Absolute path of the SKILL.md, POSIX-normalized: stable across scans. */
  id: string;
  name: string;
  title?: string;
  summary?: string;
  category?: SkillCategory;
  description: string;
  scope: SkillScope;
  /** Folder that owns the skill; its scripts/references live here. */
  dir: string;
  /** Absolute path of the SKILL.md itself. */
  file: string;
  /** Bundled files relative to `dir`, POSIX separators, capped. */
  files: string[];
  /** The Markdown body after the frontmatter. */
  body: string;
  /** Newest mtime of the file and its folder; drives cache invalidation. */
  mtime: number;
}

export interface ScanSkillsOptions {
  /** Legacy unused external roots kept optional for test/caller compatibility. */
  homeDir?: string;
  projectDir?: string;
  /** App-bundled zero-dependency skills directory (`resources/skills`). */
  bundledDir?: string;
  /** App-managed skills directory (`<userData>/skills-managed`). */
  managedDir?: string;
  readDir?: (dir: string) => fs.Dirent[];
  readText?: (file: string) => string | undefined;
  stat?: (target: string) => { isFile(): boolean; isDirectory(): boolean; mtimeMs: number } | undefined;
}

export interface ScanSkillsResult {
  roots: string[];
  entries: ScannedSkill[];
}

const toPosix = (value: string) => value.replace(/\\/g, '/');

/**
 * Resolves the bundled `resources/skills` directory in both dev and packaged builds.
 */
export function resolveBundledSkillsDir(input: {
  packaged: boolean;
  appPath: string;
  resourcesPath: string;
}): string {
  if (input.packaged) return path.join(input.resourcesPath, 'skills');
  const candidate = path.join(input.appPath, 'resources', 'skills');
  if (fs.existsSync(candidate)) return candidate;
  return path.join(process.cwd(), 'resources', 'skills');
}

export function skillRoots(
  _homeDir?: string,
  _projectDir?: string,
  managedDir?: string,
  bundledDir?: string,
): { scope: SkillScope; dir: string }[] {
  return [
    ...(bundledDir ? [{ scope: 'bundled' as const, dir: bundledDir }] : []),
    ...(managedDir ? [{ scope: 'managed' as const, dir: managedDir }] : []),
  ];
}

export function scanSkills(options: ScanSkillsOptions): ScanSkillsResult {
  const io = {
    readDir: options.readDir ?? defaultReadDir,
    readText: options.readText ?? defaultReadText,
    stat: options.stat ?? defaultStat,
  };
  const roots = skillRoots(options.homeDir, options.projectDir, options.managedDir, options.bundledDir);

  // Keyed by name so a managed skill overrides a bundled skill of the same name.
  const byName = new Map<string, ScannedSkill>();

  for (const root of roots) {
    for (const dirent of io.readDir(root.dir)) {
      if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue;
      const dir = path.join(root.dir, dirent.name);
      const skill = describe(dir, root.scope, io);
      if (skill) byName.set(skill.name, skill);
    }
  }

  return {
    roots: roots.map((root) => root.dir),
    entries: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function describe(
  dir: string,
  scope: SkillScope,
  io: Required<Pick<ScanSkillsOptions, 'readDir' | 'readText' | 'stat'>>,
): ScannedSkill | undefined {
  const info = io.stat(dir);
  if (!info?.isDirectory()) return undefined;

  const file = path.join(dir, SKILL_FILE);
  const fileInfo = io.stat(file);
  if (!fileInfo?.isFile()) return undefined;

  const raw = io.readText(file);
  if (raw === undefined) return undefined;

  const { frontmatter, body } = splitFrontmatter(raw);
  const name = (frontmatter.name ?? path.basename(dir)).trim() || path.basename(dir);
  const title = frontmatter.title?.trim() || undefined;
  const summary = frontmatter.summary?.trim() || undefined;
  const rawCategory = frontmatter.category?.trim();
  const category: SkillCategory =
    rawCategory === 'office' || rawCategory === 'creative'
      ? rawCategory
      : scope === 'managed'
        ? 'office'
        : 'creative';
  const description = (frontmatter.description ?? firstParagraph(body)).trim();

  return {
    id: toPosix(file),
    name,
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    category,
    description,
    scope,
    dir,
    file,
    files: listFiles(dir, io),
    body,
    mtime: Math.max(fileInfo.mtimeMs, info.mtimeMs),
  };
}

/**
 * Splits `---\nkey: value\n---\nbody` without pulling in a YAML parser.
 *
 * Only the keys a skill header actually uses are read; anything else is ignored
 * rather than validated, because a skill that fails to parse should still be
 * usable — the worst case is a missing description, not a broken app.
 */
export function splitFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const normalized = raw.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(normalized);
  if (!match) return { frontmatter: {}, body: normalized.trim() };

  const frontmatter: Record<string, string> = {};
  const lines = match[1]!.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const entry = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!entry) continue;
    const [, key, rawValue] = entry as unknown as [string, string, string];

    // `description: >` and `description: |` fold the following indented lines.
    if (/^[>|][-+]?$/.test(rawValue.trim())) {
      const block: string[] = [];
      while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1]!) || lines[index + 1] === '')) {
        index += 1;
        block.push(lines[index]!.trim());
      }
      frontmatter[key] = block.join(' ').trim();
      continue;
    }

    frontmatter[key] = unquote(rawValue.trim());
  }

  return { frontmatter, body: normalized.slice(match[0].length).trim() };
}

const unquote = (value: string) => {
  const quote = value[0];
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
};

/** A skill without frontmatter still deserves a description: its first sentence. */
function firstParagraph(body: string): string {
  const paragraph = body
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .find((block) => block.length > 0 && !block.startsWith('#') && !block.startsWith('```'));
  if (!paragraph) return '';
  const sentence = /^(.*?[.。!?！？])(\s|$)/.exec(paragraph.replace(/\s+/g, ' '));
  return (sentence?.[1] ?? paragraph.replace(/\s+/g, ' ')).slice(0, 400);
}

function listFiles(
  dir: string,
  io: Required<Pick<ScanSkillsOptions, 'readDir' | 'readText' | 'stat'>>,
): string[] {
  const found: string[] = [];
  const walk = (current: string, depth: number) => {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
    for (const dirent of io.readDir(current)) {
      if (found.length >= MAX_FILES) return;
      if (dirent.name === 'node_modules' || dirent.name === '.git' || dirent.name === '__pycache__') continue;
      const target = path.join(current, dirent.name);
      const info = io.stat(target);
      if (!info) continue;
      const relative = toPosix(path.relative(dir, target));
      if (info.isDirectory()) {
        // Summarize huge icon libraries (`templates/icons/<pack>/`) instead of
        // exhausting `MAX_FILES` with 12,000 individual `.svg` entries.
        if (relative.startsWith('templates/icons/') && relative.split('/').length === 3) {
          found.push(`${relative}/`);
          continue;
        }
        walk(target, depth + 1);
        continue;
      }
      if (relative === SKILL_FILE) continue;
      found.push(relative);
    }
  };
  walk(dir, 0);
  return found.sort();
}

function defaultReadDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function defaultReadText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function defaultStat(target: string) {
  try {
    return fs.statSync(target);
  } catch {
    return undefined;
  }
}
