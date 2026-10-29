import path from 'node:path';
import type fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanSkills, splitFrontmatter, type ScanSkillsOptions } from './scanner';

/**
 * Skills are the one capability OPC reads eagerly, so the parser has to survive
 * whatever people actually put in a SKILL.md — no frontmatter, quoted values,
 * folded blocks, a folder that is not a skill at all.
 */

interface FakeEntry {
  kind: 'file' | 'dir';
  text?: string;
  mtime?: number;
}

const posix = (value: string) => value.replace(/\\/g, '/');

function fakeIo(entries: Record<string, FakeEntry>): Required<Pick<ScanSkillsOptions, 'readDir' | 'readText' | 'stat'>> {
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
      if (dirs.has(key)) return { isFile: () => false, isDirectory: () => true, mtimeMs: 1 };
      return undefined;
    },
  };
}

const home = 'C:/home';
const project = 'C:/work/app';
const globalRoot = `${home}/.agents/skills`;
const projectRoot = `${project}/.agents/skills`;

const skill = (body: string, frontmatter?: string) =>
  frontmatter === undefined ? body : `---\n${frontmatter}\n---\n\n${body}`;

const scan = (entries: Record<string, FakeEntry>) =>
  scanSkills({ homeDir: home, projectDir: project, ...fakeIo(entries) });

describe('splitFrontmatter', () => {
  it('reads name and description and keeps the body', () => {
    const parsed = splitFrontmatter(skill('# Title\n\nDo the thing.', 'name: pdf\ndescription: Handles PDFs'));
    expect(parsed.frontmatter).toEqual({ name: 'pdf', description: 'Handles PDFs' });
    expect(parsed.body).toBe('# Title\n\nDo the thing.');
  });

  it('folds a block scalar description', () => {
    const parsed = splitFrontmatter(
      skill('Body.', 'name: x\ndescription: >\n  first line\n  second line\nlicense: MIT'),
    );
    expect(parsed.frontmatter.description).toBe('first line second line');
    expect(parsed.frontmatter.license).toBe('MIT');
  });

  it('strips matching quotes', () => {
    expect(splitFrontmatter(skill('b', 'name: "quoted"')).frontmatter.name).toBe('quoted');
  });

  it('returns the whole file as body when there is no frontmatter', () => {
    expect(splitFrontmatter('# Just markdown')).toEqual({ frontmatter: {}, body: '# Just markdown' });
  });
});

describe('scanSkills', () => {
  it('finds a skill, its description and its bundled files', () => {
    const result = scan({
      [`${globalRoot}/pdf/SKILL.md`]: {
        kind: 'file',
        text: skill('# PDF guide\n\nStep one.', 'name: pdf\ndescription: PDF toolkit'),
      },
      [`${globalRoot}/pdf/scripts/fill.py`]: { kind: 'file' },
      [`${globalRoot}/pdf/references/forms.md`]: { kind: 'file' },
    });

    expect(result.roots.map(posix)).toEqual([globalRoot, projectRoot]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      name: 'pdf',
      description: 'PDF toolkit',
      scope: 'global',
      files: ['references/forms.md', 'scripts/fill.py'],
      body: '# PDF guide\n\nStep one.',
    });
  });

  it('falls back to the folder name and the first sentence', () => {
    const result = scan({
      [`${globalRoot}/notes/SKILL.md`]: {
        kind: 'file',
        text: '# Notes\n\nSummarise meeting notes into decisions. Then file them.',
      },
    });

    expect(result.entries[0]).toMatchObject({
      name: 'notes',
      description: 'Summarise meeting notes into decisions.',
    });
  });

  it('ignores folders without SKILL.md, hidden folders and node_modules', () => {
    const result = scan({
      [`${globalRoot}/empty/README.md`]: { kind: 'file' },
      [`${globalRoot}/.git/SKILL.md`]: { kind: 'file' },
      [`${globalRoot}/node_modules/SKILL.md`]: { kind: 'file' },
      [`${globalRoot}/real/SKILL.md`]: { kind: 'file', text: skill('Body.', 'name: real') },
    });

    expect(result.entries.map((entry) => entry.name)).toEqual(['real']);
  });

  it('lets a project skill replace a global one with the same name', () => {
    const result = scan({
      [`${globalRoot}/deploy/SKILL.md`]: { kind: 'file', text: skill('global.', 'name: deploy\ndescription: global one') },
      [`${projectRoot}/deploy/SKILL.md`]: { kind: 'file', text: skill('project.', 'name: deploy\ndescription: project one') },
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ description: 'project one', scope: 'project' });
  });

  it('caps the file listing instead of walking a huge tree', () => {
    const entries: Record<string, FakeEntry> = {
      [`${globalRoot}/big/SKILL.md`]: { kind: 'file', text: skill('Body.', 'name: big') },
    };
    for (let index = 0; index < 260; index += 1) {
      entries[`${globalRoot}/big/assets/file-${index}.txt`] = { kind: 'file' };
    }

    expect(scan(entries).entries[0]!.files).toHaveLength(200);
  });

  it('reads the newest mtime so edits invalidate the cache', () => {
    const result = scan({
      [`${globalRoot}/fresh/SKILL.md`]: { kind: 'file', mtime: 7, text: skill('Body.', 'name: fresh') },
      [`${globalRoot}/fresh`]: { kind: 'dir', mtime: 11 },
    });

    expect(result.entries[0]!.mtime).toBe(11);
  });
});
