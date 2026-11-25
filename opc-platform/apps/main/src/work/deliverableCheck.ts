import type { TaskOutputSpec } from '@opc/shared/domain';
import fs from 'node:fs';
import path from 'node:path';
import {
  listWorkspaceFiles,
  normalizeWorkspaceRelPath,
  resolveWithin,
  type WorkspaceFile,
} from './workspace';

export interface DeliverableCheckInput {
  outputs: readonly TaskOutputSpec[];
  workspaceDir: string;
  files: readonly WorkspaceFile[];
  answer: string;
}

export interface DeliverableMapping {
  declared: string;
  actual: string;
  strategy: 'basename' | 'unique-extension';
}

export interface DeliverableCheckResult {
  ok: boolean;
  reason?: string;
  discoveredFiles: WorkspaceFile[];
  mapped: DeliverableMapping[];
  existingFiles: string[];
}

const NON_DELIVERABLE_DIRS = new Set([
  'inputs',
  'work',
  '_work',
  'tmp',
  'temp',
  'browser',
  'node_modules',
  '__pycache__',
]);

const PROBE_FILE_PATTERN = /^(?:test|tiny|tmp|debug|probe|sample)(?:[._-].*|\.[a-z0-9]+)$/i;

const DOCUMENT_OR_MEDIA_EXTS = new Set([
  '.pdf',
  '.docx',
  '.doc',
  '.xlsx',
  '.xls',
  '.pptx',
  '.ppt',
  '.csv',
  '.md',
  '.html',
  '.htm',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.svg',
  '.mp4',
  '.mp3',
  '.wav',
  '.zip',
]);

const BINARY_DELIVERABLE_EXTS = new Set([
  '.pdf',
  '.docx',
  '.doc',
  '.xlsx',
  '.xls',
  '.pptx',
  '.ppt',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.mp4',
  '.mp3',
  '.wav',
  '.zip',
]);

function fileKey(relPath: string): string {
  const normalized = normalizeWorkspaceRelPath(relPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isDeliverableCandidate(file: WorkspaceFile): boolean {
  if (file.bytes <= 0) return false;
  const rel = normalizeWorkspaceRelPath(file.relPath);
  if (!rel) return false;
  const segments = rel.split('/');
  if (segments.some((seg) => seg.startsWith('.'))) return false;
  const firstSegment = segments[0]?.toLowerCase() ?? '';
  if (NON_DELIVERABLE_DIRS.has(firstSegment)) return false;
  const baseName = segments[segments.length - 1] ?? '';
  if (PROBE_FILE_PATTERN.test(baseName)) return false;
  return true;
}

function isInOutputDir(relPath: string): boolean {
  const lower = normalizeWorkspaceRelPath(relPath).toLowerCase();
  return lower.startsWith('output/') || lower.startsWith('outputs/');
}

function isEmptyBinaryFile(relPath: string, bytes: number): boolean {
  const ext = path.posix.extname(relPath).toLowerCase();
  return BINARY_DELIVERABLE_EXTS.has(ext) && bytes === 0;
}

function probeWorkspaceFile(workspaceDir: string, relPath: string): WorkspaceFile | null {
  const normalized = normalizeWorkspaceRelPath(relPath);
  if (!normalized) return null;
  try {
    const abs = resolveWithin(workspaceDir, normalized);
    const stat = fs.statSync(abs, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) return null;
    return { relPath: normalized, absolutePath: abs, bytes: stat.size };
  } catch {
    return null;
  }
}

function pickUniqueCandidate(candidates: WorkspaceFile[]): WorkspaceFile | null {
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    const inOutput = candidates.filter((candidate) => isInOutputDir(candidate.relPath));
    if (inOutput.length === 1) return inOutput[0]!;
  }
  return null;
}

/**
 * Verifies declared task outputs using a two-tier check:
 * 1) Exact normalized POSIX relative path (plus direct `statSync` bypassing any walk limit).
 * 2) Safe fallback matching (`output/` <-> `outputs/`, unique basename, or unique document/media extension).
 */
export function verifyDeclaredOutputs(input: DeliverableCheckInput): DeliverableCheckResult {
  const allByKey = new Map<string, WorkspaceFile>();
  const initialKeys = new Set<string>();
  const discoveredFiles: WorkspaceFile[] = [];
  const mapped: DeliverableMapping[] = [];
  const claimedKeys = new Set<string>();

  const registerFile = (file: WorkspaceFile) => {
    const normalized: WorkspaceFile = {
      ...file,
      relPath: normalizeWorkspaceRelPath(file.relPath),
    };
    const key = fileKey(normalized.relPath);
    if (!allByKey.has(key)) {
      allByKey.set(key, normalized);
      if (!initialKeys.has(key)) {
        discoveredFiles.push(normalized);
      }
    }
    return allByKey.get(key)!;
  };

  for (const file of input.files) {
    const normalized: WorkspaceFile = {
      ...file,
      relPath: normalizeWorkspaceRelPath(file.relPath),
    };
    const key = fileKey(normalized.relPath);
    initialKeys.add(key);
    allByKey.set(key, normalized);
  }

  type FileOutputSpec = Extract<TaskOutputSpec, { kind: 'file' }>;
  const fileOutputs = input.outputs.filter((output): output is FileOutputSpec => output.kind === 'file');
  const unmatched: Array<{ output: FileOutputSpec; declaredRel: string }> = [];
  let emptyBinaryRel: string | null = null;

  // Pass 1: Tier-1 exact path check (bypasses any 50-file listing cap via direct stat).
  for (const output of fileOutputs) {
    const declaredRel = normalizeWorkspaceRelPath(output.path);
    const key = fileKey(declaredRel);
    let found = allByKey.get(key);
    if (!found) {
      const probed = probeWorkspaceFile(input.workspaceDir, declaredRel);
      if (probed) {
        found = registerFile(probed);
      }
    }

    if (found) {
      if (isEmptyBinaryFile(found.relPath, found.bytes)) {
        emptyBinaryRel ??= declaredRel;
        continue;
      }
      claimedKeys.add(fileKey(found.relPath));
      continue;
    }

    unmatched.push({ output, declaredRel });
  }

  // Pass 2: Tier-2 fallback matching for unmatched file outputs.
  const stillMissing: string[] = [];
  if (unmatched.length > 0) {
    if (input.files.length >= 50) {
      try {
        for (const extra of listWorkspaceFiles(input.workspaceDir, 500)) {
          registerFile(extra);
        }
      } catch {
        // Ignore directory walk failures here; Pass 2 falls back to known files.
      }
    }

    const unmatchedExtCounts = new Map<string, number>();
    for (const item of unmatched) {
      const ext = path.posix.extname(item.declaredRel).toLowerCase();
      if (ext) {
        unmatchedExtCounts.set(ext, (unmatchedExtCounts.get(ext) ?? 0) + 1);
      }
    }

    for (const item of unmatched) {
      const { declaredRel } = item;
      const declaredLower = declaredRel.toLowerCase();
      const declaredBase = path.posix.basename(declaredRel).toLowerCase();
      const declaredExt = path.posix.extname(declaredRel).toLowerCase();

      // Priority 0: direct `output/` <-> `outputs/` prefix swap check.
      let matchedFile: WorkspaceFile | null = null;
      let strategy: DeliverableMapping['strategy'] = 'basename';
      const swappedRel = declaredLower.startsWith('outputs/')
        ? `output/${declaredRel.slice('outputs/'.length)}`
        : declaredLower.startsWith('output/')
          ? `outputs/${declaredRel.slice('output/'.length)}`
          : null;

      if (swappedRel) {
        const swappedKey = fileKey(swappedRel);
        let candidate = allByKey.get(swappedKey);
        if (!candidate) {
          const probed = probeWorkspaceFile(input.workspaceDir, swappedRel);
          if (probed) {
            candidate = registerFile(probed);
          }
        }
        if (
          candidate &&
          !claimedKeys.has(fileKey(candidate.relPath)) &&
          !isEmptyBinaryFile(candidate.relPath, candidate.bytes) &&
          candidate.bytes > 0
        ) {
          matchedFile = candidate;
          strategy = 'basename';
        }
      }

      // Priority A: unique deliverable candidate with identical basename.
      if (!matchedFile && (declaredRel.includes('/') || Array.from(allByKey.values()).some((f) => isInOutputDir(f.relPath)))) {
        const basenameCandidates = Array.from(allByKey.values()).filter(
          (candidate) =>
            isDeliverableCandidate(candidate) &&
            !claimedKeys.has(fileKey(candidate.relPath)) &&
            path.posix.basename(candidate.relPath).toLowerCase() === declaredBase,
        );
        const picked = pickUniqueCandidate(basenameCandidates);
        if (picked) {
          matchedFile = picked;
          strategy = 'basename';
        }
      }

      // Priority B: unique deliverable candidate matching a document/media extension.
      if (
        !matchedFile &&
        declaredExt &&
        DOCUMENT_OR_MEDIA_EXTS.has(declaredExt) &&
        (unmatchedExtCounts.get(declaredExt) ?? 0) === 1
      ) {
        const extCandidates = Array.from(allByKey.values()).filter(
          (candidate) =>
            isDeliverableCandidate(candidate) &&
            !claimedKeys.has(fileKey(candidate.relPath)) &&
            path.posix.extname(candidate.relPath).toLowerCase() === declaredExt,
        );
        const picked = pickUniqueCandidate(extCandidates);
        if (picked) {
          matchedFile = picked;
          strategy = 'unique-extension';
        }
      }

      if (matchedFile) {
        claimedKeys.add(fileKey(matchedFile.relPath));
        mapped.push({
          declared: declaredRel,
          actual: matchedFile.relPath,
          strategy,
        });
      } else {
        stillMissing.push(declaredRel);
      }
    }
  }

  const candidateExisting = Array.from(allByKey.values())
    .filter((file) => isDeliverableCandidate(file))
    .map((file) => file.relPath);
  const existingFiles = (
    candidateExisting.length > 0
      ? candidateExisting
      : Array.from(allByKey.values()).map((file) => file.relPath)
  ).slice(0, 10);

  for (const output of input.outputs) {
    if (output.kind === 'text' && !input.answer.trim()) {
      return {
        ok: false,
        reason: `缺少文本回答：${output.description}`,
        discoveredFiles,
        mapped,
        existingFiles,
      };
    }
  }

  if (emptyBinaryRel) {
    return {
      ok: false,
      reason: `文件交付物为空（0 字节）：${emptyBinaryRel}`,
      discoveredFiles,
      mapped,
      existingFiles,
    };
  }

  if (stillMissing.length > 0) {
    const firstMissing = stillMissing[0]!;
    const workspaceHint =
      existingFiles.length > 0
        ? `（当前工作区已有文件：${existingFiles.join('、')}）`
        : '（当前工作区尚无生成文件）';
    return {
      ok: false,
      reason: `缺少文件交付物：${firstMissing}${workspaceHint}`,
      discoveredFiles,
      mapped,
      existingFiles,
    };
  }

  return {
    ok: true,
    discoveredFiles,
    mapped,
    existingFiles,
  };
}
