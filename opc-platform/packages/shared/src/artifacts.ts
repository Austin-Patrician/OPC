import type { TaskOutputSpec } from './domain';

export interface PartitionedArtifacts<T> {
  deliverables: T[];
  intermediate: T[];
}

const INTERMEDIATE_TOP_DIRS = new Set([
  'inputs',
  'work',
  '_work',
  'tmp',
  'temp',
  'browser',
  'node_modules',
  '__pycache__',
  '.git',
  '.venv',
  'venv',
  '.cache',
]);

const PROBE_FILE_PATTERN = /^(?:test|tiny|tmp|debug|probe|sample)(?:[._-].*|\.[a-z0-9]+)$/i;

function normalizeRelPath(relPath: string): string {
  return relPath
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/+/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function baseNameOf(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash >= 0 ? relPath.slice(slash + 1) : relPath;
}

function isInOutputDir(lowerRel: string): boolean {
  return lowerRel.startsWith('output/') || lowerRel.startsWith('outputs/');
}

function isHiddenRel(relPath: string): boolean {
  return relPath.split('/').some((seg) => seg.startsWith('.'));
}

function isIntermediatePath(relPath: string): boolean {
  if (!relPath) return true;
  if (isHiddenRel(relPath)) return true;
  const slash = relPath.indexOf('/');
  const firstSeg = (slash >= 0 ? relPath.slice(0, slash) : relPath).toLowerCase();
  if (INTERMEDIATE_TOP_DIRS.has(firstSeg)) return true;
  const base = baseNameOf(relPath);
  return PROBE_FILE_PATTERN.test(base);
}

/**
 * Separates final deliverable artifacts (`output/`, `outputs/`, or explicitly declared
 * contract outputs; falling back to non-intermediate files when neither exists) from
 * intermediate workspace files (`work/`, `_work/`, `tmp/`, `browser/`, temp probes).
 */
export function partitionTaskArtifacts<T extends { relPath: string }>(
  artifacts: readonly T[],
  declaredOutputs?: readonly TaskOutputSpec[],
): PartitionedArtifacts<T> {
  const declaredExactSet = new Set<string>();
  const declaredSwappedSet = new Set<string>();
  const declaredBaseNames = new Set<string>();

  for (const output of declaredOutputs ?? []) {
    if (output.kind !== 'file') continue;
    const norm = normalizeRelPath(output.path);
    if (!norm) continue;
    const lower = norm.toLowerCase();
    declaredExactSet.add(lower);
    if (lower.startsWith('outputs/')) {
      declaredSwappedSet.add(`output/${lower.slice('outputs/'.length)}`);
    } else if (lower.startsWith('output/')) {
      declaredSwappedSet.add(`outputs/${lower.slice('output/'.length)}`);
    }
    const base = baseNameOf(lower);
    if (base) declaredBaseNames.add(base);
  }

  const matchedDeliverables: T[] = [];
  const unmatched: T[] = [];

  for (const artifact of artifacts) {
    const rel = normalizeRelPath(artifact.relPath);
    const lower = rel.toLowerCase();
    const baseLower = baseNameOf(lower);

    const isPrimary =
      declaredExactSet.has(lower) ||
      declaredSwappedSet.has(lower) ||
      (isInOutputDir(lower) && !isHiddenRel(rel) && !PROBE_FILE_PATTERN.test(baseLower)) ||
      (!isIntermediatePath(rel) && declaredBaseNames.has(baseLower));

    if (isPrimary) {
      matchedDeliverables.push(artifact);
    } else {
      unmatched.push(artifact);
    }
  }

  if (matchedDeliverables.length > 0) {
    return { deliverables: matchedDeliverables, intermediate: unmatched };
  }

  const deliverables: T[] = [];
  const intermediate: T[] = [];
  for (const artifact of artifacts) {
    const rel = normalizeRelPath(artifact.relPath);
    if (isIntermediatePath(rel)) {
      intermediate.push(artifact);
    } else {
      deliverables.push(artifact);
    }
  }
  return { deliverables, intermediate };
}
