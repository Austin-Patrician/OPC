import { Fragment, useEffect } from 'react';
import {
  Boxes,
  Briefcase,
  CalendarDays,
  ChevronRight,
  FileCode2,
  GitFork,
  Image as ImageIcon,
  Layers,
  MessagesSquare,
  Network,
  RefreshCw,
  ScanText,
  Share2,
  ShieldCheck,
  Sparkles,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { buttonClass } from '@/features/settings/ui/kit';
import {
  EXTENSION_KEY,
  extensionDescriptionKey,
  extensionFallbackTitle,
  extensionTitleKey,
  isExternalExtension,
} from '@/shared/lib/extensionCopy';
import { cn } from '@/shared/lib/cn';
import type { ExtensionGroup } from '../model/grouping';

type TonalStyle = 'sky' | 'violet' | 'amber' | 'emerald' | 'teal';

interface ExtensionVisual {
  icon?: LucideIcon;
  glyph?: string;
  tone: TonalStyle;
}

const TONE_CLASSES: Record<TonalStyle, string> = {
  sky: 'border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  violet: 'border-violet-500/20 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  amber: 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  emerald: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  teal: 'border-teal-500/20 bg-teal-500/10 text-teal-600 dark:text-teal-400',
};

const BY_KEY: Record<string, ExtensionVisual> = {
  work: { icon: Briefcase, tone: 'sky' },
  coding: { icon: FileCode2, tone: 'violet' },
  sandbox: { icon: ShieldCheck, tone: 'amber' },
  speech: { icon: MessagesSquare, tone: 'sky' },
  image: { icon: ImageIcon, tone: 'sky' },
  ocr: { icon: ScanText, glyph: 'T', tone: 'emerald' },
  memory: { icon: CalendarDays, tone: 'sky' },
  decision: { icon: Network, tone: 'violet' },
  decompose: { icon: GitFork, tone: 'violet' },
  skills: { icon: Sparkles, tone: 'emerald' },
  comm: { icon: MessagesSquare, tone: 'teal' },
};

const BY_NAME: Record<string, ExtensionVisual> = {
  'opc.trace': { icon: Share2, tone: 'teal' },
  'opc.assistant-tools': { icon: Wrench, tone: 'emerald' },
  'opc.recall': { icon: RefreshCw, tone: 'emerald' },
};

export function extensionVisual(name: string): ExtensionVisual {
  const key = EXTENSION_KEY[name];
  return (key ? BY_KEY[key] : undefined) ?? BY_NAME[name] ?? { icon: Boxes, tone: 'sky' };
}

export function ExtensionTile({ name, size = 'md' }: { name: string; size?: 'md' | 'sm' }) {
  const visual = extensionVisual(name);
  const Icon = visual.icon;
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-lg border',
        size === 'sm' ? 'size-8' : 'size-9',
        TONE_CLASSES[visual.tone],
      )}
    >
      {visual.glyph ? (
        <span className={cn('font-bold leading-none', size === 'sm' ? 'text-sm' : 'text-base')}>
          {visual.glyph}
        </span>
      ) : Icon ? (
        <Icon className={size === 'sm' ? 'size-4' : 'size-[18px]'} strokeWidth={1.85} />
      ) : null}
    </span>
  );
}

export function ExtensionCard({
  group,
  onSelect,
}: {
  group: ExtensionGroup;
  onSelect?: (group: ExtensionGroup) => void;
}) {
  const { t } = useTranslation();
  const titleKey = extensionTitleKey(group.name);
  const descriptionKey = extensionDescriptionKey(group.name);
  const title = titleKey ? t(titleKey) : extensionFallbackTitle(group.name);
  const description = descriptionKey
    ? t(descriptionKey)
    : isExternalExtension(group.name)
      ? t('capabilities.external.groupDescription')
      : t('capabilities.unknownExtension');

  const extraParts = [
    group.tasks > 0 ? t('capabilities.counts.tasks', { count: group.tasks }) : '',
    group.hooks > 0 ? t('capabilities.counts.hooks', { count: group.hooks }) : '',
    group.sections > 0 ? t('capabilities.counts.sections', { count: group.sections }) : '',
  ].filter(Boolean);

  return (
    <article className="h-full rounded-xl border border-line bg-surface transition-colors hover:border-line-strong hover:bg-surface-muted/20">
      <button
        type="button"
        onClick={() => onSelect?.(group)}
        className="group/card flex h-full w-full flex-col justify-between p-3.5 text-left"
      >
        <div className="w-full">
          <div className="flex items-start gap-3">
            <ExtensionTile name={group.name} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <h4 className="min-w-0 truncate text-sm font-semibold text-ink">{title}</h4>
                <div className="flex shrink-0 items-center gap-1">
                  <span
                    className="inline-flex min-w-[1.375rem] items-center justify-center rounded-full bg-surface-muted px-1.5 py-0.5 text-3xs font-medium text-ink-secondary tabular-nums"
                    title={t('capabilities.builtin.badgeLabel', { count: group.tools.length })}
                  >
                    {group.tools.length}
                  </span>
                  <ChevronRight className="size-4 text-ink-quaternary transition-transform duration-150 group-hover/card:translate-x-0.5 group-hover/card:text-ink-secondary" />
                </div>
              </div>
              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-tertiary">
                {description}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-3 flex w-full flex-wrap items-center gap-x-2 gap-y-1 border-t border-line/60 pt-2.5 text-3xs text-ink-quaternary">
          <Meta icon={Users} label={t('capabilities.extensionAgents', { count: group.agents })} />
          <MetaDivider />
          <Meta
            icon={Wrench}
            label={
              group.tools.length > 0
                ? t('capabilities.extensionToolCount', { count: group.tools.length })
                : t('capabilities.extensionNoTools')
            }
          />
          {extraParts.map((part) => (
            <Fragment key={part}>
              <MetaDivider />
              <Meta icon={Layers} label={part} />
            </Fragment>
          ))}
        </div>
      </button>
    </article>
  );
}

function Meta({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <Icon className="size-3 shrink-0" strokeWidth={1.8} />
      <span className="truncate">{label}</span>
    </span>
  );
}

const MetaDivider = () => <span aria-hidden="true" className="h-2.5 w-px shrink-0 bg-line" />;

/** Opened by a card's chevron: the tools behind the summary, without a page jump. */
export function ExtensionDetailsDialog({
  group,
  onClose,
}: {
  group: ExtensionGroup;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const titleKey = extensionTitleKey(group.name);
  const descriptionKey = extensionDescriptionKey(group.name);
  const title = titleKey ? t(titleKey) : extensionFallbackTitle(group.name);
  const description = descriptionKey
    ? t(descriptionKey)
    : isExternalExtension(group.name)
      ? t('capabilities.external.groupDescription')
      : t('capabilities.unknownExtension');

  const extraParts = [
    group.tasks > 0 ? t('capabilities.counts.tasks', { count: group.tasks }) : '',
    group.hooks > 0 ? t('capabilities.counts.hooks', { count: group.hooks }) : '',
    group.sections > 0 ? t('capabilities.counts.sections', { count: group.sections }) : '',
  ].filter(Boolean);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-line bg-surface shadow-popover"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          <ExtensionTile name={group.name} size="sm" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold text-ink">{title}</h2>
            <code className="mt-0.5 block truncate font-mono text-3xs text-ink-quaternary">
              {group.name}
            </code>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-md p-1 text-ink-tertiary transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
          <p className="text-sm leading-relaxed text-ink-secondary">{description}</p>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-3xs text-ink-quaternary">
            <Meta icon={Users} label={t('capabilities.extensionAgents', { count: group.agents })} />
            <MetaDivider />
            <Meta
              icon={Wrench}
              label={
                group.tools.length > 0
                  ? t('capabilities.extensionToolCount', { count: group.tools.length })
                  : t('capabilities.extensionNoTools')
              }
            />
            {extraParts.map((part) => (
              <Fragment key={part}>
                <MetaDivider />
                <Meta icon={Layers} label={part} />
              </Fragment>
            ))}
          </div>

          <section>
            <h3 className="text-3xs font-semibold tracking-[0.08em] text-ink-quaternary uppercase">
              {t('capabilities.builtin.details.tools')}
            </h3>
            {group.tools.length > 0 ? (
              <ul className="mt-2 space-y-1.5">
                {group.tools.map((tool) => (
                  <li
                    key={tool.name}
                    className="rounded-lg border border-line bg-surface-muted/40 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 truncate font-mono text-xs font-medium text-ink">
                        {tool.name}
                      </code>
                      {tool.deferred ? (
                        <span className="ml-auto shrink-0 rounded-full border border-line bg-surface px-1.5 py-0.5 text-3xs text-ink-quaternary">
                          {t('capabilities.deferred')}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-3xs leading-relaxed text-ink-tertiary">
                      {tool.description || t(`capabilities.tools.${tool.name}`, { defaultValue: '' })}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-ink-quaternary">
                {t('capabilities.builtin.details.noTools')}
              </p>
            )}
          </section>
        </div>

        <footer className="flex items-center justify-end border-t border-line px-5 py-3">
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('common.close')}
          </button>
        </footer>
      </div>
    </div>
  );
}
