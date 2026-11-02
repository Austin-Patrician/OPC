import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BRAND_COLORS,
  INDUSTRIES,
  brandColor,
  colorLabelKey,
  industryLabelKey,
} from '@/entities/company/model/options';
import { useCompany, useCompanyProfile } from '@/entities/company/model/useCompany';
import { CompanyMark } from '@/entities/company/ui/CompanyMark';
import { cn } from '@/shared/lib/cn';
import { Block, StepHeader } from './onboardingUi';

const inputClass =
  'w-full rounded-xl border border-line bg-surface text-ink outline-none placeholder:text-ink-quaternary transition select-text focus:border-accent focus:ring-4 focus:ring-accent/12 hover:border-line-strong';

/** Matches the caps in `CompanyService`, so the counter never lies. */
const NAME_MAX = 40;
const BOSS_MAX = 20;
const VISION_MAX = 60;

interface StepCompanyProps {
  departmentCount: number;
  agentCount: number;
}

/**
 * 公司身份：名字、称呼、行业、品牌色。
 *
 * 每一个字段都走 `window.opc.company`（名字/行业落 `company` 行，其余落
 * `app_setting`）。右栏是那份已存状态的实时预览，不是一张图。
 *
 * 这里曾经还有一整块「预算天花板」——预算删掉之后它也没了。
 */
export function StepCompany({ departmentCount, agentCount }: StepCompanyProps) {
  const { t } = useTranslation();
  const profile = useCompanyProfile();
  const update = useCompany((state) => state.update);
  const color = brandColor(profile.colorId);
  const cardRef = useRef<HTMLDivElement>(null);

  // Text fields keep a local draft and commit on blur/Enter: one row per edit
  // instead of one per keystroke, and the caret never jumps.
  const [nameDraft, setNameDraft] = useState(profile.name);
  const [bossDraft, setBossDraft] = useState(profile.bossName);
  const [visionDraft, setVisionDraft] = useState(profile.vision);

  // Follow the stored profile when it arrives (or changes from another window).
  useEffect(() => setNameDraft(profile.name), [profile.name]);
  useEffect(() => setBossDraft(profile.bossName), [profile.bossName]);
  useEffect(() => setVisionDraft(profile.vision), [profile.vision]);

  const onCardMove = (event: PointerEvent<HTMLDivElement>) => {
    const element = cardRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    element.style.setProperty('--ry', `${(x - 0.5) * 16}deg`);
    element.style.setProperty('--rx', `${(0.5 - y) * 12}deg`);
    element.style.setProperty('--gx', `${x * 100}%`);
    element.style.setProperty('--gy', `${y * 100}%`);
  };

  const onCardLeave = () => {
    const element = cardRef.current;
    if (!element) return;
    element.style.setProperty('--ry', '0deg');
    element.style.setProperty('--rx', '0deg');
  };

  const now = new Date();
  const displayName = nameDraft.trim() || t('company.fallbackName');

  return (
    <>
      <StepHeader
        eyebrow={t('onboarding.company.eyebrow')}
        title={t('onboarding.company.title')}
        description={t('onboarding.company.description')}
      />

      <div className="grid grid-cols-[minmax(0,1fr)_18.75rem] items-start gap-9">
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="onb-company-name" className="text-base font-semibold text-ink">
                {t('onboarding.company.nameLabel')} <span className="text-danger">*</span>
              </label>
              <div className="relative mt-2">
                <input
                  id="onb-company-name"
                  autoFocus
                  value={nameDraft}
                  maxLength={NAME_MAX}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onBlur={() => {
                    if (nameDraft !== profile.name) void update({ name: nameDraft });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                  placeholder={t('onboarding.company.namePlaceholder')}
                  autoComplete="off"
                  className={`${inputClass} h-12 pr-14 pl-4 text-[1.0625rem] font-medium`}
                />
                <span className="absolute top-1/2 right-4 -translate-y-1/2 text-xs-plus tabular-nums text-ink-quaternary">
                  {Array.from(nameDraft).length}/{NAME_MAX}
                </span>
              </div>
            </div>

            <div>
              <label htmlFor="onb-boss-name" className="text-base font-semibold text-ink">
                {t('onboarding.company.bossLabel')}
              </label>
              <div className="relative mt-2">
                <input
                  id="onb-boss-name"
                  value={bossDraft}
                  maxLength={BOSS_MAX}
                  onChange={(event) => setBossDraft(event.target.value)}
                  onBlur={() => {
                    if (bossDraft !== profile.bossName) void update({ bossName: bossDraft });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                  placeholder={t('onboarding.company.bossPlaceholder')}
                  autoComplete="off"
                  className={`${inputClass} h-12 pr-14 pl-4 text-[1.0625rem] font-medium`}
                />
                <span className="absolute top-1/2 right-4 -translate-y-1/2 text-xs-plus tabular-nums text-ink-quaternary">
                  {Array.from(bossDraft).length}/{BOSS_MAX}
                </span>
              </div>
              <p className="mt-1 text-2xs text-ink-quaternary">{t('onboarding.company.bossHint')}</p>
            </div>
          </div>

          <div>
            <label htmlFor="onb-company-vision" className="text-base font-semibold text-ink">
              {t('onboarding.company.visionLabel')}{' '}
              <span className="text-xs-plus font-normal text-ink-tertiary">{t('onboarding.company.optional')}</span>
            </label>
            <input
              id="onb-company-vision"
              value={visionDraft}
              maxLength={VISION_MAX}
              onChange={(event) => setVisionDraft(event.target.value)}
              onBlur={() => {
                if (visionDraft !== profile.vision) void update({ vision: visionDraft });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              placeholder={t('onboarding.company.visionPlaceholder')}
              autoComplete="off"
              className={`${inputClass} mt-2 h-10 px-3.5 text-base-plus`}
            />
          </div>

          <Block title={t('onboarding.company.industryTitle')}>
            <div className="flex flex-wrap gap-2">
              {INDUSTRIES.map((industry) => {
                const active = profile.industry === industry.id;
                return (
                  <button
                    key={industry.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => void update({ industry: active ? '' : industry.id })}
                    className={cn(
                      'h-9 cursor-pointer rounded-full border px-3.5 text-sm-plus transition-all',
                      active
                        ? 'border-accent bg-accent-soft font-medium text-accent-ink shadow-[0_0_0_3px_var(--accent-soft)]'
                        : 'border-line bg-surface text-ink-secondary hover:border-line-strong',
                    )}
                  >
                    {t(industryLabelKey(industry.id))}
                  </button>
                );
              })}
            </div>
          </Block>

          <Block title={t('onboarding.company.colorTitle')} hint={t(colorLabelKey(profile.colorId))}>
            <div className="flex items-center gap-3">
              {BRAND_COLORS.map((option) => {
                const active = profile.colorId === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    title={t(colorLabelKey(option.id))}
                    aria-label={t(colorLabelKey(option.id))}
                    aria-pressed={active}
                    onClick={() => void update({ colorId: option.id })}
                    className={cn(
                      'size-8 cursor-pointer rounded-full transition-transform',
                      active ? 'scale-110 ring-2 ring-accent ring-offset-2 ring-offset-surface' : 'hover:scale-110',
                    )}
                    style={{ background: `linear-gradient(140deg, ${option.from}, ${option.to})` }}
                  />
                );
              })}
            </div>
          </Block>

        </div>

        {/* Live business card */}
        <div className="pt-2" style={{ perspective: '1000px' }}>
          <div
            ref={cardRef}
            onPointerMove={onCardMove}
            onPointerLeave={onCardLeave}
            className="relative flex h-[13.5rem] flex-col overflow-hidden rounded-[1.25rem] p-5 text-white shadow-[0_30px_60px_-24px_rgba(0,0,0,0.55)] transition-transform duration-300 ease-out"
            style={{
              transform: 'rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg))',
              background: `linear-gradient(140deg, ${color.to} 0%, #0B0D14 78%)`,
            }}
          >
            <div
              aria-hidden
              className="absolute -top-12 -right-10 size-44 rounded-full opacity-70 blur-2xl transition-[background] duration-500"
              style={{ background: color.from }}
            />
            <div aria-hidden className="onb-grid absolute inset-0 opacity-60" />
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                background:
                  'radial-gradient(260px circle at var(--gx, 20%) var(--gy, 0%), rgba(255,255,255,0.2), transparent 55%)',
              }}
            />
            <div className="relative flex items-start justify-between">
              <CompanyMark name={displayName} colorId={profile.colorId} src={profile.logo} size={44} />
              <span className="text-3xs font-semibold tracking-[0.24em] text-white/50">OPC</span>
            </div>
            <div className="relative mt-auto min-w-0">
              <div className="truncate text-[1.1875rem] font-bold tracking-tight">{displayName}</div>
              <div className={cn('mt-1 truncate text-sm', visionDraft.trim() ? 'text-white/70' : 'text-white/30')}>
                {visionDraft.trim() || t('onboarding.company.cardVisionPlaceholder')}
              </div>
              <div className="mt-3 flex items-center justify-between gap-2 text-2xs text-white/50">
                <span className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-white/10 px-2">
                  {profile.industry ? t(industryLabelKey(profile.industry)) : t('onboarding.company.cardIndustryEmpty')}
                  <span className="text-white/30">·</span>
                  {t('onboarding.company.cardOrg', { departments: departmentCount, agents: agentCount })}
                </span>
                <span className="shrink-0 font-mono">
                  EST. {now.getFullYear()}.{String(now.getMonth() + 1).padStart(2, '0')}
                </span>
              </div>
            </div>
          </div>
          <p className="mt-3.5 text-center text-xs-plus text-ink-quaternary">{t('onboarding.company.cardHint')}</p>
        </div>
      </div>
    </>
  );
}
