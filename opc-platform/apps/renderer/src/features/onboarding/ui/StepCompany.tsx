import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Coins, Wallet } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BudgetView } from '@opc/shared/ipc';
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
import { Block, StepHeader, formatTokens } from './onboardingUi';

const inputClass =
  'w-full rounded-xl border border-line bg-surface text-ink outline-none placeholder:text-ink-quaternary transition select-text focus:border-accent focus:ring-4 focus:ring-accent/12 hover:border-line-strong';

/** Matches the caps in `CompanyService`, so the counter never lies. */
const NAME_MAX = 40;
const BOSS_MAX = 20;
const VISION_MAX = 60;

interface StepCompanyProps {
  /** The company budget row as stored (`budget` table, scope = company). */
  budget: BudgetView | null;
  departmentCount: number;
  agentCount: number;
  onBudgetChange: (budget: BudgetView) => void;
}

/**
 * The company's identity and its money ceiling, in one card.
 *
 * Every field writes through `window.opc.company` (name / industry land in the
 * `company` row, the rest in `app_setting`), and the budget writes through
 * `budget.setLimit` — the same call the budget centre uses. The right column is a
 * live preview of that stored state, not a picture.
 */
export function StepCompany({ budget, departmentCount, agentCount, onBudgetChange }: StepCompanyProps) {
  const { t, i18n } = useTranslation();
  const profile = useCompanyProfile();
  const update = useCompany((state) => state.update);
  const color = brandColor(profile.colorId);
  const cardRef = useRef<HTMLDivElement>(null);

  // Text fields keep a local draft and commit on blur/Enter: one row per edit
  // instead of one per keystroke, and the caret never jumps.
  const [nameDraft, setNameDraft] = useState(profile.name);
  const [bossDraft, setBossDraft] = useState(profile.bossName);
  const [visionDraft, setVisionDraft] = useState(profile.vision);
  const [draftLimit, setDraftLimit] = useState(() => String(budget?.limitTokens ?? ''));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Follow the stored profile when it arrives (or changes from another window).
  useEffect(() => setNameDraft(profile.name), [profile.name]);
  useEffect(() => setBossDraft(profile.bossName), [profile.bossName]);
  useEffect(() => setVisionDraft(profile.vision), [profile.vision]);
  useEffect(() => setDraftLimit(String(budget?.limitTokens ?? '')), [budget?.limitTokens]);

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

  const saveLimit = async () => {
    const value = Number(draftLimit.replace(/[^\d]/g, ''));
    if (!budget || !Number.isFinite(value) || value <= 0) {
      setError(t('onboarding.company.budgetInvalid'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const overview = await window.opc!.budget.setLimit({
        scope: 'company',
        scopeId: budget.scopeId,
        limitTokens: value,
      });
      const next = overview.budgets.find((row) => row.scope === 'company');
      if (next) onBudgetChange(next);
      setNotice(t('onboarding.company.budgetSaved'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const used = budget?.usedTokens ?? 0;
  const limit = budget?.limitTokens ?? 0;
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
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

          <Block
            title={t('onboarding.company.budgetTitle')}
            hint={
              budget ? (
                <span className="tabular-nums">
                  {t('onboarding.company.budgetUsage', {
                    used: formatTokens(used, i18n.language),
                    limit: formatTokens(limit, i18n.language),
                  })}
                </span>
              ) : null
            }
          >
            <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
              <div className="flex items-center gap-3.5">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#FFB86B] to-[#F0436A] text-white shadow-[0_6px_16px_-6px_rgba(240,67,106,0.7)]">
                  <Wallet className="size-[1.125rem]" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-base font-medium text-ink">{t('onboarding.company.budgetLabel')}</div>
                  <div className="mt-0.5 text-xs-plus text-ink-tertiary">{t('onboarding.company.budgetHint')}</div>
                </div>
                <div className="flex items-center gap-2">
                  {budget ? (
                    <>
                      <input
                        aria-label={t('onboarding.company.budgetLabel')}
                        value={draftLimit}
                        inputMode="numeric"
                        onChange={(event) => {
                          setDraftLimit(event.target.value.replace(/[^\d]/g, ''));
                          setNotice(null);
                        }}
                        className="h-9 w-[7.5rem] rounded-lg border border-line bg-surface px-2.5 text-right font-mono text-sm text-ink outline-none focus:border-accent"
                      />
                      <button
                        type="button"
                        disabled={saving || !draftLimit}
                        onClick={() => void saveLimit()}
                        className="h-9 cursor-pointer rounded-lg bg-accent px-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {t('onboarding.company.budgetSave')}
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-ink-quaternary">{t('onboarding.company.budgetMissing')}</span>
                  )}
                </div>
              </div>

              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-muted">
                <div
                  className={cn(
                    'h-full rounded-full transition-[width] duration-500',
                    ratio >= 0.9 ? 'bg-danger' : ratio >= 0.7 ? 'bg-warning' : 'bg-accent',
                  )}
                  style={{ width: `${Math.max(ratio * 100, 1.5)}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between text-2xs text-ink-quaternary">
                <span className="inline-flex items-center gap-1">
                  <Coins className="size-3" />
                  {t('onboarding.company.budgetScope')}
                </span>
                <span className="tabular-nums">
                  {budget?.periodKey ?? '—'} · {Math.round(ratio * 100)}%
                </span>
              </div>

              {notice ? <p className="mt-2 text-xs text-success">{notice}</p> : null}
              {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
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
