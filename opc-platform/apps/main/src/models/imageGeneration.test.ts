import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateImage } from './imageGeneration';

// 1×1 transparent PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let server: http.Server;
let baseUrl = '';
let lastBody: unknown = null;
let lastHeaders: http.IncomingHttpHeaders = {};
let lastPath = '';
type Mode =
  | 'b64'
  | 'url'
  | 'http500'
  | 'garbage'
  | 'chat-ok'
  | 'chat-text'
  | 'gemini-ok'
  | 'gemini-text';

let mode: Mode = 'b64';

beforeAll(async () => {
  server = http.createServer((request, response) => {
    lastPath = request.url ?? '';
    lastHeaders = request.headers;

    if (request.url?.endsWith('/image.png')) {
      response
        .writeHead(200, { 'content-type': 'image/png' })
        .end(Buffer.from(PNG_BASE64, 'base64'));
      return;
    }

    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      try {
        lastBody = JSON.parse(body) as unknown;
      } catch {
        lastBody = body;
      }

      if (request.url === '/v1/images/generations') {
        if (mode === 'http500') {
          response.writeHead(500, { 'content-type': 'text/plain' }).end('boom');
          return;
        }
        if (mode === 'garbage') {
          response.writeHead(200, { 'content-type': 'text/plain' }).end('not json');
          return;
        }
        const payload =
          mode === 'url' ? { data: [{ url: `${baseUrl}/image.png` }] } : { data: [{ b64_json: PNG_BASE64 }] };
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
        return;
      }

      if (request.url === '/v1/chat/completions') {
        const payload =
          mode === 'chat-text'
            ? { choices: [{ message: { content: 'I cannot draw that.' } }] }
            : {
                choices: [
                  {
                    message: {
                      images: [{ image_url: { url: `data:image/png;base64,${PNG_BASE64}` } }],
                    },
                  },
                ],
              };
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
        return;
      }

      if (request.url?.includes(':generateContent')) {
        const payload =
          mode === 'gemini-text'
            ? { candidates: [{ content: { parts: [{ text: 'blocked by policy' }] } }] }
            : {
                candidates: [
                  {
                    content: {
                      parts: [{ inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }],
                    },
                  },
                ],
              };
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
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

describe('generateImage · openai-images', () => {
  it('posts an OpenAI-compatible payload and decodes b64_json', async () => {
    mode = 'b64';
    const result = await generateImage({
      baseUrl,
      apiKey: 'test-key',
      model: 'gpt-image-1',
      prompt: 'a red cube',
      protocol: 'openai-images',
    });

    expect(lastPath).toBe('/v1/images/generations');
    expect(lastBody).toMatchObject({
      model: 'gpt-image-1',
      prompt: 'a red cube',
      n: 1,
      size: '1024x1024',
    });
    // gpt-image-* rejects response_format; DALL·E-style URLs are still handled.
    expect(lastBody).not.toHaveProperty('response_format');
    expect(result.bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(result.mimeType).toBe('image/png');
  });

  it('downloads the image when the provider returns a url instead', async () => {
    mode = 'url';
    const result = await generateImage({ baseUrl, apiKey: 'k', model: 'm', prompt: 'p' });
    expect(result.bytes.byteLength).toBeGreaterThan(0);
    expect(result.mimeType).toBe('image/png');
  });

  it('surfaces HTTP errors with the response body', async () => {
    mode = 'http500';
    await expect(generateImage({ baseUrl, apiKey: 'k', model: 'm', prompt: 'p' })).rejects.toThrow(
      /HTTP 500: boom/,
    );
  });

  it('rejects a non-JSON response instead of returning empty bytes', async () => {
    mode = 'garbage';
    await expect(generateImage({ baseUrl, apiKey: 'k', model: 'm', prompt: 'p' })).rejects.toThrow(
      /不是 JSON/,
    );
  });
});

describe('generateImage · openrouter-images', () => {
  it('uses chat completions with the image modality', async () => {
    mode = 'chat-ok';
    const result = await generateImage({
      baseUrl,
      apiKey: 'or-key',
      model: 'google/gemini-2.5-flash-image',
      prompt: 'a blue circle',
      protocol: 'openrouter-images',
    });

    expect(lastPath).toBe('/v1/chat/completions');
    expect(lastHeaders.authorization).toBe('Bearer or-key');
    expect(lastBody).toMatchObject({
      model: 'google/gemini-2.5-flash-image',
      modalities: ['image', 'text'],
    });
    expect(result.bytes.byteLength).toBeGreaterThan(0);
    expect(result.mimeType).toBe('image/png');
  });

  it('reports a text-only refusal instead of returning empty bytes', async () => {
    mode = 'chat-text';
    await expect(
      generateImage({ baseUrl, apiKey: 'k', model: 'm', prompt: 'p', protocol: 'openrouter-images' }),
    ).rejects.toThrow(/I cannot draw that/);
  });
});

describe('generateImage · google-images', () => {
  it('calls Gemini generateContent with the model in the path', async () => {
    mode = 'gemini-ok';
    const result = await generateImage({
      baseUrl,
      apiKey: 'gem-key',
      model: 'gemini-2.5-flash-image',
      prompt: 'a green triangle',
      protocol: 'google-images',
    });

    expect(lastPath).toBe('/v1/models/gemini-2.5-flash-image:generateContent');
    expect(lastHeaders['x-goog-api-key']).toBe('gem-key');
    expect(lastBody).toMatchObject({
      contents: [{ role: 'user', parts: [{ text: 'a green triangle' }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    });
    expect(result.bytes.byteLength).toBeGreaterThan(0);
    expect(result.mimeType).toBe('image/png');
  });

  it('reports a blocked prompt instead of returning empty bytes', async () => {
    mode = 'gemini-text';
    await expect(
      generateImage({ baseUrl, apiKey: 'k', model: 'm', prompt: 'p', protocol: 'google-images' }),
    ).rejects.toThrow(/blocked by policy/);
  });
});
