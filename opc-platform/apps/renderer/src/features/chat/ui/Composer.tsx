import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, LoaderCircle, Mic, Paperclip, Square, X } from 'lucide-react';
import type { ChatAttachmentRef } from '@opc/shared/domain';
import { useTranslation } from 'react-i18next';
import { useModels } from '@/features/models/model/useModels';
import { useVoiceRecorder } from '../model/useVoiceRecorder';
import { getFileIcon } from '@/shared/file-icon/file-icons';

/** Maximum visible rows before the composer starts scrolling. */
const MAX_COMPOSER_ROWS = 5;

interface ComposerProps {
  onSend: (text: string, mentionIds: string[], attachments?: ChatAttachmentRef[]) => void;
  /** Previously sent user messages, newest first. */
  history: readonly string[];
}

/** Single-line Buddy composer, matching the supplied IM home reference. */
export function Composer({ onSend, history }: ComposerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [historyDraft, setHistoryDraft] = useState('');
  /** True once the draft needs more than one line in the compact row layout. */
  const [isMultiline, setIsMultiline] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const attachRef = useRef<HTMLButtonElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
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
  /**
   * Decide whether the draft still fits on one line. The measurement always
   * uses the textarea width of the compact layout, so the decision cannot flip
   * back and forth after the layout itself becomes wider.
   */
  const updateMultiline = useCallback(() => {
    const bar = barRef.current;
    const input = inputRef.current;
    const measure = measureRef.current;
    if (!bar || !input || !measure) return;
    const style = window.getComputedStyle(bar);
    const horizontalPadding =
      (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    const gap = Number.parseFloat(style.columnGap) || 12;
    const controlsWidth =
      (attachRef.current?.offsetWidth ?? 18) +
      (micRef.current?.offsetWidth ?? 34) +
      (sendRef.current?.offsetWidth ?? 34);
    const compactWidth = Math.max(
      40,
      bar.clientWidth - horizontalPadding - controlsWidth - gap * 3 - 2,
    );
    measure.style.width = `${compactWidth}px`;
    const lineHeight = Number.parseFloat(window.getComputedStyle(measure).lineHeight) || 20;
    setIsMultiline(measure.scrollHeight > lineHeight + 1);
  }, []);
  // Grow with the content up to five lines, then scroll inside the textarea.
  const resizeInput = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    const style = window.getComputedStyle(input);
    const lineHeight = Number.parseFloat(style.lineHeight) || 20;
    const verticalPadding =
      (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const maxHeight = lineHeight * MAX_COMPOSER_ROWS + verticalPadding;
    input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);
  useLayoutEffect(() => {
    updateMultiline();
    resizeInput();
  }, [text, isMultiline, updateMultiline, resizeInput]);
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === 'undefined') return undefined;
    let lastWidth = bar.clientWidth;
    const observer = new ResizeObserver(() => {
      if (bar.clientWidth === lastWidth) return;
      lastWidth = bar.clientWidth;
      updateMultiline();
      resizeInput();
    });
    observer.observe(bar);
    return () => observer.disconnect();
  }, [updateMultiline, resizeInput]);
  const models = useModels();
  const asrRef = models.defaults.asr;
  const asrConfigured = Boolean(
    asrRef && models.providers.some((provider) =>
      provider.id === asrRef.providerId && provider.hasKey && provider.models.some(
        (model) => model.id === asrRef.modelId && model.capability === 'asr' && model.voiceEnabled,
      ),
    ),
  );
  /** Set text and put the caret at the end, used when recalling history. */
  const applyComposerText = (value: string) => {
    setText(value);
    window.requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(value.length, value.length);
    });
  };
  const resetHistory = () => {
    setHistoryIndex(null);
    setHistoryDraft('');
  };
  const handleTranscript = useCallback((transcript: string) => {
    setText((current) => [current.trim(), transcript.trim()].filter(Boolean).join(' '));
    setHistoryIndex(null);
    setHistoryDraft('');
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
    resetHistory();
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      // Shift+Enter inserts a newline; plain Enter sends.
      if (event.shiftKey) return;
      event.preventDefault();
      submit();
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    // Leave modified arrows (selection, word jumps, shortcuts) to the input.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (history.length === 0) return;

    const input = event.currentTarget;
    if (event.key === 'ArrowUp') {
      if (historyIndex === null) {
        // Enter history only when the caret sits at the very start, so normal
        // cursor movement inside a draft is untouched.
        if (input.value.length > 0 && (input.selectionStart !== 0 || input.selectionEnd !== 0)) return;
        event.preventDefault();
        setHistoryDraft(text);
        setHistoryIndex(0);
        applyComposerText(history[0] ?? '');
        return;
      }
      if (historyIndex >= history.length - 1) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      const next = historyIndex + 1;
      setHistoryIndex(next);
      applyComposerText(history[next] ?? '');
      return;
    }

    if (historyIndex === null) return;
    event.preventDefault();
    if (historyIndex === 0) {
      setHistoryIndex(null);
      applyComposerText(historyDraft);
      setHistoryDraft('');
      return;
    }
    const next = historyIndex - 1;
    setHistoryIndex(next);
    applyComposerText(history[next] ?? '');
  };

  const toggleVoice = () => {
    setVoiceError(null);
    if (voice.state === 'recording') voice.stop();
    else if (voice.state === 'idle' && asrConfigured) void voice.start();
  };

  return (
    <div className="buddy-composer-wrap shrink-0 px-6 pt-2 pb-5 sm:px-10">
      {attachments.length > 0 ? <AttachmentTray attachments={attachments} onRemove={(id) => setAttachments((current) => current.filter((item) => item.id !== id))} /> : null}
      {attachmentError ? <div className="buddy-attachment-error mx-auto mb-2 w-full max-w-[880px]" role="status">{attachmentError}</div> : null}
      <div ref={barRef} className={`buddy-composer-bar mx-auto grid min-h-[52px] w-full max-w-[880px] grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-2 rounded-[15px] px-4 py-2 ${dragging ? 'buddy-composer-dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); void addFiles([...event.dataTransfer.files]); }}>
        <div
          ref={measureRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute top-0 left-0 whitespace-pre-wrap break-words text-[13px] leading-5"
        >
          {text || ' '}{text.endsWith('\n') ? ' ' : ''}
        </div>
        {dragging ? <div className="buddy-composer-drop-hint" aria-hidden="true"><Paperclip size={15} />松开即可添加附件</div> : null}
        <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { void addFiles([...event.target.files ?? []]); event.currentTarget.value = ''; }} />
        <button
          ref={attachRef}
          type="button"
          onClick={() => void window.opc!.chat.chooseAttachments().then((chosen) => setAttachments((current) => [...current, ...chosen].slice(0, 20))).catch((error) => setAttachmentError(error instanceof Error ? error.message : String(error)))}
          title={t('chat.action.attach')}
          aria-label={t('chat.action.attach')}
          className={`buddy-composer-icon shrink-0 ${isMultiline ? 'col-start-1 row-start-2' : 'col-start-1 row-start-1'}`}
        >
          <Paperclip size={18} strokeWidth={1.8} />
        </button>
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            // Editing a recalled message turns it into a fresh draft.
            if (historyIndex !== null) {
              setHistoryIndex(null);
              setHistoryDraft(event.target.value);
            }
          }}
          onKeyDown={onKeyDown}
          onPaste={(event) => { const files = [...event.clipboardData.files]; const withPath = files.filter((file) => Boolean((file as File & { path?: string }).path)); if (withPath.length) { event.preventDefault(); void addFiles(withPath); } else { const item = [...event.clipboardData.items].find((entry) => entry.kind === 'file'); if (item) { event.preventDefault(); const blob = item.getAsFile(); if (blob) void blob.arrayBuffer().then((bytes) => window.opc!.chat.materializeClipboardAttachment({ name: blob.name || `pasted-${Date.now()}`, mimeType: blob.type, bytes })).then((ref) => setAttachments((current) => [...current, ref].slice(0, 20))).catch((error) => setAttachmentError(error instanceof Error ? error.message : String(error))); } } }}
          autoFocus
          placeholder={t('chat.inputPlaceholder')}
          aria-label={t('chat.inputPlaceholder')}
          className={`buddy-composer-input min-w-0 w-full resize-none bg-transparent px-0 py-0 text-[13px] leading-5 outline-none ${isMultiline ? 'col-span-full col-start-1 row-start-1' : 'col-start-2 row-start-1'}`}
        />
        <button
          ref={micRef}
          type="button"
          onClick={toggleVoice}
          disabled={!asrConfigured || voice.state === 'transcribing'}
          title={asrConfigured ? t(voice.state === 'recording' ? 'chat.speech.stopRecording' : 'chat.action.voice') : t('chat.speech.noAsr')}
          aria-label={asrConfigured ? t(voice.state === 'recording' ? 'chat.speech.stopRecording' : 'chat.action.voice') : t('chat.speech.noAsr')}
          aria-pressed={voice.state === 'recording'}
          className={`buddy-composer-icon buddy-mic-button flex size-[34px] shrink-0 items-center justify-center rounded-full ${isMultiline ? 'col-start-3 row-start-2' : 'col-start-3 row-start-1'} ${voice.state === 'recording' ? 'buddy-recording-button' : ''} disabled:cursor-not-allowed disabled:opacity-35`}
        >
          {voice.state === 'transcribing' ? <LoaderCircle className="animate-spin" size={18} /> : voice.state === 'recording' ? <Square size={16} fill="currentColor" /> : <Mic size={18} />}
        </button>
        <button
          ref={sendRef}
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label={t('common.send')}
          className={`buddy-send-button flex size-[34px] shrink-0 items-center justify-center rounded-full text-white transition disabled:cursor-default disabled:opacity-45 disabled:shadow-none ${isMultiline ? 'col-start-4 row-start-2' : 'col-start-4 row-start-1'}`}
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
