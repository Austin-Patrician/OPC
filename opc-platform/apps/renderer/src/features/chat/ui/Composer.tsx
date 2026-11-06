import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, ChevronDown, LoaderCircle, Mic, Paperclip, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { QUICK_PROMPTS } from '../model/quickPrompts';
import { useModels } from '@/features/models/model/useModels';
import { useVoiceRecorder } from '../model/useVoiceRecorder';

interface ComposerProps {
  onSend: (text: string, mentionIds: string[]) => void;
}

/** Single-line Buddy composer, matching the supplied IM home reference. */
export function Composer({ onSend }: ComposerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [examplesOpen, setExamplesOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const models = useModels();
  const asrRef = models.defaults.asr;
  const asrConfigured = Boolean(
    asrRef && models.providers.some((provider) =>
      provider.id === asrRef.providerId && provider.hasKey && provider.models.some(
        (model) => model.id === asrRef.modelId && model.capability === 'asr' && model.voiceEnabled,
      ),
    ),
  );
  const handleTranscript = useCallback((transcript: string) => {
    setText((current) => [current.trim(), transcript.trim()].filter(Boolean).join(' '));
    setVoiceError(null);
    inputRef.current?.focus();
  }, []);
  const handleVoiceError = useCallback((message: string) => setVoiceError(message), []);
  const voice = useVoiceRecorder({ onTranscript: handleTranscript, onError: handleVoiceError });
  const canSend = text.trim().length > 0;

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    onSend(value, []);
    setText('');
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  const fillExample = (value: string) => {
    setText(value);
    setExamplesOpen(false);
    inputRef.current?.focus();
  };

  const toggleVoice = () => {
    setVoiceError(null);
    if (voice.state === 'recording') voice.stop();
    else if (voice.state === 'idle' && asrConfigured) void voice.start();
  };

  return (
    <div className="buddy-composer-wrap shrink-0 px-6 pt-2 pb-5 sm:px-10">
      {examplesOpen ? (
        <div className="buddy-example-menu mx-auto mb-2 w-full max-w-[880px] rounded-xl border p-1.5 shadow-popover">
          <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[.12em] text-[#87938c]">
            {t('chat.quickPrompts')}
          </div>
          {QUICK_PROMPTS.slice(0, 5).map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => fillExample(prompt)}
              className="block w-full rounded-lg px-2.5 py-2 text-left text-[12px] text-[#526159] transition hover:bg-[#edf7f0] hover:text-[#168848]"
            >
              {prompt}
            </button>
          ))}
        </div>
      ) : null}
      <div className="buddy-composer-bar mx-auto flex h-[52px] w-full max-w-[880px] items-center gap-3 rounded-[15px] px-4">
        <button
          type="button"
          onClick={() => fillExample(t('chat.action.attachExample'))}
          title={t('chat.action.attach')}
          aria-label={t('chat.action.attach')}
          className="buddy-composer-icon shrink-0"
        >
          <Paperclip size={18} strokeWidth={1.8} />
        </button>
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
          placeholder={t('chat.inputPlaceholder')}
          aria-label={t('chat.inputPlaceholder')}
          className="buddy-composer-input min-w-0 flex-1 bg-transparent text-[13px] outline-none"
        />
        <button
          type="button"
          onClick={() => setExamplesOpen((open) => !open)}
          aria-label={t('chat.quickPromptsHint')}
          aria-expanded={examplesOpen}
          className="buddy-composer-icon shrink-0"
        >
          <ChevronDown size={18} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          onClick={toggleVoice}
          disabled={!asrConfigured || voice.state === 'transcribing'}
          title={asrConfigured ? t(voice.state === 'recording' ? 'chat.speech.stopRecording' : 'chat.action.voice') : t('chat.speech.noAsr')}
          aria-label={asrConfigured ? t(voice.state === 'recording' ? 'chat.speech.stopRecording' : 'chat.action.voice') : t('chat.speech.noAsr')}
          aria-pressed={voice.state === 'recording'}
          className={`buddy-composer-icon buddy-mic-button flex size-[34px] shrink-0 items-center justify-center rounded-full ${voice.state === 'recording' ? 'buddy-recording-button' : ''} disabled:cursor-not-allowed disabled:opacity-35`}
        >
          {voice.state === 'transcribing' ? <LoaderCircle className="animate-spin" size={18} /> : voice.state === 'recording' ? <Square size={16} fill="currentColor" /> : <Mic size={18} />}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label={t('common.send')}
          className="buddy-send-button flex size-[34px] shrink-0 items-center justify-center rounded-full text-white transition disabled:cursor-default disabled:opacity-45 disabled:shadow-none"
        >
          <ArrowUp size={17} strokeWidth={2.3} />
        </button>
      </div>
      {voice.state !== 'idle' || voiceError ? (
        <div className="mx-auto mt-2 w-full max-w-[880px] px-2 text-[11px]" aria-live="polite">
          {voiceError ? <span className="text-danger">{voiceError}</span> : null}
          {voice.state === 'recording' ? <span className="text-accent-text">{t('chat.speech.recording')}</span> : null}
          {voice.state === 'transcribing' ? <span className="text-ink-tertiary">{t('chat.speech.transcribing')}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
