import type { ModelConfigService } from '../models/modelConfigService';
import type { JudgePayload, JudgeResult } from './protocol';

/**
 * 语义判断（`11-watchdog-spec.md` W5）。
 *
 * 它回答的问题只有一个：**这些动作还指向那个目标吗？**
 * 程序层能说"它在重复""它停了"；说不了"它动得很勤、但方向已经偏了"。
 *
 * 三条自我约束：
 *
 * 1. **只出结论，不动手。** 返回值里没有"取消/重跑"这种字段——那要等 W6 的
 *    白名单动作，且永远不含杀任务。
 * 2. **可以回答"判不了"。** 证据不够时说 `insufficient_evidence` 是正确行为，
 *    不是失败；逼它给结论只会多一种误判。
 * 3. **模型不可用不是故障。** 没配模型就把错误交回去，程序层照常工作。
 */

const SYSTEM_PROMPT = [
  '你是一个只看证据的判断器，判断一个正在运行的执行体是否还在朝目标推进。',
  '',
  '你会看到：任务目标（验收标准）、触发的规则、最近的动作序列（工具名、参数摘要、成败）。',
  '只根据这些证据判断，不要猜测没有出现的东西。',
  '',
  '输出**只有**一个 JSON 对象，不要解释、不要代码块、不要建议、不要 Markdown。',
  '第一个字符必须是 `{`，最后一个字符必须是 `}`。',
  '{',
  '  "verdict": "progressing | stalled | looping | deviating | insufficient_evidence",',
  '  "reason": "一句话，指出是哪个证据支撑这个结论",',
  '  "confidence": 0.0 到 1.0',
  '}',
  '只允许这三个字段。你是判断器，不是顾问：**不要**说下一步该怎么做。',
  '',
  '定义：',
  '- progressing：动作在推进目标，即使慢；',
  '- stalled：没有新动作，或在等一个不会来的东西；',
  '- looping：反复做同一个动作、结果没有变化；',
  '- deviating：动作在推进，但推进的不是目标要求的东西；',
  '- insufficient_evidence：现有证据不足以判断——**这个答案经常是对的**。',
].join('\n');

export function createWatchdogJudge(
  models: ModelConfigService,
  resolveRef: () => { providerId: string; modelId: string } | null = () => null,
) {
  return async (payload: JudgePayload): Promise<JudgeResult> => {
    // 优先用它自己配的模型；没配才退回默认 LLM——那是兜底，不是等价方案。
    const target = resolveRef() ?? models.getDefaults().llm;
    if (!target) return { ok: false, error: '没有可用的判断模型（设置 → 进展监督 → 模型）' };

    try {
      const runtime = await models.runtime.createModels();
      const model = await models.runtime.resolveModel(target.providerId, target.modelId);
      if (!model) return { ok: false, error: '找不到配置的判断模型' };

      const answer = await runtime.complete(model, {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: evidenceOf(payload) }] }],
      } as never);

      const text = ((answer as { content?: { type: string; text?: string }[] }).content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');

      return {
        ...parseVerdict(text),
        model: `${target.providerId}/${target.modelId}`,
        ok: true,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

/** 证据：目标 + 候选 + 最近的动作。不带整个库，也不带提示词。 */
function evidenceOf(payload: JudgePayload): string {
  const lines = [
    // 指令同时放在 user 消息里：有的 provider 不转发 systemPrompt，
    // 而这条任务要求"只输出 JSON"，不能只靠可能存在的那一层。
    SYSTEM_PROMPT,
    '',
    '--- 证据 ---',
    `任务：${payload.title}`,
    `目标（验收标准）：${payload.goal.trim() || '（没有写验收标准）'}`,
    '',
    `触发的规则：${payload.candidate.kind}`,
    `规则给出的说法：${payload.candidate.summary}`,
    `规则附带的证据：${payload.candidate.detail}`,
    '',
    `最近 ${payload.trace.length} 个动作（旧 → 新）：`,
  ];

  for (const row of payload.trace) {
    const status = row.ok === null ? '?（没拿到结果）' : row.ok ? '成功' : '失败';
    lines.push(`${row.seq}. ${row.name} ${row.argsDigest} → ${status}`);
  }

  return lines.join('\n');
}

const VERDICTS = new Set([
  'progressing',
  'stalled',
  'looping',
  'deviating',
  'insufficient_evidence',
]);

/**
 * 解析模型的回答。
 *
 * 解析不出来时给 `insufficient_evidence` 而不是抛：模型啰嗦是常态，
 * 而"这一轮没判出来"恰好是那个合法的结论。
 */
function parseVerdict(text: string): {
  verdict:
    | 'progressing'
    | 'stalled'
    | 'looping'
    | 'deviating'
    | 'insufficient_evidence';
  reason: string;
  confidence: number;
} {
  const candidates = [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1), ...embedded(text)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as {
        verdict?: unknown;
        reason?: unknown;
        confidence?: unknown;
      };
      const verdict = typeof parsed.verdict === 'string' ? parsed.verdict.trim() : '';
      if (!VERDICTS.has(verdict)) continue;
      return {
        verdict: verdict as never,
        reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 400) : '',
        confidence:
          typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
            ? Math.min(1, Math.max(0, parsed.confidence))
            : 0,
      };
    } catch {
      // 试下一个候选。
    }
  }

  console.warn('[watchdog] 判断输出无法解析', debugRaw(text));
  return {
    verdict: 'insufficient_evidence',
    reason: `模型没有给出可解析的结论（原文 ${text.length} 字：${debugRaw(text)}）`,
    confidence: 0,
  };
}

/** 解析失败时留一行原文，否则"判不了"会变成查不动的黑箱。 */
function debugRaw(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

/**
 * 模型爱在结论前后夹带解释。这里把**不含嵌套**的 `{…"verdict"…}` 片段挑出来再试。
 *
 * 不引 JSON 修复库：判不出来时返回 `insufficient_evidence` 本来就是合法结论，
 * 为一条容错引入一个解析器不值得。
 */
function embedded(text: string): string[] {
  return text.match(/\{[^{}]*"verdict"[^{}]*\}/g) ?? [];
}
