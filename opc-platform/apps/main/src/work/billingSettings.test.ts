import { describe, expect, it } from 'vitest';
import { openCompanyDatabase } from '../data/companyDatabase';
import { BillingSettingsService, BILLING_KEYS } from './billingSettings';

const fresh = () => {
  const db = openCompanyDatabase(':memory:');
  return { db, service: new BillingSettingsService(db) };
};

describe('BillingSettingsService', () => {
  it('returns the documented defaults before anything is written', () => {
    const { db, service } = fresh();
    expect(service.get()).toEqual({
      pricingMode: 'provider_first',
      displayCurrency: 'CNY',
      usdCnyRate: 7.3,
      updatedAt: 0,
    });
    db.close();
  });

  it('seeds missing keys with 7.3 and a CNY display', () => {
    const { db, service } = fresh();
    service.ensureDefaults();

    const rows = db
      .prepare('SELECT key, value FROM app_setting WHERE key LIKE ? ORDER BY key')
      .all('billing.%') as { key: string; value: string }[];
    expect(rows).toEqual([
      { key: BILLING_KEYS.displayCurrency, value: 'CNY' },
      { key: BILLING_KEYS.usdCnyRate, value: '7.3' },
      { key: BILLING_KEYS.pricingMode, value: 'provider_first' },
    ]);
    expect(service.get()).toMatchObject({ displayCurrency: 'CNY', usdCnyRate: 7.3 });
    db.close();
  });

  it('writes only the fields in the patch', () => {
    const { db, service } = fresh();
    service.ensureDefaults();

    service.update({ usdCnyRate: 7.25 });
    expect(service.get()).toMatchObject({
      pricingMode: 'provider_first',
      displayCurrency: 'CNY',
      usdCnyRate: 7.25,
    });

    service.update({ pricingMode: 'configured_only' });
    expect(service.get()).toMatchObject({
      pricingMode: 'configured_only',
      displayCurrency: 'CNY',
      usdCnyRate: 7.25,
    });
    db.close();
  });

  it('rounds the rate to four decimals and rejects out-of-range values', () => {
    const { db, service } = fresh();
    expect(service.update({ usdCnyRate: 7.123456 }).usdCnyRate).toBe(7.1235);

    expect(() => service.update({ usdCnyRate: 0 })).toThrow(/汇率/);
    expect(() => service.update({ usdCnyRate: 101 })).toThrow(/汇率/);
    expect(() => service.update({ usdCnyRate: Number.NaN })).toThrow(/汇率/);
    // A rejected write must not leave a half-applied value behind.
    expect(service.get().usdCnyRate).toBe(7.1235);
    db.close();
  });

  it('rejects unknown modes and currencies', () => {
    const { db, service } = fresh();
    expect(() => service.update({ pricingMode: 'auto' as never })).toThrow(/pricingMode/);
    expect(() => service.update({ displayCurrency: 'EUR' as never })).toThrow(/displayCurrency/);
    db.close();
  });

  it('does not overwrite a value you already chose', () => {
    const { db, service } = fresh();
    service.ensureDefaults();
    service.update({ usdCnyRate: 7.1, displayCurrency: 'USD' });

    service.ensureDefaults();
    expect(service.get()).toMatchObject({ usdCnyRate: 7.1, displayCurrency: 'USD' });
    db.close();
  });

  it('falls back per field when a row is corrupt', () => {
    const { db, service } = fresh();
    service.ensureDefaults();
    db.prepare('UPDATE app_setting SET value = ? WHERE key = ?').run('not-a-mode', BILLING_KEYS.pricingMode);
    db.prepare('UPDATE app_setting SET value = ? WHERE key = ?').run('abc', BILLING_KEYS.usdCnyRate);

    expect(service.get()).toMatchObject({
      pricingMode: 'provider_first',
      usdCnyRate: 7.3,
      displayCurrency: 'CNY',
    });
    db.close();
  });
});
