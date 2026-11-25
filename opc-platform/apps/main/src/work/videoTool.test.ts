import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@earendil-works/chord/context';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import type { VideoGenerateBytesInput } from '../models/videoService';
import { createVideoToolExtension } from './videoTool';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'opc-video-tool-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function toolOf(generate: (input: VideoGenerateBytesInput) => ReturnType<typeof createMockResult>) {
  const ext = createVideoToolExtension({ generate, defaultRoot: workspace });
  return ext.tools![0]!;
}

async function createMockResult() {
  return {
    ok: true as const,
    bytes: new Uint8Array([0x00, 0x01, 0x02]),
    mimeType: 'video/mp4',
    providerId: 'kling',
    model: 'kling-3.0',
    durationSeconds: 5,
  };
}

function makeApi(filesWritten: Map<string, Uint8Array>, filesOnDisk: Map<string, Uint8Array>): ToolExecutionApi {
  return {
    agent: async () => ({ cwd: workspace }),
    env: {
      readBinaryFile: async (target: string) => {
        const bytes = filesOnDisk.get(path.resolve(target));
        if (!bytes) return { ok: false, error: { code: 'not_found' } };
        return { ok: true, value: bytes };
      },
      writeFile: async (relPath: string, content: Uint8Array) => {
        filesWritten.set(relPath, content);
        return { ok: true, value: undefined };
      },
    },
  } as unknown as ToolExecutionApi;
}

describe('generate_video tool', () => {
  it('writes generated MP4 into workspace and forwards prompt parameters', async () => {
    const written = new Map<string, Uint8Array>();
    const generate = vi.fn(async () => createMockResult());
    const tool = toolOf(generate);

    const result = await tool.execute(
      {
        prompt: 'Wide tracking shot of a mountain lake',
        filename: './output/hero',
        duration: 5,
        aspectRatio: '16:9',
        resolution: '1080p',
        generateAudio: true,
      },
      makeApi(written, new Map()),
      {} as Context,
    );

    expect(result.isError).toBeUndefined();
    expect(written.get('output/hero.mp4')).toEqual(new Uint8Array([0x00, 0x01, 0x02]));
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Wide tracking shot of a mountain lake',
        duration: 5,
        aspectRatio: '16:9',
        resolution: '1080p',
        generateAudio: true,
      }),
    );
  });

  it('loads workspace start/end reference keyframes for image-to-video', async () => {
    const startPath = path.join(workspace, 'frames', 'start.png');
    const endPath = path.join(workspace, 'frames', 'end.jpg');
    mkdirSync(path.dirname(startPath), { recursive: true });
    writeFileSync(startPath, 'stub');
    writeFileSync(endPath, 'stub');

    const disk = new Map<string, Uint8Array>([
      [path.resolve(startPath), new Uint8Array([11, 22])],
      [path.resolve(endPath), new Uint8Array([33, 44])],
    ]);
    const written = new Map<string, Uint8Array>();
    const generate = vi.fn(async () => createMockResult());
    const tool = toolOf(generate);

    const result = await tool.execute(
      {
        prompt: 'Smooth transition',
        imagePath: 'frames/start.png',
        endImagePath: 'frames/end.jpg',
        filename: 'shot1.mp4',
      },
      makeApi(written, disk),
      {} as Context,
    );

    expect(result.isError).toBeUndefined();
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        startImage: { bytes: new Uint8Array([11, 22]), mimeType: 'image/png' },
        endImage: { bytes: new Uint8Array([33, 44]), mimeType: 'image/jpeg' },
      }),
    );
  });

  it('rejects path traversal on imagePath and output filename', async () => {
    const written = new Map<string, Uint8Array>();
    const generate = vi.fn(async () => createMockResult());
    const tool = toolOf(generate);

    const badInput = await tool.execute(
      { prompt: 'x', imagePath: '../secret.png' },
      makeApi(written, new Map()),
      {} as Context,
    );
    expect(badInput.isError).toBe(true);
    expect(generate).not.toHaveBeenCalled();

    const badOutput = await tool.execute(
      { prompt: 'x', filename: '../escape.mp4' },
      makeApi(written, new Map()),
      {} as Context,
    );
    expect(badOutput.isError).toBe(true);
  });
});
