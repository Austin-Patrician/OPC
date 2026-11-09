import { Type } from 'typebox';
import { defineExtension, defineTool, type ToolExecutionResult } from '@earendil-works/pi-durable';
import type { ImageModelCapabilities, ImageParameterName, ImageParameterSpec } from '@opc/shared/domain';
import type { GenerateImageOptions } from '../models/imageGeneration';

export interface GeneratedBytes {
  ok: boolean;
  bytes?: Uint8Array;
  mimeType?: string;
  model?: string;
  error?: string;
}

export interface ImageToolDeps {
  /** Resolves the configured image provider/model and returns the raw bytes. */
  generate: (input: { prompt: string; modelId?: string; options?: GenerateImageOptions }) => Promise<GeneratedBytes>;
  capabilities: () => ImageModelCapabilities | null;
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
  const capabilities = deps.capabilities();
  const imageProperties = Object.fromEntries(
    Object.entries(capabilities?.parameters ?? {}).map(([name, spec]) => [name, toSchema(spec!)]),
  );
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
          ...imageProperties,
        }),
        execute: async (args, api, context): Promise<ToolExecutionResult> => {
          const options = parseOptions(args, capabilities);
          if ('error' in options) {
            return { isError: true, output: [{ type: 'text' as const, text: options.error }] };
          }
          const generated = await deps.generate({ prompt: args.prompt, options: options.value });
          if (!generated.ok || !generated.bytes) {
            return {
              isError: true,
              output: [{ type: 'text' as const, text: `图像生成失败：${generated.error ?? '未知错误'}` }],
            };
          }

          const extension =
            generated.mimeType === 'image/jpeg' ? 'jpg' : generated.mimeType === 'image/webp' ? 'webp' : 'png';
          const filename = sanitize(args.filename ?? `image-${Date.now()}.${extension}`);
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
                mimeType: generated.mimeType ?? 'image/png',
              model: generated.model ?? 'unknown',
            },
          };
        },
      }),
    ],
  });
}

function toSchema(spec: ImageParameterSpec) {
  const options = {
    description: spec.description,
    ...(spec.default !== undefined ? { default: spec.default } : {}),
  };
  switch (spec.type) {
    case 'enum':
      if (!spec.values?.length) return Type.Optional(Type.String(options));
      return Type.Optional(Type.Union((spec.values ?? []).map((value) => Type.Literal(value)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]], options));
    case 'number':
      return Type.Optional(Type.Number({ ...options, minimum: spec.minimum, maximum: spec.maximum }));
    case 'integer':
      return Type.Optional(Type.Integer({ ...options, minimum: spec.minimum, maximum: spec.maximum }));
    case 'boolean':
      return Type.Optional(Type.Boolean(options));
    default:
      return Type.Optional(Type.String(options));
  }
}

function parseOptions(
  args: Record<string, unknown>,
  capabilities: ImageModelCapabilities | null,
): { value: GenerateImageOptions } | { error: string } {
  const options: GenerateImageOptions = {};
  const names = Object.keys(args).filter((name) => name !== 'prompt' && name !== 'filename');
  for (const rawName of names) {
    const name = rawName as ImageParameterName;
    const spec = capabilities?.parameters[name];
    if (!spec) return { error: `当前图片模型不支持参数：${rawName}` };
    const value = args[rawName];
    if (spec.type === 'enum' && (typeof value !== 'string' || !spec.values?.includes(value))) {
      return { error: `参数 ${rawName} 的值不受支持` };
    }
    if (spec.type === 'string' && typeof value !== 'string') return { error: `参数 ${rawName} 必须是字符串` };
    if (spec.type === 'boolean' && typeof value !== 'boolean') return { error: `参数 ${rawName} 必须是布尔值` };
    if ((spec.type === 'number' || spec.type === 'integer') && typeof value !== 'number') {
      return { error: `参数 ${rawName} 必须是数字` };
    }
    if (spec.type === 'integer' && !Number.isInteger(value)) return { error: `参数 ${rawName} 必须是整数` };
    if (typeof value === 'number' && (spec.minimum !== undefined && value < spec.minimum || spec.maximum !== undefined && value > spec.maximum)) {
      return { error: `参数 ${rawName} 超出允许范围` };
    }
    options[name] = value as GenerateImageOptions[ImageParameterName];
  }
  return { value: options };
}

/** Flat names only: the workspace is shared with the sandbox hook. */
function sanitize(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'image.png';
  const clean = base.replace(/[^\w.-]+/g, '_');
  return clean.includes('.') ? clean : `${clean}.png`;
}
