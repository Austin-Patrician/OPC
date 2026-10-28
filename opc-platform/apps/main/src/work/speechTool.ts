import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { Type } from 'typebox';
import type { Context } from '@earendil-works/chord/context';
import { defineExtension, defineTool, type ToolExecutionResult } from '@earendil-works/pi-durable';
import type { SpeechLanguage, SpeechSynthesizeResult, SpeechTranscribeResult } from '@opc/shared/domain';

/**
 * Xiaomi's ASR window is 8k context tokens (~20 minutes of audio), so the byte
 * guard is generous rather than exact: the provider reports a clearer error.
 */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/** One TTS request stays well inside the 8k context; longer text must be split. */
const MAX_TTS_CHARS = 4_000;

/** Above this the transcript is also written to a file so nothing is lost. */
const MAX_INLINE_CHARS = 12_000;

const AUDIO_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
};

export interface SpeechToolDeps {
  /** Absent when no ASR model is enabled; the tool is then not installed. */
  transcribe?: (input: {
    audio: Uint8Array;
    mimeType: string;
    language?: SpeechLanguage;
  }) => Promise<SpeechTranscribeResult>;
  /** Absent when no TTS model is enabled; the tool is then not installed. */
  synthesize?: (input: {
    text: string;
    voice?: string;
    format?: 'wav' | 'mp3';
  }) => Promise<SpeechSynthesizeResult>;
  /** Fallback when the conversation has no cwd of its own. */
  defaultRoot: string;
}

/**
 * `transcribe_audio` and `text_to_speech`: the agent-facing speech tools.
 *
 * Each tool is installed only when its half of the pipeline is actually usable,
 * so a model never sees a tool that can only fail. Files move through the
 * execution environment (same as `generate_image`), which means the artifact and
 * acceptance pipeline picks the output up without extra wiring.
 */
export function createSpeechToolExtension(deps: SpeechToolDeps) {
  const tools = [
    ...(deps.transcribe ? [createTranscribeTool(deps.transcribe, deps.defaultRoot)] : []),
    ...(deps.synthesize ? [createSynthesizeTool(deps.synthesize)] : []),
  ];

  return defineExtension({ name: 'opc.speech', tools });
}

type TranscribeFn = NonNullable<SpeechToolDeps['transcribe']>;
type SynthesizeFn = NonNullable<SpeechToolDeps['synthesize']>;

function createTranscribeTool(transcribe: TranscribeFn, defaultRoot: string) {
  return defineTool({
    name: 'transcribe_audio',
    description:
      'Transcribe a speech audio file from the workspace into text (speech-to-text). Use it for meeting recordings, voice memos, interviews and podcast clips. Supports mp3, wav, m4a, webm, ogg and flac up to 25MB (roughly 20 minutes); split longer audio first. Returns the transcript, and writes the full text to a .md file when it is very long.',
    parameters: Type.Object({
      path: Type.String({
        description: 'Audio path relative to the workspace, e.g. recordings/standup.mp3.',
      }),
      language: Type.Optional(
        Type.String({
          description:
            'Spoken language: auto (default, detect), zh (Chinese) or en (English). Pinning it improves accuracy on short or noisy clips.',
        }),
      ),
    }),
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      const agent = await api.agent(context);
      const root = path.resolve(agent.cwd ?? defaultRoot);
      const target = path.resolve(root, args.path);

      if (!contains(root, target)) {
        return fail(`只能转写工作区内的音频：${args.path}`);
      }

      const extension = path.extname(target).toLowerCase();
      const mimeType = AUDIO_TYPES[extension];
      if (!mimeType) {
        return fail(
          `不支持的音频格式：${extension || '（无扩展名）'}。支持 mp3、wav、m4a、webm、ogg、flac。`,
        );
      }

      let realRoot: string;
      let realTarget: string;
      try {
        realRoot = await realpath(root);
        realTarget = await realpath(target);
      } catch {
        return fail(`找不到音频：${args.path}（路径相对工作区，且必须是已存在的文件）`);
      }
      if (!contains(realRoot, realTarget)) {
        return fail(`符号链接指向工作区外，已拒绝：${args.path}`);
      }

      const env = api.env;
      if (!env) return fail('当前会话没有可用的文件环境，无法读取音频');

      const read = await env.readBinaryFile(realTarget, context);
      if (!read.ok) {
        return fail(
          read.error.code === 'not_found'
            ? `找不到音频：${args.path}`
            : `读取音频失败：${read.error.message}`,
        );
      }
      const bytes = read.value;
      if (bytes.byteLength === 0) return fail(`音频是空文件：${args.path}`);
      if (bytes.byteLength > MAX_AUDIO_BYTES) {
        return fail(
          `音频过大（${formatBytes(bytes.byteLength)}），单次上限 ${formatBytes(MAX_AUDIO_BYTES)}；请先切分成较短的片段。`,
        );
      }

      const language = normalizeLanguage(args.language);
      let result: SpeechTranscribeResult;
      try {
        result = await transcribe({ audio: new Uint8Array(bytes), mimeType, language });
      } catch (error) {
        return fail(`语音转写失败：${error instanceof Error ? error.message : String(error)}`);
      }
      if (!result.ok || !result.text) {
        return fail(`语音转写失败：${result.error ?? '未知错误'}`);
      }

      return reportTranscript(args.path, target, result, env, context);
    },
  });
}

function createSynthesizeTool(synthesize: SynthesizeFn) {
  return defineTool({
    name: 'text_to_speech',
    description:
      'Read text aloud with the configured speech-synthesis model and save the audio into the workspace. Use it when the deliverable is spoken: a voice-over, an audio summary, a narration for a video. Returns the file name. Split anything longer than about 4000 characters into several calls.',
    parameters: Type.Object({
      text: Type.String({ description: 'The exact text to speak, in the target language.' }),
      filename: Type.Optional(
        Type.String({
          description: 'Target file name, e.g. intro.mp3. Defaults to a timestamped name.',
        }),
      ),
      voice: Type.Optional(
        Type.String({
          description:
            'Preset voice id, when the model has several (Xiaomi: mimo_default, 冰糖, 茉莉, 苏打, 白桦, Mia, Chloe, Milo, Dean). Omit to use the provider default.',
        }),
      ),
      format: Type.Optional(Type.String({ description: 'Audio format: mp3 (default) or wav.' })),
    }),
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      const text = args.text.trim();
      if (!text) return fail('要合成的文本不能为空');
      if (text.length > MAX_TTS_CHARS) {
        return fail(
          `文本过长（${text.length} 字符），单次上限 ${MAX_TTS_CHARS}。请分成几段分别合成，再用文件名区分。`,
        );
      }

      const format = args.format?.trim().toLowerCase() === 'wav' ? 'wav' : 'mp3';
      let result: SpeechSynthesizeResult;
      try {
        result = await synthesize({ text, voice: args.voice?.trim() || undefined, format });
      } catch (error) {
        return fail(`语音合成失败：${error instanceof Error ? error.message : String(error)}`);
      }
      if (!result.ok || !result.bytes) {
        return fail(`语音合成失败：${result.error ?? '未知错误'}`);
      }

      const env = api.env;
      if (!env) return fail('当前会话没有可用的文件环境，无法写入音频');

      const extension = result.mimeType === 'audio/wav' ? 'wav' : format;
      const filename = sanitize(args.filename ?? `speech-${Date.now()}.${extension}`, extension);
      const written = await env.writeFile(filename, result.bytes, context);
      if (!written || !written.ok) {
        return fail(`写入文件失败：${filename}`);
      }

      return {
        output: [
          {
            type: 'text' as const,
            text: `已生成 ${filename}（${result.bytes.byteLength} B，${text.length} 字符，模型 ${result.model ?? 'unknown'}）`,
          },
        ],
        details: {
          file: filename,
          bytes: result.bytes.byteLength,
          chars: text.length,
          model: result.model ?? 'unknown',
        },
      };
    },
  });
}

/**
 * The transcript is the deliverable, so a long one is written next to the audio
 * instead of being cut off in the transcript window.
 */
async function reportTranscript(
  requested: string,
  target: string,
  result: SpeechTranscribeResult,
  env: EnvLike,
  context: Context,
): Promise<ToolExecutionResult> {
  const text = result.text ?? '';
  const header = [
    `转写完成：${requested}`,
    result.seconds ? `${result.seconds} 秒音频` : '',
    result.model ? `模型 ${result.model}` : '',
  ]
    .filter(Boolean)
    .join('，');

  if (text.length <= MAX_INLINE_CHARS) {
    return {
      output: [{ type: 'text' as const, text: `${header}\n\n${text}` }],
      details: {
        file: requested,
        chars: text.length,
        ...(result.seconds !== undefined ? { seconds: result.seconds } : {}),
        ...(result.model ? { model: result.model } : {}),
        transcriptFile: null,
      },
    };
  }

  // Same flat-name rule as `generate_image`: the workspace is shared with the
  // sandbox hook, which does not create directories on demand.
  const base = path.basename(target, path.extname(target));
  const transcriptFile = sanitize(`${base}.transcript.md`, 'md');
  const written = await env.writeFile(transcriptFile, new TextEncoder().encode(text), context);
  const head = text.slice(0, MAX_INLINE_CHARS);
  const note = written?.ok
    ? `全文 ${text.length} 字符已写入 ${transcriptFile}。`
    : `全文 ${text.length} 字符，写入 ${transcriptFile} 失败。`;

  return {
    output: [
      {
        type: 'text' as const,
        text: `${header}\n${note}\n\n${head}\n…（以上为前 ${MAX_INLINE_CHARS} 字符）`,
      },
    ],
    details: {
      file: requested,
      chars: text.length,
      ...(result.seconds !== undefined ? { seconds: result.seconds } : {}),
      ...(result.model ? { model: result.model } : {}),
      transcriptFile: written?.ok ? transcriptFile : null,
    },
  };
}

interface EnvLike {
  writeFile: (path: string, content: Uint8Array, context: Context) => Promise<{ ok: boolean } | undefined>;
}

function normalizeLanguage(value: string | undefined): SpeechLanguage | undefined {
  const clean = value?.trim().toLowerCase();
  if (clean === 'zh' || clean === 'en' || clean === 'auto') return clean;
  return undefined;
}

function fail(text: string): ToolExecutionResult {
  return { isError: true, output: [{ type: 'text' as const, text }] };
}

/** `target` is inside `root`, comparing path segments rather than string prefixes. */
function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Flat names only: the workspace is shared with the sandbox hook. */
function sanitize(filename: string, fallbackExtension: string): string {
  const base = filename.split(/[\\/]/).pop() ?? `speech.${fallbackExtension}`;
  const clean = base.replace(/[^\w.-]+/g, '_');
  return clean.includes('.') ? clean : `${clean}.${fallbackExtension}`;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}
