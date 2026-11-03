import type { TriggerSource, TriagePolicy, TriagePolicyPatch } from '@opc/shared/domain';
import { DEFAULT_SEMANTIC_PROMPT, DEFAULT_TRIAGE_POLICY } from '@opc/shared/domain';
import type { CompanyDatabase } from '../data/companyDatabase';

/**
 * 两层过滤的策略存在哪、怎么读。
 *
 * 存 `app_setting` 而不是加表：它是一份偏好（几行 JSON），不是会被查询的业务数据，
 * 和 `compaction` 的存法一致。改完立刻生效——Router 每一轮都重新读，不做缓存，
 * 所以不存在"设置了但这一版还没生效"这种解释不了的状态。
 */

const KEY = 'router.triage';

const SOURCES: readonly TriggerSource[] = ['im', 'folder', 'manual', 'calendar', 'github'];

/**
 * 把库里的（或者界面传来的）半份策略补成一份完整的。
 *
 * 每个字段都单独兜底：一个手改坏的 JSON、一个未来版本写进来的枚举值，都不该让
 * 调度停摆。识别不了就退回默认——默认的含义是"多问一句"，不是"少干一件"。
 */
export function normalizeTriagePolicy(raw: unknown): TriagePolicy {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as TriagePolicyPatch;

  const sources = Array.isArray(input.sources)
    ? SOURCES.filter((source) => input.sources?.includes(source))
    : DEFAULT_TRIAGE_POLICY.sources;

  return {
    fastPath: input.fastPath === 'allowlist' ? 'allowlist' : 'noise',
    // 空名单等于"什么都不放行"——那是把调度关掉，不是配置。退回默认。
    sources: sources.length > 0 ? sources : DEFAULT_TRIAGE_POLICY.sources,
    semantic: input.semantic === 'decision' ? 'decision' : 'router',
    noiseThreshold: clampThreshold(input.noiseThreshold),
    semanticPrompt: normalizePrompt(input.semanticPrompt),
  };
}

/**
 * 策略文本。空的那份等于"没有策略"，分类器会退化成靠自己的常识判——那不如用默认。
 *
 * 截到 2000 字：它每一批都要发一次，一段贴进来的长文会把每次分类的输入撑大，而
 * 判噪这件事本来就不需要那么长。
 */
function normalizePrompt(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SEMANTIC_PROMPT;
  const trimmed = value.trim();
  if (trimmed.length === 0) return DEFAULT_SEMANTIC_PROMPT;
  return trimmed.slice(0, 2000);
}

function clampThreshold(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TRIAGE_POLICY.noiseThreshold;
  return Math.min(0.95, Math.max(0.5, value));
}

export class TriagePolicyStore {
  constructor(private readonly db: CompanyDatabase) {}

  get = (): TriagePolicy => {
    const raw = this.db.prepare('SELECT value FROM app_setting WHERE key = ?').get(KEY) as
      | { value: string }
      | undefined;
    if (!raw) return DEFAULT_TRIAGE_POLICY;
    try {
      return normalizeTriagePolicy(JSON.parse(raw.value));
    } catch {
      return DEFAULT_TRIAGE_POLICY;
    }
  };

  /** 部分更新：没提到的字段保持原值（表单只提交它改过的那几行）。 */
  set = (patch: TriagePolicyPatch): TriagePolicy => {
    const next = normalizeTriagePolicy({ ...this.get(), ...patch });
    this.db
      .prepare(
        `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(KEY, JSON.stringify(next), Date.now());
    return next;
  };
}
