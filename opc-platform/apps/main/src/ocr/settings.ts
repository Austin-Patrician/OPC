import type { OcrSettings } from '@opc/shared/ocr';
import type { CompanyDatabase } from '../data/companyDatabase';

const KEY = 'ocr';

/**
 * On by default: the models ship with the app, so the useful default is "read
 * pictures". A missing asset list still wins — see `OcrEngine.assetsReady`.
 */
export const DEFAULT_OCR_SETTINGS: OcrSettings = { enabled: true, detail: 'text' };

/**
 * 设置 → 运行时 stores the OCR policy in the same `app_setting` table as the
 * compaction and default-model choices: one row, company-wide, no migration.
 */
export class OcrSettingsStore {
  constructor(private readonly db: CompanyDatabase) {}

  get = (): OcrSettings => {
    const row = this.db.prepare('SELECT value FROM app_setting WHERE key = ?').get(KEY) as
      | { value: string }
      | undefined;
    if (!row) return { ...DEFAULT_OCR_SETTINGS };
    try {
      const parsed = JSON.parse(row.value) as Partial<OcrSettings>;
      return {
        enabled: parsed.enabled !== false,
        detail: parsed.detail === 'lines' ? 'lines' : 'text',
      };
    } catch {
      return { ...DEFAULT_OCR_SETTINGS };
    }
  };

  set = (next: OcrSettings): OcrSettings => {
    const clean: OcrSettings = {
      enabled: next.enabled !== false,
      detail: next.detail === 'lines' ? 'lines' : 'text',
    };
    this.db
      .prepare(
        `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(KEY, JSON.stringify(clean), Date.now());
    return clean;
  };
}
