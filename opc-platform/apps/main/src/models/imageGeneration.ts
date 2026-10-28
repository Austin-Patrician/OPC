import { defaultNetworkClient, type NetworkClient } from '../network/networkClient';

/** Wire protocols an image model can speak. Mirrors `ModelOption.api`. */
export const IMAGE_PROTOCOLS = ['openai-images', 'openrouter-images', 'google-images'] as const;

export interface GenerateImageInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  /** `ModelOption.api`; unknown values fall back to `openai-images`. */
  protocol?: string;
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

interface ImageRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Image generation for the three protocols the settings page exposes:
 *
 * - `openai-images`     → OpenAI-compatible `POST /images/generations`
 * - `openrouter-images` → OpenRouter chat completions with `modalities: ['image']`
 *   (this is what pi's own image API does; OpenRouter has no /images endpoint)
 * - `google-images`     → Gemini `POST /models/{model}:generateContent`
 *
 * Provider/base URL/API key all come from the stored provider row, so the same
 * built-in models can be pointed at a relay by editing the base URL.
 */
export async function generateImage(input: GenerateImageInput): Promise<GeneratedImage> {
  const protocol = normalizeProtocol(input.protocol);
  switch (protocol) {
    case 'openrouter-images':
      return generateOpenRouter(input);
    case 'google-images':
      return generateGemini(input);
    default:
      return generateOpenAiCompat(input);
  }
}

function normalizeProtocol(value: string | undefined): (typeof IMAGE_PROTOCOLS)[number] {
  return IMAGE_PROTOCOLS.find((protocol) => protocol === value) ?? 'openai-images';
}

async function generateOpenAiCompat(input: GenerateImageInput): Promise<GeneratedImage> {
  const { payload: raw, responseBytes } = await postJson(input, {
    url: `${trimBase(input.baseUrl)}/images/generations`,
    headers: { authorization: `Bearer ${input.apiKey}` },
    body: {
      model: input.model,
      prompt: input.prompt,
      n: 1,
      size: input.size ?? '1024x1024',
      // No `response_format`: gpt-image-* always returns b64 and rejects the
      // parameter, while DALL·E-style relays can return a URL (handled below).
    },
  });

  const first = (raw as { data?: { b64_json?: string; url?: string }[] }).data?.[0];
  if (!first) throw new Error('图像接口没有返回 data[0]');

  if (first.b64_json) {
    return finish(input, Buffer.from(first.b64_json, 'base64'), 'image/png', responseBytes);
  }
  if (first.url) return download(input, first.url, responseBytes);
  throw new Error('图像接口既没有 b64_json 也没有 url');
}

interface ChatImageResponse {
  choices?: {
    message?: {
      content?: string | { type?: string; text?: string; image_url?: { url?: string } | string }[];
      images?: { image_url?: string | { url?: string } }[];
    };
  }[];
}

async function generateOpenRouter(input: GenerateImageInput): Promise<GeneratedImage> {
  const { payload: raw, responseBytes } = await postJson(input, {
    url: `${trimBase(input.baseUrl)}/chat/completions`,
    headers: { authorization: `Bearer ${input.apiKey}` },
    body: {
      model: input.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
      modalities: ['image', 'text'],
      stream: false,
    },
  });

  const message = (raw as ChatImageResponse).choices?.[0]?.message;
  const urls: string[] = [];
  for (const image of message?.images ?? []) {
    const url = typeof image.image_url === 'string' ? image.image_url : image.image_url?.url;
    if (url) urls.push(url);
  }
  if (Array.isArray(message?.content)) {
    for (const part of message.content) {
      if (part.type !== 'image_url') continue;
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (url) urls.push(url);
    }
  }

  for (const url of urls) {
    const decoded = decodeDataUrl(url);
    if (decoded) return finish(input, decoded.bytes, decoded.mimeType, responseBytes);
    return download(input, url, responseBytes);
  }

  const text = typeof message?.content === 'string' ? message.content : '';
  throw new Error(`图像接口没有返回图片${text ? `：${text.slice(0, 300)}` : ''}`);
}

interface GeminiResponse {
  candidates?: {
    content?: {
      parts?: {
        text?: string;
        inlineData?: { mimeType?: string; data?: string };
        inline_data?: { mime_type?: string; data?: string };
      }[];
    };
  }[];
  promptFeedback?: { blockReason?: string };
}

async function generateGemini(input: GenerateImageInput): Promise<GeneratedImage> {
  const { payload, responseBytes } = await postJson(input, {
    url: `${trimBase(input.baseUrl)}/models/${encodeURIComponent(input.model)}:generateContent`,
    headers: { 'x-goog-api-key': input.apiKey },
    body: {
      contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
      // Gemini image models need the response modality declared explicitly.
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    },
  });

  const parts = (payload as GeminiResponse).candidates?.flatMap((candidate) => candidate.content?.parts ?? []) ?? [];
  for (const part of parts) {
    const inline = part.inlineData ?? part.inline_data;
    if (!inline?.data) continue;
    const mimeType = part.inlineData?.mimeType ?? part.inline_data?.mime_type ?? 'image/png';
    return finish(input, Buffer.from(inline.data, 'base64'), mimeType, responseBytes);
  }

  const blocked = (payload as GeminiResponse).promptFeedback?.blockReason;
  const text = parts
    .map((part) => part.text)
    .filter((value): value is string => Boolean(value))
    .join('\n');
  const reason = blocked ? `（${blocked}）` : text ? `：${text.slice(0, 300)}` : '';
  throw new Error(`图像接口没有返回图片${reason}`);
}

/** POSTs JSON and turns non-2xx / non-JSON responses into actionable errors. */
async function postJson(
  input: GenerateImageInput,
  request: ImageRequest,
): Promise<{ payload: unknown; responseBytes: number }> {
  const network = input.network ?? defaultNetworkClient;
  const response = await network.fetch(
    request.url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      signal: input.signal ?? AbortSignal.timeout(120_000),
    },
    { purpose: 'image', providerId: input.providerId },
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`图像接口 HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  try {
    return { payload: JSON.parse(text) as unknown, responseBytes: text.length };
  } catch {
    throw new Error(`图像接口返回的不是 JSON: ${text.slice(0, 200)}`);
  }
}

async function download(
  input: GenerateImageInput,
  url: string,
  responseBytes: number,
): Promise<GeneratedImage> {
  const network = input.network ?? defaultNetworkClient;
  const response = await network.fetch(
    url,
    { signal: input.signal ?? AbortSignal.timeout(120_000) },
    { purpose: 'image', providerId: input.providerId },
  );
  if (!response.ok) throw new Error(`下载生成图失败: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return finish(input, bytes, response.headers.get('content-type') ?? 'image/png', responseBytes);
}

function decodeDataUrl(url: string): { bytes: Buffer; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (!match?.[1] || !match[2]) return null;
  return { bytes: Buffer.from(match[2], 'base64'), mimeType: match[1] };
}

function finish(
  input: GenerateImageInput,
  bytes: Buffer,
  mimeType: string,
  responseBytes: number,
): GeneratedImage {
  return { bytes, mimeType, model: input.model, responseBytes };
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}
