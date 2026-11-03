import type { TriggerSource } from '@opc/shared/domain';
import type { NormalizedTrigger, TriggerAdapter, TriggerRequest } from './types';

/**
 * 触发入口的路由表。
 *
 * 只做三件事，顺序是固定的：**认人 → 验身 → 归一**。三件事分开写，是因为它们失败
 * 的原因完全不同，混在一起用户只会看到"没反应"：
 *
 * - 路径不认识 → 404，回一份已知入口的名单；
 * - 签名不对   → 401，说清是"没配密钥"还是"签名不匹配"；
 * - 归一为空   → 200。**这是成功**：`ping`、`url_verification`、已读回执都该是 200
 *   且没有事件。回 4xx 会让平台一直重投，把一条无意义的消息变成永久的噪声源。
 */
export interface TriggerOutcome {
  status: number;
  body: string;
  /** 归一到的事件。空数组 + 200 是合法结果，见上。 */
  accepted: NormalizedTrigger[];
  /** 落到哪个适配器（`null` = 没认出来）。 */
  adapterId: string | null;
  source: TriggerSource | null;
  /** 没接住的原因，只写日志，不回给外部（别把"你没配对"告诉互联网）。 */
  reason?: string;
}

export class TriggerRegistry {
  constructor(private readonly adapters: readonly TriggerAdapter[]) {}

  /** 已知入口。设置页显示它，用户才知道该把哪个 URL 填到平台里。 */
  get entries(): { id: string; source: TriggerSource }[] {
    return this.adapters.map((adapter) => ({ id: adapter.id, source: adapter.source }));
  }

  handle(request: TriggerRequest): TriggerOutcome {
    const id = routeId(request.path);
    const adapter = id ? this.adapters.find((entry) => entry.id === id) : undefined;
    if (!adapter) {
      return {
        status: 404,
        body: JSON.stringify({ ok: false, known: this.entries.map((entry) => entry.id) }),
        accepted: [],
        adapterId: null,
        source: null,
        reason: `未知入口 ${request.path}`,
      };
    }

    // 接入挑战先于签名：平台刚填完 URL 时密钥还没生效，而这一步不带任何工作内容。
    const challenge = adapter.challenge?.(request) ?? null;
    if (challenge) {
      return { status: 200, body: challenge, accepted: [], adapterId: adapter.id, source: adapter.source };
    }

    const verified = adapter.verify(request);
    if (!verified.ok) {
      return {
        status: 401,
        body: JSON.stringify({ ok: false }),
        accepted: [],
        adapterId: adapter.id,
        source: adapter.source,
        reason: verified.reason,
      };
    }

    let accepted: NormalizedTrigger[];
    try {
      accepted = adapter.normalize(request);
    } catch (error) {
      return {
        status: 200,
        body: JSON.stringify({ ok: true, accepted: 0 }),
        accepted: [],
        adapterId: adapter.id,
        source: adapter.source,
        reason: `归一失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }

    return {
      status: 200,
      // 回 200 之前就已经决定要不要落事件了；平台只需要知道"收到了"。
      body: JSON.stringify({ ok: true, accepted: accepted.length }),
      accepted,
      adapterId: adapter.id,
      source: adapter.source,
    };
  }
}

/** `/hook/github` → `github`。多余的层级一律不认，路径要短且确定。 */
export function routeId(pathname: string): string | null {
  const match = /^\/hook\/([a-z0-9_-]+)\/?$/.exec(pathname);
  return match?.[1] ?? null;
}
