import {
  MAX_CHAT_ATTACHMENT_BYTES,
  type ChatAttachmentRef,
} from '@opc/shared/domain';
import fs from 'node:fs';
import path from 'node:path';

export const WORKSPACE_INPUTS_DIR = 'inputs';

export interface StagedAttachmentsResult {
  staged: ChatAttachmentRef[];
  missing: Array<{ name: string; path: string; reason: string }>;
}

function sanitizeInputFilename(rawName: string): string {
  const withoutControls = [...path.basename(rawName || 'attachment')]
    .map((ch) => (ch.charCodeAt(0) < 32 ? '_' : ch))
    .join('');
  const base = withoutControls
    // Strip path/invalid Windows filename characters while preserving Unicode (e.g. CJK).
    .replaceAll(/[<>:"/\\|?*]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  return base || 'attachment';
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithinDir(dir: string, target: string): boolean {
  const root = comparablePath(dir);
  const candidate = comparablePath(target);
  if (candidate === root) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate.startsWith(prefix);
}

/**
 * Copies authorized task attachments into `<workspaceDir>/inputs/` so workers
 * operate solely on workspace-local copies without external path exceptions or
 * risk to the user's original files.
 */
export function stageAttachmentsToWorkspace(
  workspaceDir: string,
  attachments: readonly ChatAttachmentRef[],
): StagedAttachmentsResult {
  if (attachments.length === 0) return { staged: [], missing: [] };

  const workspaceRoot = path.resolve(workspaceDir);
  const inputsDir = path.join(workspaceRoot, WORKSPACE_INPUTS_DIR);
  const staged: ChatAttachmentRef[] = [];
  const missing: Array<{ name: string; path: string; reason: string }> = [];
  const usedRelPaths = new Set<string>();

  for (const attachment of attachments) {
    const rawPath = attachment.path?.trim();
    if (!rawPath) {
      missing.push({ name: attachment.name || 'attachment', path: '', reason: '附件路径为空' });
      continue;
    }

    const sourcePath = path.resolve(rawPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(sourcePath);
    } catch {
      missing.push({ name: attachment.name || path.basename(sourcePath), path: rawPath, reason: '文件不存在或无法访问' });
      continue;
    }

    if (!stat.isFile()) {
      missing.push({ name: attachment.name || path.basename(sourcePath), path: rawPath, reason: '附件不是普通文件' });
      continue;
    }
    if (stat.size > MAX_CHAT_ATTACHMENT_BYTES) {
      missing.push({ name: attachment.name || path.basename(sourcePath), path: rawPath, reason: '单个附件超过 100MB 上限' });
      continue;
    }

    fs.mkdirSync(inputsDir, { recursive: true });

    if (isWithinDir(inputsDir, sourcePath)) {
      const existingRel = path.relative(workspaceRoot, sourcePath).replaceAll('\\', '/');
      if (!usedRelPaths.has(existingRel.toLowerCase())) {
        usedRelPaths.add(existingRel.toLowerCase());
        staged.push({
          ...attachment,
          path: sourcePath,
          size: stat.size,
          availability: 'available',
        });
        continue;
      }
    }

    const sanitized = sanitizeInputFilename(attachment.name || path.basename(sourcePath));
    const ext = path.extname(sanitized);
    const stem = ext ? sanitized.slice(0, -ext.length) : sanitized;
    let candidateName = sanitized;
    let suffix = 2;

    while (true) {
      const relKey = `${WORKSPACE_INPUTS_DIR}/${candidateName}`.toLowerCase();
      if (!usedRelPaths.has(relKey)) {
        const destPath = path.join(inputsDir, candidateName);
        if (!fs.existsSync(destPath)) {
          fs.copyFileSync(sourcePath, destPath);
          usedRelPaths.add(relKey);
          staged.push({
            ...attachment,
            name: candidateName,
            path: destPath,
            size: stat.size,
            availability: 'available',
          });
          break;
        }
        try {
          const destStat = fs.statSync(destPath);
          if (destStat.isFile() && destStat.size === stat.size) {
            usedRelPaths.add(relKey);
            staged.push({
              ...attachment,
              name: candidateName,
              path: destPath,
              size: stat.size,
              availability: 'available',
            });
            break;
          }
        } catch {
          // Probe failure falls through to next suffix.
        }
      }
      candidateName = `${stem}-${suffix}${ext}`;
      suffix += 1;
    }
  }

  return { staged, missing };
}

/**
 * Filesystem guard for agent work.
 *
 * Every read/write goes through `resolveWithin`, so a path that escapes the
 * workspace (`../..`, absolute paths, symlinks pointing out) is rejected instead
 * of silently written. This is the first line of defence until per-employee
 * containers land.
 */
export function resolveWithin(rootDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`拒绝绝对路径: ${relativePath}`);
  }

  const root = path.resolve(rootDir);
  const target = path.resolve(root, relativePath);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;

  if (target !== root && !target.startsWith(prefix)) {
    throw new Error(`路径越界: ${relativePath}`);
  }
  return target;
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes a UTF-8 file inside `rootDir`, creating parent folders as needed. */
export function writeFileWithin(rootDir: string, relativePath: string, content: string): string {
  const target = resolveWithin(rootDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

export interface WorkspaceFile {
  relPath: string;
  absolutePath: string;
  bytes: number;
}

/** Normalizes workspace-relative paths to POSIX `/` separators without leading `./` or `/`. */
export function normalizeWorkspaceRelPath(relPath: string): string {
  const posix = relPath.trim().replaceAll('\\', '/').replace(/\/+/g, '/');
  return posix.replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

const IGNORED = new Set(['.git', 'node_modules', '.DS_Store']);

/** Flat list of regular files in a workspace (bounded, so a runaway agent cannot flood). */
export function listWorkspaceFiles(rootDir: string, limit = 50): WorkspaceFile[] {
  const results: WorkspaceFile[] = [];

  const root = path.resolve(rootDir);
  const walk = (dir: string) => {
    if (results.length >= limit) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= limit) return;
      if (IGNORED.has(entry.name)) continue;
      // Top-level `inputs/` holds staged user attachments, never generated deliverables.
      if (dir === root && entry.isDirectory() && entry.name === WORKSPACE_INPUTS_DIR) continue;

      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const stat = fs.statSync(absolutePath);
      results.push({
        relPath: normalizeWorkspaceRelPath(path.relative(root, absolutePath)),
        absolutePath,
        bytes: stat.size,
      });
    }
  };

  walk(root);
  return results;
}
