import {
  ChevronDown,
  Monitor,
  MonitorSmartphone,
  MoreHorizontal,
  Phone,
  PlusCircle,
  Video,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '@/shared/ui/IconButton';

interface ChatHeaderProps {
  title: string;
  memberCount: number;
  onOpenDossier: () => void;
  onOpenAddMember: () => void;
}

/** 54px conversation header: identity on the left, the six Figma actions right. */
export function ChatHeader({
  title,
  memberCount,
  onOpenDossier,
  onOpenAddMember,
}: ChatHeaderProps) {
  const { t } = useTranslation();

  return (
    <header className="flex h-header shrink-0 items-center justify-between border-b border-line px-5 select-none">
      <div className="flex min-w-0 items-center gap-2.5">
        <h1 className="truncate text-xl font-semibold text-ink">{title}</h1>
        {memberCount > 1 ? (
          <span className="text-sm font-normal text-ink-tertiary">
            ({t('chat.members', { count: memberCount })})
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-[1.125rem] text-ink-secondary">
        <IconButton label={t('chat.action.call')} className="hidden sm:inline-flex">
          <Phone className="size-[1.125rem]" strokeWidth={1.6} />
        </IconButton>
        <IconButton label={t('chat.action.video')} className="hidden sm:inline-flex">
          <Video className="size-[1.1875rem]" strokeWidth={1.6} />
        </IconButton>
        <IconButton label={t('chat.action.screen')} className="hidden md:inline-flex">
          <Monitor className="size-[1.125rem]" strokeWidth={1.6} />
        </IconButton>
        <IconButton label={t('chat.action.devices')} className="hidden md:inline-flex">
          <span className="flex items-center">
            <MonitorSmartphone className="size-[1.125rem]" strokeWidth={1.6} />
            <ChevronDown className="size-3 text-ink-quaternary" />
          </span>
        </IconButton>
        <IconButton label={t('chat.action.addMember')} onClick={onOpenAddMember}>
          <PlusCircle className="size-[1.125rem]" strokeWidth={1.6} />
        </IconButton>
        <IconButton label={t('chat.dossier')} onClick={onOpenDossier}>
          <MoreHorizontal className="size-[1.1875rem]" strokeWidth={1.7} />
        </IconButton>
      </div>
    </header>
  );
}
