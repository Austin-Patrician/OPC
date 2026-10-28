import { useCallback, useEffect, useRef, useState } from 'react';

export type VoiceRecorderState = 'idle' | 'recording' | 'transcribing';

/** Long enough for a meeting note, short enough to stay under one ASR request. */
const MAX_RECORDING_MS = 120_000;

interface UseVoiceRecorderOptions {
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}

/**
 * Records the microphone and turns it into a 16 kHz mono WAV.
 *
 * Xiaomi's ASR only accepts mp3/wav while `MediaRecorder` produces webm/opus in
 * Chromium, so the blob is decoded and re-rendered through an
 * `OfflineAudioContext`; no ffmpeg dependency is needed. The main process does
 * the actual transcription, so the API key never reaches the renderer.
 */
export function useVoiceRecorder({ onTranscript, onError }: UseVoiceRecorderOptions) {
  const [state, setState] = useState<VoiceRecorderState>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const callbacksRef = useRef({ onTranscript, onError });
  callbacksRef.current = { onTranscript, onError };

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }, []);

  const start = useCallback(async () => {
    if (state !== 'idle') return;
    const bridge = window.opc?.speech;
    if (!bridge) {
      callbacksRef.current.onError('主进程未连接，无法转写');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      callbacksRef.current.onError('当前环境不支持麦克风录音');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      cancelledRef.current = false;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        chunksRef.current = [];
        releaseStream();
        if (cancelledRef.current) return;
        setState('transcribing');
        try {
          const wav = await toWav(blob);
          const result = await bridge.transcribe({ audio: wav, mimeType: 'audio/wav' });
          if (!result.ok || !result.text) {
            throw new Error(result.error ?? '语音识别没有返回文本');
          }
          callbacksRef.current.onTranscript(result.text);
        } catch (error) {
          callbacksRef.current.onError(error instanceof Error ? error.message : String(error));
        } finally {
          setState('idle');
        }
      };

      recorder.start();
      setState('recording');
      timerRef.current = window.setTimeout(stop, MAX_RECORDING_MS);
    } catch (error) {
      releaseStream();
      setState('idle');
      callbacksRef.current.onError(
        error instanceof Error ? `无法打开麦克风：${error.message}` : '无法打开麦克风',
      );
    }
  }, [releaseStream, state, stop]);

  useEffect(
    () => () => {
      cancelledRef.current = true;
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      releaseStream();
    },
    [releaseStream],
  );

  return { state, start, stop };
}

/** Decodes whatever `MediaRecorder` produced and re-encodes it as 16 kHz WAV. */
async function toWav(blob: Blob): Promise<Uint8Array> {
  const encoded = await blob.arrayBuffer();
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(encoded.slice(0));
    const sampleRate = 16_000;
    const frames = Math.max(1, Math.ceil(decoded.duration * sampleRate));
    const offline = new OfflineAudioContext(1, frames, sampleRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0), sampleRate);
  } finally {
    await context.close();
  }
}

/** Minimal 16-bit PCM WAV encoder (mono). */
function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
