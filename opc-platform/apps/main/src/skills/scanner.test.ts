import path from 'node:path';
import type fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanSkills, splitFrontmatter, type ScanSkillsOptions } from './scanner';

/**
 * OPC uses a pure built-in curated skills catalog: only `bundledDir` and
 * `managedDir` are scanned, never external `~/.agents/skills`.
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
const bundledRoot = 'C:/app/resources/skills';
const managedRoot = 'C:/userData/skills-managed';
const externalGlobalRoot = `${home}/.agents/skills`;
const externalProjectRoot = `${project}/.agents/skills`;

const skill = (body: string, frontmatter?: string) =>
  frontmatter === undefined ? body : `---\n${frontmatter}\n---\n\n${body}`;

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
  it('ignores external ~/.agents/skills and .agents/skills completely', () => {
    const result = scanSkills({
      homeDir: home,
      projectDir: project,
      bundledDir: bundledRoot,
      managedDir: managedRoot,
      ...fakeIo({
        [`${externalGlobalRoot}/pdf/SKILL.md`]: {
          kind: 'file',
          text: skill('External PDF', 'name: pdf\ndescription: external pdf'),
        },
        [`${externalProjectRoot}/custom/SKILL.md`]: {
          kind: 'file',
          text: skill('Project custom', 'name: custom\ndescription: external project'),
        },
        [`${bundledRoot}/video-production/SKILL.md`]: {
          kind: 'file',
          text: skill(
            '# Video',
            'name: video-production\ntitle: 视频制作工作流\nsummary: 端到端视频工作流\ncategory: creative\ndescription: bundled video workflow',
          ),
        },
        [`${managedRoot}/office-pdf/SKILL.md`]: {
          kind: 'file',
          text: skill('# PDF', 'name: office-pdf\ndescription: OPC PDF'),
        },
      }),
    });

    expect(result.roots.map(posix)).toEqual([bundledRoot, managedRoot]);
    expect(result.entries.map((e) => e.name)).toEqual(['office-pdf', 'video-production']);
    expect(result.entries[1]).toMatchObject({
      name: 'video-production',
      title: '视频制作工作流',
      summary: '端到端视频工作流',
      category: 'creative',
      scope: 'bundled',
    });
    expect(result.entries[0]).toMatchObject({
      name: 'office-pdf',
      category: 'office',
      scope: 'managed',
    });
  });

  it('falls back to the folder name and the first sentence', () => {
    const result = scanSkills({
      bundledDir: bundledRoot,
      ...fakeIo({
        [`${bundledRoot}/notes/SKILL.md`]: {
          kind: 'file',
          text: '# Notes\n\nSummarise meeting notes into decisions. Then file them.',
        },
      }),
    });

    expect(result.entries[0]).toMatchObject({
      name: 'notes',
      description: 'Summarise meeting notes into decisions.',
    });
  });

  it('ignores folders without SKILL.md, hidden folders and node_modules', () => {
    const result = scanSkills({
      bundledDir: bundledRoot,
      ...fakeIo({
        [`${bundledRoot}/empty/README.md`]: { kind: 'file' },
        [`${bundledRoot}/.git/SKILL.md`]: { kind: 'file' },
        [`${bundledRoot}/node_modules/SKILL.md`]: { kind: 'file' },
        [`${bundledRoot}/real/SKILL.md`]: { kind: 'file', text: skill('Body.', 'name: real') },
      }),
    });

    expect(result.entries.map((entry) => entry.name)).toEqual(['real']);
  });

  it('lets managedDir override bundledDir on name collision', () => {
    const result = scanSkills({
      bundledDir: bundledRoot,
      managedDir: managedRoot,
      ...fakeIo({
        [`${bundledRoot}/shared/SKILL.md`]: { kind: 'file', text: skill('bundled.', 'name: shared\ndescription: b') },
        [`${managedRoot}/shared/SKILL.md`]: { kind: 'file', text: skill('managed.', 'name: shared\ndescription: m') },
      }),
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ description: 'm', scope: 'managed' });
  });

  it('prunes deep templates/icons subdirs so workflows and scripts stay visible within MAX_FILES', () => {
    const entries: Record<string, FakeEntry> = {
      [`${managedRoot}/office-ppt/SKILL.md`]: { kind: 'file', text: skill('Body.', 'name: ppt-master') },
      [`${managedRoot}/office-ppt/scripts/svg_to_pptx.py`]: { kind: 'file' },
      [`${managedRoot}/office-ppt/workflows/generate-pptx.md`]: { kind: 'file' },
      [`${managedRoot}/office-ppt/templates/icons/README.md`]: { kind: 'file' },
    };
    for (let i = 0; i < 250; i += 1) {
      entries[`${managedRoot}/office-ppt/templates/icons/tabler-outline/icon-${i}.svg`] = { kind: 'file' };
    }

    const files = scanSkills({ managedDir: managedRoot, ...fakeIo(entries) }).entries[0]!.files;
    expect(files).toContain('scripts/svg_to_pptx.py');
    expect(files).toContain('workflows/generate-pptx.md');
    expect(files).toContain('templates/icons/README.md');
    expect(files).toContain('templates/icons/tabler-outline/');
    expect(files.some((f) => f.endsWith('.svg'))).toBe(false);
  });

  it('caps huge directories cleanly and tracks newest mtime', () => {
    const entries: Record<string, FakeEntry> = {
      [`${bundledRoot}/big/SKILL.md`]: { kind: 'file', mtime: 7, text: skill('Body.', 'name: big') },
      [`${bundledRoot}/big`]: { kind: 'dir', mtime: 11 },
    };
    for (let index = 0; index < 260; index += 1) {
      entries[`${bundledRoot}/big/assets/file-${index}.txt`] = { kind: 'file' };
    }

    const result = scanSkills({ bundledDir: bundledRoot, ...fakeIo(entries) });
    expect(result.entries[0]!.files).toHaveLength(200);
    expect(result.entries[0]!.mtime).toBe(11);
  });
});
