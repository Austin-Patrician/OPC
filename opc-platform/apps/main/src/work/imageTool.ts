import { Type } from 'typebox';
import { defineExtension, defineTool, type ToolExecutionResult } from '@earendil-works/pi-durable';

export interface GeneratedBytes {
  ok: boolean;
  bytes?: Uint8Array;
  mimeType?: string;
  model?: string;
  error?: string;
}

export interface ImageToolDeps {
  /** Resolves the configured image provider/model and returns the raw bytes. */
  generate: (input: { prompt: string; modelId?: string }) => Promise<GeneratedBytes>;
}

/**
 * `generate_image`: the agent-facing tool.
 *
 * The model only decides *what* to draw and *where* to put it; provider
 * resolution, credentials and the HTTP call stay in the host. The file is written
 * through the execution environment, so it lands in the conversation workspace and
 * the normal artifact/acceptance pipeline picks it up.
 */
export function createImageToolExtension(deps: ImageToolDeps) {
  return defineExtension({
    name: 'opc.image',
    tools: [
      defineTool({
        name: 'generate_image',
        description:
          'Generate an image from a text prompt and save it into the workspace. Use it when the deliverable is a picture (icon, illustration, poster, UI mock). Returns the file name.',
        parameters: Type.Object({
          prompt: Type.String({ description: 'What the image should contain, in detail.' }),
          filename: Type.Optional(
            Type.String({ description: 'Target file name, e.g. icon.png. Defaults to a timestamped name.' }),
          ),
        }),
        execute: async (args, api, context): Promise<ToolExecutionResult> => {
          const generated = await deps.generate({ prompt: args.prompt });
          if (!generated.ok || !generated.bytes) {
            return {
              isError: true,
              output: [{ type: 'text' as const, text: `图像生成失败：${generated.error ?? '未知错误'}` }],
            };
          }

          const filename = sanitize(args.filename ?? `image-${Date.now()}.png`);
          const written = await api.env?.writeFile(filename, generated.bytes, context);
          if (!written || !written.ok) {
            return {
              isError: true,
              output: [{ type: 'text' as const, text: `写入文件失败：${filename}` }],
            };
          }

          return {
            output: [
              {
                type: 'text' as const,
                text: `已生成 ${filename}（${generated.bytes.byteLength} B，模型 ${generated.model ?? 'unknown'}）`,
              },
            ],
            details: {
              file: filename,
              bytes: generated.bytes.byteLength,
              model: generated.model ?? 'unknown',
            },
          };
        },
      }),
    ],
  });
}

/** Flat names only: the workspace is shared with the sandbox hook. */
function sanitize(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'image.png';
  const clean = base.replace(/[^\w.-]+/g, '_');
  return clean.includes('.') ? clean : `${clean}.png`;
}
