import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CompanyProfile } from '@opc/shared/domain';
import { useCompany, useCompanyProfile } from '@/entities/company/model/useCompany';
import { Segmented } from '@/features/settings/ui/kit';
import { LOCALES, type Locale } from '@/shared/i18n/types';
import { useUiPrefs } from '@/shared/prefs/useUiPrefs';
import { BuddyMark } from '@/shared/ui/BuddyMark';
import { Block, ChoiceCard, StepHeader } from './onboardingUi';

type ReplyTone = CompanyProfile['replyTone'];
type ReplyDetail = CompanyProfile['replyDetail'];

const TONES: readonly ReplyTone[] = ['friendly', 'balanced', 'professional'];
const DETAILS: readonly ReplyDetail[] = ['concise', 'balanced', 'detailed'];

/**
 * Step 1: who you are, assistant name, interface language, and how the assistant replies.
 * Writes directly to `useCompany` + `useUiPrefs`, matching Settings → 个人偏好 & 外观.
 */
export function StepProfile() {
  const { t } = useTranslation();
  const profile = useCompanyProfile();
  const update = useCompany((state) => state.update);
  const locale = useUiPrefs((state) => state.locale);
  const setLocale = useUiPrefs((state) => state.setLocale);

  const [nameDraft, setNameDraft] = useState(profile.userName);
  const [assistantDraft, setAssistantDraft] = useState(profile.assistantName);
  const nameTimerRef = useRef<number | null>(null);
  const assistantTimerRef = useRef<number | null>(null);
  const latestNameRef = useRef(nameDraft);
  const latestSavedNameRef = useRef(profile.userName);
  const latestAssistantRef = useRef(assistantDraft);
  const latestSavedAssistantRef = useRef(profile.assistantName);
  latestNameRef.current = nameDraft;
  latestSavedNameRef.current = profile.userName;
  latestAssistantRef.current = assistantDraft;
  latestSavedAssistantRef.current = profile.assistantName;

  useEffect(() => {
    setNameDraft(profile.userName);
  }, [profile.userName]);

  useEffect(() => {
    setAssistantDraft(profile.assistantName);
  }, [profile.assistantName]);

  const flushName = (raw: string) => {
    if (nameTimerRef.current !== null) {
      window.clearTimeout(nameTimerRef.current);
      nameTimerRef.current = null;
    }
    const trimmed = raw.trim();
    if (trimmed !== latestSavedNameRef.current) {
      void update({ userName: trimmed });
    }
  };

  const flushAssistant = (raw: string) => {
    if (assistantTimerRef.current !== null) {
      window.clearTimeout(assistantTimerRef.current);
      assistantTimerRef.current = null;
    }
    const trimmed = raw.trim();
    if (trimmed !== latestSavedAssistantRef.current) {
      void update({ assistantName: trimmed });
    }
  };

  useEffect(
    () => () => {
      if (nameTimerRef.current !== null) {
        window.clearTimeout(nameTimerRef.current);
        nameTimerRef.current = null;
        const trimmed = latestNameRef.current.trim();
        if (trimmed !== latestSavedNameRef.current) {
          void update({ userName: trimmed });
        }
      }
      if (assistantTimerRef.current !== null) {
        window.clearTimeout(assistantTimerRef.current);
        assistantTimerRef.current = null;
        const trimmed = latestAssistantRef.current.trim();
        if (trimmed !== latestSavedAssistantRef.current) {
          void update({ assistantName: trimmed });
        }
      }
    },
    [update],
  );

  const onNameChange = (value: string) => {
    const next = value.slice(0, 20);
    setNameDraft(next);
    if (nameTimerRef.current !== null) window.clearTimeout(nameTimerRef.current);
    nameTimerRef.current = window.setTimeout(() => flushName(next), 350);
  };

  const onAssistantChange = (value: string) => {
    const next = value.slice(0, 20);
    setAssistantDraft(next);
    if (assistantTimerRef.current !== null) window.clearTimeout(assistantTimerRef.current);
    assistantTimerRef.current = window.setTimeout(() => flushAssistant(next), 350);
  };

  const displayName = nameDraft.trim() || t('company.userFallback');
  const displayAssistant = assistantDraft.trim() || t('company.assistantFallback');

  return (
    <>
      <StepHeader
        eyebrow={t('onboarding.profile.eyebrow')}
        title={t('onboarding.profile.title')}
        description={t('onboarding.profile.description')}
      />

      <div className="space-y-6">
        {/* Live Buddy Reply Preview */}
        <div className="flex items-center gap-3.5 rounded-2xl border border-line bg-surface-muted/45 px-4 py-3">
          <BuddyMark size="md" phase="thinking" interactive showAura={false} showShadow={false} />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-ink-tertiary">
              {displayAssistant} · {t('onboarding.profile.previewLabel')}
            </div>
            <p className="mt-0.5 text-sm leading-relaxed text-ink">
              {t(`onboarding.profile.previewSample.${profile.replyTone}`, { name: displayName })}{' '}
              <span className="text-ink-tertiary">
                ({t(`settings.company.detail.${profile.replyDetail}`)})
              </span>
            </p>
          </div>
        </div>

        {/* Name + Assistant Name + Interface Language */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Block title={t('onboarding.profile.nameLabel')} hint={t('onboarding.profile.nameHint')}>
            <input
              type="text"
              value={nameDraft}
              onChange={(event) => onNameChange(event.target.value)}
              onBlur={() => flushName(nameDraft)}
              placeholder={t('onboarding.profile.namePlaceholder')}
              className="h-10 w-full rounded-xl border border-line bg-surface px-3 text-base text-ink outline-none placeholder:text-ink-quaternary focus:border-accent"
            />
          </Block>

          <Block
            title={t('onboarding.profile.assistantLabel')}
            hint={t('onboarding.profile.assistantHint')}
          >
            <input
              type="text"
              value={assistantDraft}
              onChange={(event) => onAssistantChange(event.target.value)}
              onBlur={() => flushAssistant(assistantDraft)}
              placeholder={t('onboarding.profile.assistantPlaceholder')}
              className="h-10 w-full rounded-xl border border-line bg-surface px-3 text-base text-ink outline-none placeholder:text-ink-quaternary focus:border-accent"
            />
          </Block>

          <Block title={t('onboarding.profile.languageLabel')}>
            <div className="flex h-10 items-center">
              <Segmented<Locale>
                label={t('onboarding.profile.languageLabel')}
                value={locale}
                onChange={(next) => setLocale(next)}
                options={LOCALES.map((loc) => ({
                  value: loc,
                  label: t(`settings.language.${loc}`),
                }))}
              />
            </div>
          </Block>
        </div>

        {/* Reply Tone */}
        <Block title={t('onboarding.profile.toneLabel')} hint={t('onboarding.profile.toneHint')}>
          <div className="grid grid-cols-3 gap-2.5">
            {TONES.map((tone) => (
              <ChoiceCard
                key={tone}
                selected={profile.replyTone === tone}
                onClick={() => void update({ replyTone: tone })}
                className="px-3.5 py-3"
              >
                <div className="pr-5 text-sm-plus font-semibold text-ink">
                  {t(`settings.company.tone.${tone}`)}
                </div>
                <p className="mt-0.5 text-xs leading-snug text-ink-tertiary">
                  {t(`onboarding.profile.toneDesc.${tone}`)}
                </p>
              </ChoiceCard>
            ))}
          </div>
        </Block>

        {/* Reply Detail */}
        <Block title={t('onboarding.profile.detailLabel')} hint={t('onboarding.profile.detailHint')}>
          <div className="grid grid-cols-3 gap-2.5">
            {DETAILS.map((detail) => (
              <ChoiceCard
                key={detail}
                selected={profile.replyDetail === detail}
                onClick={() => void update({ replyDetail: detail })}
                className="px-3.5 py-3"
              >
                <div className="pr-5 text-sm-plus font-semibold text-ink">
                  {t(`settings.company.detail.${detail}`)}
                </div>
                <p className="mt-0.5 text-xs leading-snug text-ink-tertiary">
                  {t(`onboarding.profile.detailDesc.${detail}`)}
                </p>
              </ChoiceCard>
            ))}
          </div>
        </Block>
      </div>
    </>
  );
}
