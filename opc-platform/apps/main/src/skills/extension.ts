import path from 'node:path';
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
 * scripts/x.py" still goes through `bash`, with the sandbox policy in
 * the way.
 */

export interface SkillsExtensionOptions {
  /** Enabled skills, read at render time so a toggle applies to the next request. */
  skills: () => readonly ScannedSkill[];
  /** Per-skill body cap; the rest is left on disk for the `read` tool. */
  bodyLimit?: number;
  /** Whether the current agent has `generate_image` active (configured image model + policy). */
  hasImageTool?: () => boolean;
  /** Whether the current agent has `text_to_speech` active (configured TTS model + policy). */
  hasTtsTool?: () => boolean;
}

const DEFAULT_BODY_LIMIT = 24_000;

function isPptMasterSkill(skill: ScannedSkill): boolean {
  return skill.name.toLowerCase() === 'ppt-master' || path.basename(skill.dir).toLowerCase() === 'office-ppt';
}

function pptMasterRuntimeBridge(
  skill: ScannedSkill,
  caps: { hasImageTool: boolean; hasTtsTool: boolean },
): string {
  const imageBridge = caps.hasImageTool
    ? [
        '- **AI 配图通道（强制走 Path B `host-native`）**：当前已配置内置 `generate_image` 工具。**严禁运行 `image_gen.py --manifest`**（未安装 `google-genai` 且未配置 `IMAGE_BACKEND`），严格按 `references/image-generator.md` §7 的 **Path B（`host-native`）** 执行：',
        '  1. 按规范写入 `./work/ppt/<项目名>/images/image_prompts.json`（可选运行 `"$OPC_OFFICE_PYTHON" "${SKILL_DIR}/scripts/image_gen.py" --render-md "./work/ppt/<项目名>/images/image_prompts.json"` 生成 sidecar）。',
        '  2. 按 `items[].prompt` 调用内置 `generate_image`，直接将 `filename` 设为 `work/ppt/<项目名>/images/<目标filename>` 并传入当前模型支持的尺寸/比例参数，生成后会直接写入目标目录；随后将 `image_prompts.json` 对应项 `status` 标为 `"Generated"`。',
        '  3. 全部配图就位后运行 `"$OPC_OFFICE_PYTHON" "${SKILL_DIR}/scripts/analyze_images.py" "./work/ppt/<项目名>/images"` 回填真实像素尺寸，再在 SVG 中引用 `../images/<filename>`。',
      ]
    : [
        '- **AI 配图降级（当前未配置图像模型）**：当前工作台未配置可用图像生成模型（无 `generate_image` 工具）。**严禁调用 `image_gen.py --manifest`，也不要进入 `Offline Manual / Needs-Manual` 阻塞等待**；除非用户已上传本地图片，否则全程使用纯原生 SVG 矢量布局、`${SKILL_DIR}/templates/icons/` 内置矢量图标库与原生可编辑图表完成视觉设计。',
      ];

  const speechBridge = caps.hasTtsTool
    ? '- **旁白配音**：需要配音旁白时调用内置 `text_to_speech`（生成在工作区根目录后按需移入工程目录）。'
    : '- **旁白配音**：当前未配置语音合成模型，专注交付高质量原生可编辑 `.pptx`，不生成旁白音频。';

  return [
    '## OPC 运行时桥接指令（优先级高于默认环境假设）',
    `- **SKILL_DIR 固定只读路径**：\`${skill.dir}\`（禁止向 \`SKILL_DIR\` 写入或修改任何文件）。`,
    '- **Python 解释器**：所有 `${SKILL_DIR}/scripts/*.py` 命令一律优先用 `"$OPC_OFFICE_PYTHON"` 执行（`attribution_guard.py`、质量检查与 `svg_to_pptx.py` 均同），避免触发 Windows `WindowsApps\\python3.exe` 占位符。',
    '- **工作区与交付物路径**：PPT 工程目录请建在当前任务工作区的相对路径 `./work/ppt/<项目名>/` 下；完成 `svg_quality_checker.py` 视觉质检并运行 `svg_to_pptx.py` 导出后，务必将终稿复制到 `./output/<语义化文件名>.pptx`，任务结束时 OPC 会自动登记为交付物并用内置 PPTX 预览器逐页展示。',
    '- **批量并发执行（大幅提速）**：多张配图优先同回合并发调用 `generate_image`；撰写多页 SVG 时在同一回合并发 `write`（或用单段 Python 脚本一次落盘全部页面），把质量检查、`svg_to_pptx.py` 导出与预览图渲染合并进尽量少的 `bash` 命令，避免逐页、逐文件串行空转。',
    '- **低开销视觉自检（单张拼图原则）**：若需要导出预览图检查版式，先用 Pillow 把所有页面拼成 **1 张 1600px 宽的 JPEG 拼图**（如 `work/ppt/<项目名>/preview_grid.jpg`，质量 80），仅调用 **1 次** `read` 整体验收；仅对确有遮挡/溢出嫌疑的个别页面才定向查看单页，严禁逐页多次 `read` 全分辨率 PNG 或修改后全量重读。',
    '- **交互节奏（干练直出 / Chat & Delegated 分支）**：遵循 `references/confirm-surface.md` §1 的 Chat / Delegated 模式，**严禁启动本地 Flask `confirm_ui` Web 服务器**。只要用户的主题和目标基本明确，直接端到端完成大纲规划 → 16:9 SVG 绘制 → 质量检查 → 原生 `.pptx` 导出并交付初稿（后续用户提出修改意见时可用 `--roundtrip` 增量精修）；仅在主题、核心内容或受众完全缺失时才通过 `ask_user` 提 1 次简短澄清。',
    '- **PDF 参考解析**：解析参考 PDF 文档优先调用内置 `office-pdf`（运行环境未安装 AGPL 协议的 `PyMuPDF`）。',
    ...imageBridge,
    speechBridge,
    '',
  ].join('\n');
}

export function createSkillsExtension(options: SkillsExtensionOptions) {
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;

  return defineExtension({
    name: 'opc.skills',
    sections: [
      section('skills', () => {
        const skills = options.skills();
        if (skills.length === 0) return undefined;
        const hasManaged = skills.some((skill) => skill.scope === 'managed');
        return [
          'OPC 工作台已启用下面这些内置技能。技能是一份说明书，不是工具：',
          '需要时先用 read_skill 读出全文，再按里面的步骤做；不要凭名字猜步骤。',
          ...(hasManaged
            ? [
                '执行内置办公技能脚本时优先使用 "$OPC_OFFICE_PYTHON" 运行其 scripts/ 下的脚本；产物请写入当前任务工作区的相对路径（如 ./output/），任务结束会自动登记为交付文件。',
              ]
            : []),
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
          name: Type.String({ description: '技能名，例如 pdf、xlsx、ppt-master' }),
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

          const bridge = isPptMasterSkill(skill)
            ? `${pptMasterRuntimeBridge(skill, {
                hasImageTool: options.hasImageTool?.() ?? false,
                hasTtsTool: options.hasTtsTool?.() ?? false,
              })}\n`
            : '';

          const files =
            skill.files.length > 0
              ? `\n\n自带文件（相对 ${skill.dir}）：\n${skill.files.map((file) => `- ${file}`).join('\n')}`
              : '';

          return {
            output: [
              {
                type: 'text' as const,
                text: `# 技能：${skill.name}\n${skill.description}\n\n${bridge}${body}${files}`,
              },
            ],
            details: { name: skill.name, dir: skill.dir, files: skill.files.length },
          };
        },
      }),
    ],
  });
}
