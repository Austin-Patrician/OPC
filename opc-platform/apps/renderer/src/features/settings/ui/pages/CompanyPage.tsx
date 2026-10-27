import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, ImagePlus, Loader2, Upload, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CompanyProfile, CompanyProfilePatch } from '@opc/shared/domain';
import type { BudgetView } from '@opc/shared/ipc';
import {
  BRAND_COLORS,
  INDUSTRIES,
  brandColor,
  colorLabelKey,
  companyName,
  industryLabelKey,
} from '@/entities/company/model/options';
import { useCompany, useCompanyProfile } from '@/entities/company/model/useCompany';
import { CompanyMark } from '@/entities/company/ui/CompanyMark';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { cn } from '@/shared/lib/cn';
import { buttonClass, PageHeader, Row, Section, TextField } from '../kit';

const NAME_MAX = 40;
const BOSS_MAX = 20;
const VISION_MAX = 60;

/** Matches `CompanyService.clampImage`: 500 KB of binary ≈ 683 K base64 chars. */
const IMAGE_MAX_BYTES = 500 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];

type ImageField = 'logo' | 'bossAvatar';

/**
 * Logo uploader used for both identities. The preview doubles as the picker (hover
 * shows the upload hint); the explicit button is there for discoverability.
 */
function LogoPicker({
  preview,
  hasImage,
  rounded = 'rounded-xl',
  label,
  error,
  onPick,
  onClear,
}: {
  preview: ReactNode;
  hasImage: boolean;
  rounded?: string;
  label: string;
  error?: string | null;
  onPick: (file: File | undefined) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        aria-label={label}
        className={cn(
          'group relative shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-accent',
          rounded,
        )}
      >
        {preview}
        <span
          className={cn(
            'pointer-events-none absolute inset-0 flex items-center justify-center bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100',
            rounded,
          )}
        >
          <ImagePlus className="size-4" />
        </span>
      </button>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => inputRef.current?.click()} className={buttonClass.secondary}>
            <Upload className="size-3.5" />
            {hasImage ? t('settings.company.imageReplace') : t('settings.company.imageUpload')}
          </button>
          {hasImage ? (
            <button
              type="button"
              onClick={onClear}
              className="text-xs text-ink-tertiary transition-colors hover:text-danger"
            >
              {t('settings.company.imageRemove')}
            </button>
          ) : null}
        </div>
        {error ? <p className="mt-1 text-2xs text-danger">{error}</p> : null}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={IMAGE_TYPES.join(',')}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset first, so re-selecting the same file still fires `change`.
          event.target.value = '';
          onPick(file);
        }}
      />
    </div>
  );
}

/**
 * Settings → 通用 → 公司与称呼.
 *
 * One form, one save: name, industry, vision, brand colour and both uploaded
 * identities are drafts until the header's 保存 runs. Nothing here writes on blur
 * or on every keystroke, so a half-edited name never reaches the title bar.
 *
 * Logos are small base64 data URLs kept in `app_setting` (see `CompanyService`);
 * the renderer only validates type/size before reading the file, the main process
 * re-validates the payload.
 */
export function CompanyPage() {
  const { t, i18n } = useTranslation();
  const profile = useCompanyProfile();
  const update = useCompany((state) => state.update);
  const status = useCompany((state) => state.status);

  const [nameDraft, setNameDraft] = useState(profile.name);
  const [bossDraft, setBossDraft] = useState(profile.bossName);
  const [visionDraft, setVisionDraft] = useState(profile.vision);
  const [industryDraft, setIndustryDraft] = useState(profile.industry);
  const [colorDraft, setColorDraft] = useState(profile.colorId);
  const [logoDraft, setLogoDraft] = useState(profile.logo ?? '');
  const [bossAvatarDraft, setBossAvatarDraft] = useState(profile.bossAvatar ?? '');
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<{ field: ImageField; message: string } | null>(null);
  const [budget, setBudget] = useState<BudgetView | null>(null);

  useEffect(() => setNameDraft(profile.name), [profile.name]);
  useEffect(() => setBossDraft(profile.bossName), [profile.bossName]);
  useEffect(() => setVisionDraft(profile.vision), [profile.vision]);
  useEffect(() => setIndustryDraft(profile.industry), [profile.industry]);
  useEffect(() => setColorDraft(profile.colorId), [profile.colorId]);
  useEffect(() => setLogoDraft(profile.logo ?? ''), [profile.logo]);
  useEffect(() => setBossAvatarDraft(profile.bossAvatar ?? ''), [profile.bossAvatar]);

  useEffect(() => {
    void window.opc?.budget
      .overview()
      .then((overview) => setBudget(overview.budgets.find((row) => row.scope === 'company') ?? null))
      .catch(() => setBudget(null));
  }, []);

  const dirty =
    nameDraft !== profile.name ||
    bossDraft !== profile.bossName ||
    visionDraft !== profile.vision ||
    industryDraft !== profile.industry ||
    colorDraft !== profile.colorId ||
    logoDraft !== (profile.logo ?? '') ||
    bossAvatarDraft !== (profile.bossAvatar ?? '');

  const color = brandColor(colorDraft);
  const displayName = companyName({ ...profile, name: nameDraft }, t('company.fallbackName'));
  const bossDisplay = bossDraft.trim() || t('company.bossFallback');

  const pickImage = (field: ImageField, file: File | undefined) => {
    if (!file) return;
    setImageError(null);
    if (!IMAGE_TYPES.includes(file.type)) {
      setImageError({ field, message: t('settings.company.imageType') });
      return;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      setImageError({ field, message: t('settings.company.imageTooLarge') });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      if (field === 'logo') setLogoDraft(reader.result);
      else setBossAvatarDraft(reader.result);
      setSavedNotice(false);
      setSaveError(null);
    };
    reader.onerror = () => setImageError({ field, message: t('settings.company.imageFailed') });
    reader.readAsDataURL(file);
  };

  const syncDrafts = (next: CompanyProfile) => {
    setNameDraft(next.name);
    setBossDraft(next.bossName);
    setVisionDraft(next.vision);
    setIndustryDraft(next.industry);
    setColorDraft(next.colorId);
    setLogoDraft(next.logo ?? '');
    setBossAvatarDraft(next.bossAvatar ?? '');
  };

  const discardChanges = () => {
    syncDrafts(profile);
    setImageError(null);
    setSaveError(null);
    setSavedNotice(false);
  };

  const saveAll = async () => {
    if (!dirty || saving) return;
    const patch: CompanyProfilePatch = {};
    if (nameDraft.trim() !== profile.name) patch.name = nameDraft.trim();
    if (bossDraft.trim() !== profile.bossName) patch.bossName = bossDraft.trim();
    if (visionDraft.trim() !== profile.vision) patch.vision = visionDraft.trim();
    if (industryDraft !== profile.industry) patch.industry = industryDraft;
    if (colorDraft !== profile.colorId) patch.colorId = colorDraft;
    if (logoDraft !== (profile.logo ?? '')) patch.logo = logoDraft;
    if (bossAvatarDraft !== (profile.bossAvatar ?? '')) patch.bossAvatar = bossAvatarDraft;

    // Only whitespace changed: nothing to write, just normalise the form.
    if (Object.keys(patch).length === 0) {
      syncDrafts(profile);
      setSavedNotice(true);
      return;
    }

    setSaving(true);
    setSaveError(null);
    setImageError(null);
    await update(patch);
    setSaving(false);

    // `update` records failures on the store instead of rejecting (the title bar
    // and onboarding call it fire-and-forget), so the result is read back here.
    const latest = useCompany.getState();
    if (latest.error) {
      setSaveError(latest.error);
      return;
    }
    // Normalise the drafts to what was stored: whitespace-only edits produce an
    // empty patch, and the trimmed name must not keep the form looking dirty.
    syncDrafts(latest.profile);
    setSavedNotice(true);
  };

  return (
    <>
      <PageHeader
        crumbs={[t('settings.group.general'), t('settings.page.company')]}
        title={t('settings.page.company')}
        description={t('settings.company.description')}
        actions={
          <div className="flex items-center gap-2">
            <span
              aria-live="polite"
              className={cn('w-12 shrink-0 text-right text-2xs', dirty ? 'text-ink-tertiary' : 'text-success')}
            >
              {dirty ? t('settings.company.unsaved') : savedNotice ? t('settings.company.saved') : null}
            </span>
            <button
              type="button"
              data-testid="company-discard"
              disabled={!dirty || saving}
              onClick={discardChanges}
              className={buttonClass.secondary}
            >
              {t('settings.company.discard')}
            </button>
            <button
              type="button"
              data-testid="company-save"
              disabled={!dirty || saving}
              aria-busy={saving}
              onClick={() => void saveAll()}
              className={buttonClass.primary}
            >
              <Loader2 className={cn('size-3.5 animate-spin', !saving && 'invisible')} />
              {t('common.save')}
            </button>
          </div>
        }
      />

      <div className="space-y-4">
        {/* Business card preview: follows the drafts, so it doubles as the live
            answer to "what will the title bar say once I save?". */}
        <section
          className="relative overflow-hidden rounded-2xl border border-line text-white"
          style={{ background: `linear-gradient(120deg, ${color.to}, #0B0D14 82%)` }}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute -top-24 -right-16 size-64 rounded-full opacity-50 blur-3xl"
            style={{ background: color.from }}
          />
          <div className="relative flex flex-wrap items-center gap-4 px-5 py-5">
            <CompanyMark name={displayName} colorId={colorDraft} src={logoDraft || undefined} size={56} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-xl font-bold tracking-tight">{displayName}</span>
                <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-2xs">
                  {industryDraft
                    ? t(industryLabelKey(industryDraft))
                    : t('onboarding.company.cardIndustryEmpty')}
                </span>
              </div>
              <div
                className={cn(
                  'mt-1 truncate text-sm',
                  visionDraft.trim() ? 'text-white/70' : 'text-white/35',
                )}
              >
                {visionDraft.trim() || t('settings.company.visionPlaceholder')}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 rounded-full bg-white/10 py-1 pr-3 pl-1">
              <Avatar name={bossDisplay} src={bossAvatarDraft || undefined} size="xs" status="online" />
              <span className="max-w-[8rem] truncate text-sm font-medium">{bossDisplay}</span>
            </div>
          </div>
        </section>

        {saveError ? (
          <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{saveError}</p>
        ) : null}

        <Section
          title={t('settings.company.brandTitle')}
          description={t('settings.company.brandDesc')}
          action={status === 'loading' ? <span className="text-2xs text-ink-quaternary">{t('settings.company.loading')}</span> : null}
        >
          <Row label={t('settings.company.logo')} hint={t('settings.company.logoHint')}>
            <LogoPicker
              preview={<CompanyMark name={displayName} colorId={colorDraft} src={logoDraft || undefined} size={44} />}
              hasImage={Boolean(logoDraft)}
              label={t('settings.company.imageUpload')}
              error={imageError?.field === 'logo' ? imageError.message : null}
              onPick={(file) => pickImage('logo', file)}
              onClear={() => {
                setLogoDraft('');
                setImageError(null);
                setSavedNotice(false);
              }}
            />
          </Row>

          <Row label={t('settings.company.name')} hint={t('settings.company.nameHint')}>
            <TextField
              ariaLabel={t('settings.company.name')}
              value={nameDraft}
              onChange={(next) => {
                setNameDraft(next.slice(0, NAME_MAX));
                setSavedNotice(false);
              }}
              placeholder={t('onboarding.company.namePlaceholder')}
              className="w-[16rem]"
            />
          </Row>

          <Row label={t('settings.company.industry')}>
            <div className="flex flex-wrap justify-end gap-1.5">
              {INDUSTRIES.map((industry) => {
                const active = industryDraft === industry.id;
                return (
                  <button
                    key={industry.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setIndustryDraft(active ? '' : industry.id);
                      setSavedNotice(false);
                    }}
                    className={cn(
                      'h-7 cursor-pointer rounded-full border px-2.5 text-sm transition-colors',
                      active
                        ? 'border-accent bg-accent-soft font-medium text-accent-ink'
                        : 'border-line bg-surface text-ink-secondary hover:border-line-strong',
                    )}
                  >
                    {t(industryLabelKey(industry.id))}
                  </button>
                );
              })}
            </div>
          </Row>

          <Row label={t('settings.company.vision')}>
            <TextField
              ariaLabel={t('settings.company.vision')}
              value={visionDraft}
              onChange={(next) => {
                setVisionDraft(next.slice(0, VISION_MAX));
                setSavedNotice(false);
              }}
              placeholder={t('settings.company.visionPlaceholder')}
              className="w-[20rem]"
            />
          </Row>

          <Row label={t('settings.company.brand')}>
            <div className="flex items-center gap-2">
              {BRAND_COLORS.map((option) => {
                const active = colorDraft === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    title={t(colorLabelKey(option.id))}
                    aria-label={t(colorLabelKey(option.id))}
                    aria-pressed={active}
                    onClick={() => {
                      setColorDraft(option.id);
                      setSavedNotice(false);
                    }}
                    className={cn(
                      'size-6 cursor-pointer rounded-full transition-transform',
                      active ? 'scale-110 ring-2 ring-accent ring-offset-2' : 'hover:scale-110',
                    )}
                    style={{ background: `linear-gradient(140deg, ${option.from}, ${option.to})` }}
                  />
                );
              })}
            </div>
          </Row>
        </Section>

        <Section title={t('settings.company.bossTitle')} description={t('settings.company.bossDesc')}>
          <Row label={t('settings.company.boss')} hint={t('settings.company.bossHint')}>
            <TextField
              ariaLabel={t('settings.company.boss')}
              value={bossDraft}
              onChange={(next) => {
                setBossDraft(next.slice(0, BOSS_MAX));
                setSavedNotice(false);
              }}
              placeholder={t('onboarding.company.bossPlaceholder')}
              className="w-[16rem]"
            />
          </Row>

          <Row label={t('settings.company.bossAvatar')} hint={t('settings.company.bossAvatarHint')}>
            <LogoPicker
              preview={<Avatar name={bossDisplay} src={bossAvatarDraft || undefined} size="lg" />}
              hasImage={Boolean(bossAvatarDraft)}
              rounded="rounded-full"
              label={t('settings.company.imageUpload')}
              error={imageError?.field === 'bossAvatar' ? imageError.message : null}
              onPick={(file) => pickImage('bossAvatar', file)}
              onClear={() => {
                setBossAvatarDraft('');
                setImageError(null);
                setSavedNotice(false);
              }}
            />
          </Row>
        </Section>

        <Section
          title={t('settings.company.budget')}
          description={t('settings.company.budgetHint')}
          action={<Wallet className="size-4 text-warning" />}
        >
          <Row label={t('settings.company.budget')}>
            <span className="font-mono text-sm text-ink">
              {budget
                ? t('onboarding.company.budgetUsage', {
                    used: new Intl.NumberFormat(i18n.language, { notation: 'compact' }).format(budget.usedTokens),
                    limit: new Intl.NumberFormat(i18n.language, { notation: 'compact' }).format(budget.limitTokens),
                  })
                : '—'}
            </span>
            <a
              href="#/budget"
              className="flex h-[30px] items-center gap-1 rounded-md border border-line bg-surface px-3 text-sm-plus text-ink-secondary transition-colors hover:border-accent hover:text-accent"
            >
              {t('settings.company.openBudget')}
              <ArrowUpRight className="size-3.5" />
            </a>
          </Row>
        </Section>
      </div>
    </>
  );
}
