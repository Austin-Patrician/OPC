import { useTranslation } from 'react-i18next';
import type { AssistantActivity, AssistantActivityPhase } from '@opc/shared/ipc';
import { BuddyMark } from '@/shared/ui/BuddyMark';

interface ChatHeaderProps {
  title: string;
  memberCount: number;
  activity?: AssistantActivity;
}

/**
 * 会话头部：只有身份。
 *
 * 这里曾经有一排「语音 / 视频 / 投屏 / 多设备」，四个按钮都没有 `onClick`——
 * 是照着设计稿摆的，点了什么也不会发生。还有「加成员」和「档案」：v2 里和你
 * 对话的只有 Router 一个，没有同事可加，也没有执行体档案可开。
 *
 * 留着它们的成本不是几行 JSX，是让用户以为这些事做得到。
 */
export function ChatHeader({ title, memberCount, activity }: ChatHeaderProps) {
  const { t } = useTranslation();
  const phase: AssistantActivityPhase = activity?.phase ?? 'idle';
  const statusText = t(`chat.activity.${phase}`);

  return (
    <header
      className="buddy-chat-header relative flex shrink-0 items-center border-b border-line px-4 select-none"
      style={{ height: 36, minHeight: 36, maxHeight: 36, flexBasis: 36 }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="truncate text-xl font-semibold text-ink">{title}</h1>
        {memberCount > 1 ? (
          <span className="text-sm font-normal text-ink-tertiary">
            ({t('chat.members', { count: memberCount })})
          </span>
        ) : null}
      </div>
      <div
        className="buddy-assistant-status absolute left-1/2 top-1/2 flex min-w-0 max-w-[min(48vw,320px)] -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-2"
        aria-live="polite"
        aria-label={statusText}
      >
        <BuddyMark size="xs" phase={phase} />
        <span className="buddy-assistant-status-label truncate text-xs font-medium">{statusText}</span>
        {phase !== 'idle' && phase !== 'completed' && phase !== 'error' ? (
          <span className="buddy-assistant-status-dots inline-flex shrink-0 gap-0.5" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        ) : null}
      </div>
    </header>
  );
}
