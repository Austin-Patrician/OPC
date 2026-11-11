import { useState } from 'react';
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
 *
 * The list is honest about the two-phase model: scanning only reads files, so a
 * disabled row shows where the code is but not what it registers. Turning one on
 * imports it into the main process, which is why the first toggle asks for trust
 * and every later one does not.
 */
export function ExternalExtensionsSection({
  catalog,
  busyId,
  error,
  onToggle,
}: {
  catalog: PiExtensionCatalog | null;
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
          <span className="rounded-full bg-accent-soft px-2.5 py-1 text-3xs font-semibold text-accent-ink">
            {entries.length}
          </span>
        }
        className="capabilities-section"
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
        ) : (
          <div className="px-4 py-6">
            <p className="text-sm text-ink-tertiary">{t('capabilities.external.empty')}</p>
            <ul className="mt-2 space-y-1">
              {(catalog?.roots ?? []).map((root) => (
                <li key={root} className="flex items-center gap-1.5 text-3xs text-ink-quaternary">
                  <FolderOpen className="size-3 shrink-0" />
                  <code className="truncate font-mono">{root}</code>
                </li>
              ))}
            </ul>
            <p className="mt-2 max-w-[42rem] text-xs leading-relaxed text-ink-quaternary">
              {t('capabilities.external.emptyHint')}
            </p>
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
    ? { label: t('capabilities.external.loaded'), className: 'bg-success/10 text-success' }
    : entry.enabled
      ? { label: t('capabilities.external.failed'), className: 'bg-danger/10 text-danger' }
      : { label: t('capabilities.external.disabled'), className: 'bg-surface-muted text-ink-tertiary' };

  return (
    <article className="capability-card rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <span className="capability-icon grid size-10 shrink-0 place-items-center rounded-xl">
          <Icon className="size-[18px]" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h4 className="truncate text-sm-plus font-semibold text-ink" title={entry.entry}>{entry.name}</h4>
              <div className="mt-1 flex items-center gap-1.5 text-3xs text-ink-quaternary">
                <span>{t(`capabilities.external.scope.${entry.scope}`)}</span>
                {entry.version ? <><span aria-hidden="true">·</span><span>v{entry.version}</span></> : null}
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

          {entry.description ? (
            <p className="mt-3 line-clamp-2 text-xs-plus leading-relaxed text-ink-tertiary">{entry.description}</p>
          ) : null}

          <div className="mt-4 flex items-center justify-between gap-2">
            <span className={cn('rounded-full px-2 py-1 text-3xs font-semibold', status.className)}>
              {status.label}
            </span>
            {entry.unsupported.length > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-1 text-3xs font-medium text-warning" title={entry.unsupported.join(' · ')}>
                <AlertTriangle className="size-3" />
                {t('capabilities.external.partial')}
              </span>
            ) : null}
          </div>

          {entry.loaded ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {entry.tools.map((tool) => (
                <code
                  key={tool}
                  className="rounded-lg border border-line bg-surface-muted/60 px-2 py-1 font-mono text-3xs text-ink-secondary"
                >
                  {tool}
                </code>
              ))}
            </div>
          ) : null}

          {entry.error ? (
            <p className="mt-1.5 flex items-start gap-1.5 text-3xs leading-relaxed text-danger">
              <AlertTriangle className="mt-px size-3 shrink-0" />
              <span className="min-w-0 break-words">{entry.error}</span>
            </p>
          ) : null}
        </div>

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-line bg-surface shadow-popover">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="flex items-center gap-2 text-base-plus font-semibold text-ink">
            <Wrench className="size-4 text-warning" />
            {t('capabilities.external.trustTitle', { name: entry.name })}
          </h2>
          <button type="button" onClick={onCancel} aria-label={t('common.close')}>
            <X className="size-4 text-ink-tertiary hover:text-ink" />
          </button>
        </header>

        <div className="space-y-3 px-4 py-3 text-sm leading-relaxed text-ink-secondary">
          <p>{t('capabilities.external.trustBody')}</p>
          <ul className="space-y-1 text-xs text-ink-tertiary">
            <li>· {t('capabilities.external.trustRisk.code')}</li>
            <li>· {t('capabilities.external.trustRisk.data')}</li>
            <li>· {t('capabilities.external.trustRisk.network')}</li>
          </ul>
          <code className="block truncate rounded-md border border-line bg-surface-muted px-2 py-1.5 font-mono text-3xs text-ink-tertiary" title={entry.entry}>
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
