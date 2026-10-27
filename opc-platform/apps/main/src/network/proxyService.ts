import type { ProxyConfig } from '@opc/shared/domain';
import type { CompanyDatabase } from '../data/companyDatabase';
import {
  DEFAULT_PROXY_CONFIG,
  normalizeProxyInput,
  PROXY_MODES,
  PROXY_PROTOCOLS,
  type ResolvedProxy,
} from './proxyConfig';

/**
 * Persistence for the boss's proxy choice, in `app_setting` — the same table the
 * company profile and model defaults use, so no schema migration is needed and the
 * choice travels with a database copy.
 *
 * Two rows: the config itself (JSON, no secret) and the password (ciphertext,
 * `safeStorage`). Splitting them means the settings page can display the config
 * without ever touching the keyring, and a missing keyring cannot corrupt it.
 *
 * Electron is injected (`cipher`, `apply`) so this class is testable against a
 * real SQLite file without launching a window.
 */

const KEY_CONFIG = 'network.proxy';
const KEY_PASSWORD = 'network.proxyPassword';

export interface SecretCipher {
  encrypt(plain: string): Buffer;
  decrypt(payload: Buffer): string;
}

export interface ProxyServiceDeps {
  cipher: SecretCipher;
  /** Applies a config to Chromium, `fetch` and the environment. */
  apply: (config: ResolvedProxy) => Promise<void>;
  now?: () => number;
}

export class NetworkProxyService {
  private readonly now: () => number;

  constructor(
    private readonly db: CompanyDatabase,
    private readonly deps: ProxyServiceDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  /** What the settings page renders: no secret, only `hasPassword`. */
  get = (): ProxyConfig => {
    const stored = this.readConfig();
    return { ...stored, hasPassword: this.readPassword() !== '' };
  };

  /** The config plus the decrypted secret, for the runtime only. */
  resolve = (): ResolvedProxy => ({ ...this.readConfig(), password: this.readPassword() });

  /**
   * Validates an unsaved draft into what *would* be applied. Used by the "test
   * connection" button: it must exercise the form, not the last saved config.
   */
  candidate = (raw: unknown): ResolvedProxy => {
    const input = normalizeProxyInput(raw);
    const password = input.password === undefined ? this.readPassword() : input.password;
    return {
      mode: input.mode,
      protocol: input.protocol,
      host: input.host,
      port: input.port,
      username: input.username,
      bypass: input.bypass,
      hasPassword: password.length > 0,
      password,
    };
  };

  /**
   * Validates, persists, then applies. Order matters: a config that cannot be
   * encrypted must not be written (that would silently disable proxy auth), and a
   * config that cannot be applied must still be reported.
   */
  update = async (raw: unknown): Promise<ProxyConfig> => {
    const input = normalizeProxyInput(raw);
    const keepPassword = input.password === undefined;
    const password = keepPassword ? this.readPassword() : (input.password ?? '');
    // Encrypt before opening the transaction: `safeStorage` is the only step that
    // can fail for environmental reasons, and it must not leave a half-written row.
    const encrypted = password ? this.deps.cipher.encrypt(password) : null;

    const write = this.db.transaction(() => {
      const now = this.now();
      this.setSetting(
        KEY_CONFIG,
        JSON.stringify({
          mode: input.mode,
          protocol: input.protocol,
          host: input.host,
          port: input.port,
          username: input.username,
          bypass: input.bypass,
        }),
        now,
      );
      if (encrypted) {
        this.setSetting(KEY_PASSWORD, encrypted.toString('base64'), now);
      } else if (!keepPassword) {
        this.db.prepare('DELETE FROM app_setting WHERE key = ?').run(KEY_PASSWORD);
      }
    });
    write();

    try {
      await this.deps.apply(this.resolve());
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`代理设置已保存，但立即生效失败：${reason}`, { cause: error });
    }

    return this.get();
  };

  private readConfig = (): ProxyConfig => {
    const raw = this.setting(KEY_CONFIG);
    let parsed: Record<string, unknown> = {};
    if (raw) {
      try {
        const value: unknown = JSON.parse(raw);
        if (value && typeof value === 'object') parsed = value as Record<string, unknown>;
      } catch {
        // A corrupt row must not brick networking: fall back to the defaults.
      }
    }

    const mode = PROXY_MODES.find((candidate) => candidate === parsed.mode) ?? DEFAULT_PROXY_CONFIG.mode;
    const protocol =
      PROXY_PROTOCOLS.find((candidate) => candidate === parsed.protocol) ?? DEFAULT_PROXY_CONFIG.protocol;
    const port = typeof parsed.port === 'number' && parsed.port > 0 ? parsed.port : DEFAULT_PROXY_CONFIG.port;

    return {
      mode,
      protocol,
      host: typeof parsed.host === 'string' ? parsed.host : '',
      port,
      username: typeof parsed.username === 'string' ? parsed.username : '',
      hasPassword: false,
      bypass: typeof parsed.bypass === 'string' ? parsed.bypass : '',
    };
  };

  /** Decryption failure is a missing password, never a crash at launch. */
  private readPassword = (): string => {
    const encoded = this.setting(KEY_PASSWORD);
    if (!encoded) return '';
    try {
      return this.deps.cipher.decrypt(Buffer.from(encoded, 'base64'));
    } catch (error) {
      console.warn('[OPC] 代理密码无法解密，按未设置处理', error);
      return '';
    }
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
