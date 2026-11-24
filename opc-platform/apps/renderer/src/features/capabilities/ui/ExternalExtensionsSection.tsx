import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  AudioLines,
  Brain,
  Code2,
  FileCode2,
  FolderOpen,
  Image,
  MessagesSquare,
  Package,
  Plug,
  ScanText,
  ShieldCheck,
  SlidersHorizontal,
  Volume2,
  Wrench,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PiExtensionCatalog, PiExtensionView } from '@opc/shared/ipc';
import { buttonClass, Section, Toggle } from '@/features/settings/ui/kit';
import { cn } from '@/shared/lib/cn';

/**
 * Pi extensions found on this machine, in 技能与工具.
 */
export function ExternalExtensionsSection({
  catalog,
  filteredEmpty = false,
  busyId,
  error,
  onToggle,
}: {
  catalog: PiExtensionCatalog | null;
  filteredEmpty?: boolean;
  /** Id currently being enabled/disabled, so its switch can show progress. */
  busyId: string;
  error: string;
  onToggle: (entry: PiExtensionView, next: boolean) => void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PiExtensionView | null>(null);

  const entries = catalog?.entries ?? [];

  const requestToggle = (entry: PiExtensionView, next: boolean) => {
    if (next && !entry.trusted) {
      setPending(entry);
      return;
    }
    onToggle(entry, next);
  };

  return (
    <>
      <Section
        title={t('capabilities.external.title')}
        description={t('capabilities.external.description')}
        action={
          <span className="rounded-full border border-line bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-ink-secondary tabular-nums">
            {entries.length}
          </span>
        }
      >
        {error ? (
          <p className="border-b border-line bg-danger/5 px-4 py-2 text-xs text-danger">{error}</p>
        ) : null}

        {entries.length > 0 ? (
          <div className="grid gap-3 p-4 md:grid-cols-2">
            {entries.map((entry) => (
              <ExternalRow
                key={entry.id}
                entry={entry}
                busy={busyId === entry.id}
                onToggle={requestToggle}
              />
            ))}
          </div>
        ) : filteredEmpty ? (
          <p className="px-4 py-8 text-center text-sm text-ink-tertiary">
            {t('capabilities.ui.noMatches')}
          </p>
        ) : (
          <div className="px-4 py-5">
            <div className="rounded-xl border border-dashed border-line bg-surface-muted/30 px-4 py-4">
              <p className="text-sm font-medium text-ink-secondary">{t('capabilities.external.empty')}</p>
              <ul className="mt-2.5 flex flex-wrap gap-1.5">
                {(catalog?.roots ?? []).map((root) => (
                  <li
                    key={root}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-3xs text-ink-tertiary"
                  >
                    <FolderOpen className="size-3 shrink-0 text-ink-quaternary" />
                    <code className="truncate font-mono">{root}</code>
                  </li>
                ))}
              </ul>
              <p className="mt-2.5 max-w-[44rem] text-xs leading-relaxed text-ink-quaternary">
                {t('capabilities.external.emptyHint')}
              </p>
            </div>
          </div>
        )}
      </Section>

      {pending ? (
        <TrustDialog
          entry={pending}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            onToggle(pending, true);
            setPending(null);
          }}
        />
      ) : null}
    </>
  );
}

function ExternalRow({
  entry,
  busy,
  onToggle,
}: {
  entry: PiExtensionView;
  busy: boolean;
  onToggle: (entry: PiExtensionView, next: boolean) => void;
}) {
  const { t } = useTranslation();
  const Icon = extensionIcon(entry.name);
  const status = entry.enabled && entry.loaded
    ? { label: t('capabilities.external.loaded'), dot: 'bg-success', text: 'text-success' }
    : entry.enabled
      ? { label: t('capabilities.external.failed'), dot: 'bg-danger', text: 'text-danger' }
      : { label: t('capabilities.external.disabled'), dot: 'bg-ink-quaternary', text: 'text-ink-tertiary' };

  const visibleTools = entry.loaded ? entry.tools.slice(0, 4) : [];
  const hiddenToolCount = entry.loaded ? Math.max(0, entry.tools.length - visibleTools.length) : 0;

  return (
    <article
      className={cn(
        'flex flex-col justify-between rounded-xl border p-3.5 transition-colors',
        entry.enabled
          ? 'border-line bg-surface hover:border-line-strong'
          : 'border-line/75 bg-surface-muted/25 hover:border-line-strong',
      )}
    >
      <div>
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'grid size-9 shrink-0 place-items-center rounded-lg border',
              entry.enabled
                ? 'border-accent/20 bg-accent-soft text-accent-ink'
                : 'border-line bg-surface-muted text-ink-tertiary',
            )}
          >
            <Icon className="size-4" />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h4 className="truncate text-sm font-semibold text-ink" title={entry.entry}>
                  {entry.name}
                </h4>
                <div className="mt-0.5 flex items-center gap-1.5 text-3xs text-ink-quaternary">
                  <span>{t(`capabilities.external.scope.${entry.scope}`)}</span>
                  {entry.version ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">v{entry.version}</span>
                    </>
                  ) : null}
                </div>
              </div>
              <Toggle
                checked={entry.enabled}
                disabled={busy}
                onChange={(next) => onToggle(entry, next)}
                label={entry.name}
                title={busy ? t('capabilities.external.working') : undefined}
              />
            </div>
          </div>
        </div>

        {entry.description ? (
          <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-ink-tertiary">
            {entry.description}
          </p>
        ) : null}
      </div>

      <div className="mt-3 space-y-2 border-t border-line/60 pt-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className={cn('inline-flex items-center gap-1.5 text-3xs font-medium', status.text)}>
            <span className={cn('size-1.5 rounded-full', status.dot)} aria-hidden="true" />
            {status.label}
          </span>
          {entry.unsupported.length > 0 ? (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-3xs font-medium text-warning"
              title={entry.unsupported.join(' · ')}
            >
              <AlertTriangle className="size-3" />
              {t('capabilities.external.partial')}
            </span>
          ) : null}
        </div>

        {visibleTools.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {visibleTools.map((tool) => (
              <code
                key={tool}
                className="rounded-md border border-line bg-surface-muted/60 px-1.5 py-0.5 font-mono text-3xs text-ink-secondary"
              >
                {tool}
              </code>
            ))}
            {hiddenToolCount > 0 ? (
              <span className="rounded-md border border-line bg-surface-muted/40 px-1.5 py-0.5 font-mono text-3xs text-ink-quaternary">
                +{hiddenToolCount}
              </span>
            ) : null}
          </div>
        ) : null}

        {entry.error ? (
          <p className="flex items-start gap-1.5 text-3xs leading-relaxed text-danger">
            <AlertTriangle className="mt-px size-3 shrink-0" />
            <span className="min-w-0 break-words">{entry.error}</span>
          </p>
        ) : null}
      </div>
    </article>
  );
}

function extensionIcon(name: string): LucideIcon {
  const normalized = name.toLowerCase();
  if (normalized.includes('coding') || normalized.includes('code')) return Code2;
  if (normalized.includes('work')) return Package;
  if (normalized.includes('sandbox') || normalized.includes('limit')) return ShieldCheck;
  if (normalized.includes('image')) return Image;
  if (normalized.includes('speech') || normalized.includes('voice')) return Volume2;
  if (normalized.includes('ocr')) return ScanText;
  if (normalized.includes('memory')) return Brain;
  if (normalized.includes('comm')) return MessagesSquare;
  if (normalized.includes('audio')) return AudioLines;
  if (normalized.includes('setting') || normalized.includes('config')) return SlidersHorizontal;
  if (normalized.includes('skill')) return FileCode2;
  return Plug;
}

function TrustDialog({
  entry,
  onCancel,
  onConfirm,
}: {
  entry: PiExtensionView;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div
      role="presentation"
      onMouseDown={onCancel}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
    >
      <div
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-line bg-surface shadow-popover"
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="flex items-center gap-2 text-base-plus font-semibold text-ink">
            <Wrench className="size-4 text-warning" />
            {t('capabilities.external.trustTitle', { name: entry.name })}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label={t('common.close')}
            className="rounded-md p-1 text-ink-tertiary transition-colors hover:bg-surface-muted hover:text-ink"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="space-y-3 px-4 py-3.5 text-sm leading-relaxed text-ink-secondary">
          <p>{t('capabilities.external.trustBody')}</p>
          <ul className="space-y-1 text-xs text-ink-tertiary">
            <li>· {t('capabilities.external.trustRisk.code')}</li>
            <li>· {t('capabilities.external.trustRisk.data')}</li>
            <li>· {t('capabilities.external.trustRisk.network')}</li>
          </ul>
          <code
            className="block truncate rounded-md border border-line bg-surface-muted px-2.5 py-1.5 font-mono text-3xs text-ink-tertiary"
            title={entry.entry}
          >
            {entry.entry}
          </code>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button type="button" className={buttonClass.secondary} onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className={buttonClass.primary} onClick={onConfirm}>
            {t('capabilities.external.trustConfirm')}
          </button>
        </footer>
      </div>
    </div>
  );
}
