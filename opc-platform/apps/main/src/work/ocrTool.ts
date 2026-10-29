import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { Type } from 'typebox';
import { defineExtension, defineTool, type ToolExecutionResult } from '@earendil-works/pi-durable';
import type { OcrDetail, OcrResult } from '@opc/shared/ocr';
import type { OcrEngine } from '../ocr/service';

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_CHARS = 8_000;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif']);

export interface OcrToolDeps {
  ocr: OcrEngine;
  /** Fallback when the conversation has no cwd of its own. */
  defaultRoot: string;
}

/**
 * `ocr_image`: text out of a picture, for models that cannot see.
 *
 * The model only names a workspace file; reading, size checks and the OCR call
 * all stay in the host. Text (not an image block) goes back into the transcript,
 * so it is cheap, searchable and survives compaction.
 */
export function createOcrToolExtension(deps: OcrToolDeps) {
  return defineExtension({
    name: 'opc.ocr',
    tools: [
      defineTool({
        name: 'ocr_image',
        description:
          'Extract the text from an image file in the workspace (OCR). Use it when you cannot see images or when the exact wording of a screenshot, scan or photo matters. The answer follows the company setting (plain reading order, or one line at a time); set detail only to override it for this call. Supports png, jpg, webp, bmp, tiff and gif up to 15MB.',
        parameters: Type.Object({
          path: Type.String({
            description: 'Image path relative to the workspace, e.g. screenshots/login.png.',
          }),
          detail: Type.Optional(
            Type.String({
              description:
                'Override the company default: text for plain reading order, lines to prefix each line with x,y,w,h and confidence.',
            }),
          ),
        }),
        execute: async (args, api, context): Promise<ToolExecutionResult> => {
          const detail = resolveDetail(args.detail, deps.ocr.settings?.().detail);
          const agent = await api.agent(context);
          const root = path.resolve(agent.cwd ?? deps.defaultRoot);
          const target = path.resolve(root, args.path);

          if (!contains(root, target)) {
            return fail(`只能识别工作区内的图片：${args.path}`);
          }
          if (!IMAGE_EXTENSIONS.has(path.extname(target).toLowerCase())) {
            return fail(`不支持的图片格式：${path.extname(target) || '（无扩展名）'}。支持 png、jpg、webp、bmp、tiff、gif。`);
          }

          let realRoot: string;
          let realTarget: string;
          try {
            realRoot = await realpath(root);
            realTarget = await realpath(target);
          } catch {
            return fail(`找不到图片：${args.path}（路径相对工作区，且必须是已存在的文件）`);
          }
          if (!contains(realRoot, realTarget)) {
            return fail(`符号链接指向工作区外，已拒绝：${args.path}`);
          }

          const env = api.env;
          if (!env) return fail('当前会话没有可用的文件环境，无法读取图片');

          const read = await env.readBinaryFile(realTarget, context);
          if (!read.ok) {
            return fail(read.error.code === 'not_found' ? `找不到图片：${args.path}` : `读取图片失败：${read.error.message}`);
          }
          const bytes = read.value;
          if (bytes.byteLength === 0) return fail(`图片是空文件：${args.path}`);
          if (bytes.byteLength > MAX_BYTES) {
            return fail(`图片过大（${formatBytes(bytes.byteLength)}），单张上限 ${formatBytes(MAX_BYTES)}。`);
          }

          let result: OcrResult;
          try {
            result = await deps.ocr.recognize(new Uint8Array(bytes));
          } catch (error) {
            return fail(error instanceof Error ? error.message : `OCR 失败：${String(error)}`);
          }

          return succeed(args.path, detail, result);
        },
      }),
    ],
  });
}

/**
 * The boss's setting is the default; the model may still ask for the other shape
 * for one call (a table needs coordinates even when the company reads prose).
 */
function resolveDetail(asked: string | undefined, preferred: OcrDetail | undefined): OcrDetail {
  const explicit = asked?.trim().toLowerCase();
  if (explicit === 'lines' || explicit === 'text') return explicit;
  return preferred === 'lines' ? 'lines' : 'text';
}

function succeed(file: string, detail: OcrDetail, result: OcrResult): ToolExecutionResult {
  const header = `图片 ${result.width}×${result.height}，${result.lines.length} 行，置信度 ${(result.confidence * 100).toFixed(1)}%，引擎 ${result.engine}，耗时 ${result.elapsedMs}ms`;

  if (result.lines.length === 0 || result.text.trim().length === 0) {
    return {
      output: [{ type: 'text' as const, text: `${header}\n未识别到文字。` }],
      details: { file, lines: 0, confidence: result.confidence, engine: result.engine, truncated: false },
    };
  }

  const body =
    detail === 'lines'
      ? result.lines
          .map((line) => `[${Math.round(line.box.x)},${Math.round(line.box.y)} ${Math.round(line.box.width)}×${Math.round(line.box.height)} ${line.confidence.toFixed(2)}] ${line.text}`)
          .join('\n')
      : result.text;

  const truncated = body.length > MAX_CHARS;
  const shown = truncated ? `${body.slice(0, MAX_CHARS)}\n…（已截断，全文 ${body.length} 字符；可分段识别或用 detail="lines" 查看行）` : body;

  return {
    output: [{ type: 'text' as const, text: `${header}\n\n${shown}` }],
    details: {
      file,
      lines: result.lines.length,
      confidence: result.confidence,
      engine: result.engine,
      width: result.width,
      height: result.height,
      elapsedMs: result.elapsedMs,
      truncated,
    },
  };
}

function fail(text: string): ToolExecutionResult {
  return { isError: true, output: [{ type: 'text' as const, text }] };
}

/** `target` is inside `root`, comparing path segments rather than string prefixes. */
function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}
