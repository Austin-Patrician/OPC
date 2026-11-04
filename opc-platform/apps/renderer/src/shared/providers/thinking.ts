import { THINKING_LEVELS, type ThinkingLevel } from './catalog';

/**
 * 一个模型支持哪些思考档位。
 *
 * 首选是 **pi 自己算出来的结果**（`getSupportedThinkingLevels`，随 catalog 一起
 * 从主进程传过来）：它看模型的 `reasoning` 与 `thinkingLevelMap`，`xhigh` / `max`
 * 只有映射里明确写过才会出现。这里不再维护第二张映射表。
 *
 * 只有两种情况下会退回 `FALLBACK_THINKING_LEVELS`（低/中/高）：
 *   - 模型是手填的，pi 的目录里没有它；
 *   - 旧的主进程还没带 `thinkingLevels` 字段。
 *
 * `reasoning === false` 是唯一的"不许选"：返回空数组，界面不出现档位控件。
 * pi 对这类模型返回 `['off']`，同样折算成空数组。
 */
export const FALLBACK_THINKING_LEVELS: readonly ThinkingLevel[] = ['low', 'medium', 'high'];

const KNOWN_LEVELS = new Set<ThinkingLevel>(THINKING_LEVELS.map((entry) => entry.value));

export function thinkingLevelsFor(
  model: {
    id: string;
    /** `false` = 模型明确不支持思考；`undefined` = 不知道，按支持处理。 */
    reasoning?: boolean;
  },
  /** pi 的 `getSupportedThinkingLevels()` 结果。 */
  supported?: readonly string[],
): ThinkingLevel[] {
  if (model.reasoning === false) return [];

  const fromPi = (supported ?? []).filter((level): level is ThinkingLevel =>
    KNOWN_LEVELS.has(level as ThinkingLevel),
  );
  if (fromPi.length > 0) {
    // pi 用 `['off']` 表示"这个模型没有思考档位"，和空数组是同一个意思。
    return fromPi.length === 1 && fromPi[0] === 'off' ? [] : [...fromPi];
  }

  return [...FALLBACK_THINKING_LEVELS];
}
