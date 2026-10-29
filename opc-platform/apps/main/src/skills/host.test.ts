import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PiSkillHost, promptTokens, skillSummary } from './host';

/**
 * The store keeps *disabled* ids, so the interesting cases are: a fresh machine
 * (everything on), an explicit off, and a skill that disappears afterwards.
 */

let root: string;
let home: string;
let project: string;
let userData: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'opc-skills-'));
  home = path.join(root, 'home');
  project = path.join(root, 'project');
  userData = path.join(root, 'userData');
  mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
  mkdirSync(path.join(project, '.agents', 'skills'), { recursive: true });
  mkdirSync(userData, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSkill(name: string, description = `${name} does things.`) {
  const dir = path.join(home, '.agents', 'skills', name);
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nInstructions for ${name}.\n`,
    'utf8',
  );
  writeFileSync(path.join(dir, 'scripts', 'run.py'), 'print(1)\n', 'utf8');
  return path.join(dir, 'SKILL.md');
}

const host = () => new PiSkillHost({ userDataDir: userData, homeDir: home, projectDir: project });

describe('PiSkillHost', () => {
  it('offers every discovered skill by default, with no trust step', () => {
    writeSkill('pdf');
    writeSkill('xlsx');

    const catalog = host().list();

    expect(catalog.entries.map((entry) => entry.name)).toEqual(['pdf', 'xlsx']);
    expect(catalog.entries[0]).toMatchObject({
      enabled: true,
      scope: 'global',
      files: 1,
    });
    expect(catalog.roots).toHaveLength(2);
  });

  it('remembers an opt-out and reports it in enabled()', () => {
    writeSkill('pdf');
    writeSkill('xlsx');
    const instance = host();
    const pdf = instance.list().entries.find((entry) => entry.name === 'pdf')!;

    const catalog = instance.setEnabled(pdf.id, false);

    expect(catalog.entries.find((entry) => entry.name === 'pdf')).toMatchObject({ enabled: false });
    expect(instance.enabled().map((entry) => entry.name)).toEqual(['xlsx']);
    expect(JSON.parse(readFileSync(path.join(userData, 'pi-skills.json'), 'utf8'))).toEqual({
      version: 1,
      disabled: [pdf.id],
    });

    instance.setEnabled(pdf.id, true);
    expect(instance.enabled().map((entry) => entry.name)).toEqual(['pdf', 'xlsx']);
  });

  it('rejects an id that is not on disk', () => {
    expect(() => host().setEnabled(path.join(root, 'nope', 'SKILL.md'), false)).toThrow(/技能不存在/);
  });

  it('forgets an opt-out after the skill is uninstalled', () => {
    const file = writeSkill('gone');
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
    writeSkill('pdf');
    const [skill] = host().enabled();

    expect(skill!.body).toContain('Instructions for pdf.');
    expect(skill!.files).toEqual(['scripts/run.py']);
  });
});

describe('skillSummary / promptTokens', () => {
  const base = {
    id: 'x',
    name: 'pdf',
    scope: 'global' as const,
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
