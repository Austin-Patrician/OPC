import { useTranslation } from 'react-i18next';

interface ChatHeaderProps {
  title: string;
  memberCount: number;
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
export function ChatHeader({ title, memberCount }: ChatHeaderProps) {
  const { t } = useTranslation();

  return (
    <header className="flex h-header shrink-0 items-center border-b border-line px-5 select-none">
      <div className="flex min-w-0 items-center gap-2.5">
        <h1 className="truncate text-xl font-semibold text-ink">{title}</h1>
        {memberCount > 1 ? (
          <span className="text-sm font-normal text-ink-tertiary">
            ({t('chat.members', { count: memberCount })})
          </span>
        ) : null}
      </div>
    </header>
  );
}
