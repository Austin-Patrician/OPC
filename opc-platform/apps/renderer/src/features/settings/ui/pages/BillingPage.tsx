import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_BILLING_SETTINGS, type DisplayCurrency, type PricingMode } from '@opc/shared/domain';
import { useBilling, useBillingSettings } from '@/entities/billing/model/useBilling';
import { formatMoney } from '@/shared/lib/money';
import { PageHeader, Row, Section, Segmented, SelectField, TextField, buttonClass } from '../kit';

const PRICING_MODES: readonly PricingMode[] = [
  'provider_first',
  'configured_only',
  'provider_only',
];

/**
 * Settings → 通用 → 计费 (docs/ai-billing.md §5.5).
 *
 * Three global choices: how money is decided, which currency is shown, and the
 * manual rate used to show CNY. The rate is display-only — the ledger is USD —
 * so this page never touches historical charges.
 */
export function BillingPage() {
  const { t } = useTranslation();
  const settings = useBillingSettings();
  const update = useBilling((state) => state.update);
  const storeError = useBilling((state) => state.error);

  // The rate is a string while being typed: "7." and "" are valid intermediate
  // states, and writing them to SQLite would be a bug, not a preference.
  const [rateText, setRateText] = useState(String(settings.usdCnyRate));
  const [rateError, setRateError] = useState<string | null>(null);

  useEffect(() => {
    setRateText(String(settings.usdCnyRate));
  }, [settings.usdCnyRate]);

  // Same range as the main process (`MIN_USD_CNY_RATE`/`MAX_USD_CNY_RATE`), so the
  // UI refuses a typo locally instead of round-tripping an error from SQLite.
  const parsedRate = Number(rateText.replace(',', '.'));
  const validRate = Number.isFinite(parsedRate) && parsedRate >= 0.01 && parsedRate <= 100;
  const previewSettings = validRate ? { ...settings, usdCnyRate: parsedRate } : settings;

  const commitRate = () => {
    if (!validRate) {
      setRateError(t('settings.billing.rateInvalid'));
      return;
    }
    setRateError(null);
    void update({ usdCnyRate: Math.round(parsedRate * 10_000) / 10_000 });
  };

  return (
    <>
      <PageHeader
        crumbs={[t('settings.title'), t('settings.group.general')]}
        title={t('settings.page.billing')}
        description={t('settings.billing.desc')}
      />

      <div className="space-y-4">
        <Section
          title={t('settings.billing.policyTitle')}
          description={t('settings.billing.policyHint')}
        >
          <Row
            label={t('settings.billing.policy')}
            hint={t(`settings.billing.mode.${settings.pricingMode}`)}
            settingKey="billing.pricingMode"
          >
            <div className="w-[15rem]">
              <SelectField
                value={settings.pricingMode}
                onChange={(next) => void update({ pricingMode: next as PricingMode })}
                ariaLabel={t('settings.billing.policy')}
              >
                {PRICING_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`settings.billing.modeLabel.${mode}`)}
                  </option>
                ))}
              </SelectField>
            </div>
          </Row>
        </Section>

        <Section
          title={t('settings.billing.displayTitle')}
          description={t('settings.billing.displayHint')}
        >
          <Row
            label={t('settings.billing.currency')}
            hint={t('settings.billing.currencyHint')}
            settingKey="billing.displayCurrency"
          >
            <Segmented<DisplayCurrency>
              value={settings.displayCurrency}
              onChange={(next) => void update({ displayCurrency: next })}
              label={t('settings.billing.currency')}
              options={[
                { value: 'USD', label: 'USD $' },
                { value: 'CNY', label: 'CNY ¥' },
              ]}
            />
          </Row>

          <Row
            label={t('settings.billing.rate')}
            hint={t('settings.billing.rateHint')}
            settingKey="billing.fxRateUsdCny"
          >
            <div className="flex items-center gap-2">
              <span className="whitespace-nowrap text-xs-plus text-ink-tertiary">1 USD =</span>
              <div className="w-[6rem]">
                <TextField
                  value={rateText}
                  onChange={(next) => {
                    setRateText(next);
                    setRateError(null);
                  }}
                  ariaLabel={t('settings.billing.rate')}
                  mono
                  className="text-right"
                  onBlur={commitRate}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                />
              </div>
              <span className="text-xs-plus text-ink-tertiary">CNY</span>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => {
                  setRateText(String(DEFAULT_BILLING_SETTINGS.usdCnyRate));
                  setRateError(null);
                  void update({ usdCnyRate: DEFAULT_BILLING_SETTINGS.usdCnyRate });
                }}
              >
                {t('settings.billing.rateReset')}
              </button>
            </div>
          </Row>

          {rateError ? (
            <p className="border-t border-line px-4 py-2 text-xs text-danger">{rateError}</p>
          ) : (
            <p className="border-t border-line px-4 py-2 text-2xs text-ink-quaternary">
              {t('settings.billing.rateBlurHint')}
            </p>
          )}
        </Section>

        <Section
          title={t('settings.billing.previewTitle')}
          description={t('settings.billing.previewHint')}
        >
          <Row label={t('settings.billing.previewMonth')}>
            {/* 预算删掉之后，这里没有"本月已花"可读；单价预览仍然有意义。 */}
            <span className="text-sm text-ink-quaternary">{t('settings.billing.previewEmpty')}</span>
          </Row>
          <Row label={t('settings.billing.previewSample')} hint={t('settings.billing.previewSampleHint')}>
            <span className="font-mono text-sm text-ink">
              {formatMoney(1, { ...previewSettings, displayCurrency: 'USD' })}
              {' ≈ '}
              {formatMoney(1, { ...previewSettings, displayCurrency: 'CNY' })}
            </span>
          </Row>
        </Section>

        {storeError ? <p className="px-1 text-xs text-danger">{storeError}</p> : null}

        <p className="px-1 text-2xs leading-relaxed text-ink-quaternary">
          {t('settings.billing.footnote')}
        </p>
      </div>
    </>
  );
}
