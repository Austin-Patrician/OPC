import { describe, expect, it } from 'vitest';
import { buildKlingAuthHeader, generateVideo } from './videoGeneration';
import type { NetworkClient } from '../network/networkClient';

interface MockStep {
  match: (url: string, init?: RequestInit) => boolean;
  handle: (url: string, init?: RequestInit) => Response;
}

function mockNetwork(steps: MockStep[]): { network: NetworkClient; calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> } {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  let cursor = 0;

  const network: NetworkClient = {
    childEnv: (base = process.env) => ({ ...base }),
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
      const headers = Object.fromEntries(
        Object.entries(rawHeaders).map(([k, v]) => [k.toLowerCase(), v]),
      );
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ url, method, headers, body });

      const step = steps[cursor];
      if (!step || !step.match(url, init)) {
        throw new Error(`Unexpected network call #${cursor}: ${method} ${url}`);
      }
      cursor += 1;
      return step.handle(url, init);
    },
  };

  return { network, calls };
}

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const mp4Response = (bytes: number[] = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]) =>
  new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': 'video/mp4' },
  });

describe('generateVideo multi-protocol engine', () => {
  it('supports fal-queue with I2V start/end frames, polling, and download', async () => {
    const { network, calls } = mockNetwork([
      {
        match: (url, init) => url === 'https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video' && init?.method === 'POST',
        handle: () =>
          jsonResponse({
            request_id: 'req-123',
            status_url: 'https://queue.fal.run/fal-ai/kling-video/requests/req-123/status',
            response_url: 'https://queue.fal.run/fal-ai/kling-video/requests/req-123',
          }),
      },
      {
        match: (url) => url.endsWith('/status'),
        handle: () => jsonResponse({ status: 'IN_PROGRESS' }),
      },
      {
        match: (url) => url.endsWith('/status'),
        handle: () => jsonResponse({ status: 'COMPLETED' }),
      },
      {
        match: (url) => url.endsWith('/requests/req-123'),
        handle: () => jsonResponse({ video: { url: 'https://cdn.fal.media/out.mp4' } }),
      },
      {
        match: (url) => url === 'https://cdn.fal.media/out.mp4',
        handle: () => mp4Response([1, 2, 3, 4]),
      },
    ]);

    const result = await generateVideo(
      {
        baseUrl: 'https://queue.fal.run',
        apiKey: 'fal-secret',
        providerId: 'fal',
        protocol: 'fal-queue',
        model: 'fal-ai/kling-video/v3/pro/image-to-video',
        prompt: 'Slow dolly in',
        duration: 5,
        aspectRatio: '16:9',
        startImage: { bytes: new Uint8Array([9, 8]), mimeType: 'image/png' },
        endImage: { bytes: new Uint8Array([7, 6]), mimeType: 'image/jpeg' },
        pollIntervalMs: 1,
      },
      network,
    );

    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4]);
    expect(result.mimeType).toBe('video/mp4');
    expect(calls[0]?.headers.authorization).toBe('Key fal-secret');
    const submitted = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(submitted.image_url).toBe('data:image/png;base64,CQg=');
    expect(submitted.tail_image_url).toBe('data:image/jpeg;base64,BwY=');
  });

  it('supports volcengine-ark-video Seedance first/last frames and status polling', async () => {
    const { network, calls } = mockNetwork([
      {
        match: (url, init) => url === 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks' && init?.method === 'POST',
        handle: () => jsonResponse({ id: 'ark-task-1' }),
      },
      {
        match: (url) => url.endsWith('/contents/generations/tasks/ark-task-1'),
        handle: () => jsonResponse({ status: 'running' }),
      },
      {
        match: (url) => url.endsWith('/contents/generations/tasks/ark-task-1'),
        handle: () =>
          jsonResponse({
            status: 'succeeded',
            duration: 5,
            content: { video_url: 'https://tos.volces.com/seedance.mp4' },
          }),
      },
      {
        match: (url) => url === 'https://tos.volces.com/seedance.mp4',
        handle: () => mp4Response([5, 6, 7]),
      },
    ]);

    const result = await generateVideo(
      {
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        apiKey: 'ark-token',
        providerId: 'volcengine-ark',
        protocol: 'volcengine-ark-video',
        model: 'doubao-seedance-2-5-260628',
        prompt: 'Camera pans right',
        startImage: { bytes: new Uint8Array([1, 2]), mimeType: 'image/png' },
        pollIntervalMs: 1,
      },
      network,
    );

    expect(Array.from(result.bytes)).toEqual([5, 6, 7]);
    expect(result.durationSeconds).toBe(5);
    const submitted = JSON.parse(calls[0]!.body!) as { content: Array<{ role?: string }> };
    expect(submitted.content[1]?.role).toBe('first_frame');
  });

  it('supports kling-video both with AccessKey:SecretKey JWT signing and Bearer tokens', async () => {
    const authHeader = buildKlingAuthHeader('ak123:sk456');
    expect(authHeader.startsWith('Bearer ')).toBe(true);
    expect(authHeader.slice(7).split('.')).toHaveLength(3);
    expect(buildKlingAuthHeader('relay-bearer-token')).toBe('Bearer relay-bearer-token');

    const { network, calls } = mockNetwork([
      {
        match: (url, init) => url === 'https://api.klingai.com/v1/videos/text2video' && init?.method === 'POST',
        handle: () => jsonResponse({ code: 0, data: { task_id: 'kl-9' } }),
      },
      {
        match: (url) => url === 'https://api.klingai.com/v1/videos/text2video/kl-9',
        handle: () =>
          jsonResponse({
            code: 0,
            data: {
              task_status: 'succeed',
              task_result: { videos: [{ url: 'https://cdn.klingai.com/kl-9.mp4', duration: '5' }] },
            },
          }),
      },
      {
        match: (url) => url === 'https://cdn.klingai.com/kl-9.mp4',
        handle: () => mp4Response([10, 20]),
      },
    ]);

    const result = await generateVideo(
      {
        baseUrl: 'https://api.klingai.com',
        apiKey: 'ak123:sk456',
        providerId: 'kling',
        protocol: 'kling-video',
        model: 'kling-3.0',
        prompt: 'Rain on neon street',
        generateAudio: true,
        pollIntervalMs: 1,
      },
      network,
    );

    expect(Array.from(result.bytes)).toEqual([10, 20]);
    expect(result.durationSeconds).toBe(5);
    expect(calls[0]?.headers.authorization?.startsWith('Bearer ')).toBe(true);
  });

  it('supports minimax-video submit, query polling, files/retrieve, and download', async () => {
    const { network } = mockNetwork([
      {
        match: (url, init) => url === 'https://api.minimaxi.com/v1/video_generation' && init?.method === 'POST',
        handle: () => jsonResponse({ task_id: 'mm-1', base_resp: { status_code: 0 } }),
      },
      {
        match: (url) => url === 'https://api.minimaxi.com/v1/query/video_generation?task_id=mm-1',
        handle: () => jsonResponse({ status: 'Processing', base_resp: { status_code: 0 } }),
      },
      {
        match: (url) => url === 'https://api.minimaxi.com/v1/query/video_generation?task_id=mm-1',
        handle: () => jsonResponse({ status: 'Success', file_id: 'file-77', base_resp: { status_code: 0 } }),
      },
      {
        match: (url) => url === 'https://api.minimaxi.com/v1/files/retrieve?file_id=file-77',
        handle: () => jsonResponse({ file: { download_url: 'https://cdn.minimaxi.com/mm-1.mp4' }, base_resp: { status_code: 0 } }),
      },
      {
        match: (url) => url === 'https://cdn.minimaxi.com/mm-1.mp4',
        handle: () => mp4Response([3, 4, 5]),
      },
    ]);

    const result = await generateVideo(
      {
        baseUrl: 'https://api.minimaxi.com/v1',
        apiKey: 'mm-key',
        providerId: 'minimax',
        protocol: 'minimax-video',
        model: 'MiniMax-H3',
        prompt: 'Cat leaps onto windowsill',
        pollIntervalMs: 1,
      },
      network,
    );

    expect(Array.from(result.bytes)).toEqual([3, 4, 5]);
  });

  it('supports google-veo predictLongRunning and authenticated URI download', async () => {
    const { network, calls } = mockNetwork([
      {
        match: (url, init) =>
          url === 'https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-001:predictLongRunning' &&
          init?.method === 'POST',
        handle: () => jsonResponse({ name: 'operations/veo-op-1', done: false }),
      },
      {
        match: (url) => url === 'https://generativelanguage.googleapis.com/v1beta/operations/veo-op-1',
        handle: () =>
          jsonResponse({
            name: 'operations/veo-op-1',
            done: true,
            response: {
              generateVideoResponse: {
                generatedSamples: [{ video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/v1:download' } }],
              },
            },
          }),
      },
      {
        match: (url) => url === 'https://generativelanguage.googleapis.com/v1beta/files/v1:download',
        handle: () => mp4Response([9, 9]),
      },
    ]);

    const result = await generateVideo(
      {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'goog-key',
        providerId: 'google',
        protocol: 'google-veo',
        model: 'veo-3.1-generate-001',
        prompt: 'Ocean waves at golden hour',
        duration: 6,
        pollIntervalMs: 1,
      },
      network,
    );

    expect(Array.from(result.bytes)).toEqual([9, 9]);
    expect(calls[2]?.headers['x-goog-api-key']).toBe('goog-key');
  });

  it('supports openai-videos gateway and /content download fallback', async () => {
    const { network } = mockNetwork([
      {
        match: (url, init) => url === 'https://relay.example.com/v1/videos' && init?.method === 'POST',
        handle: () => jsonResponse({ id: 'vid-88', status: 'queued' }),
      },
      {
        match: (url) => url === 'https://relay.example.com/v1/videos/vid-88',
        handle: () => jsonResponse({ id: 'vid-88', status: 'completed' }),
      },
      {
        match: (url) => url === 'https://relay.example.com/v1/videos/vid-88/content',
        handle: () => mp4Response([42, 43]),
      },
    ]);

    const result = await generateVideo(
      {
        baseUrl: 'https://relay.example.com/v1',
        apiKey: 'relay-key',
        providerId: 'openai-video',
        protocol: 'openai-videos',
        model: 'sora-2',
        prompt: 'Drone flyover',
        duration: 8,
        pollIntervalMs: 1,
      },
      network,
    );

    expect(Array.from(result.bytes)).toEqual([42, 43]);
  });

  it('aborts cleanly when signal is triggered during polling', async () => {
    const controller = new AbortController();
    const { network } = mockNetwork([
      {
        match: () => true,
        handle: () => {
          setTimeout(() => controller.abort(), 5);
          return jsonResponse({ id: 'vid-abort', status: 'queued' });
        },
      },
      {
        match: () => true,
        handle: () => jsonResponse({ id: 'vid-abort', status: 'in_progress' }),
      },
    ]);

    await expect(
      generateVideo(
        {
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'relay-key',
          providerId: 'openai-video',
          protocol: 'openai-videos',
          model: 'sora-2',
          prompt: 'Abort test',
          signal: controller.signal,
          pollIntervalMs: 500,
        },
        network,
      ),
    ).rejects.toThrow(/取消/);
  });
});
