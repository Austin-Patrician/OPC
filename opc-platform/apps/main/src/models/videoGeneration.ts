import crypto from 'node:crypto';
import { defaultNetworkClient, type NetworkClient } from '../network/networkClient';
import { DIRECT_VIDEO_BASE_URLS, VIDEO_PROTOCOLS, type VideoProtocol } from './videoCatalog';

const DEFAULT_POLL_INTERVAL_MS = 4_000;
const DEFAULT_TIMEOUT_MS = 600_000;
const REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

export interface VideoImageInput {
  bytes: Uint8Array;
  mimeType: string;
}

export interface VideoGenerationRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  protocol?: string;
  providerId?: string;
  startImage?: VideoImageInput;
  endImage?: VideoImageInput;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  generateAudio?: boolean;
  negativePrompt?: string;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface VideoGenerationResult {
  bytes: Uint8Array;
  mimeType: string;
  durationSeconds?: number;
  taskId?: string;
}

/** Infers the wire protocol from explicit model api, provider api, or provider id. */
export function inferVideoProtocol(
  providerId: string,
  modelApi?: string,
  providerApi?: string,
): VideoProtocol {
  for (const candidate of [modelApi, providerApi]) {
    if (candidate && VIDEO_PROTOCOLS.includes(candidate as VideoProtocol)) {
      return candidate as VideoProtocol;
    }
  }
  switch (providerId) {
    case 'fal':
      return 'fal-queue';
    case 'volcengine-ark':
      return 'volcengine-ark-video';
    case 'kling':
      return 'kling-video';
    case 'minimax':
      return 'minimax-video';
    case 'google':
      return 'google-veo';
    default:
      return 'openai-videos';
  }
}

/** Returns the default base URL for a given provider or video protocol. */
export function defaultVideoBaseUrl(providerId: string, protocol: VideoProtocol): string {
  if (DIRECT_VIDEO_BASE_URLS[providerId]) return DIRECT_VIDEO_BASE_URLS[providerId];
  switch (protocol) {
    case 'fal-queue':
      return DIRECT_VIDEO_BASE_URLS.fal!;
    case 'volcengine-ark-video':
      return DIRECT_VIDEO_BASE_URLS['volcengine-ark']!;
    case 'kling-video':
      return DIRECT_VIDEO_BASE_URLS.kling!;
    case 'minimax-video':
      return DIRECT_VIDEO_BASE_URLS.minimax!;
    case 'google-veo':
      return DIRECT_VIDEO_BASE_URLS.google!;
    default:
      return DIRECT_VIDEO_BASE_URLS['openai-video']!;
  }
}

/** Generates a video clip through the provider's async queue/polling protocol and returns raw bytes. */
export async function generateVideo(
  request: VideoGenerationRequest,
  network: NetworkClient = defaultNetworkClient,
): Promise<VideoGenerationResult> {
  const protocol = inferVideoProtocol(request.providerId ?? '', request.protocol);
  switch (protocol) {
    case 'fal-queue':
      return generateFalQueue(request, network);
    case 'volcengine-ark-video':
      return generateVolcengineArk(request, network);
    case 'kling-video':
      return generateKling(request, network);
    case 'minimax-video':
      return generateMinimax(request, network);
    case 'google-veo':
      return generateGoogleVeo(request, network);
    default:
      return generateOpenAiVideos(request, network);
  }
}

async function generateFalQueue(
  req: VideoGenerationRequest,
  network: NetworkClient,
): Promise<VideoGenerationResult> {
  const baseUrl = trimBase(req.baseUrl || DIRECT_VIDEO_BASE_URLS.fal!);
  const modelPath = req.model.replace(/^\/+/, '');
  const headers = { authorization: `Key ${req.apiKey}` };
  const submit = await requestJson(network, `${baseUrl}/${modelPath}`, {
    method: 'POST',
    headers,
    body: {
      prompt: req.prompt,
      ...(req.duration ? { duration: String(req.duration) } : {}),
      ...(req.aspectRatio ? { aspect_ratio: req.aspectRatio } : {}),
      ...(req.resolution ? { resolution: req.resolution } : {}),
      ...(req.generateAudio !== undefined ? { generate_audio: req.generateAudio } : {}),
      ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
      ...(req.startImage ? { image_url: toDataUrl(req.startImage) } : {}),
      ...(req.endImage ? { tail_image_url: toDataUrl(req.endImage) } : {}),
    },
    signal: req.signal,
    providerId: req.providerId,
  });

  const requestId = asString(submit.request_id);
  const immediateUrl = extractFalVideoUrl(submit);
  if (immediateUrl) {
    return downloadVideo(network, immediateUrl, {
      signal: req.signal,
      providerId: req.providerId,
      durationSeconds: req.duration,
      taskId: requestId,
    });
  }

  const statusUrl =
    asString(submit.status_url) ??
    (requestId ? `${baseUrl}/${modelPath}/requests/${requestId}/status` : undefined);
  const responseUrl =
    asString(submit.response_url) ??
    (requestId ? `${baseUrl}/${modelPath}/requests/${requestId}` : undefined);

  if (!statusUrl || !responseUrl) {
    throw new Error('fal 视频接口未返回 request_id 或轮询地址');
  }

  const videoUrl = await pollUntil(req, async () => {
    const statusPayload = await requestJson(network, statusUrl, {
      method: 'GET',
      headers,
      signal: req.signal,
      providerId: req.providerId,
    });
    const inlineUrl = extractFalVideoUrl(statusPayload);
    if (inlineUrl) return inlineUrl;

    const state = (asString(statusPayload.status) ?? '').toUpperCase();
    if (state === 'COMPLETED') {
      const resp = await requestJson(network, responseUrl, {
        method: 'GET',
        headers,
        signal: req.signal,
        providerId: req.providerId,
      });
      const url = extractFalVideoUrl(resp);
      if (!url) throw new Error('fal 任务已完成但未返回 video.url');
      return url;
    }
    if (state === 'FAILED' || state === 'ERROR' || state === 'CANCELLED') {
      throw new Error(`fal 视频生成失败：${asString(statusPayload.error) ?? state}`);
    }
    return POLL_PENDING;
  });

  return downloadVideo(network, videoUrl, {
    signal: req.signal,
    providerId: req.providerId,
    durationSeconds: req.duration,
    taskId: requestId,
  });
}

function extractFalVideoUrl(payload: Record<string, unknown>): string | undefined {
  const video =
    asRecord(payload.video) ??
    asRecord(asRecord(payload.data)?.video) ??
    asRecord(asRecord(payload.response)?.video);
  return asString(video?.url);
}

async function generateVolcengineArk(
  req: VideoGenerationRequest,
  network: NetworkClient,
): Promise<VideoGenerationResult> {
  const baseUrl = trimBase(req.baseUrl || DIRECT_VIDEO_BASE_URLS['volcengine-ark']!);
  const headers = { authorization: `Bearer ${req.apiKey}` };
  const content: Record<string, unknown>[] = [{ type: 'text', text: req.prompt }];
  if (req.startImage) {
    content.push({
      type: 'image_url',
      image_url: { url: toDataUrl(req.startImage) },
      role: 'first_frame',
    });
  }
  if (req.endImage) {
    content.push({
      type: 'image_url',
      image_url: { url: toDataUrl(req.endImage) },
      role: 'last_frame',
    });
  }

  const submit = await requestJson(network, `${baseUrl}/contents/generations/tasks`, {
    method: 'POST',
    headers,
    body: {
      model: req.model,
      content,
      ...(req.aspectRatio ? { ratio: req.aspectRatio } : {}),
      ...(req.duration ? { duration: req.duration } : {}),
      ...(req.resolution ? { resolution: req.resolution } : {}),
      ...(req.generateAudio !== undefined ? { generate_audio: req.generateAudio } : {}),
      watermark: false,
    },
    signal: req.signal,
    providerId: req.providerId,
  });

  const taskId = asString(submit.id) ?? asString(asRecord(submit.data)?.id);
  if (!taskId) throw new Error('火山引擎方舟视频接口未返回任务 id');

  const result = await pollUntil(req, async () => {
    const statusPayload = await requestJson(
      network,
      `${baseUrl}/contents/generations/tasks/${encodeURIComponent(taskId)}`,
      {
        method: 'GET',
        headers,
        signal: req.signal,
        providerId: req.providerId,
      },
    );
    const state = (asString(statusPayload.status) ?? '').toLowerCase();
    if (state === 'succeeded') {
      const url =
        asString(asRecord(statusPayload.content)?.video_url) ??
        asString(asRecord(statusPayload.output)?.video_url) ??
        asString(statusPayload.video_url);
      if (!url) throw new Error('火山引擎方舟视频任务完成但未返回 video_url');
      return {
        url,
        duration: asNumber(statusPayload.duration) ?? req.duration,
      };
    }
    if (state === 'failed' || state === 'expired' || state === 'cancelled') {
      const errObj = asRecord(statusPayload.error);
      throw new Error(`火山引擎方舟视频生成失败：${asString(errObj?.message) ?? asString(statusPayload.error) ?? state}`);
    }
    return POLL_PENDING;
  });

  return downloadVideo(network, result.url, {
    signal: req.signal,
    providerId: req.providerId,
    durationSeconds: result.duration,
    taskId,
  });
}

/** Supports both raw Bearer relay tokens and official Kling `AccessKey:SecretKey` HS256 JWT signing. */
export function buildKlingAuthHeader(apiKey: string): string {
  const trimmed = apiKey.trim();
  const separator = trimmed.indexOf(':');
  if (separator > 0 && separator < trimmed.length - 1 && !trimmed.includes(' ')) {
    const ak = trimmed.slice(0, separator);
    const sk = trimmed.slice(separator + 1);
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64Url(JSON.stringify({ iss: ak, exp: now + 1800, nbf: now - 5 }));
    const signature = crypto
      .createHmac('sha256', sk)
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `Bearer ${header}.${payload}.${signature}`;
  }
  return `Bearer ${trimmed}`;
}

async function generateKling(
  req: VideoGenerationRequest,
  network: NetworkClient,
): Promise<VideoGenerationResult> {
  const baseUrl = trimBase(req.baseUrl || DIRECT_VIDEO_BASE_URLS.kling!);
  const endpoint = req.startImage ? 'image2video' : 'text2video';
  const authHeader = () => ({ authorization: buildKlingAuthHeader(req.apiKey) });

  const submit = await requestJson(network, `${baseUrl}/v1/videos/${endpoint}`, {
    method: 'POST',
    headers: authHeader(),
    body: {
      model_name: req.model,
      prompt: req.prompt,
      ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
      ...(req.aspectRatio ? { aspect_ratio: req.aspectRatio } : {}),
      ...(req.duration ? { duration: String(req.duration) } : {}),
      ...(req.resolution ? { mode: req.resolution === '1080p' ? 'pro' : 'std' } : {}),
      ...(req.generateAudio !== undefined ? { sound: req.generateAudio ? 'on' : 'off' } : {}),
      ...(req.startImage ? { image: Buffer.from(req.startImage.bytes).toString('base64') } : {}),
      ...(req.endImage ? { image_tail: Buffer.from(req.endImage.bytes).toString('base64') } : {}),
    },
    signal: req.signal,
    providerId: req.providerId,
  });

  if (typeof submit.code === 'number' && submit.code !== 0) {
    throw new Error(`可灵视频接口返回错误(${submit.code})：${asString(submit.message) ?? '未知错误'}`);
  }
  const taskId = asString(asRecord(submit.data)?.task_id) ?? asString(submit.task_id);
  if (!taskId) throw new Error('可灵视频接口未返回 task_id');

  const result = await pollUntil(req, async () => {
    const statusPayload = await requestJson(
      network,
      `${baseUrl}/v1/videos/${endpoint}/${encodeURIComponent(taskId)}`,
      {
        method: 'GET',
        headers: authHeader(),
        signal: req.signal,
        providerId: req.providerId,
      },
    );
    const data = asRecord(statusPayload.data) ?? statusPayload;
    const state = (asString(data.task_status) ?? '').toLowerCase();
    if (state === 'succeed') {
      const taskResult = asRecord(data.task_result);
      const videos = Array.isArray(taskResult?.videos) ? taskResult.videos : [];
      const first = asRecord(videos[0]);
      const url = asString(first?.url);
      if (!url) throw new Error('可灵视频任务完成但未返回 videos[0].url');
      return {
        url,
        duration: asNumber(first?.duration) ?? req.duration,
      };
    }
    if (state === 'failed') {
      throw new Error(`可灵视频生成失败：${asString(data.task_status_msg) ?? 'failed'}`);
    }
    return POLL_PENDING;
  });

  return downloadVideo(network, result.url, {
    signal: req.signal,
    providerId: req.providerId,
    durationSeconds: result.duration,
    taskId,
  });
}

async function generateMinimax(
  req: VideoGenerationRequest,
  network: NetworkClient,
): Promise<VideoGenerationResult> {
  const baseUrl = trimBase(req.baseUrl || DIRECT_VIDEO_BASE_URLS.minimax!);
  const headers = { authorization: `Bearer ${req.apiKey}` };
  const submit = await requestJson(network, `${baseUrl}/video_generation`, {
    method: 'POST',
    headers,
    body: {
      model: req.model,
      prompt: req.prompt,
      ...(req.startImage ? { first_frame_image: toDataUrl(req.startImage) } : {}),
      ...(req.endImage ? { last_frame_image: toDataUrl(req.endImage) } : {}),
      ...(req.duration ? { duration: req.duration } : {}),
      ...(req.resolution ? { resolution: req.resolution } : {}),
    },
    signal: req.signal,
    providerId: req.providerId,
  });

  assertMinimaxOk(submit);
  const taskId = asString(submit.task_id);
  if (!taskId) throw new Error('MiniMax 视频接口未返回 task_id');

  const fileId = await pollUntil(req, async () => {
    const statusPayload = await requestJson(
      network,
      `${baseUrl}/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
      {
        method: 'GET',
        headers,
        signal: req.signal,
        providerId: req.providerId,
      },
    );
    assertMinimaxOk(statusPayload);
    const state = asString(statusPayload.status) ?? '';
    if (state === 'Success') {
      const id = asString(statusPayload.file_id);
      if (!id) throw new Error('MiniMax 视频任务完成但未返回 file_id');
      return id;
    }
    if (state === 'Fail') {
      const baseResp = asRecord(statusPayload.base_resp);
      throw new Error(`MiniMax 视频生成失败：${asString(baseResp?.status_msg) ?? state}`);
    }
    return POLL_PENDING;
  });

  const filePayload = await requestJson(
    network,
    `${baseUrl}/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
    {
      method: 'GET',
      headers,
      signal: req.signal,
      providerId: req.providerId,
    },
  );
  assertMinimaxOk(filePayload);
  const downloadUrl = asString(asRecord(filePayload.file)?.download_url) ?? asString(filePayload.download_url);
  if (!downloadUrl) throw new Error('MiniMax files/retrieve 未返回 download_url');

  return downloadVideo(network, downloadUrl, {
    signal: req.signal,
    providerId: req.providerId,
    durationSeconds: req.duration,
    taskId,
  });
}

function assertMinimaxOk(payload: Record<string, unknown>): void {
  const resp = asRecord(payload.base_resp);
  if (!resp) return;
  if (typeof resp.status_code === 'number' && resp.status_code !== 0) {
    throw new Error(`MiniMax 接口错误(${resp.status_code})：${asString(resp.status_msg) ?? '未知错误'}`);
  }
}

async function generateGoogleVeo(
  req: VideoGenerationRequest,
  network: NetworkClient,
): Promise<VideoGenerationResult> {
  const baseUrl = trimBase(req.baseUrl || DIRECT_VIDEO_BASE_URLS.google!);
  const headers = { 'x-goog-api-key': req.apiKey };
  const instance: Record<string, unknown> = { prompt: req.prompt };
  if (req.startImage) {
    instance.image = {
      bytesBase64Encoded: Buffer.from(req.startImage.bytes).toString('base64'),
      mimeType: req.startImage.mimeType,
    };
  }
  if (req.endImage) {
    instance.lastFrame = {
      bytesBase64Encoded: Buffer.from(req.endImage.bytes).toString('base64'),
      mimeType: req.endImage.mimeType,
    };
  }
  const parameters: Record<string, unknown> = {
    ...(req.aspectRatio ? { aspectRatio: req.aspectRatio } : {}),
    ...(req.duration ? { durationSeconds: req.duration } : {}),
    ...(req.resolution ? { resolution: req.resolution } : {}),
    ...(req.negativePrompt ? { negativePrompt: req.negativePrompt } : {}),
    ...(req.generateAudio !== undefined ? { generateAudio: req.generateAudio } : {}),
  };

  const operation = await requestJson(
    network,
    `${baseUrl}/models/${encodeURIComponent(req.model)}:predictLongRunning`,
    {
      method: 'POST',
      headers,
      body: {
        instances: [instance],
        ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
      },
      signal: req.signal,
      providerId: req.providerId,
    },
  );

  const opName = asString(operation.name);
  const resolvedOp =
    operation.done === true
      ? operation
      : await pollUntil(req, async () => {
          if (!opName) throw new Error('Google Veo 未返回 operation name');
          const pollUrl = /^https?:\/\//.test(opName)
            ? opName
            : `${baseUrl}/${opName.replace(/^\/+/, '')}`;
          const next = await requestJson(network, pollUrl, {
            method: 'GET',
            headers,
            signal: req.signal,
            providerId: req.providerId,
          });
          if (next.done === true) return next;
          return POLL_PENDING;
        });

  if (resolvedOp.error) {
    const err = asRecord(resolvedOp.error);
    throw new Error(`Google Veo 视频生成失败：${asString(err?.message) ?? JSON.stringify(resolvedOp.error)}`);
  }

  const response = asRecord(resolvedOp.response);
  const videoResponse = asRecord(response?.generateVideoResponse) ?? asRecord(response?.generate_video_response);
  const samples = Array.isArray(videoResponse?.generatedSamples)
    ? videoResponse.generatedSamples
    : Array.isArray(response?.predictions)
      ? response.predictions
      : [];
  const firstSample = asRecord(samples[0]);
  const videoObj = asRecord(firstSample?.video) ?? firstSample;
  const b64 = asString(videoObj?.bytesBase64Encoded);
  if (b64) {
    return {
      bytes: new Uint8Array(Buffer.from(b64, 'base64')),
      mimeType: normalizeVideoMime(asString(videoObj?.mimeType) ?? 'video/mp4'),
      durationSeconds: req.duration,
      taskId: opName,
    };
  }
  const uri = asString(videoObj?.uri);
  if (!uri) throw new Error('Google Veo 操作完成但未返回视频 uri 或内嵌数据');

  return downloadVideo(network, uri, {
    headers,
    signal: req.signal,
    providerId: req.providerId,
    durationSeconds: req.duration,
    taskId: opName,
  });
}

async function generateOpenAiVideos(
  req: VideoGenerationRequest,
  network: NetworkClient,
): Promise<VideoGenerationResult> {
  const baseUrl = trimBase(req.baseUrl || DIRECT_VIDEO_BASE_URLS['openai-video']!);
  const headers = { authorization: `Bearer ${req.apiKey}` };
  const submit = await requestJson(network, `${baseUrl}/videos`, {
    method: 'POST',
    headers,
    body: {
      model: req.model,
      prompt: req.prompt,
      ...(req.duration ? { seconds: String(req.duration) } : {}),
      ...(req.aspectRatio ? { aspect_ratio: req.aspectRatio } : {}),
      ...(req.resolution ? { resolution: req.resolution } : {}),
      ...(req.startImage ? { input_reference: toDataUrl(req.startImage) } : {}),
    },
    signal: req.signal,
    providerId: req.providerId,
  });

  const taskId = asString(submit.id);
  const directUrl = extractOpenAiVideoUrl(submit);
  if (directUrl) {
    return downloadVideo(network, directUrl, {
      headers,
      signal: req.signal,
      providerId: req.providerId,
      durationSeconds: req.duration,
      taskId,
    });
  }
  if (!taskId) throw new Error('OpenAI 兼容视频接口既未返回 id 也未返回视频 URL');

  const resolvedUrl = await pollUntil(req, async () => {
    const statusPayload = await requestJson(
      network,
      `${baseUrl}/videos/${encodeURIComponent(taskId)}`,
      {
        method: 'GET',
        headers,
        signal: req.signal,
        providerId: req.providerId,
      },
    );
    const state = (asString(statusPayload.status) ?? '').toLowerCase();
    if (state === 'completed' || state === 'succeeded') {
      return extractOpenAiVideoUrl(statusPayload) ?? `${baseUrl}/videos/${encodeURIComponent(taskId)}/content`;
    }
    if (state === 'failed' || state === 'cancelled' || state === 'error') {
      const err = asRecord(statusPayload.error);
      throw new Error(`视频生成失败：${asString(err?.message) ?? asString(statusPayload.error) ?? state}`);
    }
    return POLL_PENDING;
  });

  return downloadVideo(network, resolvedUrl, {
    headers,
    signal: req.signal,
    providerId: req.providerId,
    durationSeconds: req.duration,
    taskId,
  });
}

function extractOpenAiVideoUrl(payload: Record<string, unknown>): string | undefined {
  const dataList = Array.isArray(payload.data) ? payload.data : [];
  const firstData = asRecord(dataList[0]);
  return (
    asString(payload.url) ??
    asString(payload.video_url) ??
    asString(firstData?.url) ??
    asString(firstData?.video_url)
  );
}

const POLL_PENDING = Symbol('poll-pending');

async function pollUntil<T>(
  req: VideoGenerationRequest,
  step: () => Promise<T | typeof POLL_PENDING>,
): Promise<T> {
  const intervalMs = req.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (req.signal?.aborted) {
      throw new Error('视频生成已取消');
    }
    if (Date.now() > deadline) {
      throw new Error(`视频生成超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`);
    }
    const outcome = await step();
    if (outcome !== POLL_PENDING) return outcome;
    await sleepWithAbort(intervalMs, req.signal);
  }
}

async function requestJson(
  network: NetworkClient,
  url: string,
  options: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: Record<string, unknown>;
    signal?: AbortSignal;
    providerId?: string;
  },
): Promise<Record<string, unknown>> {
  const signal = combineSignal(options.signal, REQUEST_TIMEOUT_MS);
  const response = await network.fetch(
    url,
    {
      method: options.method,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal,
    },
    { purpose: 'video', providerId: options.providerId },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`视频接口 HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return asRecord(parsed) ?? {};
  } catch {
    throw new Error(`视频接口返回的不是 JSON: ${text.slice(0, 200)}`);
  }
}

async function downloadVideo(
  network: NetworkClient,
  url: string,
  options: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    providerId?: string;
    durationSeconds?: number;
    taskId?: string;
  },
): Promise<VideoGenerationResult> {
  const response = await network.fetch(
    url,
    {
      ...(options.headers ? { headers: options.headers } : {}),
      signal: combineSignal(options.signal, DOWNLOAD_TIMEOUT_MS),
    },
    { purpose: 'video', providerId: options.providerId },
  );
  if (!response.ok) {
    throw new Error(`下载生成的视频失败: HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_VIDEO_BYTES) {
    throw new Error(`生成的视频体积过大（${Math.round(contentLength / (1024 * 1024))} MB），超出 200 MB 上限`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error('下载的视频内容为空');
  }
  if (bytes.byteLength > MAX_VIDEO_BYTES) {
    throw new Error(`生成的视频体积过大（${Math.round(bytes.byteLength / (1024 * 1024))} MB），超出 200 MB 上限`);
  }
  return {
    bytes,
    mimeType: normalizeVideoMime(response.headers.get('content-type')),
    durationSeconds: options.durationSeconds,
    taskId: options.taskId,
  };
}

function normalizeVideoMime(raw: string | null | undefined): string {
  const lower = (raw ?? '').toLowerCase();
  if (lower.includes('webm')) return 'video/webm';
  return 'video/mp4';
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('视频生成已取消'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('视频生成已取消'));
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function toDataUrl(image: VideoImageInput): string {
  return `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}`;
}

function base64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}
