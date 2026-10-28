import { defaultNetworkClient, type NetworkClient } from '../network/networkClient';

export interface GenerateImageInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  /** OpenAI-compatible size string, e.g. `1024x1024`. */
  size?: string;
  signal?: AbortSignal;
  /** Provider id, for request attribution when logging failures. */
  providerId?: string;
  /** Network seam; defaults to the plain global fetch (tests). */
  network?: NetworkClient;
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
  model: string;
  /** Raw provider payload size, for diagnostics. */
  responseBytes: number;
}

/**
 * Image generation over the OpenAI-compatible `/images/generations` endpoint.
 *
 * Why not `models.generateImages`: pi registers a single image API
 * (`openrouter-images`) whose provider wiring we cannot exercise without an
 * OpenRouter key. The endpoint below is what OpenRouter and most compatible
 * relays implement, so it works with the same provider config as chat — and it
 * can be verified against a local mock server.
 */
export async function generateImage(input: GenerateImageInput): Promise<GeneratedImage> {
  const network = input.network ?? defaultNetworkClient;
  const context = { purpose: 'image' as const, providerId: input.providerId };
  const endpoint = `${input.baseUrl.replace(/\/$/, '')}/images/generations`;
  const response = await network.fetch(
    endpoint,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        n: 1,
        size: input.size ?? '1024x1024',
        response_format: 'b64_json',
      }),
      signal: input.signal ?? AbortSignal.timeout(120_000),
    },
    context,
  );

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`图像接口 HTTP ${response.status}: ${raw.slice(0, 300)}`);
  }

  let payload: { data?: { b64_json?: string; url?: string }[] };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    throw new Error(`图像接口返回的不是 JSON: ${raw.slice(0, 200)}`);
  }

  const first = payload.data?.[0];
  if (!first) throw new Error('图像接口没有返回 data[0]');

  if (first.b64_json) {
    return {
      bytes: Buffer.from(first.b64_json, 'base64'),
      mimeType: 'image/png',
      model: input.model,
      responseBytes: raw.length,
    };
  }

  if (first.url) {
    // Some relays ignore `response_format` and return a URL; fetch it once so the
    // artifact is on disk instead of depending on a remote host.
    const image = await network.fetch(
      first.url,
      { signal: input.signal ?? AbortSignal.timeout(120_000) },
      context,
    );
    if (!image.ok) throw new Error(`下载生成图失败: HTTP ${image.status}`);
    const bytes = Buffer.from(await image.arrayBuffer());
    return {
      bytes,
      mimeType: image.headers.get('content-type') ?? 'image/png',
      model: input.model,
      responseBytes: raw.length,
    };
  }

  throw new Error('图像接口既没有 b64_json 也没有 url');
}
