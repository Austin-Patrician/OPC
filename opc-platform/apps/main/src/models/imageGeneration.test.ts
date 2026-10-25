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
let mode: 'b64' | 'url' | 'http500' | 'garbage' = 'b64';

beforeAll(async () => {
  server = http.createServer((request, response) => {
    if (request.url === '/v1/images/generations') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        lastBody = JSON.parse(body) as unknown;
        if (mode === 'http500') {
          response.writeHead(500, { 'content-type': 'text/plain' }).end('boom');
          return;
        }
        if (mode === 'garbage') {
          response.writeHead(200, { 'content-type': 'text/plain' }).end('not json');
          return;
        }
        const payload =
          mode === 'url'
            ? { data: [{ url: `${baseUrl}/image.png` }] }
            : { data: [{ b64_json: PNG_BASE64 }] };
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
      });
      return;
    }

    if (request.url?.endsWith('/image.png')) {
      response
        .writeHead(200, { 'content-type': 'image/png' })
        .end(Buffer.from(PNG_BASE64, 'base64'));
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('generateImage', () => {
  it('posts an OpenAI-compatible payload and decodes b64_json', async () => {
    mode = 'b64';
    const result = await generateImage({
      baseUrl,
      apiKey: 'test-key',
      model: 'vendor/model-1',
      prompt: 'a red cube',
    });

    expect(lastBody).toMatchObject({
      model: 'vendor/model-1',
      prompt: 'a red cube',
      n: 1,
      response_format: 'b64_json',
    });
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
