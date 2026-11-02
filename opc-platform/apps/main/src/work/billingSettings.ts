import type {
  BillingSettings,
  BillingSettingsPatch,
  DisplayCurrency,
  PricingMode,
} from '@opc/shared/domain';
import { DEFAULT_BILLING_SETTINGS } from '@opc/shared/domain';
import type { CompanyDatabase } from '../data/companyDatabase';

/**
 * Settings → 通用 → 计费, stored as three `app_setting` rows.
 *
 * The ledger is USD-only (docs/ai-billing.md §5.4). `usdCnyRate` is a *display*
 * rate: it converts money at render time and is never written into a charge, so
 * changing it cannot rewrite history. Reads are deliberately forgiving (a corrupt
 * row falls back to the default); writes are strict, because a typo in the rate
 * would silently mis-price every report.
 */

export const BILLING_KEYS = {
  pricingMode: 'billing.pricingMode',
  displayCurrency: 'billing.displayCurrency',
  usdCnyRate: 'billing.fxRateUsdCny',
} as const;

const PRICING_MODES: readonly PricingMode[] = [
  'provider_first',
  'configured_only',
  'provider_only',
];
const DISPLAY_CURRENCIES: readonly DisplayCurrency[] = ['USD', 'CNY'];

/** A planning rate, not a live quote: 0.01–100 covers every plausible USD/CNY. */
export const MIN_USD_CNY_RATE = 0.01;
export const MAX_USD_CNY_RATE = 100;

interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
}

export function isPricingMode(value: unknown): value is PricingMode {
  return typeof value === 'string' && PRICING_MODES.includes(value as PricingMode);
}

export function isDisplayCurrency(value: unknown): value is DisplayCurrency {
  return typeof value === 'string' && DISPLAY_CURRENCIES.includes(value as DisplayCurrency);
}

/** Four decimals is enough for 7.3 / 7.25 / 7.1234 and avoids float noise. */
export function normalizeUsdCnyRate(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < MIN_USD_CNY_RATE || value > MAX_USD_CNY_RATE) return null;
  return Math.round(value * 10_000) / 10_000;
}

export class BillingSettingsService {
  constructor(private readonly db: CompanyDatabase) {}

  /**
   * Missing or unreadable rows fall back per field, so a half-written upgrade
   * still yields a usable page instead of throwing at bootstrap.
   */
  get = (): BillingSettings => {
    const rows = this.db
      .prepare(`SELECT key, value, updated_at FROM app_setting WHERE key IN (?, ?, ?)`)
      .all(BILLING_KEYS.pricingMode, BILLING_KEYS.displayCurrency, BILLING_KEYS.usdCnyRate) as
      | SettingRow[]
      | undefined;

    const byKey = new Map((rows ?? []).map((row) => [row.key, row]));
    const modeRow = byKey.get(BILLING_KEYS.pricingMode);
    const currencyRow = byKey.get(BILLING_KEYS.displayCurrency);
    const rateRow = byKey.get(BILLING_KEYS.usdCnyRate);

    // `pricingMode`/`displayCurrency` are plain strings, not JSON.
    const mode = isPricingMode(modeRow?.value) ? modeRow.value : DEFAULT_BILLING_SETTINGS.pricingMode;
    const displayCurrency = isDisplayCurrency(currencyRow?.value)
      ? currencyRow.value
      : DEFAULT_BILLING_SETTINGS.displayCurrency;
    const parsedRate = rateRow ? Number(rateRow.value) : Number.NaN;
    const usdCnyRate = normalizeUsdCnyRate(parsedRate) ?? DEFAULT_BILLING_SETTINGS.usdCnyRate;

    const updatedAt = (rows ?? []).reduce((latest, row) => Math.max(latest, row.updated_at), 0);

    return { pricingMode: mode, displayCurrency, usdCnyRate, updatedAt };
  };

  /**
   * Partial write. An empty patch is a no-op (it still returns the stored row),
   * and an unknown field is rejected rather than ignored: a typo in the IPC
   * payload must not look like a successful save.
   */
  update = (patch: BillingSettingsPatch): BillingSettings => {
    const writes: { key: string; value: string }[] = [];

    if (patch.pricingMode !== undefined) {
      if (!isPricingMode(patch.pricingMode)) throw new Error('billing: pricingMode 非法');
      writes.push({ key: BILLING_KEYS.pricingMode, value: patch.pricingMode });
    }
    if (patch.displayCurrency !== undefined) {
      if (!isDisplayCurrency(patch.displayCurrency)) throw new Error('billing: displayCurrency 非法');
      writes.push({ key: BILLING_KEYS.displayCurrency, value: patch.displayCurrency });
    }
    if (patch.usdCnyRate !== undefined) {
      const rate = normalizeUsdCnyRate(patch.usdCnyRate);
      if (rate === null) {
        throw new Error(`billing: 汇率必须在 ${MIN_USD_CNY_RATE}–${MAX_USD_CNY_RATE} 之间`);
      }
      writes.push({ key: BILLING_KEYS.usdCnyRate, value: String(rate) });
    }

    if (writes.length > 0) {
      const now = Date.now();
      const run = this.db.transaction(() => {
        for (const write of writes) {
          this.db
            .prepare(
              `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            )
            .run(write.key, write.value, now);
        }
      });
      run();
    }

    return this.get();
  };

  /**
   * Seed missing keys only. An upgrade must not overwrite a boss who already
   * chose 7.2 yesterday; `INSERT OR IGNORE` is the whole behaviour.
   */
  ensureDefaults = (): void => {
    const now = Date.now();
    const run = this.db.transaction(() => {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)`,
      );
      insert.run(BILLING_KEYS.pricingMode, DEFAULT_BILLING_SETTINGS.pricingMode, now);
      insert.run(BILLING_KEYS.displayCurrency, DEFAULT_BILLING_SETTINGS.displayCurrency, now);
      insert.run(BILLING_KEYS.usdCnyRate, String(DEFAULT_BILLING_SETTINGS.usdCnyRate), now);
    });
    run();
  };
}
