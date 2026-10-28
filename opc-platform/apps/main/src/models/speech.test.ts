import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { synthesizeSpeech, transcribeAudio } from './speech';

const WAV_BASE64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';
const AUDIO = new Uint8Array([1, 2, 3, 4]);

let server: http.Server;
let baseUrl = '';
let lastBody: unknown = null;
let lastContentType = '';
let lastPath = '';
type Mode = 'asr' | 'tts' | 'voicedesign' | 'empty' | 'http500';

let mode: Mode = 'asr';

beforeAll(async () => {
  server = http.createServer((request, response) => {
    lastPath = request.url ?? '';
    lastContentType = String(request.headers['content-type'] ?? '');
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      try {
        lastBody = JSON.parse(raw.toString('utf8')) as unknown;
      } catch {
        lastBody = raw.toString('utf8');
      }

      if (mode === 'http500') {
        response.writeHead(500, { 'content-type': 'text/plain' }).end('boom');
        return;
      }

      if (request.url === '/v1/audio/transcriptions') {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ text: 'openai transcript' }));
        return;
      }

      if (request.url === '/v1/audio/speech') {
        response.writeHead(200, { 'content-type': 'audio/mpeg' }).end(Buffer.from([9, 8, 7]));
        return;
      }

      if (request.url === '/v1/chat/completions') {
        if (mode === 'asr') {
          response.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              choices: [{ message: { role: 'assistant', content: '你好，世界' } }],
              usage: { seconds: 4 },
            }),
          );
          return;
        }
        if (mode === 'empty') {
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ choices: [{ message: { content: '' } }] }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  audio: { data: WAV_BASE64, transcript: null },
                },
              },
            ],
          }),
        );
        return;
      }

      response.writeHead(404).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('transcribeAudio · xiaomi-audio', () => {
  it('sends an input_audio data URL and returns the transcript', async () => {
    mode = 'asr';
    const result = await transcribeAudio({
      baseUrl,
      apiKey: 'test-key',
      model: 'mimo-v2.5-asr',
      protocol: 'xiaomi-audio',
      audio: AUDIO,
      mimeType: 'audio/wav',
      language: 'zh',
    });

    expect(result.text).toBe('你好，世界');
    expect(result.seconds).toBe(4);
    expect(lastPath).toBe('/v1/chat/completions');

    const body = lastBody as {
      model: string;
      asr_options: { language: string };
      messages: {
        content: { input_audio: { data: string; format: string } }[];
      }[];
    };
    expect(body.model).toBe('mimo-v2.5-asr');
    expect(body.asr_options.language).toBe('zh');
    expect(body.messages[0]?.content[0]?.input_audio.format).toBe('wav');
    expect(body.messages[0]?.content[0]?.input_audio.data.startsWith('data:audio/wav;base64,')).toBe(true);
  });

  it('rejects formats Xiaomi does not accept', async () => {
    await expect(
      transcribeAudio({
        baseUrl,
        apiKey: 'k',
        model: 'mimo-v2.5-asr',
        audio: AUDIO,
        mimeType: 'audio/webm',
      }),
    ).rejects.toThrow('仅支持 mp3/wav');
  });

  it('reports an empty transcript instead of returning an empty string', async () => {
    mode = 'empty';
    await expect(
      transcribeAudio({
        baseUrl,
        apiKey: 'k',
        model: 'mimo-v2.5-asr',
        audio: AUDIO,
        mimeType: 'audio/wav',
      }),
    ).rejects.toThrow('没有返回文本');
  });
});

describe('synthesizeSpeech · xiaomi-audio', () => {
  it('sends the text as an assistant message and decodes audio.data', async () => {
    mode = 'tts';
    const result = await synthesizeSpeech({
      baseUrl,
      apiKey: 'k',
      model: 'mimo-v2.5-tts',
      text: '你好',
      voice: '冰糖',
      format: 'wav',
    });

    expect(result.bytes.toString('base64')).toBe(WAV_BASE64);
    expect(result.mimeType).toBe('audio/wav');

    const body = lastBody as {
      messages: { role: string; content: string }[];
      audio: { format: string; voice?: string };
    };
    expect(body.messages).toEqual([{ role: 'assistant', content: '你好' }]);
    expect(body.audio).toEqual({ format: 'wav', voice: '冰糖' });
  });

  it('uses the user message as the voice description for voicedesign', async () => {
    mode = 'voicedesign';
    await synthesizeSpeech({
      baseUrl,
      apiKey: 'k',
      model: 'mimo-v2.5-tts-voicedesign',
      text: '欢迎收听',
      voice: '低沉、缓慢的男声',
    });

    const body = lastBody as {
      messages: { role: string; content: string }[];
      audio: { format: string; voice?: string };
    };
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: '低沉、缓慢的男声',
    });
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: '欢迎收听',
    });
    expect(body.audio.voice).toBeUndefined();
  });

  it('requires a sample for voiceclone', async () => {
    await expect(
      synthesizeSpeech({
        baseUrl,
        apiKey: 'k',
        model: 'mimo-v2.5-tts-voiceclone',
        text: '你好',
      }),
    ).rejects.toThrow('音色样本');
  });
});

describe('speech · openai-audio', () => {
  it('posts multipart to /audio/transcriptions', async () => {
    mode = 'asr';
    const result = await transcribeAudio({
      baseUrl,
      apiKey: 'k',
      model: 'whisper-1',
      protocol: 'openai-audio',
      audio: AUDIO,
      mimeType: 'audio/webm',
    });

    expect(result.text).toBe('openai transcript');
    expect(lastPath).toBe('/v1/audio/transcriptions');
    expect(lastContentType).toContain('multipart/form-data');
    expect(String(lastBody)).toContain('name="model"');
    expect(String(lastBody)).toContain('whisper-1');
  });

  it('returns the binary body from /audio/speech', async () => {
    const result = await synthesizeSpeech({
      baseUrl,
      apiKey: 'k',
      model: 'tts-1',
      protocol: 'openai-audio',
      text: 'hello',
      format: 'mp3',
    });

    expect(lastPath).toBe('/v1/audio/speech');
    expect([...result.bytes]).toEqual([9, 8, 7]);
    expect(result.mimeType).toBe('audio/mpeg');
  });

  it('surfaces HTTP errors', async () => {
    mode = 'http500';
    await expect(
      transcribeAudio({
        baseUrl,
        apiKey: 'k',
        model: 'mimo-v2.5-asr',
        audio: AUDIO,
        mimeType: 'audio/wav',
      }),
    ).rejects.toThrow('HTTP 500');
  });
});
