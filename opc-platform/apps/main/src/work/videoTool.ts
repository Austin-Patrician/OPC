import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { Type } from 'typebox';
import type { Context } from '@earendil-works/chord/context';
import { defineExtension, defineTool, type ToolExecutionResult } from '@earendil-works/pi-durable';
import type { VideoImageInput } from '../models/videoGeneration';
import type { VideoGenerateBytesInput, VideoGenerateBytesResult } from '../models/videoService';

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export interface VideoToolDeps {
  /** Resolves the configured video provider/model and generates raw MP4/WebM bytes. */
  generate: (input: VideoGenerateBytesInput) => Promise<VideoGenerateBytesResult>;
  /** Fallback workspace root when the active session has no explicit cwd. */
  defaultRoot: string;
}

/**
 * `generate_video`: the agent-facing video generation tool.
 *
 * Supports text-to-video (T2V) and image-to-video (I2V via `imagePath` / optional
 * `endImagePath` keyframes in the workspace). Writes the generated clip back into the
 * workspace so artifacts and inline chat `<video>` playback pick it up automatically.
 */
export function createVideoToolExtension(deps: VideoToolDeps) {
  return defineExtension({
    name: 'opc.video',
    tools: [
      defineTool({
        name: 'generate_video',
        description:
          'Generate a video clip (MP4/WebM) from a prompt and optional start/end reference images in the workspace. Supports text-to-video and image-to-video across configured video providers. Returns the saved workspace file path.',
        parameters: Type.Object({
          prompt: Type.String({
            description:
              'Detailed visual & motion description: subject/action, camera movement, lighting, style, pacing, and optional audio cues.',
          }),
          filename: Type.Optional(
            Type.String({
              description: 'Target relative file name in the workspace, e.g. hero-shot.mp4. Defaults to a timestamped name.',
            }),
          ),
          imagePath: Type.Optional(
            Type.String({
              description: 'Optional workspace-relative path to a start keyframe image (.png/.jpg/.webp) for image-to-video.',
            }),
          ),
          endImagePath: Type.Optional(
            Type.String({
              description: 'Optional workspace-relative path to an end keyframe image (.png/.jpg/.webp) for first-to-last frame generation.',
            }),
          ),
          duration: Type.Optional(
            Type.Number({
              description: 'Target clip duration in seconds (typically 4 to 15, depending on provider/model).',
              minimum: 2,
              maximum: 20,
            }),
          ),
          aspectRatio: Type.Optional(
            Type.String({
              description: "Aspect ratio, e.g. '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'.",
            }),
          ),
          resolution: Type.Optional(
            Type.String({
              description: "Output resolution tier if supported by the model, e.g. '480p', '720p', '1080p'.",
            }),
          ),
          generateAudio: Type.Optional(
            Type.Boolean({
              description: 'Whether to generate native synchronized audio (supported by Seedance, Kling 3.0, Veo 3.1).',
            }),
          ),
          negativePrompt: Type.Optional(
            Type.String({
              description: 'Elements or artifacts to avoid during generation.',
            }),
          ),
          providerId: Type.Optional(
            Type.String({
              description: 'Optional explicit video provider id override.',
            }),
          ),
          modelId: Type.Optional(
            Type.String({
              description: 'Optional explicit video model id override.',
            }),
          ),
        }),
        execute: async (args, api, context): Promise<ToolExecutionResult> => {
          const env = api.env;
          if (!env) {
            return fail('当前会话没有可用的工作区文件环境，无法读取参考图或写入视频');
          }

          const agent = await api.agent(context);
          const root = path.resolve(agent.cwd ?? deps.defaultRoot);

          const startImageResult = args.imagePath
            ? await readWorkspaceImage(args.imagePath, root, env, context)
            : undefined;
          if (startImageResult && 'error' in startImageResult) {
            return fail(startImageResult.error);
          }

          const endImageResult = args.endImagePath
            ? await readWorkspaceImage(args.endImagePath, root, env, context)
            : undefined;
          if (endImageResult && 'error' in endImageResult) {
            return fail(endImageResult.error);
          }

          const signal = (api as { signal?: AbortSignal }).signal;
          const generated = await deps.generate({
            prompt: args.prompt,
            providerId: args.providerId,
            modelId: args.modelId,
            startImage: startImageResult,
            endImage: endImageResult,
            duration: args.duration,
            aspectRatio: args.aspectRatio,
            resolution: args.resolution,
            generateAudio: args.generateAudio,
            negativePrompt: args.negativePrompt,
            signal,
          });

          if (!generated.ok) {
            return fail(`视频生成失败：${generated.error}`);
          }

          const extension = generated.mimeType === 'video/webm' ? 'webm' : 'mp4';
          const outName = sanitizeRelativeOutput(args.filename, extension);
          if ('error' in outName) {
            return fail(outName.error);
          }

          const written = await env.writeFile(outName.path, generated.bytes, context);
          if (!written || !written.ok) {
            return fail(`写入视频文件失败：${outName.path}`);
          }

          return {
            output: [
              {
                type: 'text' as const,
                text: `已生成 ${outName.path}（${formatBytes(generated.bytes.byteLength)}，模型 ${generated.providerId}/${generated.model}${generated.durationSeconds ? `，${generated.durationSeconds}s` : ''}）`,
              },
            ],
            details: {
              path: outName.path,
              bytes: generated.bytes.byteLength,
              mimeType: generated.mimeType,
              providerId: generated.providerId,
              modelId: generated.model,
              ...(generated.durationSeconds !== undefined
                ? { durationSeconds: generated.durationSeconds }
                : {}),
            },
          };
        },
      }),
    ],
  });
}

async function readWorkspaceImage(
  requestedPath: string,
  root: string,
  env: { readBinaryFile: (target: string, context: Context) => Promise<{ ok: true; value: Uint8Array } | { ok: false; error: { code: string; message?: string } }> },
  context: Context,
): Promise<VideoImageInput | { error: string }> {
  const cleaned = requestedPath.trim();
  if (!cleaned) return { error: '参考图路径不能为空' };
  if (path.isAbsolute(cleaned)) {
    return { error: `参考图必须使用工作区相对路径：${cleaned}` };
  }
  const target = path.resolve(root, cleaned);
  if (!contains(root, target)) {
    return { error: `参考图路径不能超出工作区：${cleaned}` };
  }

  const ext = path.extname(target).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES[ext];
  if (!mimeType) {
    return { error: `不支持的参考图格式：${ext || '（无扩展名）'}。支持 png、jpg、jpeg、webp` };
  }

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(root);
    realTarget = await realpath(target);
  } catch {
    return { error: `找不到参考图：${cleaned}` };
  }
  if (!contains(realRoot, realTarget)) {
    return { error: `参考图符号链接指向工作区外，已拒绝：${cleaned}` };
  }

  const read = await env.readBinaryFile(realTarget, context);
  if (!read.ok) {
    return {
      error:
        read.error.code === 'not_found'
          ? `找不到参考图：${cleaned}`
          : `读取参考图失败：${read.error.message ?? read.error.code}`,
    };
  }
  return { bytes: read.value, mimeType };
}

function sanitizeRelativeOutput(
  filename: string | undefined,
  fallbackExtension: 'mp4' | 'webm',
): { path: string } | { error: string } {
  if (!filename || !filename.trim()) {
    return { path: `video-${Date.now()}.${fallbackExtension}` };
  }
  const raw = filename.trim();
  if (path.isAbsolute(raw) || raw.startsWith('~')) {
    return { error: `输出文件名必须使用工作区相对路径：${raw}` };
  }
  const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0 || segments.some((seg) => seg === '..' || seg === '.')) {
    return { error: `输出文件名包含非法路径段：${raw}` };
  }
  const safeSegments = segments.map((seg) => seg.replace(/[^\w.-]+/g, '_'));
  const last = safeSegments[safeSegments.length - 1]!;
  if (!/\.(mp4|webm|mov|m4v)$/i.test(last)) {
    safeSegments[safeSegments.length - 1] = `${last}.${fallbackExtension}`;
  }
  return { path: safeSegments.join('/') };
}

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function fail(text: string): ToolExecutionResult {
  return { isError: true, output: [{ type: 'text' as const, text }] };
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}
