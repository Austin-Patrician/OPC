import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  diffSnapshot,
  FolderWatcher,
  isNoise,
  scanFolder,
  type FileSnapshot,
  type FolderSnapshot,
} from './folderWatcher';

/**
 * The first real Trigger source.
 *
 * What these lock down: noise never becomes an event (cheaper than classifying it
 * later), one save is one event, and priming does not report the whole folder as
 * new — otherwise pointing the watcher at a full directory would dispatch a task
 * per file on startup.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-watch-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(relPath: string, size = 10, mtimeMs = 1_000): FileSnapshot {
  return { relPath, size, mtimeMs };
}

describe('isNoise', () => {
  it('ignores dotfiles, editor lock files and partial downloads', () => {
    for (const name of ['.DS_Store', '~$report.docx', 'a.tmp', 'b.crdownload', 'c.swp', 'Thumbs.db']) {
      expect(isNoise(name)).toBe(true);
    }
  });

  it('keeps ordinary documents', () => {
    for (const name of ['财报.pdf', 'notes.md', 'data.csv']) {
      expect(isNoise(name)).toBe(false);
    }
  });
});

describe('diffSnapshot', () => {
  it('reports added and changed files, and ignores removals', () => {
    const before: FolderSnapshot = { 'a.txt': file('a.txt', 10, 1) };
    const after: FolderSnapshot = {
      'a.txt': file('a.txt', 20, 2),
      'b.txt': file('b.txt', 10, 3),
    };
    const delta = diffSnapshot(before, after);
    expect(delta.added.map((entry) => entry.relPath)).toEqual(['b.txt']);
    expect(delta.changed.map((entry) => entry.relPath)).toEqual(['a.txt']);
  });

  it('treats a rewrite with the same size as changed when the mtime moved', () => {
    const delta = diffSnapshot({ 'a.txt': file('a.txt', 10, 1) }, { 'a.txt': file('a.txt', 10, 2) });
    expect(delta.changed).toHaveLength(1);
  });

  it('is quiet when nothing moved', () => {
    const same: FolderSnapshot = { 'a.txt': file('a.txt') };
    expect(diffSnapshot(same, { ...same })).toEqual({ added: [], changed: [] });
  });
});

describe('scanFolder', () => {
  it('skips noise and directories', () => {
    writeFileSync(path.join(dir, 'real.txt'), 'hello');
    writeFileSync(path.join(dir, '.DS_Store'), 'x');
    mkdirSync(path.join(dir, 'nested'));
    writeFileSync(path.join(dir, 'nested', 'deep.txt'), 'x');

    // Far enough ahead that nothing looks like it is still being written.
    const snapshot = scanFolder(dir, Date.now() + 10_000);

    expect(Object.keys(snapshot)).toEqual(['real.txt']);
    expect(snapshot['real.txt']?.size).toBe(5);
  });

  it('ignores a file that was written a moment ago', () => {
    writeFileSync(path.join(dir, 'fresh.txt'), 'still writing');
    expect(scanFolder(dir, Date.now())).toEqual({});
  });

  it('returns an empty snapshot for a folder that does not exist', () => {
    expect(scanFolder(path.join(dir, 'nope'))).toEqual({});
  });
});

describe('FolderWatcher', () => {
  it('does not report the folder it was pointed at as new work', () => {
    const seen: string[] = [];
    let scan: FolderSnapshot = { 'old.txt': file('old.txt') };
    const watcher = new FolderWatcher({ dir, onFile: (entry) => seen.push(entry.relPath), scan: () => scan });

    watcher.start();
    expect(seen).toEqual([]);

    scan = { 'old.txt': file('old.txt'), 'new.txt': file('new.txt') };
    const delta = watcher.poll();
    expect(delta.added.map((entry) => entry.relPath)).toEqual(['new.txt']);
    expect(seen).toEqual(['new.txt']);
    watcher.stop();
  });

  it('reports one event per save, not one per poll', () => {
    const seen: string[] = [];
    let scan: FolderSnapshot = {};
    const watcher = new FolderWatcher({ dir, onFile: (entry) => seen.push(entry.relPath), scan: () => scan });
    watcher.start();

    scan = { 'a.txt': file('a.txt', 10, 5) };
    watcher.poll();
    watcher.poll();
    watcher.poll();

    expect(seen).toEqual(['a.txt']);
    watcher.stop();
  });

  it('reports a rewritten file again', () => {
    const seen: string[] = [];
    let scan: FolderSnapshot = {};
    const watcher = new FolderWatcher({ dir, onFile: (entry) => seen.push(entry.relPath), scan: () => scan });
    watcher.start();

    scan = { 'a.txt': file('a.txt', 10, 5) };
    watcher.poll();
    scan = { 'a.txt': file('a.txt', 12, 9) };
    watcher.poll();

    expect(seen).toEqual(['a.txt', 'a.txt']);
    watcher.stop();
  });
});
