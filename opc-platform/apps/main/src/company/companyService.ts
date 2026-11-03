import type { CompanyProfile, CompanyProfilePatch } from '@opc/shared/domain';
import type { CompanyDatabase } from '../data/companyDatabase';
import { USER_ID, COMPANY_ID } from '../data/schema';

/**
 * `company` 那一行、你，以及没有自己列的那点资料。
 *
 * `company.name` / `company.domain` 是真实的列（§4），所以工作台的身份是业务数据、
 * 不是界面偏好：重装渲染层不会丢，跟着库走，主进程也看得见。
 *
 * **「你」是一行，不是一个设置项。** 名字与头像在 `app_user`（`id = 'user'`，这个产品
 * 里唯一的那个人），因为"是谁验收的"必须解析成一个持久的身份：`acceptance.reviewer`
 * 记的就是这个 id。把名字放在 `app_setting` 里等于把"人"降级成偏好——一次偏好重置
 * 就会把它抹掉。
 *
 * 愿景与品牌色继续留在 `app_setting`：那些确实是外观。
 *
 * 长度在这里夹，不在界面里：渲染层的 `maxLength` 只是提示，恶意或有 bug 的调用方
 * 不该能写进一个无界字符串。
 */
const KEY_GOAL = 'profile.goal';
const KEY_COLOR = 'profile.colorId';
const KEY_LOGO = 'profile.logo';
// `profile.bossName` / `profile.bossAvatar` 这里不再读写：v18 已经把值搬进 `app_user`，
// 旧的两行留着，回滚一个版本仍能渲染出称呼。

export const DEFAULT_COMPANY_NAME = '我的工作台';
export const DEFAULT_USER_NAME = '我';
export const DEFAULT_COMPANY_COLOR = 'ocean';

const LIMITS = { name: 40, domain: 40, goal: 60, colorId: 24, userName: 20 } as const;

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
  domain: string | null;
}

export class CompanyService {
  constructor(private readonly db: CompanyDatabase) {}

  get = (): CompanyProfile => {
    const row = this.db
      .prepare('SELECT id, name, domain FROM company WHERE id = ?')
      .get(COMPANY_ID) as CompanyRow | undefined;
    const user = this.user();

    return {
      id: row?.id ?? COMPANY_ID,
      name: row?.name ?? DEFAULT_COMPANY_NAME,
      domain: row?.domain ?? '',
      goal: this.setting(KEY_GOAL) ?? '',
      colorId: this.setting(KEY_COLOR) ?? DEFAULT_COMPANY_COLOR,
      userName: user.name,
      logo: this.setting(KEY_LOGO) || undefined,
      userAvatar: user.avatar || undefined,
    };
  };

  /**
   * The single human. Read through this rather than `app_setting`, and treat a missing
   * row as "the defaults" instead of an error: a database that predates v18 and one
   * that has been hand-edited should both still open.
   */
  user = (): { id: string; name: string; avatar: string } => {
    const row = this.db
      .prepare('SELECT id, name, avatar FROM app_user WHERE id = ?')
      .get(USER_ID) as { id: string; name: string; avatar: string } | undefined;
    return {
      id: USER_ID,
      name: row?.name?.trim() || DEFAULT_USER_NAME,
      avatar: row?.avatar ?? '',
    };
  };

  update = (patch: CompanyProfilePatch): CompanyProfile => {
    const write = this.db.transaction(() => {
      const now = Date.now();
      const current = this.get();

      const name = patch.name === undefined ? current.name : clamp(patch.name, LIMITS.name);
      const domain = patch.domain === undefined ? current.domain : clamp(patch.domain, LIMITS.domain);

      this.db
        .prepare('UPDATE company SET name = ?, domain = ?, updated_at = ? WHERE id = ?')
        .run(name || DEFAULT_COMPANY_NAME, domain, now, COMPANY_ID);

      if (patch.goal !== undefined) this.setSetting(KEY_GOAL, clamp(patch.goal, LIMITS.goal), now);
      if (patch.colorId !== undefined) this.setSetting(KEY_COLOR, clamp(patch.colorId, LIMITS.colorId), now);
      if (patch.logo !== undefined) this.setSetting(KEY_LOGO, clampImage(patch.logo), now);

      // 你就是那一行：upsert 而不是 insert —— 迁移会种下它，手工删掉之后必须能长回来，
      // 而不是让这次写入失败。
      if (patch.userName !== undefined || patch.userAvatar !== undefined) {
        const before = this.user();
        this.db
          .prepare(
            `INSERT INTO app_user (id, name, avatar, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name, avatar = excluded.avatar, updated_at = excluded.updated_at`,
          )
          .run(
            USER_ID,
            patch.userName === undefined
              ? before.name
              : clamp(patch.userName, LIMITS.userName) || DEFAULT_USER_NAME,
            patch.userAvatar === undefined ? before.avatar : clampImage(patch.userAvatar),
            now,
            now,
          );
      }
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
