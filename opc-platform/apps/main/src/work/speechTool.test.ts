import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSpeechToolExtension } from './speechTool';

interface ToolResult {
  isError?: boolean;
  output?: { text: string }[];
  details?: Record<string, unknown>;
}

interface FakeTool {
  name: string;
  execute: (args: unknown, api: unknown, context: unknown) => Promise<ToolResult>;
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'opc-speech-tool-'));
  await mkdir(path.join(root, 'recordings'), { recursive: true });
  await writeFile(path.join(root, 'recordings', 'standup.mp3'), new Uint8Array([1, 2, 3]));
  await writeFile(path.join(root, 'notes.txt'), 'not audio');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function tools(deps: {
  transcribe?: (input: {
    audio: Uint8Array;
    mimeType: string;
    language?: 'auto' | 'zh' | 'en';
  }) => Promise<{ ok: boolean; text?: string; model?: string; seconds?: number; error?: string }>;
  synthesize?: (input: {
    text: string;
    voice?: string;
    format?: 'wav' | 'mp3';
  }) => Promise<{ ok: boolean; bytes?: Uint8Array; mimeType?: string; model?: string; error?: string }>;
}) {
  const extension = createSpeechToolExtension({ ...deps, defaultRoot: root });
  return (extension.tools ?? []) as unknown as FakeTool[];
}

function fakeApi(bytes = new Uint8Array([1, 2, 3])) {
  const writes: { path: string; bytes: number }[] = [];
  return {
    writes,
    api: {
      agent: async () => ({ cwd: root }),
      env: {
        readBinaryFile: async () => ({ ok: true, value: bytes }),
        writeFile: async (target: string, content: Uint8Array) => {
          writes.push({ path: target, bytes: content.byteLength });
          return { ok: true };
        },
      },
    },
  };
}

describe('transcribe_audio tool', () => {
  it('sends the workspace audio with its MIME type and returns the transcript', async () => {
    const calls: { mimeType: string; language?: string; bytes: number }[] = [];
    const [tool] = tools({
      transcribe: async (input) => {
        calls.push({ mimeType: input.mimeType, language: input.language, bytes: input.audio.byteLength });
        return { ok: true, text: '今天先过一遍进度', model: 'mimo-v2.5-asr', seconds: 12 };
      },
    });
    const { api } = fakeApi();

    const output = await tool!.execute({ path: 'recordings/standup.mp3', language: 'zh' }, api, {});

    expect(output.isError).toBeUndefined();
    expect(calls).toEqual([{ mimeType: 'audio/mpeg', language: 'zh', bytes: 3 }]);
    expect(output.output?.[0]?.text).toContain('今天先过一遍进度');
    expect(output.details).toMatchObject({ file: 'recordings/standup.mp3', model: 'mimo-v2.5-asr' });
  });

  it('refuses paths outside the workspace', async () => {
    const [tool] = tools({ transcribe: async () => ({ ok: true, text: 'x' }) });

    const output = await tool!.execute({ path: '../../etc/passwd.mp3' }, fakeApi().api, {});

    expect(output.isError).toBe(true);
    expect(output.output?.[0]?.text).toContain('只能转写工作区内的音频');
  });

  it('rejects a non-audio extension before calling the provider', async () => {
    let called = 0;
    const [tool] = tools({
      transcribe: async () => {
        called += 1;
        return { ok: true, text: 'x' };
      },
    });

    const output = await tool!.execute({ path: 'notes.txt' }, fakeApi().api, {});

    expect(output.isError).toBe(true);
    expect(called).toBe(0);
    expect(output.output?.[0]?.text).toContain('不支持的音频格式');
  });

  it('explains a provider failure instead of throwing', async () => {
    const [tool] = tools({ transcribe: async () => ({ ok: false, error: 'HTTP 401' }) });

    const output = await tool!.execute({ path: 'recordings/standup.mp3' }, fakeApi().api, {});

    expect(output.isError).toBe(true);
    expect(output.output?.[0]?.text).toContain('HTTP 401');
  });

  it('writes a long transcript to a file and returns only the head', async () => {
    const long = '会'.repeat(13_000);
    const [tool] = tools({ transcribe: async () => ({ ok: true, text: long }) });
    const { api, writes } = fakeApi();

    const output = await tool!.execute({ path: 'recordings/standup.mp3' }, api, {});

    expect(output.isError).toBeUndefined();
    expect(writes.map((write) => write.path)).toEqual(['standup.transcript.md']);
    expect(output.details).toMatchObject({ transcriptFile: 'standup.transcript.md', chars: 13_000 });
    expect(output.output?.[0]?.text).toContain('standup.transcript.md');
    // The inline part is capped, not the file.
    expect(output.output?.[0]?.text.length).toBeLessThan(13_000);
  });
});

describe('text_to_speech tool', () => {
  it('synthesises to mp3 by default and writes the file', async () => {
    const calls: { text: string; format?: string; voice?: string }[] = [];
    const [tool] = tools({
      synthesize: async (input) => {
        calls.push({ text: input.text, format: input.format, voice: input.voice });
        return { ok: true, bytes: new Uint8Array([9, 8, 7]), mimeType: 'audio/mpeg', model: 'mimo-v2.5-tts' };
      },
    });
    const { api, writes } = fakeApi();

    const output = await tool!.execute({ text: '  欢迎收听  ', voice: '冰糖' }, api, {});

    expect(output.isError).toBeUndefined();
    expect(calls).toEqual([{ text: '欢迎收听', format: 'mp3', voice: '冰糖' }]);
    expect(writes).toEqual([{ path: expect.stringMatching(/^speech-\d+\.mp3$/), bytes: 3 }]);
    expect(output.details).toMatchObject({ chars: 4, model: 'mimo-v2.5-tts' });
  });

  it('honours an explicit wav format and file name', async () => {
    const [tool] = tools({
      synthesize: async () => ({ ok: true, bytes: new Uint8Array([1]), mimeType: 'audio/wav' }),
    });
    const { api, writes } = fakeApi();

    await tool!.execute({ text: 'hi', format: 'wav', filename: '../intro' }, api, {});

    expect(writes[0]?.path).toBe('intro.wav');
  });

  it('rejects text over the per-request limit', async () => {
    let called = 0;
    const [tool] = tools({
      synthesize: async () => {
        called += 1;
        return { ok: true, bytes: new Uint8Array([1]) };
      },
    });

    const output = await tool!.execute({ text: 'a'.repeat(4_001) }, fakeApi().api, {});

    expect(output.isError).toBe(true);
    expect(called).toBe(0);
    expect(output.output?.[0]?.text).toContain('文本过长');
  });

  it('rejects empty text', async () => {
    const [tool] = tools({ synthesize: async () => ({ ok: true, bytes: new Uint8Array([1]) }) });

    const output = await tool!.execute({ text: '   ' }, fakeApi().api, {});

    expect(output.isError).toBe(true);
    expect(output.output?.[0]?.text).toContain('不能为空');
  });
});

describe('createSpeechToolExtension', () => {
  it('installs only the halves that are configured', () => {
    expect(tools({ transcribe: async () => ({ ok: true, text: 'x' }) }).map((tool) => tool.name)).toEqual([
      'transcribe_audio',
    ]);
    expect(tools({ synthesize: async () => ({ ok: true }) }).map((tool) => tool.name)).toEqual([
      'text_to_speech',
    ]);
    expect(
      tools({
        transcribe: async () => ({ ok: true, text: 'x' }),
        synthesize: async () => ({ ok: true }),
      }).map((tool) => tool.name),
    ).toEqual(['transcribe_audio', 'text_to_speech']);
  });
});
