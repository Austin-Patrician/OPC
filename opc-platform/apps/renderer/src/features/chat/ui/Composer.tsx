import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, LoaderCircle, Mic, Paperclip, Square, X } from 'lucide-react';
import {
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENTS_PER_MESSAGE,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  type ChatAttachmentRef,
} from '@opc/shared/domain';
import { useTranslation } from 'react-i18next';
import { useModels } from '@/features/models/model/useModels';
import { useVoiceRecorder } from '../model/useVoiceRecorder';
import { getFileIcon } from '@/shared/file-icon/file-icons';
import { openDocPreview } from '@/shared/model/docPreviewStore';
import { assistantName } from '@/entities/company/model/options';
import { useCompanyProfile } from '@/entities/company/model/useCompany';
import { emitBuddySignal, subscribeBuddySignal } from '@/shared/ui/buddyEvents';

/** Maximum visible rows before the composer starts scrolling. */
const MAX_COMPOSER_ROWS = 6;

interface ComposerProps {
  onSend: (text: string, mentionIds: string[], attachments?: ChatAttachmentRef[]) => void;
  /** Previously sent user messages, newest first. */
  history: readonly string[];
  /** True while Router or a background Worker is actively running. */
  busy?: boolean;
  /** Hard-stops active Router generation and running Workers. */
  onStop?: () => void;
}

/** Floating editorial two-row composer card aligned with the 760px message column. */
export function Composer({ onSend, history, busy = false, onStop }: ComposerProps) {
  const { t } = useTranslation();
  const profile = useCompanyProfile();
  const currentAssistantName = assistantName(profile, t('company.assistantFallback'));
  const inputPlaceholder = t('chat.inputPlaceholder', { name: currentAssistantName });
  const [text, setText] = useState('');
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [historyDraft, setHistoryDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<ChatAttachmentRef[]>([]);
  const [dragging, setDragging] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const lastTypingSignalRef = useRef(0);

  useEffect(() => {
    if (!voiceError) return;
    const timeout = window.setTimeout(() => setVoiceError(null), 8_000);
    return () => window.clearTimeout(timeout);
  }, [voiceError]);

  // Grow smoothly with content up to MAX_COMPOSER_ROWS, then scroll internally.
  const resizeInput = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    const style = window.getComputedStyle(input);
    const lineHeight = Number.parseFloat(style.lineHeight) || 22;
    const verticalPadding =
      (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const maxHeight = lineHeight * MAX_COMPOSER_ROWS + verticalPadding;
    input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useLayoutEffect(() => {
    resizeInput();
  }, [text, resizeInput]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || typeof ResizeObserver === 'undefined') return undefined;
    let lastWidth = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === lastWidth) return;
      lastWidth = input.clientWidth;
      resizeInput();
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [resizeInput]);

  const models = useModels();
  const asrRef = models.defaults.asr;
  const asrConfigured = Boolean(
    asrRef && models.providers.some((provider) =>
      provider.id === asrRef.providerId && provider.hasKey && provider.models.some(
        (model) => model.id === asrRef.modelId && model.capability === 'asr' && model.voiceEnabled,
      ),
    ),
  );

  /** Set text and put the caret at the end, used when recalling history or quoting. */
  const applyComposerText = useCallback((value: string) => {
    setText(value);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(value.length, value.length);
    });
  }, []);

  useEffect(() => {
    return subscribeBuddySignal((signal) => {
      if (signal.kind !== 'quote') return;
      const snippet = signal.text.trim();
      if (!snippet) return;
      const maxLen = 400;
      const clipped = snippet.length > maxLen ? `${snippet.slice(0, maxLen).trimEnd()}…` : snippet;
      const quoted = clipped
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join('\n');
      setText((current) => {
        const next = current.trim() ? `${current.trimEnd()}\n\n${quoted}\n\n` : `${quoted}\n\n`;
        window.requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.setSelectionRange(next.length, next.length);
        });
        return next;
      });
    });
  }, []);
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

  const appendAttachments = useCallback((incoming: readonly ChatAttachmentRef[]) => {
    setAttachments((current) => {
      const merged = [...current];
      let totalBytes = merged.reduce((sum, item) => sum + item.size, 0);
      for (const item of incoming) {
        if (item.size > MAX_CHAT_ATTACHMENT_BYTES) {
          setAttachmentError('单个附件不能超过 100MB');
          continue;
        }
        if (merged.length >= MAX_CHAT_ATTACHMENTS_PER_MESSAGE) {
          setAttachmentError(`单条消息最多添加 ${MAX_CHAT_ATTACHMENTS_PER_MESSAGE} 个附件`);
          break;
        }
        if (totalBytes + item.size > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
          setAttachmentError('单条消息附件总大小不能超过 250MB');
          continue;
        }
        merged.push(item);
        totalBytes += item.size;
      }
      return merged;
    });
  }, []);

  const addFiles = useCallback(async (files: File[]) => {
    setAttachmentError(null);
    if (files.length === 0) return;
    const resolver = window.opc?.chat.resolveDroppedFiles;
    if (resolver) {
      try {
        const refs = await resolver(files);
        if (refs.length > 0) appendAttachments(refs);
        else setAttachmentError('无法读取该文件路径');
      } catch (error) {
        setAttachmentError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const refs: ChatAttachmentRef[] = [];
    for (const file of files) {
      const filePath = (file as File & { path?: string }).path;
      if (!filePath) { setAttachmentError('无法读取该文件路径'); continue; }
      if (file.size > MAX_CHAT_ATTACHMENT_BYTES) { setAttachmentError('单个附件不能超过 100MB'); continue; }
      refs.push({ id: `${filePath}:${file.size}`, name: file.name, path: filePath, size: file.size, ...(file.type ? { mimeType: file.type } : {}), source: 'file', availability: 'available' });
    }
    if (refs.length > 0) appendAttachments(refs);
  }, [appendAttachments]);

  const submit = () => {
    const value = text.trim();
    if (!value && attachments.length === 0) return;
    onSend(value, [], attachments);
    emitBuddySignal({ kind: 'sent' });
    setText('');
    setAttachments([]);
    resetHistory();
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && busy && onStop) {
      event.preventDefault();
      onStop();
      return;
    }
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
    <div className="buddy-composer-wrap shrink-0 px-6 pt-1 pb-5">
      {attachments.length > 0 ? <AttachmentTray attachments={attachments} onRemove={(id) => setAttachments((current) => current.filter((item) => item.id !== id))} /> : null}
      {attachmentError ? <div className="buddy-attachment-error mx-auto mb-2 w-full max-w-[760px]" role="status">{attachmentError}</div> : null}
      <div
        className={`buddy-composer-bar mx-auto flex w-full max-w-[760px] flex-col rounded-[20px] ${dragging ? 'buddy-composer-dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!dragging) {
            setDragging(true);
            emitBuddySignal({ kind: 'file-drag', active: true });
          }
        }}
        onDragLeave={() => {
          setDragging(false);
          emitBuddySignal({ kind: 'file-drag', active: false });
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const files = [...event.dataTransfer.files];
          if (files.length > 0) emitBuddySignal({ kind: 'file-drop' });
          else emitBuddySignal({ kind: 'file-drag', active: false });
          void addFiles(files);
        }}
      >
        {dragging ? <div className="buddy-composer-drop-hint" aria-hidden="true"><Paperclip size={15} />松开即可添加附件</div> : null}
        <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { void addFiles([...event.target.files ?? []]); event.currentTarget.value = ''; }} />
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            const now = Date.now();
            if (event.target.value.length > 0 && now - lastTypingSignalRef.current >= 600) {
              lastTypingSignalRef.current = now;
              emitBuddySignal({ kind: 'typing' });
            }
            // Editing a recalled message turns it into a fresh draft.
            if (historyIndex !== null) {
              setHistoryIndex(null);
              setHistoryDraft(event.target.value);
            }
          }}
          onKeyDown={onKeyDown}
          onPaste={(event) => { const files = [...event.clipboardData.files]; const withPath = files.filter((file) => Boolean((file as File & { path?: string }).path)); if (withPath.length) { event.preventDefault(); void addFiles(withPath); } else { const item = [...event.clipboardData.items].find((entry) => entry.kind === 'file'); if (item) { event.preventDefault(); const blob = item.getAsFile(); if (blob) { if (blob.size > MAX_CHAT_ATTACHMENT_BYTES) { setAttachmentError('单个附件不能超过 100MB'); return; } setAttachmentError(null); void blob.arrayBuffer().then((bytes) => window.opc!.chat.materializeClipboardAttachment({ name: blob.name || `pasted-${Date.now()}`, mimeType: blob.type, bytes })).then((ref) => appendAttachments([ref])).catch((error) => setAttachmentError(error instanceof Error ? error.message : String(error))); } } } }}
          autoFocus
          placeholder={inputPlaceholder}
          aria-label={inputPlaceholder}
          className="buddy-composer-input w-full min-w-0 resize-none bg-transparent px-4 pt-3.5 pb-1.5 text-[14.5px] leading-[1.55] outline-none"
        />
        <div className="flex items-center justify-between gap-2 px-2.5 pt-1 pb-2.5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => { setAttachmentError(null); void window.opc!.chat.chooseAttachments().then((chosen) => appendAttachments(chosen)).catch((error) => setAttachmentError(error instanceof Error ? error.message : String(error))); }}
              title={t('chat.action.attach')}
              aria-label={t('chat.action.attach')}
              className="buddy-composer-icon size-8 rounded-lg text-ink-tertiary hover:bg-surface-hover hover:text-ink"
            >
              <Paperclip size={17} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              onClick={toggleVoice}
              disabled={!asrConfigured || voice.state === 'transcribing'}
              title={asrConfigured ? t(voice.state === 'recording' ? 'chat.speech.stopRecording' : 'chat.action.voice') : t('chat.speech.noAsr')}
              aria-label={asrConfigured ? t(voice.state === 'recording' ? 'chat.speech.stopRecording' : 'chat.action.voice') : t('chat.speech.noAsr')}
              aria-pressed={voice.state === 'recording'}
              className={`buddy-composer-icon buddy-mic-button flex size-8 shrink-0 items-center justify-center rounded-lg ${voice.state === 'recording' ? 'buddy-recording-button' : ''} disabled:cursor-not-allowed disabled:opacity-35`}
            >
              {voice.state === 'transcribing' ? <LoaderCircle className="animate-spin" size={17} /> : voice.state === 'recording' ? <Square size={15} fill="currentColor" /> : <Mic size={17} strokeWidth={1.8} />}
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            {busy && onStop && !canSend ? (
              <button
                type="button"
                onClick={onStop}
                title="停止当前执行（Esc）"
                aria-label="停止当前执行"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-danger text-white shadow-card transition hover:opacity-90"
              >
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                title={busy ? '发送并立即打断/调整当前执行' : t('common.send')}
                aria-label={t('common.send')}
                className="buddy-send-button flex size-8 shrink-0 items-center justify-center rounded-full transition disabled:cursor-default disabled:opacity-35 disabled:shadow-none"
              >
                <ArrowUp size={16} strokeWidth={2.3} />
              </button>
            )}
          </div>
        </div>
      </div>
      {voice.state !== 'idle' || voiceError ? (
        <div className="mx-auto mt-2 w-full max-w-[760px] px-2 text-[11px]" aria-live="polite">
          {voiceError ? <span className="text-danger">{voiceError}</span> : null}
          {voice.state === 'recording' ? <span className="text-accent-ink">{t('chat.speech.recording')}</span> : null}
          {voice.state === 'transcribing' ? <span className="text-ink-tertiary">{t('chat.speech.transcribing')}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function AttachmentTray({ attachments, onRemove }: { attachments: readonly ChatAttachmentRef[]; onRemove: (id: string) => void }) {
  return (
    <div className="buddy-attachment-tray mx-auto mb-2 w-full max-w-[760px]" aria-label={`已选择 ${attachments.length} 个附件`}>
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
  const { t } = useTranslation();
  const extension = file.name.includes('.') ? file.name.split('.').pop() : undefined;
  const missing = file.availability === 'missing';
  return (
    <div className="buddy-attachment-chip group">
      <button
        type="button"
        disabled={missing}
        title={missing ? undefined : t('chat.artifact.preview')}
        onClick={() => {
          if (missing) return;
          openDocPreview({
            source: { kind: 'staged', attachmentId: file.id },
            fileName: file.name,
            bytes: file.size,
          });
        }}
        className="flex min-w-0 flex-1 items-center gap-[9px] text-left disabled:cursor-default"
      >
        <span className="buddy-attachment-icon" dangerouslySetInnerHTML={{ __html: getFileIcon(extension, file.name) }} aria-hidden="true" />
        <span className="buddy-attachment-meta">
          <span className="buddy-attachment-name" title={file.name}>{file.name}</span>
          <span className="buddy-attachment-size">{formatAttachmentSize(file.size)}{missing ? ' · 文件不可用' : ''}</span>
        </span>
      </button>
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
