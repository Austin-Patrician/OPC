import { defaultNetworkClient, type NetworkClient } from '../network/networkClient';

/** Wire protocols a speech model can speak. Mirrors `ModelOption.api`. */
export const SPEECH_PROTOCOLS = ['xiaomi-audio', 'openai-audio'] as const;

export type SpeechProtocol = (typeof SPEECH_PROTOCOLS)[number];

interface SpeechRequestBase {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** `ModelOption.api`; unknown values fall back to `xiaomi-audio`. */
  protocol?: string;
  signal?: AbortSignal;
  /** Provider id, for request attribution when logging failures. */
  providerId?: string;
  /** Network seam; defaults to the plain global fetch (tests). */
  network?: NetworkClient;
}

export interface TranscribeRequest extends SpeechRequestBase {
  audio: Uint8Array;
  mimeType: string;
  language?: 'auto' | 'zh' | 'en';
}

export interface TranscribedAudio {
  text: string;
  model: string;
  /** Audio duration reported by the provider, when it does. */
  seconds?: number;
  /** Raw provider payload size, for diagnostics. */
  responseBytes: number;
}

export interface SynthesizeRequest extends SpeechRequestBase {
  text: string;
  /** Built-in voice id; voiceclone expects a base64 sample instead. */
  voice?: string;
  format?: 'wav' | 'mp3';
}

export interface SynthesizedAudio {
  bytes: Buffer;
  mimeType: string;
  model: string;
  responseBytes: number;
}

/**
 * Speech recognition and synthesis for the two protocols the settings page
 * exposes:
 *
 * - `xiaomi-audio` → [OI]-compatible `POST /chat/completions`. Xiaomi's ASR
 *   takes an `input_audio` content part and returns the transcript as the
 *   assistant message; TTS takes the text in an `assistant` message and returns
 *   `message.audio.data` as base64.
 * - `openai-audio` → standard `POST /audio/transcriptions` (multipart) and
 *   `POST /audio/speech` (binary). This is the fallback for [OI]-compatible
 *   relays and other vendors.
 *
 * Provider/base URL/API key all come from the stored provider row, so the same
 * model can be pointed at a relay by editing the base URL.
 */
export async function transcribeAudio(input: TranscribeRequest): Promise<TranscribedAudio> {
  switch (normalizeProtocol(input.protocol)) {
    case 'openai-audio':
      return transcribeOpenAi(input);
    default:
      return transcribeXiaomi(input);
  }
}

export async function synthesizeSpeech(input: SynthesizeRequest): Promise<SynthesizedAudio> {
  switch (normalizeProtocol(input.protocol)) {
    case 'openai-audio':
      return synthesizeOpenAi(input);
    default:
      return synthesizeXiaomi(input);
  }
}

function normalizeProtocol(value: string | undefined): SpeechProtocol {
  return SPEECH_PROTOCOLS.find((protocol) => protocol === value) ?? 'xiaomi-audio';
}

/** Xiaomi accepts mp3/wav only; anything else has to be converted first. */
function xiaomiAudioFormat(mimeType: string): {
  format: 'mp3' | 'wav';
  mimeType: string;
} {
  const normalized = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav' || normalized === 'audio/wave') {
    return { format: 'wav', mimeType: 'audio/wav' };
  }
  if (normalized === 'audio/mpeg' || normalized === 'audio/mp3') {
    return { format: 'mp3', mimeType: 'audio/mpeg' };
  }
  throw new Error(`Xiaomi ASR 仅支持 mp3/wav，当前音频是 ${mimeType || '未知格式'}`);
}

async function transcribeXiaomi(input: TranscribeRequest): Promise<TranscribedAudio> {
  const audio = xiaomiAudioFormat(input.mimeType);
  const dataUrl = `data:${audio.mimeType};base64,${Buffer.from(input.audio).toString('base64')}`;

  const { payload, responseBytes } = await postJson(input, {
    url: `${trimBase(input.baseUrl)}/chat/completions`,
    headers: { authorization: `Bearer ${input.apiKey}` },
    body: {
      model: input.model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: { data: dataUrl, format: audio.format },
            },
          ],
        },
      ],
      asr_options: { language: input.language ?? 'auto' },
      stream: false,
    },
  });

  const message = (payload as ChatCompletion).choices?.[0]?.message;
  const text = typeof message?.content === 'string' ? message.content.trim() : '';
  if (!text) {
    const reason = (payload as ChatCompletion).choices?.[0]?.finish_reason;
    throw new Error(`语音识别没有返回文本${reason ? `（${reason}）` : ''}`);
  }

  return {
    text,
    model: input.model,
    seconds: (payload as ChatCompletion).usage?.seconds,
    responseBytes,
  };
}

async function synthesizeXiaomi(input: SynthesizeRequest): Promise<SynthesizedAudio> {
  const format = input.format ?? 'wav';
  const voiceDesign = input.model.includes('voicedesign');
  const voiceClone = input.model.includes('voiceclone');

  if (voiceClone && !input.voice) {
    throw new Error('Voice Clone 需要提供音色样本（base64）');
  }

  // voicedesign reads the voice description from the user message and rejects
  // `audio.voice`; every other model takes the text from the assistant message.
  const messages = voiceDesign
    ? [
        {
          role: 'user',
          content: input.voice?.trim() || '自然、清晰、适合中文播报的声音',
        },
        { role: 'assistant', content: input.text },
      ]
    : [{ role: 'assistant', content: input.text }];

  const { payload, responseBytes } = await postJson(input, {
    url: `${trimBase(input.baseUrl)}/chat/completions`,
    headers: { authorization: `Bearer ${input.apiKey}` },
    body: {
      model: input.model,
      messages,
      audio: {
        format,
        ...(voiceDesign || !input.voice ? {} : { voice: input.voice }),
      },
      stream: false,
    },
  });

  const audio = (payload as ChatCompletion).choices?.[0]?.message?.audio;
  if (!audio?.data) {
    const reason = (payload as ChatCompletion).choices?.[0]?.finish_reason;
    throw new Error(`语音合成没有返回音频${reason ? `（${reason}）` : ''}`);
  }

  return {
    bytes: Buffer.from(audio.data, 'base64'),
    mimeType: format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
    model: input.model,
    responseBytes,
  };
}

async function transcribeOpenAi(input: TranscribeRequest): Promise<TranscribedAudio> {
  const network = input.network ?? defaultNetworkClient;
  const form = new FormData();
  form.append('model', input.model);
  // Copy into a plain ArrayBuffer: Blob does not accept every Uint8Array view.
  const audioBuffer = new ArrayBuffer(input.audio.byteLength);
  new Uint8Array(audioBuffer).set(input.audio);
  form.append('file', new Blob([audioBuffer], { type: input.mimeType }), fileNameFor(input.mimeType));
  if (input.language && input.language !== 'auto') form.append('language', input.language);

  const response = await network.fetch(
    `${trimBase(input.baseUrl)}/audio/transcriptions`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${input.apiKey}` },
      body: form,
      signal: input.signal ?? AbortSignal.timeout(180_000),
    },
    { purpose: 'speech', providerId: input.providerId },
  );

  const text = await response.text();
  if (!response.ok) throw new Error(`语音识别接口 HTTP ${response.status}: ${text.slice(0, 300)}`);
  const payload = parseJson<{ text?: string }>(text, '语音识别');
  if (!payload.text?.trim()) throw new Error('语音识别没有返回文本');

  return {
    text: payload.text.trim(),
    model: input.model,
    responseBytes: text.length,
  };
}

async function synthesizeOpenAi(input: SynthesizeRequest): Promise<SynthesizedAudio> {
  const network = input.network ?? defaultNetworkClient;
  const format = input.format ?? 'mp3';
  const response = await network.fetch(
    `${trimBase(input.baseUrl)}/audio/speech`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        input: input.text,
        voice: input.voice ?? 'alloy',
        response_format: format,
      }),
      signal: input.signal ?? AbortSignal.timeout(180_000),
    },
    { purpose: 'speech', providerId: input.providerId },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`语音合成接口 HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    bytes,
    mimeType: response.headers.get('content-type') ?? (format === 'wav' ? 'audio/wav' : 'audio/mpeg'),
    model: input.model,
    responseBytes: bytes.byteLength,
  };
}

interface ChatCompletion {
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string;
      audio?: { data?: string; transcript?: string | null };
    };
  }[];
  usage?: { seconds?: number };
}

interface JsonRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

async function postJson(
  input: SpeechRequestBase,
  request: JsonRequest,
): Promise<{ payload: unknown; responseBytes: number }> {
  const network = input.network ?? defaultNetworkClient;
  const response = await network.fetch(
    request.url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      signal: input.signal ?? AbortSignal.timeout(180_000),
    },
    { purpose: 'speech', providerId: input.providerId },
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`语音接口 HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return {
    payload: parseJson<unknown>(text, '语音接口'),
    responseBytes: text.length,
  };
}

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label}返回的不是 JSON: ${text.slice(0, 200)}`);
  }
}

function fileNameFor(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('wav')) return 'audio.wav';
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'audio.mp3';
  if (normalized.includes('webm')) return 'audio.webm';
  if (normalized.includes('ogg')) return 'audio.ogg';
  if (normalized.includes('m4a') || normalized.includes('mp4')) return 'audio.m4a';
  return 'audio.bin';
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}
