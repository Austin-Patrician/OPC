import { useEffect, useRef, useState } from 'react';
import { Loader2, Square, Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/cn';

/** Guard against reading a whole long report on one click. */
const MAX_SPEECH_CHARS = 4_000;

type SpeakState = 'idle' | 'loading' | 'playing';

/**
 * Reads one message aloud through the configured TTS model.
 *
 * Synthesis happens in the main process; this component only turns the returned
 * bytes into a blob URL and owns the audio element. Switching messages or
 * unmounting revokes the URL so a virtualized list cannot leak blobs.
 */
export function SpeakButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<SpeakState>('idle');
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const cleanup = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  };

  useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    },
    [],
  );

  const stop = () => {
    cleanup();
    setState('idle');
  };

  const speak = async () => {
    if (state === 'playing') {
      stop();
      return;
    }
    if (state === 'loading') return;

    const bridge = window.opc?.speech;
    const content = text.trim().slice(0, MAX_SPEECH_CHARS);
    if (!bridge || !content) return;

    setError(null);
    setState('loading');
    try {
      const result = await bridge.synthesize({ text: content, format: 'mp3' });
      if (!result.ok || !result.bytes) throw new Error(result.error ?? '语音合成没有返回音频');

      // Copy into a plain ArrayBuffer: the IPC value may be a view with a
      // non-ArrayBuffer backing store, which Blob does not accept directly.
      const buffer = new ArrayBuffer(result.bytes.byteLength);
      new Uint8Array(buffer).set(result.bytes);
      const url = URL.createObjectURL(new Blob([buffer], { type: result.mimeType ?? 'audio/mpeg' }));
      const audio = new Audio(url);
      audioRef.current = audio;
      urlRef.current = url;
      audio.onended = () => {
        cleanup();
        setState('idle');
      };
      audio.onerror = () => {
        cleanup();
        setError(t('chat.speech.synthesizeFailed'));
        setState('idle');
      };
      await audio.play();
      setState('playing');
    } catch (caught) {
      cleanup();
      setError(caught instanceof Error ? caught.message : String(caught));
      setState('idle');
    }
  };

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => void speak()}
        title={state === 'playing' ? t('chat.speech.stopReading') : t('chat.speech.readAloud')}
        aria-label={state === 'playing' ? t('chat.speech.stopReading') : t('chat.speech.readAloud')}
        aria-pressed={state === 'playing'}
        className={cn(
          'inline-flex size-5 items-center justify-center rounded text-ink-quaternary transition-colors hover:bg-ink/5 hover:text-accent',
          state === 'playing' && 'text-accent',
        )}
      >
        {state === 'loading' ? (
          <Loader2 className="size-3 animate-spin" />
        ) : state === 'playing' ? (
          <Square className="size-2.5 fill-current" />
        ) : (
          <Volume2 className="size-3" />
        )}
      </button>
      {error ? (
        <span className="max-w-[14rem] truncate text-2xs text-danger" title={error}>
          {error}
        </span>
      ) : null}
    </span>
  );
}
