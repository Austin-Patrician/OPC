import { describe, expect, it } from 'vitest';
import type { BillingSettings } from '@opc/shared/domain';
import { convertFromUsd, formatMoney } from './money';

const settings = (patch: Partial<BillingSettings> = {}): BillingSettings => ({
  pricingMode: 'provider_first',
  displayCurrency: 'CNY',
  usdCnyRate: 7.3,
  updatedAt: 0,
  ...patch,
});

describe('formatMoney', () => {
  it('shows USD unchanged', () => {
    expect(formatMoney(12.34, settings({ displayCurrency: 'USD' }))).toBe('$12.34');
  });

  it('converts USD to CNY at the manual rate', () => {
    expect(formatMoney(12.34, settings())).toBe('¥90.08');
    expect(convertFromUsd(1, settings())).toBeCloseTo(7.3);
  });

  it('honours the requested decimal places', () => {
    expect(formatMoney(0.0123, settings({ displayCurrency: 'USD' }), { digits: 4 })).toBe('$0.0123');
  });

  it('keeps the sign in front of the symbol', () => {
    expect(formatMoney(-1, settings({ displayCurrency: 'USD' }))).toBe('-$1.00');
  });

  it('falls back to 7.3 when the stored rate is unusable', () => {
    expect(formatMoney(1, settings({ usdCnyRate: 0 }))).toBe('¥7.30');
    expect(formatMoney(1, settings({ usdCnyRate: Number.NaN }))).toBe('¥7.30');
  });

  it('renders a dash for a non-finite amount instead of NaN', () => {
    expect(formatMoney(Number.NaN, settings())).toBe('—');
  });
});
