import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The first real Trigger source: a folder the boss drops files into.
 *
 * Chosen because it needs no credentials, works offline, and produces the moment
 * the whole product is about — something arrived and nobody asked. Calendar and
 * GitHub can follow the same shape once this one is trusted.
 *
 * The watcher is deliberately dumb: it reports *files that appeared or changed*.
 * Deciding whether that is worth a thread is the router's job (the program layer
 * and the semantic layer), not the watcher's.
 */

export interface FileSnapshot {
  relPath: string;
  size: number;
  mtimeMs: number;
}

export type FolderSnapshot = Record<string, FileSnapshot>;

/** What a scan found that the previous scan did not. */
export interface FolderDelta {
  added: FileSnapshot[];
  changed: FileSnapshot[];
}

/**
 * Names a file manager, an editor or the OS leaves behind.
 *
 * Without this the watcher would fire on `~$report.docx`, `.DS_Store` and partial
 * downloads, which is exactly the noise the two-level filter exists to remove —
 * cheaper to never create the event than to classify it later.
 */
const NOISE = [/^\./, /^~\$/, /\.(tmp|part|crdownload|download|swp)$/i, /^Thumbs\.db$/i];

/** A file that is still being written reports size 0 with a fresh mtime. */
const SETTLE_MS = 1_000;

export function isNoise(relPath: string): boolean {
  const name = path.basename(relPath);
  return NOISE.some((pattern) => pattern.test(name));
}

/** Reads one level deep: the inbox is a tray, not a tree. */
export function scanFolder(dir: string, now = Date.now()): FolderSnapshot {
  const snapshot: FolderSnapshot = {};
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return snapshot;
  }

  for (const name of entries) {
    const relPath = name;
    if (isNoise(relPath)) continue;
    const absolute = path.join(dir, name);
    try {
      const stat = statSync(absolute);
      if (!stat.isFile()) continue;
      // Not settled yet: it will be picked up on a later scan, unchanged.
      if (now - stat.mtimeMs < SETTLE_MS) continue;
      snapshot[relPath] = { relPath, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      // Vanished between readdir and stat: it will show up as removed.
    }
  }
  return snapshot;
}

/** Added or re-written files. Removals are ignored: nothing to work on. */
export function diffSnapshot(previous: FolderSnapshot, next: FolderSnapshot): FolderDelta {
  const delta: FolderDelta = { added: [], changed: [] };
  for (const [relPath, entry] of Object.entries(next)) {
    const before = previous[relPath];
    if (!before) {
      delta.added.push(entry);
    } else if (before.mtimeMs !== entry.mtimeMs || before.size !== entry.size) {
      delta.changed.push(entry);
    }
  }
  return delta;
}

export interface FolderWatcherDeps {
  dir: string;
  /** Called once per added/changed file, in scan order. */
  onFile: (file: FileSnapshot) => void;
  intervalMs?: number;
  /** Injected so a test can drive scans instead of waiting. */
  scan?: (dir: string) => FolderSnapshot;
}

/**
 * Polling, not `fs.watch`.
 *
 * `fs.watch` on macOS coalesces and renames, and a single save can produce three
 * events; polling compares snapshots instead, so one save is one event no matter
 * how the editor writes it. At one scan per interval over a tray-sized folder the
 * cost is a couple of `stat` calls — cheaper than the de-duplication `fs.watch`
 * would need.
 */
export class FolderWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshot: FolderSnapshot = {};
  private readonly scan: (dir: string) => FolderSnapshot;
  private readonly intervalMs: number;
  /** The first scan seeds the snapshot: existing files are not "new". */
  private primed = false;

  constructor(private readonly deps: FolderWatcherDeps) {
    this.scan = deps.scan ?? ((dir) => scanFolder(dir));
    this.intervalMs = deps.intervalMs ?? 15_000;
  }

  start(): void {
    this.stop();
    // Prime immediately so the first tick does not report the whole tray.
    this.snapshot = this.scan(this.deps.dir);
    this.primed = true;
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exported for probes and tests: one scan, one delta. */
  poll = (): FolderDelta => {
    const next = this.scan(this.deps.dir);
    const delta = this.primed ? diffSnapshot(this.snapshot, next) : { added: [], changed: [] };
    this.snapshot = next;
    this.primed = true;
    for (const file of [...delta.added, ...delta.changed]) this.deps.onFile(file);
    return delta;
  };
}
