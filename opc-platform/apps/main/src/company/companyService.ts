import type { CompanyProfile, CompanyProfilePatch } from '@opc/shared/domain';
import type { CompanyDatabase } from '../data/companyDatabase';
import { COMPANY_ID } from '../data/schema';

/**
 * The `company` row and the profile bits that have no column of their own.
 *
 * `company.name` / `company.industry` are real columns (§4), so the company's
 * identity is business data, not a UI preference: it survives a reinstall of the
 * renderer, travels with a database copy, and is visible to the main process.
 * Vision, brand colour and the boss's display name have no column, so they are
 * `app_setting` rows — the same table the model defaults use.
 *
 * Writes are clamped here, not in the UI: the renderer's `maxLength` is a hint, and
 * a hostile or buggy caller must not be able to store an unbounded string.
 */
const KEY_VISION = 'profile.vision';
const KEY_COLOR = 'profile.colorId';
const KEY_BOSS = 'profile.bossName';
const KEY_LOGO = 'profile.logo';
const KEY_BOSS_AVATAR = 'profile.bossAvatar';

export const DEFAULT_COMPANY_NAME = '我的公司';
export const DEFAULT_BOSS_NAME = '老板';
export const DEFAULT_COMPANY_COLOR = 'ocean';

const LIMITS = { name: 40, industry: 40, vision: 60, colorId: 24, bossName: 20 } as const;

/**
 * Uploaded logos travel through the same `app_setting` row as the other profile
 * bits, so the cap is a DB-size guard, not a pixel guard: 500 KB of PNG is about
 * 683 K characters once base64-encoded. Only image data URLs are accepted — a
 * `javascript:` URL or a remote http URL must never end up in an `<img src>`.
 */
const IMAGE_MAX_CHARS = 700_000;
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[a-z0-9+/]+={0,2}$/i;

interface CompanyRow {
  id: string;
  name: string;
  industry: string | null;
}

export class CompanyService {
  constructor(private readonly db: CompanyDatabase) {}

  get = (): CompanyProfile => {
    const row = this.db
      .prepare('SELECT id, name, industry FROM company WHERE id = ?')
      .get(COMPANY_ID) as CompanyRow | undefined;

    return {
      id: row?.id ?? COMPANY_ID,
      name: row?.name ?? DEFAULT_COMPANY_NAME,
      industry: row?.industry ?? '',
      vision: this.setting(KEY_VISION) ?? '',
      colorId: this.setting(KEY_COLOR) ?? DEFAULT_COMPANY_COLOR,
      bossName: this.setting(KEY_BOSS) ?? DEFAULT_BOSS_NAME,
      logo: this.setting(KEY_LOGO) || undefined,
      bossAvatar: this.setting(KEY_BOSS_AVATAR) || undefined,
    };
  };

  update = (patch: CompanyProfilePatch): CompanyProfile => {
    const write = this.db.transaction(() => {
      const now = Date.now();
      const current = this.get();

      const name = patch.name === undefined ? current.name : clamp(patch.name, LIMITS.name);
      const industry = patch.industry === undefined ? current.industry : clamp(patch.industry, LIMITS.industry);

      this.db
        .prepare('UPDATE company SET name = ?, industry = ?, updated_at = ? WHERE id = ?')
        .run(name || DEFAULT_COMPANY_NAME, industry, now, COMPANY_ID);

      if (patch.vision !== undefined) this.setSetting(KEY_VISION, clamp(patch.vision, LIMITS.vision), now);
      if (patch.colorId !== undefined) this.setSetting(KEY_COLOR, clamp(patch.colorId, LIMITS.colorId), now);
      if (patch.bossName !== undefined) {
        this.setSetting(KEY_BOSS, clamp(patch.bossName, LIMITS.bossName) || DEFAULT_BOSS_NAME, now);
      }
      if (patch.logo !== undefined) this.setSetting(KEY_LOGO, clampImage(patch.logo), now);
      if (patch.bossAvatar !== undefined) this.setSetting(KEY_BOSS_AVATAR, clampImage(patch.bossAvatar), now);
    });

    write();
    return this.get();
  };

  private setting = (key: string): string | undefined => {
    const row = this.db.prepare('SELECT value FROM app_setting WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  };

  private setSetting = (key: string, value: string, now: number): void => {
    this.db
      .prepare(
        `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  };
}

/** Trimmed, length-capped, control characters removed (a newline in a name breaks the title bar). */
function clamp(value: string, max: number): string {
  return value.replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
}

/**
 * Keeps only a small, well-formed image data URL. Anything else (remote URL,
 * script URL, oversized payload) is stored as empty, which the renderer reads as
 * "no image" and paints the monogram instead.
 */
function clampImage(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length > IMAGE_MAX_CHARS) return '';
  return IMAGE_DATA_URL.test(trimmed) ? trimmed : '';
}
