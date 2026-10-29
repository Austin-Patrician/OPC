import { describe, expect, it } from 'vitest';
import path from 'node:path';
import type fs from 'node:fs';
import { extensionSlug, scanPiExtensions, type ScanOptions } from './scanner';

/**
 * The scanner is the only part of extension support that reads the disk, and it
 * is the part with the most rules (three layouts, two scopes, a settings file).
 * A fake filesystem keeps the matrix cheap and platform-neutral.
 */

interface FakeEntry {
  kind: 'file' | 'dir';
  mtime?: number;
  text?: string;
}

const posix = (value: string) => value.replace(/\\/g, '/');

function fakeIo(entries: Record<string, FakeEntry>): Required<Pick<ScanOptions, 'readDir' | 'readText' | 'stat'>> {
  const files = new Map<string, FakeEntry>();
  const dirs = new Set<string>();

  for (const [key, value] of Object.entries(entries)) {
    const target = posix(key);
    files.set(target, value);
    if (value.kind === 'dir') dirs.add(target);
    let parent = target.slice(0, target.lastIndexOf('/'));
    while (parent && !dirs.has(parent)) {
      dirs.add(parent);
      parent = parent.slice(0, parent.lastIndexOf('/'));
    }
  }

  const parentOf = (target: string) => target.slice(0, target.lastIndexOf('/'));

  return {
    readDir(dir) {
      const target = posix(dir);
      const names = new Set<string>();
      for (const key of [...files.keys(), ...dirs]) {
        if (parentOf(key) === target && key !== target) names.add(key.slice(target.length + 1));
      }
      return [...names].map(
        (name) =>
          ({
            name,
            isFile: () => files.get(`${target}/${name}`)?.kind === 'file',
            isDirectory: () => dirs.has(`${target}/${name}`),
            isBlockDevice: () => false,
            isCharacterDevice: () => false,
            isFIFO: () => false,
            isSocket: () => false,
            isSymbolicLink: () => false,
            parentPath: dir,
            path: `${dir}${path.sep}${name}`,
          }) as unknown as fs.Dirent,
      );
    },
    readText(file) {
      return files.get(posix(file))?.text;
    },
    stat(target) {
      const key = posix(target);
      const entry = files.get(key);
      if (entry) {
        return {
          isFile: () => entry.kind === 'file',
          isDirectory: () => entry.kind === 'dir',
          mtimeMs: entry.mtime ?? 1,
        };
      }
      if (dirs.has(key)) {
        return { isFile: () => false, isDirectory: () => true, mtimeMs: 1 };
      }
      return undefined;
    },
  };
}

const home = 'C:/home';
const project = 'C:/work/app';
const globalRoot = `${home}/.pi/agent/extensions`;
const projectRoot = `${project}/.pi/extensions`;

const scan = (entries: Record<string, FakeEntry>) =>
  scanPiExtensions({ homeDir: home, projectDir: project, ...fakeIo(entries) });

describe('scanPiExtensions', () => {
  it('finds a single-file extension and a directory entry, ignoring nested helpers', () => {
    const result = scan({
      [`${globalRoot}/lint.ts`]: { kind: 'file', mtime: 10 },
      [`${globalRoot}/review/index.ts`]: { kind: 'file', mtime: 20 },
      [`${globalRoot}/review/helper.ts`]: { kind: 'file', mtime: 99 },
    });

    expect(result.roots.map(posix)).toEqual([globalRoot, projectRoot]);
    expect(result.entries.map((entry) => [entry.name, entry.scope, posix(entry.entry)])).toEqual([
      ['lint', 'global', `${globalRoot}/lint.ts`],
      ['review', 'global', `${globalRoot}/review/index.ts`],
    ]);
  });

  it('prefers the manifest entry and takes name/version/description from it', () => {
    const result = scan({
      [`${projectRoot}/pkg/package.json`]: {
        kind: 'file',
        text: JSON.stringify({
          name: 'acme-tools',
          version: '1.2.3',
          description: 'Acme helpers',
          pi: { extensions: ['./src/main.ts'] },
        }),
      },
      [`${projectRoot}/pkg/src/main.ts`]: { kind: 'file' },
      [`${projectRoot}/pkg/index.ts`]: { kind: 'file' },
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      name: 'acme-tools',
      version: '1.2.3',
      description: 'Acme helpers',
      scope: 'project',
    });
    expect(posix(result.entries[0]!.entry)).toBe(`${projectRoot}/pkg/src/main.ts`);
    expect(posix(result.entries[0]!.dir)).toBe(`${projectRoot}/pkg`);
  });

  it('falls back to index.ts when package.json is not a Pi manifest', () => {
    const result = scan({
      [`${globalRoot}/plain/package.json`]: {
        kind: 'file',
        text: JSON.stringify({ name: 'not-a-pi-package' }),
      },
      [`${globalRoot}/plain/index.js`]: { kind: 'file' },
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.name).toBe('not-a-pi-package');
    expect(posix(result.entries[0]!.entry)).toBe(`${globalRoot}/plain/index.js`);
  });

  it('ignores directories without an entry, hidden entries and node_modules', () => {
    const result = scan({
      [`${globalRoot}/node_modules/left-pad/index.js`]: { kind: 'file' },
      [`${globalRoot}/.hidden/index.ts`]: { kind: 'file' },
      [`${globalRoot}/empty/readme.md`]: { kind: 'file' },
      [`${globalRoot}/notes.txt`]: { kind: 'file' },
      [`${globalRoot}/real.ts`]: { kind: 'file' },
    });

    expect(result.entries.map((entry) => entry.name)).toEqual(['real']);
  });

  it('lists paths declared in settings.json, expanding ~', () => {
    const result = scan({
      [`${home}/.pi/agent/settings.json`]: {
        kind: 'file',
        text: JSON.stringify({ extensions: ['~/shared/work.ts', `${project}/tools/extra/index.ts`] }),
      },
      [`${home}/shared/work.ts`]: { kind: 'file' },
      [`${project}/tools/extra/index.ts`]: { kind: 'file' },
    });

    expect(result.entries.map((entry) => posix(entry.entry)).sort()).toEqual(
      [`${home}/shared/work.ts`, `${project}/tools/extra/index.ts`].sort(),
    );
  });

  it('survives a malformed settings.json', () => {
    const result = scan({
      [`${home}/.pi/agent/settings.json`]: { kind: 'file', text: '{ not json' },
      [`${globalRoot}/ok.ts`]: { kind: 'file' },
    });

    expect(result.entries.map((entry) => entry.name)).toEqual(['ok']);
  });

  it('uses the newest mtime so edits to the manifest invalidate the cache', () => {
    const result = scan({
      [`${globalRoot}/multi/index.ts`]: { kind: 'file', mtime: 5 },
      [`${globalRoot}/multi/package.json`]: { kind: 'file', mtime: 42, text: '{"name":"multi"}' },
    });

    expect(result.entries[0]?.mtime).toBe(42);
  });
});

describe('extensionSlug', () => {
  it('keeps names readable in policy lists', () => {
    expect(extensionSlug('Acme Tools')).toBe('acme-tools');
    expect(extensionSlug('@scope/pkg')).toBe('scope-pkg');
    expect(extensionSlug('  ')).toBe('extension');
  });
});
