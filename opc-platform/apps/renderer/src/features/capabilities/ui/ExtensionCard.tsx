import { Fragment } from 'react';
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
import type { ExtensionGroup } from '../model/grouping';

/**
 * One built-in extension, shown on the 扩展 settings page.
 *
 * The card is a summary: a tool count and the shape of what the extension adds
 * (executors, hooks, task definitions). Tools themselves live on the 工具 page,
 * so the two views cannot drift apart.
 */

interface ExtensionVisual {
  icon?: LucideIcon;
  /** Some built-ins are recognised by a letter mark rather than an icon. */
  glyph?: string;
  gradient: string;
}

const BLUE = 'linear-gradient(140deg, #4d8df7 0%, #7fb2ff 100%)';
const PURPLE = 'linear-gradient(140deg, #8b5cf6 0%, #b794ff 100%)';
const ORANGE = 'linear-gradient(140deg, #f0863a 0%, #f9b46b 100%)';
const GREEN = 'linear-gradient(140deg, #2fc57a 0%, #5fe0a2 100%)';
const TEAL = 'linear-gradient(140deg, #17b8a6 0%, #5ee0d0 100%)';
const VIOLET = 'linear-gradient(140deg, #7c5cfa 0%, #ab8dff 100%)';

const BY_KEY: Record<string, ExtensionVisual> = {
  work: { icon: Briefcase, gradient: BLUE },
  coding: { icon: FileCode2, gradient: PURPLE },
  sandbox: { icon: ShieldCheck, gradient: ORANGE },
  speech: { icon: MessagesSquare, gradient: BLUE },
  image: { icon: ImageIcon, gradient: BLUE },
  ocr: { icon: ScanText, glyph: 'T', gradient: GREEN },
  memory: { icon: CalendarDays, gradient: BLUE },
  decision: { icon: Network, gradient: VIOLET },
  decompose: { icon: GitFork, gradient: VIOLET },
  skills: { icon: Sparkles, gradient: GREEN },
  comm: { icon: MessagesSquare, gradient: TEAL },
};

/** Unregistered extensions keep their raw id, but still get a recognisable tile. */
const BY_NAME: Record<string, ExtensionVisual> = {
  'opc.trace': { icon: Share2, gradient: TEAL },
  'opc.assistant-tools': { icon: Wrench, gradient: GREEN },
  'opc.recall': { icon: RefreshCw, gradient: GREEN },
};

export function extensionVisual(name: string): ExtensionVisual {
  const key = EXTENSION_KEY[name];
  return (key ? BY_KEY[key] : undefined) ?? BY_NAME[name] ?? { icon: Boxes, gradient: BLUE };
}

export function ExtensionTile({ name, size = 'md' }: { name: string; size?: 'md' | 'sm' }) {
  const visual = extensionVisual(name);
  const Icon = visual.icon;
  return (
    <span
      className={
        size === 'sm'
          ? 'grid size-11 shrink-0 place-items-center rounded-[0.9rem] text-white'
          : 'grid size-[3.25rem] shrink-0 place-items-center rounded-2xl text-white'
      }
      style={{ backgroundImage: visual.gradient }}
    >
      {visual.glyph ? (
        <span className="text-[1.35rem] font-bold leading-none">{visual.glyph}</span>
      ) : Icon ? (
        <Icon className={size === 'sm' ? 'size-5' : 'size-6'} strokeWidth={1.9} />
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
  // External Pi extensions are named `pi.<slug>` by the host; point at the
  // section above instead of the generic "unregistered" copy.
  const title = titleKey ? t(titleKey) : extensionFallbackTitle(group.name);
  const description = descriptionKey
    ? t(descriptionKey)
    : isExternalExtension(group.name)
      ? t('capabilities.external.groupDescription')
      : t('capabilities.unknownExtension');

  // Hook-only extensions are still capabilities; say what they add instead of tools.
  const extraParts = [
    group.tasks > 0 ? t('capabilities.counts.tasks', { count: group.tasks }) : '',
    group.hooks > 0 ? t('capabilities.counts.hooks', { count: group.hooks }) : '',
    group.sections > 0 ? t('capabilities.counts.sections', { count: group.sections }) : '',
  ].filter(Boolean);

  return (
    <article className="builtin-extension-card rounded-2xl">
      <button
        type="button"
        onClick={() => onSelect?.(group)}
        className="group/card flex w-full items-start gap-4 px-5 py-4 text-left"
      >
        <ExtensionTile name={group.name} />

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <h4 className="min-w-0 truncate text-2xl font-semibold leading-snug text-ink">{title}</h4>
            <div className="flex shrink-0 items-center gap-1.5">
              <span
                className="builtin-extension-count inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-2 py-[3px] text-xs font-semibold"
                title={t('capabilities.builtin.badgeLabel', { count: group.tools.length })}
              >
                {group.tools.length}
              </span>
              <ChevronRight className="size-[1.15rem] text-ink-quaternary transition-transform duration-150 group-hover/card:translate-x-0.5" />
            </div>
          </div>

          <p className="mt-1 line-clamp-2 text-base leading-relaxed text-ink-tertiary">{description}</p>

          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-3xs text-ink-quaternary">
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
        </div>
      </button>
    </article>
  );
}

function Meta({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon className="size-3 shrink-0" strokeWidth={1.8} />
      <span className="truncate">{label}</span>
    </span>
  );
}

const MetaDivider = () => <span aria-hidden="true" className="h-2.5 w-px shrink-0 bg-line" />;

/** Opened by a card's chevron: the tools behind the summary, without a page jump. */
export function ExtensionDetailsDialog({ group, onClose }: { group: ExtensionGroup; onClose: () => void }) {
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
    <div
      role="presentation"
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface shadow-popover"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          <ExtensionTile name={group.name} size="sm" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-semibold text-ink">{title}</h2>
            <code className="mt-0.5 block truncate font-mono text-3xs text-ink-quaternary">{group.name}</code>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-lg p-1 text-ink-tertiary transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
          <p className="text-sm leading-relaxed text-ink-tertiary">{description}</p>

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
            <h3 className="text-3xs font-semibold uppercase tracking-[0.12em] text-ink-quaternary">
              {t('capabilities.builtin.details.tools')}
            </h3>
            {group.tools.length > 0 ? (
              <ul className="mt-2 space-y-1.5">
                {group.tools.map((tool) => (
                  <li key={tool.name} className="rounded-xl border border-line/70 bg-surface-muted/45 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 truncate font-mono text-xs font-medium text-ink">{tool.name}</code>
                      {tool.deferred ? (
                        <span className="ml-auto shrink-0 rounded-full bg-surface px-1.5 py-0.5 text-3xs text-ink-quaternary">
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
              <p className="mt-2 rounded-xl border border-dashed border-line px-3 py-4 text-xs text-ink-quaternary">
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
