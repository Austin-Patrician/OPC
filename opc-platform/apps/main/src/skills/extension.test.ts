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

const runTool = async (
  skills: ScannedSkill[],
  name: string,
  options?: { bodyLimit?: number; hasImageTool?: boolean; hasTtsTool?: boolean },
) => {
  const extension = createSkillsExtension({
    skills: () => skills,
    ...(options?.bodyLimit ? { bodyLimit: options.bodyLimit } : {}),
    ...(options?.hasImageTool !== undefined ? { hasImageTool: () => options.hasImageTool! } : {}),
    ...(options?.hasTtsTool !== undefined ? { hasTtsTool: () => options.hasTtsTool! } : {}),
  });
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
    const { text } = await runTool([skill('big', { body: 'x'.repeat(500) })], 'big', { bodyLimit: 100 });

    expect(text).toContain('已截断');
    expect(text).toContain('/skills/big/SKILL.md');
  });

  it('answers with the available names when the skill is unknown', async () => {
    const { result, text, diagnostics } = await runTool([skill('pdf')], 'nope');

    expect(result.isError).toBe(true);
    expect(text).toContain('pdf');
    expect(diagnostics[0]?.message).toContain('nope');
  });

  it('injects Path B host-native image & TTS bridge when configured', async () => {
    const ppt = skill('ppt-master', {
      scope: 'managed',
      dir: 'C:/userData/skills-managed/office-ppt',
      file: 'C:/userData/skills-managed/office-ppt/SKILL.md',
      files: ['scripts/svg_to_pptx.py', 'workflows/generate-pptx.md'],
      body: '# PPT Master\n\nOriginal upstream body.',
    });
    const { result, text } = await runTool([ppt], 'ppt-master', {
      hasImageTool: true,
      hasTtsTool: true,
    });

    expect(result.isError).toBeUndefined();
    expect(text).toContain('OPC 运行时桥接指令');
    expect(text).toContain('$OPC_OFFICE_PYTHON');
    expect(text).toContain('./work/ppt/');
    expect(text).toContain('./output/');
    expect(text).toContain('严禁启动本地 Flask');
    expect(text).toContain('Path B（`host-native`）');
    expect(text).toContain('严禁运行 `image_gen.py --manifest`');
    expect(text).toContain('generate_image');
    expect(text).toContain('work/ppt/<项目名>/images/<目标filename>');
    expect(text).toContain('analyze_images.py');
    expect(text).toContain('text_to_speech');
    expect(text).toContain('批量并发执行');
    expect(text).toContain('1600px 宽的 JPEG 拼图');
    expect(text).toContain('Original upstream body.');
  });

  it('instructs pure SVG/vector icon fallback when image & TTS models are unavailable', async () => {
    const ppt = skill('ppt-master', {
      scope: 'managed',
      dir: 'C:/userData/skills-managed/office-ppt',
      file: 'C:/userData/skills-managed/office-ppt/SKILL.md',
      files: ['scripts/svg_to_pptx.py'],
      body: '# PPT Master\n\nOriginal upstream body.',
    });
    const { result, text } = await runTool([ppt], 'ppt-master', {
      hasImageTool: false,
      hasTtsTool: false,
    });

    expect(result.isError).toBeUndefined();
    expect(text).toContain('当前未配置图像模型');
    expect(text).toContain('Needs-Manual');
    expect(text).toContain('templates/icons/');
    expect(text).not.toContain('调用内置 `generate_image`');
    expect(text).not.toContain('调用内置 `text_to_speech`');
    expect(text).toContain('Original upstream body.');
  });
});
