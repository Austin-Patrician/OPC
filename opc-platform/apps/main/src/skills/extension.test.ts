import { describe, expect, it } from 'vitest';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { createSkillsExtension } from './extension';
import type { ScannedSkill } from './scanner';

/**
 * The extension is the whole runtime contract for skills: one prompt section
 * that advertises them, one tool that reads one on demand.
 */

const skill = (name: string, overrides: Partial<ScannedSkill> = {}): ScannedSkill => ({
  id: `/skills/${name}/SKILL.md`,
  name,
  description: `${name} handles documents.`,
  scope: 'global',
  dir: `/skills/${name}`,
  file: `/skills/${name}/SKILL.md`,
  files: ['scripts/run.py'],
  body: `# ${name}\n\nDo the ${name} thing.`,
  mtime: 1,
  ...overrides,
});

function fakeApi() {
  const diagnostics: { severity: string; message: string }[] = [];
  const api = {
    callId: 'call-1',
    conversationId: 'conv-1',
    output: () => {},
    diagnostic: (value: { severity: string; message: string }) => diagnostics.push(value),
  } as unknown as ToolExecutionApi;
  return { api, diagnostics };
}

const renderSection = async (skills: ScannedSkill[]) => {
  const extension = createSkillsExtension({ skills: () => skills });
  const section = extension.sections![0]!;
  return section.render({} as never, {} as never);
};

const runTool = async (skills: ScannedSkill[], name: string, bodyLimit?: number) => {
  const extension = createSkillsExtension({ skills: () => skills, ...(bodyLimit ? { bodyLimit } : {}) });
  const tool = extension.tools!.find((entry) => entry.name === 'read_skill')!;
  const { api, diagnostics } = fakeApi();
  const result = await tool.execute({ name }, api, {} as never);
  const text = (result.output as { type: string; text: string }[]).map((block) => block.text).join('');
  return { result, text, diagnostics };
};

describe('createSkillsExtension', () => {
  it('is named like every other optional capability', () => {
    expect(createSkillsExtension({ skills: () => [] }).name).toBe('opc.skills');
  });

  it('renders one line per skill and says how to read it', async () => {
    const text = await renderSection([skill('pdf'), skill('xlsx', { description: 'Spreadsheets.' })]);

    expect(text).toContain('- pdf — pdf handles documents.');
    expect(text).toContain('- xlsx — Spreadsheets.');
    expect(text).toContain('read_skill');
  });

  it('renders nothing when every skill is switched off', async () => {
    expect(await renderSection([])).toBeUndefined();
  });

  it('reads a skill on demand, including its bundled files', async () => {
    const { text, result } = await runTool([skill('pdf')], 'PDF');

    expect(result.isError).toBeUndefined();
    expect(text).toContain('# 技能：pdf');
    expect(text).toContain('Do the pdf thing.');
    expect(text).toContain('scripts/run.py');
    expect(result.details).toMatchObject({ name: 'pdf', files: 1 });
  });

  it('truncates a huge body and points at the file instead', async () => {
    const { text } = await runTool([skill('big', { body: 'x'.repeat(500) })], 'big', 100);

    expect(text).toContain('已截断');
    expect(text).toContain('/skills/big/SKILL.md');
  });

  it('answers with the available names when the skill is unknown', async () => {
    const { result, text, diagnostics } = await runTool([skill('pdf')], 'nope');

    expect(result.isError).toBe(true);
    expect(text).toContain('pdf');
    expect(diagnostics[0]?.message).toContain('nope');
  });
});
