import { DEFAULT_BILLING_SETTINGS, type BillingSettings } from '@opc/shared/domain';

/**
 * Display-side money formatting.
 *
 * The ledger stores USD only; CNY is a render-time multiplication by the your
 * manual rate (docs/ai-billing.md §5.4). Keeping this in one pure function is the
 * point: a report that formats money itself will eventually disagree with the
 * rest of the app about the rate.
 */
export interface MoneyFormatOptions {
  /** Decimal places. Budget totals use 2; per-call costs use 4. */
  digits?: number;
}

export function effectiveUsdCnyRate(settings: BillingSettings): number {
  const rate = settings.usdCnyRate;
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_BILLING_SETTINGS.usdCnyRate;
}

export function convertFromUsd(usd: number, settings: BillingSettings): number {
  return settings.displayCurrency === 'CNY' ? usd * effectiveUsdCnyRate(settings) : usd;
}

export function formatMoney(
  usd: number,
  settings: BillingSettings,
  options: MoneyFormatOptions = {},
): string {
  if (!Number.isFinite(usd)) return '—';
  const digits = options.digits ?? 2;
  const amount = convertFromUsd(usd, settings);
  const symbol = settings.displayCurrency === 'CNY' ? '¥' : '$';
  const sign = amount < 0 ? '-' : '';
  return `${sign}${symbol}${Math.abs(amount).toFixed(digits)}`;
}
