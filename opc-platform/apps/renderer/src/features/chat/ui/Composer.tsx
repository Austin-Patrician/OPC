import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AtSign,
  ChevronDown,
  Clock,
  Folder,
  Image as ImageIcon,
  Mic,
  MonitorSmartphone,
  Scissors,
  Send,
  Smile,
  Zap,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Agent } from '@/entities/agent/model/types';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { cn } from '@/shared/lib/cn';
import { QUICK_PROMPTS } from '../model/quickPrompts';
import { IconButton } from '@/shared/ui/IconButton';

interface ComposerProps {
  agents: readonly Agent[];
  onSend: (text: string, mentionIds: string[]) => void;
  onOpenDossier: () => void;
  onOpenDispatch: () => void;
}

/**
 * 175px composer: toolbar row, free-growing textarea, contextual actions.
 * Mentions are resolved to agent IDs here so the transport never parses prose.
 */
export function Composer({ agents, onSend, onOpenDossier, onOpenDispatch }: ComposerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [showMention, setShowMention] = useState(false);
  const [showQuickPrompts, setShowQuickPrompts] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSend = text.trim().length > 0;

  const mentionIds = useMemo(
    () => agents.filter((agent) => text.includes(`@${agent.name}`)).map((agent) => agent.id),
    [agents, text],
  );

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim(), mentionIds);
    setText('');
    setShowMention(false);
    setShowQuickPrompts(false);
  };

  const insertText = (value: string) => {
    setText((previous) => (previous.endsWith('@') ? `${previous.slice(0, -1)}${value} ` : `${previous}${value} `));
    setShowMention(false);
    textareaRef.current?.focus();
  };

  return (
    <div className="relative flex h-composer shrink-0 flex-col border-t border-line bg-panel select-none">
      {showMention ? (
        <Popover className="bottom-[9.0625rem] left-4 w-64">
          <div className="border-b border-line px-3 py-1 text-xs font-semibold text-ink-tertiary">
            {t('chat.mentionHint')}
          </div>
          <button
            type="button"
            onClick={() => insertText('@全体成员')}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm-plus font-medium text-danger hover:bg-surface-hover"
          >
            <span>{t('chat.mentionAll')}</span>
          </button>
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => insertText(`@${agent.name}`)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm-plus text-ink hover:bg-surface-hover"
            >
              <Avatar name={agent.name} src={agent.avatarUrl} size="xs" />
              <span className="truncate font-medium">{agent.name}</span>
              <span className="ml-auto shrink-0 text-2xs text-ink-tertiary">{agent.level}</span>
            </button>
          ))}
        </Popover>
      ) : null}

      {showQuickPrompts ? (
        <Popover className="bottom-[9.0625rem] left-4 w-[26.25rem] p-2">
          <div className="flex items-center justify-between px-2 py-1 text-xs-plus font-semibold text-ink">
            <span>{t('chat.quickPrompts')}</span>
            <button
              type="button"
              onClick={() => setShowQuickPrompts(false)}
              className="text-xs text-ink-tertiary hover:text-ink"
            >
              {t('common.close')}
            </button>
          </div>
          <div className="mt-1 space-y-1">
            {QUICK_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => {
                  setText(prompt);
                  setShowQuickPrompts(false);
                  textareaRef.current?.focus();
                }}
                className="w-full rounded-lg px-2.5 py-1.5 text-left text-sm text-ink-secondary transition-colors hover:bg-surface-hover hover:text-accent-ink"
              >
                {prompt}
              </button>
            ))}
          </div>
        </Popover>
      ) : null}

      <div className="flex items-center justify-between px-4 pt-2.5 pb-1.5 text-ink-secondary">
        <div className="flex items-center gap-[0.9375rem]">
          <IconButton label={t('chat.quickPromptsHint')} onClick={() => setShowQuickPrompts((v) => !v)}>
            <Smile className="size-[1.1875rem]" strokeWidth={1.6} />
          </IconButton>
          <IconButton label={t('chat.action.attach')} className="gap-0">
            <span className="flex items-center">
              <Scissors className="size-[1.125rem]" strokeWidth={1.6} />
              <ChevronDown className="size-3 text-ink-quaternary" />
            </span>
          </IconButton>
          <IconButton label={t('chat.brief')} onClick={onOpenDossier}>
            <span className="flex items-center">
              <Folder className="size-[1.125rem]" strokeWidth={1.6} />
              <ChevronDown className="size-3 text-ink-quaternary" />
            </span>
          </IconButton>
          <IconButton label={t('chat.action.image')} className="hidden sm:inline-flex">
            <ImageIcon className="size-[1.125rem]" strokeWidth={1.6} />
          </IconButton>
          <IconButton label={t('chat.action.devices')} className="hidden sm:inline-flex">
            <MonitorSmartphone className="size-[1.125rem]" strokeWidth={1.6} />
          </IconButton>
          <IconButton label={t('chat.action.voice')} className="hidden md:inline-flex">
            <Mic className="size-[1.125rem]" strokeWidth={1.6} />
          </IconButton>

          <div className="ml-2 hidden items-center gap-1.5 border-l border-line-strong pl-2 lg:flex">
            <button
              type="button"
              onClick={() => setShowMention((v) => !v)}
              className="flex items-center gap-1 rounded bg-ink/5 px-2 py-0.5 text-xs-plus text-ink-secondary transition-colors hover:bg-accent-soft hover:text-accent"
            >
              <AtSign className="size-3" />
              <span>{t('chat.mention')}</span>
            </button>
            <button
              type="button"
              onClick={() => setText((previous) => `${previous}@全体成员 `)}
              className="flex items-center gap-1 rounded bg-accent-soft px-2 py-0.5 text-xs-plus font-medium text-accent-ink transition-colors hover:bg-accent/15"
            >
              <Zap className="size-3" />
              <span>{t('chat.action.ai')}</span>
            </button>
          </div>
        </div>

        <IconButton label={t('chat.action.history')} onClick={onOpenDossier} className="hidden sm:inline-flex">
          <Clock className="size-[1.125rem]" strokeWidth={1.6} />
        </IconButton>
      </div>

      <div className="flex flex-1 flex-col px-4 pt-1 pb-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === '@') setShowMention(true);
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={t('chat.inputPlaceholder')}
          aria-label={t('chat.inputPlaceholder')}
          className="w-full flex-1 resize-none bg-transparent text-md leading-relaxed text-ink outline-none select-text placeholder:text-ink-quaternary"
        />

        {/* 派活 is always available: a task must be dispatchable without typing first. */}
        <div className="flex items-center justify-end gap-2 pt-1">
          {canSend ? (
            <span className="text-xs text-ink-quaternary">
              {t('chat.enterToSend')} · {t('chat.shiftEnter')}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onOpenDispatch}
            className="flex items-center gap-1 rounded-md border border-accent/40 px-3 py-1 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-soft"
          >
            <Zap className="size-3" />
            <span>{t('task.dispatch')}</span>
          </button>
          {canSend ? (
            <button
              type="button"
              onClick={submit}
              className="flex items-center gap-1 rounded-md bg-accent px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
            >
              <Send className="size-3" />
              <span>{t('common.send')}</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Popover({ children, className }: { children: ReactNode; className: string }) {
  return (
    <div
      className={cn(
        'absolute z-30 overflow-hidden rounded-xl border border-line bg-surface py-1.5 shadow-popover',
        className,
      )}
    >
      {children}
    </div>
  );
}
