import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OcrResult } from '@opc/shared/ocr';
import type { OcrEngine } from '../ocr/service';
import { createOcrToolExtension } from './ocrTool';

interface ToolResult {
  isError?: boolean;
  output?: { text: string }[];
  details?: Record<string, unknown>;
}

let root: string;
let outside: string;

beforeAll(async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'opc-ocr-tool-'));
  root = path.join(base, 'workspace');
  outside = path.join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, 'shot.png'), new Uint8Array([1, 2, 3]));
  await writeFile(path.join(root, 'notes.txt'), 'not an image');
  await writeFile(path.join(outside, 'secret.png'), new Uint8Array([4]));
  await symlink(path.join(outside, 'secret.png'), path.join(root, 'escape.png'));
});

afterAll(async () => {
  await rm(path.dirname(root), { recursive: true, force: true });
});

function result(overrides: Partial<OcrResult> = {}): OcrResult {
  return {
    text: '订单确认单',
    lines: [{ text: '订单确认单', box: { x: 10, y: 20, width: 100, height: 30 }, confidence: 0.97 }],
    confidence: 0.97,
    width: 800,
    height: 600,
    engine: 'webgpu',
    elapsedMs: 420,
    ...overrides,
  };
}

function runTool(options: {
  args: { path: string; detail?: string };
  ocr?: Partial<OcrEngine>;
  bytes?: Uint8Array;
  readError?: { code: string; message: string };
}) {
  const calls: number[] = [];
  const ocr: OcrEngine = {
    recognize: async (bytes) => {
      calls.push(bytes.byteLength);
      return result();
    },
    dispose: async () => undefined,
    ...options.ocr,
  };
  const tool = (createOcrToolExtension({ ocr, defaultRoot: root }).tools ?? [])[0]!;
  const api = {
    agent: async () => ({ cwd: root }),
    env: {
      readBinaryFile: async () =>
        options.readError
          ? { ok: false, error: options.readError }
          : { ok: true, value: options.bytes ?? new Uint8Array([1, 2, 3]) },
    },
  };
  const pending = (
    tool as unknown as {
      execute: (args: unknown, api: unknown, context: unknown) => Promise<ToolResult>;
    }
  ).execute(options.args, api, {});
  return { pending, calls };
}

describe('ocr_image tool', () => {
  it('returns recognised text with image metadata', async () => {
    const { pending, calls } = runTool({ args: { path: 'shot.png' } });
    const output = await pending;

    expect(output.isError).toBeUndefined();
    expect(calls).toEqual([3]);
    expect(output.output?.[0]?.text).toContain('订单确认单');
    expect(output.output?.[0]?.text).toContain('800×600');
    expect(output.details).toMatchObject({ file: 'shot.png', engine: 'webgpu', truncated: false });
  });

  it('prefixes each line with its box when detail=lines', async () => {
    const { pending } = runTool({ args: { path: 'shot.png', detail: 'lines' } });
    const output = await pending;

    expect(output.output?.[0]?.text).toContain('[10,20 100×30 0.97] 订单确认单');
  });

  it('refuses paths outside the workspace', async () => {
    const { pending, calls } = runTool({ args: { path: '../../outside/secret.png' } });
    const output = await pending;

    expect(output.isError).toBe(true);
    expect(calls).toEqual([]);
    expect(output.output?.[0]?.text).toContain('只能识别工作区内的图片');
  });

  it('refuses a symlink that points outside the workspace', async () => {
    const { pending } = runTool({ args: { path: 'escape.png' } });
    const output = await pending;

    expect(output.isError).toBe(true);
    expect(output.output?.[0]?.text).toContain('符号链接');
  });

  it('rejects non-image extensions before reading', async () => {
    const { pending, calls } = runTool({ args: { path: 'notes.txt' } });
    const output = await pending;

    expect(output.isError).toBe(true);
    expect(calls).toEqual([]);
    expect(output.output?.[0]?.text).toContain('不支持的图片格式');
  });

  it('reports a missing file', async () => {
    const { pending } = runTool({
      args: { path: 'shot.png' },
      readError: { code: 'not_found', message: 'ENOENT' },
    });
    const output = await pending;

    expect(output.isError).toBe(true);
    expect(output.output?.[0]?.text).toContain('找不到图片');
  });

  it('refuses images over 15MB', async () => {
    const { pending, calls } = runTool({ args: { path: 'shot.png' }, bytes: new Uint8Array(15 * 1024 * 1024 + 1) });
    const output = await pending;

    expect(output.isError).toBe(true);
    expect(calls).toEqual([]);
    expect(output.output?.[0]?.text).toContain('图片过大');
  });

  it('explains an engine failure instead of throwing', async () => {
    const { pending } = runTool({
      args: { path: 'shot.png' },
      ocr: { recognize: async () => Promise.reject(new Error('OCR 引擎不可用')) },
    });
    const output = await pending;

    expect(output.isError).toBe(true);
    expect(output.output?.[0]?.text).toContain('OCR 引擎不可用');
  });

  it('succeeds with a note when the image has no text', async () => {
    const { pending } = runTool({
      args: { path: 'shot.png' },
      ocr: { recognize: async () => result({ text: '', lines: [], confidence: 0 }) },
    });
    const output = await pending;

    expect(output.isError).toBeUndefined();
    expect(output.output?.[0]?.text).toContain('未识别到文字');
  });

  it('truncates long text and says so', async () => {
    const long = '长'.repeat(9_000);
    const { pending } = runTool({
      args: { path: 'shot.png' },
      ocr: {
        recognize: async () =>
          result({
            text: long,
            lines: [{ text: long, box: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.9 }],
          }),
      },
    });
    const output = await pending;

    expect(output.details?.truncated).toBe(true);
    expect(output.output?.[0]?.text).toContain('已截断');
    expect(output.output?.[0]?.text.length).toBeLessThan(long.length + 500);
  });
});
