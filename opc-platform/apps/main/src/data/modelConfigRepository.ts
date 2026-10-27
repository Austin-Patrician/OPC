import type { ModelOption, ProviderConfig, ProviderDraft } from '@opc/shared/domain';
import type { CompanyDatabase } from './companyDatabase';

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  api: string;
  is_custom: number;
  icon: string | null;
  models: string;
  credential: Buffer | null;
  updated_at: number;
}

/**
 * Model providers, their model lists and the encrypted API keys.
 *
 * This is infrastructure rather than business state (§12.2): losing it costs a
 * re-entry, not a re-hire. Keys are stored as the ciphertext produced by
 * `models/keyCipher.ts`; the plaintext never reaches SQLite and never leaves the
 * main process, so `hasKey` is all the renderer ever learns.
 */
export class ModelConfigRepository {
  constructor(private readonly db: CompanyDatabase) {}

  listProviders = (): ProviderConfig[] =>
    (this.db.prepare('SELECT * FROM model_provider ORDER BY created_at, id').all() as ProviderRow[]).map(
      toProvider,
    );

  getProvider = (providerId: string): ProviderConfig | undefined => {
    const row = this.db.prepare('SELECT * FROM model_provider WHERE id = ?').get(providerId) as
      | ProviderRow
      | undefined;
    return row ? toProvider(row) : undefined;
  };

  /** Upsert without clobbering: renaming a provider must not drop its models or key. */
  saveProvider = (draft: ProviderDraft): void => {
    const now = Date.now();
    // `undefined` means "the caller did not touch the icon" — keep the stored one,
    // so ad-hoc saves (ensureProvider, refresh) never wipe a chosen icon. `''` clears.
    const icon = draft.icon === undefined ? null : draft.icon.trim();
    this.db
      .prepare(
        `INSERT INTO model_provider (id, name, base_url, api, is_custom, icon, models, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           base_url = excluded.base_url,
           api = excluded.api,
           is_custom = excluded.is_custom,
           icon = COALESCE(excluded.icon, model_provider.icon),
           updated_at = excluded.updated_at`,
      )
      .run(draft.id, draft.name, draft.baseUrl, draft.api, draft.isCustom ? 1 : 0, icon, now, now);
  };

  removeProvider = (providerId: string): void => {
    // The row is the credential's only home, so deleting it deletes the key too.
    this.db.prepare('DELETE FROM model_provider WHERE id = ?').run(providerId);
  };

  saveModels = (providerId: string, models: readonly ModelOption[]): void => {
    this.db
      .prepare('UPDATE model_provider SET models = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(models), Date.now(), providerId);
  };

  saveCredential = (providerId: string, ciphertext: Buffer): void => {
    this.db
      .prepare('UPDATE model_provider SET credential = ?, updated_at = ? WHERE id = ?')
      .run(ciphertext, Date.now(), providerId);
  };

  readCredential = (providerId: string): Buffer | undefined => {
    const row = this.db.prepare('SELECT credential FROM model_provider WHERE id = ?').get(providerId) as
      | { credential: Buffer | null }
      | undefined;
    return row?.credential ?? undefined;
  };

  clearCredential = (providerId: string): void => {
    this.db
      .prepare('UPDATE model_provider SET credential = NULL, updated_at = ? WHERE id = ?')
      .run(Date.now(), providerId);
  };

  getSetting = (key: string): string | undefined => {
    const row = this.db.prepare('SELECT value FROM app_setting WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  };

  /** An empty value is stored as '' on purpose: "chosen nothing" ≠ "never set". */
  setSetting = (key: string, value: string): void => {
    this.db
      .prepare(
        `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  };
}

function toProvider(row: ProviderRow): ProviderConfig {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    api: row.api,
    isCustom: row.is_custom === 1,
    icon: row.icon || undefined,
    hasKey: row.credential !== null,
    models: parseModels(row.models),
    updatedAt: row.updated_at,
  };
}

function parseModels(raw: string): ModelOption[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ModelOption[]) : [];
  } catch {
    return [];
  }
}
