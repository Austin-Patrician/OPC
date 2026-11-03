import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ImagePlus, Loader2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CompanyProfile, CompanyProfilePatch } from '@opc/shared/domain';
import {
  BRAND_COLORS,
  DOMAINS,
  brandColor,
  colorLabelKey,
  companyName,
  domainLabelKey,
} from '@/entities/company/model/options';
import { useCompany, useCompanyProfile } from '@/entities/company/model/useCompany';
import { CompanyMark } from '@/entities/company/ui/CompanyMark';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { cn } from '@/shared/lib/cn';
import { buttonClass, PageHeader, Row, Section, TextField } from '../kit';

const NAME_MAX = 40;
const USER_MAX = 20;
const GOAL_MAX = 60;

/** Matches `CompanyService.clampImage`: 500 KB of binary ≈ 683 K base64 chars. */
const IMAGE_MAX_BYTES = 500 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];

type ImageField = 'logo' | 'userAvatar';

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
 * 设置 → 工作台与称呼。
 *
 * 一个表单、一次保存：名字、你在做什么、一句话目标、配色，以及两张上传的
 * identities are drafts until the header's 保存 runs. Nothing here writes on blur
 * or on every keystroke, so a half-edited name never reaches the title bar.
 *
 * Logos are small base64 data URLs kept in `app_setting` (see `CompanyService`);
 * the renderer only validates type/size before reading the file, the main process
 * re-validates the payload.
 */
export function CompanyPage() {
  const { t } = useTranslation();
  const profile = useCompanyProfile();
  const update = useCompany((state) => state.update);
  const status = useCompany((state) => state.status);

  const [nameDraft, setNameDraft] = useState(profile.name);
  const [userDraft, setUserDraft] = useState(profile.userName);
  const [goalDraft, setGoalDraft] = useState(profile.goal);
  const [domainDraft, setDomainDraft] = useState(profile.domain);
  const [colorDraft, setColorDraft] = useState(profile.colorId);
  const [logoDraft, setLogoDraft] = useState(profile.logo ?? '');
  const [userAvatarDraft, setUserAvatarDraft] = useState(profile.userAvatar ?? '');
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<{ field: ImageField; message: string } | null>(null);

  useEffect(() => setNameDraft(profile.name), [profile.name]);
  useEffect(() => setUserDraft(profile.userName), [profile.userName]);
  useEffect(() => setGoalDraft(profile.goal), [profile.goal]);
  useEffect(() => setDomainDraft(profile.domain), [profile.domain]);
  useEffect(() => setColorDraft(profile.colorId), [profile.colorId]);
  useEffect(() => setLogoDraft(profile.logo ?? ''), [profile.logo]);
  useEffect(() => setUserAvatarDraft(profile.userAvatar ?? ''), [profile.userAvatar]);

  const dirty =
    nameDraft !== profile.name ||
    userDraft !== profile.userName ||
    goalDraft !== profile.goal ||
    domainDraft !== profile.domain ||
    colorDraft !== profile.colorId ||
    logoDraft !== (profile.logo ?? '') ||
    userAvatarDraft !== (profile.userAvatar ?? '');

  const color = brandColor(colorDraft);
  const displayName = companyName({ ...profile, name: nameDraft }, t('company.fallbackName'));
  const userDisplay = userDraft.trim() || t('company.userFallback');

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
      else setUserAvatarDraft(reader.result);
      setSavedNotice(false);
      setSaveError(null);
    };
    reader.onerror = () => setImageError({ field, message: t('settings.company.imageFailed') });
    reader.readAsDataURL(file);
  };

  const syncDrafts = (next: CompanyProfile) => {
    setNameDraft(next.name);
    setUserDraft(next.userName);
    setGoalDraft(next.goal);
    setDomainDraft(next.domain);
    setColorDraft(next.colorId);
    setLogoDraft(next.logo ?? '');
    setUserAvatarDraft(next.userAvatar ?? '');
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
    if (userDraft.trim() !== profile.userName) patch.userName = userDraft.trim();
    if (goalDraft.trim() !== profile.goal) patch.goal = goalDraft.trim();
    if (domainDraft !== profile.domain) patch.domain = domainDraft;
    if (colorDraft !== profile.colorId) patch.colorId = colorDraft;
    if (logoDraft !== (profile.logo ?? '')) patch.logo = logoDraft;
    if (userAvatarDraft !== (profile.userAvatar ?? '')) patch.userAvatar = userAvatarDraft;

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
                  {domainDraft
                    ? t(domainLabelKey(domainDraft))
                    : t('onboarding.company.cardDomainEmpty')}
                </span>
              </div>
              <div
                className={cn(
                  'mt-1 truncate text-sm',
                  goalDraft.trim() ? 'text-white/70' : 'text-white/35',
                )}
              >
                {goalDraft.trim() || t('settings.company.goalPlaceholder')}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 rounded-full bg-white/10 py-1 pr-3 pl-1">
              <Avatar name={userDisplay} src={userAvatarDraft || undefined} size="xs" status="online" />
              <span className="max-w-[8rem] truncate text-sm font-medium">{userDisplay}</span>
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

          <Row label={t('settings.company.domain')}>
            <div className="flex flex-wrap justify-end gap-1.5">
              {DOMAINS.map((domain) => {
                const active = domainDraft === domain.id;
                return (
                  <button
                    key={domain.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setDomainDraft(active ? '' : domain.id);
                      setSavedNotice(false);
                    }}
                    className={cn(
                      'h-7 cursor-pointer rounded-full border px-2.5 text-sm transition-colors',
                      active
                        ? 'border-accent bg-accent-soft font-medium text-accent-ink'
                        : 'border-line bg-surface text-ink-secondary hover:border-line-strong',
                    )}
                  >
                    {t(domainLabelKey(domain.id))}
                  </button>
                );
              })}
            </div>
          </Row>

          <Row label={t('settings.company.goal')}>
            <TextField
              ariaLabel={t('settings.company.goal')}
              value={goalDraft}
              onChange={(next) => {
                setGoalDraft(next.slice(0, GOAL_MAX));
                setSavedNotice(false);
              }}
              placeholder={t('settings.company.goalPlaceholder')}
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

        <Section title={t('settings.company.userTitle')} description={t('settings.company.userDesc')}>
          <Row label={t('settings.company.user')} hint={t('settings.company.userHint')}>
            <TextField
              ariaLabel={t('settings.company.user')}
              value={userDraft}
              onChange={(next) => {
                setUserDraft(next.slice(0, USER_MAX));
                setSavedNotice(false);
              }}
              placeholder={t('onboarding.company.userPlaceholder')}
              className="w-[16rem]"
            />
          </Row>

          <Row label={t('settings.company.userAvatar')} hint={t('settings.company.userAvatarHint')}>
            <LogoPicker
              preview={<Avatar name={userDisplay} src={userAvatarDraft || undefined} size="lg" />}
              hasImage={Boolean(userAvatarDraft)}
              rounded="rounded-full"
              label={t('settings.company.imageUpload')}
              error={imageError?.field === 'userAvatar' ? imageError.message : null}
              onPick={(file) => pickImage('userAvatar', file)}
              onClear={() => {
                setUserAvatarDraft('');
                setImageError(null);
                setSavedNotice(false);
              }}
            />
          </Row>
        </Section>

      </div>
    </>
  );
}
