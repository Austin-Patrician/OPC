import type { TriggerEvent, TriagePolicy } from '@opc/shared/domain';

/**
 * 程序层：不花一个 token 就能判掉的那部分（§3.1 Fast Path）。
 *
 * 这一层的设计原则只有一条——**它只挡确定是噪声的**。拿不准就往上交，因为这一层
 * 挡错东西的代价是"活丢了而且没人知道"，而交上去的代价只是几百个 token。所以这里
 * 的规则要能一句话说清"为什么这肯定不是活"，说不清的都不许加进来。
 *
 * 三条规则：
 *   ① 自己写出来的回环（`payload.origin === 'self'`）——文件夹监视器看见的
 *      "工作区里多了个文件"如果是我们自己刚写的那份产出，那不是新工作。
 *   ② 空内容——没有正文可判，交给模型也只是浪费一次调用。
 *   ③ 窗口内重复指纹——同源、同 kind、同正文的环境事件（同一份文件被 touch 两次）。
 *      **人说的话不去重**：你连发两条"在吗"就是两条，谁也没有资格替你合并。
 *
 * 另外 `allowlist` 模式下多一条：不在名单里的来源一律不放行。那是个显式的选择
 * （"我就让它盯收件箱"），代价是新接的适配器要登记一次，所以默认不是它。
 */

export type FastPathVerdict = 'keep' | 'drop';

/** 人类说话的来源：不去重。 */
const HUMAN_SOURCES: ReadonlySet<string> = new Set(['im', 'manual']);

const DEFAULT_REPEAT_WINDOW_MS = 60_000;
/** 指纹表的自清理阈值：它只是个去重窗口，不是账本。 */
const MAX_FINGERPRINTS = 500;

export interface FastPathDeps {
  /** 每一轮都重新读：设置里改完立刻生效，不做缓存。 */
  policy: () => TriagePolicy;
  now?: () => number;
  /** 去重窗口；0 关掉去重。 */
  repeatWindowMs?: number;
}

export function createFastPath(deps: FastPathDeps): (event: TriggerEvent) => FastPathVerdict {
  const now = deps.now ?? Date.now;
  const windowMs = deps.repeatWindowMs ?? DEFAULT_REPEAT_WINDOW_MS;
  /** fingerprint → 上次见到它的时刻。只用来挡"同一件事在一分钟内说了两遍"。 */
  const seen = new Map<string, number>();

  const remember = (fingerprint: string, at: number): boolean => {
    const previous = seen.get(fingerprint);
    if (previous !== undefined && at - previous < windowMs) {
      seen.set(fingerprint, at);
      return true;
    }
    if (seen.size >= MAX_FINGERPRINTS) {
      for (const [key, stamp] of seen) {
        if (at - stamp >= windowMs) seen.delete(key);
      }
      if (seen.size >= MAX_FINGERPRINTS) seen.clear();
    }
    seen.set(fingerprint, at);
    return false;
  };

  return (event) => {
    const policy = deps.policy();

    // ① 自己的回环。
    if (event.payload.origin === 'self') return 'drop';

    // ② 空内容。
    const body = bodyOf(event.payload);
    if (body.length === 0) return 'drop';

    // 名单模式：只让登记的来源进来。
    if (policy.fastPath === 'allowlist' && !policy.sources.includes(event.source)) return 'drop';

    // ③ 窗口内重复（环境事件才去重）。
    if (windowMs > 0 && !HUMAN_SOURCES.has(event.source)) {
      const at = now();
      if (remember(`${event.source}|${event.kind}|${body}`, at)) return 'drop';
    }

    return 'keep';
  };
}

/**
 * 事件里最像"内容"的那个字段。适配器约定：`text` / `goal` / `path` / `summary` / `brief`。
 *
 * 程序层去重与 Inline & Spill 用的是同一份判断——两处各写一遍，迟早出现"去重看的是
 * `path`、注入看的是 `text`"这种对不上的情况。
 */
export function bodyOf(payload: Record<string, unknown>): string {
  for (const field of ['text', 'goal', 'instruction', 'title', 'path', 'summary', 'brief'] as const) {
    const value = payload[field];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  const keys = Object.keys(payload).filter((key) => key !== 'threadKey' && key !== 'origin');
  if (keys.length === 0) return '';
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, payload[key]])));
}
