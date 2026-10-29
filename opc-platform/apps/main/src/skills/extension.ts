import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { skillSummary } from './host';
import type { ScannedSkill } from './scanner';

/**
 * Skills as a runtime extension: one prompt section plus one tool.
 *
 * Progressive disclosure, the same shape Anthropic's Agent Skills use:
 *   - the section lists `name — one-line description` for every enabled skill,
 *     which is all a model needs to decide "this one is relevant";
 *   - `read_skill` returns the full SKILL.md (and the bundled files) only when
 *     the model asks, so the token cost is paid per use, not per request.
 *
 * The body is returned as text, not executed: a skill that says "run
 * scripts/x.py" still goes through `bash`, with the sandbox and call limit in
 * the way.
 */

export interface SkillsExtensionOptions {
  /** Enabled skills, read at render time so a toggle applies to the next request. */
  skills: () => readonly ScannedSkill[];
  /** Per-skill body cap; the rest is left on disk for the `read` tool. */
  bodyLimit?: number;
}

const DEFAULT_BODY_LIMIT = 24_000;

export function createSkillsExtension(options: SkillsExtensionOptions) {
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;

  return defineExtension({
    name: 'opc.skills',
    sections: [
      section('skills', () => {
        const skills = options.skills();
        if (skills.length === 0) return undefined;
        return [
          '这台机器上装了下面这些技能。技能是一份说明书，不是工具：',
          '需要时先用 read_skill 读出全文，再按里面的步骤做；不要凭名字猜步骤。',
          '',
          ...skills.map((skill) => `- ${skill.name} — ${skillSummary(skill)}`),
        ].join('\n');
      }),
    ],
    tools: [
      defineTool({
        name: 'read_skill',
        description:
          '读取一个技能的完整说明（SKILL.md 正文）以及它自带的文件清单。技能名来自系统提示里的 skills 列表。',
        parameters: Type.Object({
          name: Type.String({ description: '技能名，例如 pdf、xlsx' }),
        }),
        async execute(args, api: ToolExecutionApi) {
          const skills = options.skills();
          const wanted = args.name.trim().toLowerCase();
          const skill =
            skills.find((entry) => entry.name.toLowerCase() === wanted) ??
            skills.find((entry) => entry.name.toLowerCase().includes(wanted));

          if (!skill) {
            const available = skills.map((entry) => entry.name).join('、') || '（没有启用的技能）';
            api.diagnostic({
              severity: 'warn',
              message: `read_skill 找不到「${args.name}」，可用：${available}`,
            });
            return {
              output: [{ type: 'text' as const, text: `找不到技能「${args.name}」。可用：${available}` }],
              isError: true,
            };
          }

          const body =
            skill.body.length > bodyLimit
              ? `${skill.body.slice(0, bodyLimit)}\n\n……（正文过长已截断，完整内容在 ${skill.file}，可用 read 工具读取）`
              : skill.body;

          const files =
            skill.files.length > 0
              ? `\n\n自带文件（相对 ${skill.dir}）：\n${skill.files.map((file) => `- ${file}`).join('\n')}`
              : '';

          return {
            output: [
              {
                type: 'text' as const,
                text: `# 技能：${skill.name}\n${skill.description}\n\n${body}${files}`,
              },
            ],
            details: { name: skill.name, dir: skill.dir, files: skill.files.length },
          };
        },
      }),
    ],
  });
}
