import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CompanyProfile } from '@opc/shared/domain';
import { bossName, companyName } from '@/entities/company/model/options';

/** Matches the cap in `CompanyService.update`. */
const BOSS_NAME_MAX = 20;

interface IdentityPopoverProps {
  profile: CompanyProfile;
  /** Commits a new display name through the same IPC call the settings page uses. */
  onRename: (name: string) => void;
}

/**
 * The card that opens to the right of the title-bar avatar.
 *
 * Three facts only — your name, the company and your role — because the title bar
 * no longer has room (or need) to print the company name. The name itself is still
 * renameable in place: the pencil appears on hover and commits on Enter/blur.
 */
export function IdentityPopover({ profile, onRename }: IdentityPopoverProps) {
  const { t } = useTranslation();
  const boss = bossName(profile, t('company.bossFallback'));
  const company = companyName(profile, t('company.fallbackName'));

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(profile.bossName);

  const startEdit = () => {
    setDraft(profile.bossName);
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== profile.bossName) onRename(next);
  };

  return (
    <div
      role="dialog"
      data-testid="identity-card"
      aria-label={t('titleBar.profile')}
      className="no-drag absolute top-0 left-full z-50 ml-2 w-72 cursor-default rounded-xl border border-line bg-surface p-3 shadow-popover"
    >
      <dl className="space-y-2">
        <div className="group/name flex items-center gap-3">
          <dt className="w-14 shrink-0 text-2xs text-ink-tertiary">{t('titleBar.fields.name')}</dt>
          <dd className="flex min-w-0 flex-1 items-center gap-1">
            {editing ? (
              <input
                autoFocus
                value={draft}
                maxLength={BOSS_NAME_MAX}
                aria-label={t('titleBar.bossName')}
                placeholder={t('titleBar.bossNamePlaceholder')}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') {
                    // Cancel the rename, not the whole card.
                    event.stopPropagation();
                    setEditing(false);
                  }
                }}
                className="h-6 w-full min-w-0 rounded border border-accent bg-surface px-1.5 text-sm text-ink outline-none"
              />
            ) : (
              <>
                <span className="truncate text-sm text-ink">{boss}</span>
                <button
                  type="button"
                  onClick={startEdit}
                  title={t('titleBar.renameBoss')}
                  aria-label={t('titleBar.renameBoss')}
                  className="shrink-0 rounded p-1 text-ink-quaternary opacity-0 transition hover:text-ink focus-visible:opacity-100 group-hover/name:opacity-100"
                >
                  <Pencil className="size-3" />
                </button>
              </>
            )}
          </dd>
        </div>

        <div className="flex items-baseline gap-3">
          <dt className="w-14 shrink-0 text-2xs text-ink-tertiary">{t('titleBar.fields.company')}</dt>
          <dd className="min-w-0 flex-1 truncate text-sm text-ink">{company}</dd>
        </div>

        <div className="flex items-baseline gap-3">
          <dt className="w-14 shrink-0 text-2xs text-ink-tertiary">{t('titleBar.fields.role')}</dt>
          <dd className="min-w-0 flex-1 text-sm leading-snug text-ink">{t('org.founderRole')}</dd>
        </div>
      </dl>
    </div>
  );
}
