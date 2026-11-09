import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, ChevronDown, LoaderCircle, Mic, Paperclip, Square, X } from 'lucide-react';
import type { ChatAttachmentRef } from '@opc/shared/domain';
import { useTranslation } from 'react-i18next';
import { QUICK_PROMPTS } from '../model/quickPrompts';
import { useModels } from '@/features/models/model/useModels';
import { useVoiceRecorder } from '../model/useVoiceRecorder';
import { getFileIcon } from '@/shared/file-icon/file-icons';

interface ComposerProps {
  onSend: (text: string, mentionIds: string[], attachments?: ChatAttachmentRef[]) => void;
}

/** Single-line Buddy composer, matching the supplied IM home reference. */
export function Composer({ onSend }: ComposerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [examplesOpen, setExamplesOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<ChatAttachmentRef[]>([]);
  const [dragging, setDragging] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  useEffect(() => {
    if (!voiceError) return;
    const timeout = window.setTimeout(() => setVoiceError(null), 8_000);
    return () => window.clearTimeout(timeout);
  }, [voiceError]);
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
  const canSend = text.trim().length > 0 || attachments.length > 0;

  const addFiles = useCallback(async (files: File[]) => {
    setAttachmentError(null);
    const refs: ChatAttachmentRef[] = [];
    for (const file of files) {
      const filePath = (file as File & { path?: string }).path;
      if (!filePath) { setAttachmentError('无法读取该文件路径'); continue; }
      if (file.size > 500 * 1024 * 1024) { setAttachmentError('单个附件不能超过 500MB'); continue; }
      refs.push({ id: `${filePath}:${file.size}`, name: file.name, path: filePath, size: file.size, ...(file.type ? { mimeType: file.type } : {}), source: 'file', availability: 'available' });
    }
    setAttachments((current) => [...current, ...refs].slice(0, 20));
  }, []);

  const submit = () => {
    const value = text.trim();
    if (!value && attachments.length === 0) return;
    onSend(value, [], attachments);
    setText('');
    setAttachments([]);
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
      {attachments.length > 0 ? <AttachmentTray attachments={attachments} onRemove={(id) => setAttachments((current) => current.filter((item) => item.id !== id))} /> : null}
      {attachmentError ? <div className="buddy-attachment-error mx-auto mb-2 w-full max-w-[880px]" role="status">{attachmentError}</div> : null}
      <div className={`buddy-composer-bar mx-auto flex min-h-[52px] w-full max-w-[880px] items-center gap-3 rounded-[15px] px-4 ${dragging ? 'buddy-composer-dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void addFiles([...event.dataTransfer.files]); }}>
        {dragging ? <div className="buddy-composer-drop-hint" aria-hidden="true"><Paperclip size={15} />松开即可添加附件</div> : null}
        <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { void addFiles([...event.target.files ?? []]); event.currentTarget.value = ''; }} />
        <button
          type="button"
          onClick={() => void window.opc!.chat.chooseAttachments().then((chosen) => setAttachments((current) => [...current, ...chosen].slice(0, 20))).catch((error) => setAttachmentError(error instanceof Error ? error.message : String(error)))}
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
          onPaste={(event) => { const files = [...event.clipboardData.files]; const withPath = files.filter((file) => Boolean((file as File & { path?: string }).path)); if (withPath.length) { event.preventDefault(); void addFiles(withPath); } else { const item = [...event.clipboardData.items].find((entry) => entry.kind === 'file'); if (item) { event.preventDefault(); const blob = item.getAsFile(); if (blob) void blob.arrayBuffer().then((bytes) => window.opc!.chat.materializeClipboardAttachment({ name: blob.name || `pasted-${Date.now()}`, mimeType: blob.type, bytes })).then((ref) => setAttachments((current) => [...current, ref].slice(0, 20))).catch((error) => setAttachmentError(error instanceof Error ? error.message : String(error))); } } }}
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

function AttachmentTray({ attachments, onRemove }: { attachments: readonly ChatAttachmentRef[]; onRemove: (id: string) => void }) {
  return (
    <div className="buddy-attachment-tray mx-auto mb-2 w-full max-w-[880px]" aria-label={`已选择 ${attachments.length} 个附件`}>
      <div className="buddy-attachment-tray-head">
        <span className="buddy-attachment-tray-label">附件</span>
        <span className="buddy-attachment-tray-count">{attachments.length}/20</span>
      </div>
      <div className="buddy-attachment-list">
        {attachments.map((file) => <AttachmentChip key={file.id} file={file} onRemove={() => onRemove(file.id)} />)}
      </div>
    </div>
  );
}

function AttachmentChip({ file, onRemove }: { file: ChatAttachmentRef; onRemove: () => void }) {
  const extension = file.name.includes('.') ? file.name.split('.').pop() : undefined;
  return (
    <div className="buddy-attachment-chip group">
      <span className="buddy-attachment-icon" dangerouslySetInnerHTML={{ __html: getFileIcon(extension, file.name) }} aria-hidden="true" />
      <span className="buddy-attachment-meta">
        <span className="buddy-attachment-name" title={file.name}>{file.name}</span>
        <span className="buddy-attachment-size">{formatAttachmentSize(file.size)}{file.availability === 'missing' ? ' · 文件不可用' : ''}</span>
      </span>
      <button type="button" className="buddy-attachment-remove" onClick={onRemove} aria-label={`移除 ${file.name}`} title="移除附件"><X size={14} strokeWidth={2.2} /></button>
    </div>
  );
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
