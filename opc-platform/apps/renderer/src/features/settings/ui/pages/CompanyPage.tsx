import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CompanyProfilePatch } from '@opc/shared/domain';
import { useCompany, useCompanyProfile } from '@/entities/company/model/useCompany';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { buttonClass, PageHeader, Row, Section, TextField } from '../kit';

const IMAGE_MAX_BYTES = 500 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'];

export function CompanyPage() {
  const { t } = useTranslation();
  const profile = useCompanyProfile();
  const update = useCompany((state) => state.update);
  const [name, setName] = useState(profile.userName);
  const [instructions, setInstructions] = useState(profile.replyInstructions);
  const [avatar, setAvatar] = useState(profile.userAvatar ?? '');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => setName(profile.userName), [profile.userName]);
  useEffect(() => setInstructions(profile.replyInstructions), [profile.replyInstructions]);
  useEffect(() => setAvatar(profile.userAvatar ?? ''), [profile.userAvatar]);

  const dirty = name !== profile.userName || instructions !== profile.replyInstructions || avatar !== (profile.userAvatar ?? '');
  const save = async (extra: CompanyProfilePatch = {}) => {
    await update({ userName: name.trim(), replyInstructions: instructions, userAvatar: avatar, ...extra });
    setSaved(true);
  };

  const pickAvatar = (file?: File) => {
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) { setError(t('settings.company.imageType')); return; }
    if (file.size > IMAGE_MAX_BYTES) { setError(t('settings.company.imageTooLarge')); return; }
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === 'string') { setAvatar(reader.result); setError(''); setSaved(false); } };
    reader.onerror = () => setError(t('settings.company.imageFailed'));
    reader.readAsDataURL(file);
  };

  const toneOptions = ['friendly', 'balanced', 'professional'] as const;
  const detailOptions = ['concise', 'balanced', 'detailed'] as const;

  return (
    <>
      <PageHeader crumbs={[t('settings.group.general'), t('settings.page.company')]} title={t('settings.page.company')}
        description={t('settings.company.description')}
        actions={<><span aria-live="polite" className="text-2xs text-success">{saved ? t('settings.company.saved') : dirty ? t('settings.company.unsaved') : ''}</span>
          <button type="button" disabled={!dirty} onClick={() => void save()} className={buttonClass.primary}>{t('common.save')}</button></>} />
      <div className="space-y-4">
        <Section title={t('settings.company.userTitle')} description={t('settings.company.userDesc')}>
          <Row label={t('settings.company.user')} hint={t('settings.company.userHint')}>
            <TextField ariaLabel={t('settings.company.user')} value={name} onChange={(value) => { setName(value.slice(0, 20)); setSaved(false); }} placeholder={t('settings.company.userPlaceholder')} className="w-56" />
          </Row>
          <Row label={t('settings.company.userAvatar')} hint={t('settings.company.userAvatarHint')}>
            <div className="flex items-center gap-3">
              <Avatar name={name.trim() || t('company.userFallback')} src={avatar || undefined} size="md" />
              <label className={buttonClass.secondary}>{avatar ? t('settings.company.imageReplace') : t('settings.company.imageUpload')}
                <input type="file" accept={IMAGE_TYPES.join(',')} className="hidden" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; pickAvatar(file); }} />
              </label>
              {avatar && <button type="button" onClick={() => { setAvatar(''); setSaved(false); }} className="text-xs text-ink-tertiary hover:text-danger">{t('settings.company.imageRemove')}</button>}
            </div>
          </Row>
          {error && <p className="px-4 pb-3 text-xs text-danger">{error}</p>}
        </Section>

        <Section title={t('settings.company.replyTitle')} description={t('settings.company.replyDesc')}>
          <Row label={t('settings.company.replyTone')}>
            <div className="flex gap-1.5">{toneOptions.map((value) => <button key={value} type="button" aria-pressed={profile.replyTone === value} onClick={() => { void save({ replyTone: value }); setSaved(false); }} className={`rounded-full border px-3 py-1 text-xs transition ${profile.replyTone === value ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line text-ink-secondary hover:border-line-strong'}`}>{t(`settings.company.tone.${value}`)}</button>)}</div>
          </Row>
          <Row label={t('settings.company.replyDetail')}>
            <div className="flex gap-1.5">{detailOptions.map((value) => <button key={value} type="button" aria-pressed={profile.replyDetail === value} onClick={() => { void save({ replyDetail: value }); setSaved(false); }} className={`rounded-full border px-3 py-1 text-xs transition ${profile.replyDetail === value ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line text-ink-secondary hover:border-line-strong'}`}>{t(`settings.company.detail.${value}`)}</button>)}</div>
          </Row>
          <Row label={t('settings.company.replyInstructions')} hint={t('settings.company.replyInstructionsHint')}>
            <textarea aria-label={t('settings.company.replyInstructions')} value={instructions} maxLength={500} onChange={(event) => { setInstructions(event.target.value); setSaved(false); }} placeholder={t('settings.company.replyInstructionsPlaceholder')} className="min-h-20 w-80 resize-y rounded-md border border-line bg-surface p-2.5 text-sm text-ink outline-none placeholder:text-ink-quaternary focus:border-accent" />
          </Row>
        </Section>
      </div>
    </>
  );
}
