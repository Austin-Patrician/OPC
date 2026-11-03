import type { CompanyDatabase } from '../data/companyDatabase';

/**
 * 触发源的配置。
 *
 * 三个密钥（GitHub / 飞书 / 钉钉）各存一份，因为它们是三套不同的签名算法，也常常由
 * 三个不同的平台各自重置。空 = 没配 = **拒绝**（见 `trigger/verify.ts`），不是放行。
 *
 * 端口也是配置：4399 只是默认值，撞上别的软件就该能改，而不是让人去关掉正在跑的东西。
 */

export interface TriggerSecrets {
  github: string;
  feishu: string;
  dingtalk: string;
}

export interface TriggerSettings {
  port: number;
  secrets: TriggerSecrets;
}

export interface TriggerSettingsPatch {
  port?: number;
  secrets?: Partial<TriggerSecrets>;
}

const KEY = 'trigger.hooks';
const DEFAULT_PORT = 4319;

export class TriggerSettingsStore {
  constructor(private readonly db: CompanyDatabase) {}

  get = (): TriggerSettings => {
    const raw = this.db.prepare('SELECT value FROM app_setting WHERE key = ?').get(KEY) as
      | { value: string }
      | undefined;
    if (!raw) return { port: DEFAULT_PORT, secrets: { github: '', feishu: '', dingtalk: '' } };
    try {
      return normalize(JSON.parse(raw.value));
    } catch {
      return { port: DEFAULT_PORT, secrets: { github: '', feishu: '', dingtalk: '' } };
    }
  };

  set = (patch: TriggerSettingsPatch): TriggerSettings => {
    const current = this.get();
    const next = normalize({
      port: patch.port ?? current.port,
      secrets: { ...current.secrets, ...patch.secrets },
    });
    this.db
      .prepare(
        `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(KEY, JSON.stringify(next), Date.now());
    return next;
  };
}

/** 手改坏的 JSON、越界端口都不该让应用启动失败：认不出就用默认，端口夹回合法区间。 */
function normalize(raw: unknown): TriggerSettings {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as TriggerSettingsPatch;
  const secrets = (typeof input.secrets === 'object' && input.secrets !== null ? input.secrets : {}) as
    Partial<TriggerSecrets>;
  const port =
    typeof input.port === 'number' && Number.isInteger(input.port) && input.port >= 1024 && input.port <= 65535
      ? input.port
      : DEFAULT_PORT;
  return {
    port,
    secrets: {
      github: typeof secrets.github === 'string' ? secrets.github.trim() : '',
      feishu: typeof secrets.feishu === 'string' ? secrets.feishu.trim() : '',
      dingtalk: typeof secrets.dingtalk === 'string' ? secrets.dingtalk.trim() : '',
    },
  };
}

export const DEFAULT_TRIGGER_PORT = DEFAULT_PORT;
