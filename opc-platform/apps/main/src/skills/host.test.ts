import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PiSkillHost, promptTokens, skillSummary } from './host';

/**
 * The store keeps *disabled* ids for OPC's built-in (`bundled` and `managed`)
 * skills, ignoring any external `~/.agents/skills`.
 */

let root: string;
let home: string;
let project: string;
let bundledDir: string;
let managedDir: string;
let userData: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'opc-skills-'));
  home = path.join(root, 'home');
  project = path.join(root, 'project');
  bundledDir = path.join(root, 'resources', 'skills');
  managedDir = path.join(root, 'userData', 'skills-managed');
  userData = path.join(root, 'userData');
  mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
  mkdirSync(path.join(project, '.agents', 'skills'), { recursive: true });
  mkdirSync(bundledDir, { recursive: true });
  mkdirSync(managedDir, { recursive: true });
  mkdirSync(userData, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSkill(baseDir: string, name: string, extraFrontmatter = '', description = `${name} does things.`) {
  const dir = path.join(baseDir, name);
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n${extraFrontmatter}---\n\n# ${name}\n\nInstructions for ${name}.\n`,
    'utf8',
  );
  writeFileSync(path.join(dir, 'scripts', 'run.py'), 'print(1)\n', 'utf8');
  return path.join(dir, 'SKILL.md');
}

const host = () =>
  new PiSkillHost({ userDataDir: userData, homeDir: home, projectDir: project, bundledDir, managedDir });

describe('PiSkillHost', () => {
  it('offers built-in bundled and managed skills while ignoring external ~/.agents/skills', () => {
    writeSkill(path.join(home, '.agents', 'skills'), 'external-pdf');
    writeSkill(path.join(project, '.agents', 'skills'), 'external-xlsx');
    writeSkill(bundledDir, 'video-production', 'title: 视频制作工作流\ncategory: creative\n');
    writeSkill(managedDir, 'office-pdf');

    const catalog = host().list();

    expect(catalog.entries.map((entry) => entry.name)).toEqual(['office-pdf', 'video-production']);
    expect(catalog.entries[1]).toMatchObject({
      name: 'video-production',
      title: '视频制作工作流',
      category: 'creative',
      enabled: true,
      scope: 'bundled',
      files: 1,
    });
    expect(catalog.roots).toHaveLength(2);
  });

  it('remembers an opt-out and reports it in enabled()', () => {
    writeSkill(managedDir, 'office-pdf');
    writeSkill(managedDir, 'office-excel');
    const instance = host();
    const pdf = instance.list().entries.find((entry) => entry.name === 'office-pdf')!;

    const catalog = instance.setEnabled(pdf.id, false);

    expect(catalog.entries.find((entry) => entry.name === 'office-pdf')).toMatchObject({ enabled: false });
    expect(instance.enabled().map((entry) => entry.name)).toEqual(['office-excel']);
    expect(JSON.parse(readFileSync(path.join(userData, 'pi-skills.json'), 'utf8'))).toEqual({
      version: 1,
      disabled: [pdf.id],
    });

    instance.setEnabled(pdf.id, true);
    expect(instance.enabled().map((entry) => entry.name)).toEqual(['office-excel', 'office-pdf']);
  });

  it('rejects an id that is not on disk', () => {
    expect(() => host().setEnabled(path.join(root, 'nope', 'SKILL.md'), false)).toThrow(/技能不存在/);
  });

  it('forgets an opt-out after the managed skill is removed', () => {
    const file = writeSkill(managedDir, 'gone');
    const instance = host();
    const [entry] = instance.list().entries;
    instance.setEnabled(entry!.id, false);

    rmSync(path.dirname(file), { recursive: true, force: true });
    instance.list();

    expect(JSON.parse(readFileSync(path.join(userData, 'pi-skills.json'), 'utf8'))).toEqual({
      version: 1,
      disabled: [],
    });
  });

  it('returns the body and the bundled files to the runtime', () => {
    writeSkill(managedDir, 'office-pdf');
    const [skill] = host().enabled();

    expect(skill!.body).toContain('Instructions for office-pdf.');
    expect(skill!.files).toEqual(['scripts/run.py']);
  });

  it('picks up newly synced packs after invalidateCache()', () => {
    const instance = new PiSkillHost({ userDataDir: userData, bundledDir, managedDir });
    expect(instance.enabled()).toEqual([]);

    writeSkill(managedDir, 'office-ppt');
    instance.invalidateCache();

    expect(instance.enabled()).toHaveLength(1);
    expect(instance.enabled()[0]).toMatchObject({ name: 'office-ppt', scope: 'managed' });
  });

  it('discovers real resources/skills/video-production with Chinese title and creative category', () => {
    const realBundledDir = path.resolve(process.cwd(), 'resources', 'skills');
    const instance = new PiSkillHost({
      userDataDir: userData,
      bundledDir: realBundledDir,
    });

    const videoSkill = instance.enabled().find((entry) => entry.name === 'video-production');
    expect(videoSkill).toBeDefined();
    expect(videoSkill?.scope).toBe('bundled');
    expect(videoSkill?.title).toBe('视频制作工作流');
    expect(videoSkill?.category).toBe('creative');
    expect(videoSkill?.files).toContain('references/model-prompting.md');
    expect(videoSkill?.files).toContain('references/ffmpeg-postproduction.md');
  });
});

describe('skillSummary / promptTokens', () => {
  const base = {
    id: 'x',
    name: 'pdf',
    scope: 'managed' as const,
    dir: '/skills/pdf',
    file: '/skills/pdf/SKILL.md',
    files: [],
    body: '',
    mtime: 0,
  };

  it('trims a long description to the prompt budget', () => {
    const summary = skillSummary({ ...base, description: 'a'.repeat(900) });
    expect(summary).toHaveLength(300);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('collapses newlines so one skill stays one prompt line', () => {
    expect(skillSummary({ ...base, description: 'one\ntwo' })).toBe('one two');
  });

  it('estimates a non-zero cost', () => {
    expect(promptTokens({ ...base, description: 'PDF toolkit' })).toBeGreaterThan(0);
  });
});
