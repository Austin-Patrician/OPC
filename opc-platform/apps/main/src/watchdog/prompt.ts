/**
 * 判断用的提示词与解析（W5）。
 *
 * 放在这个文件里是为了让**两个进程用同一份**：主进程兜底调用时用它，子进程
 * 自己调用时也用它。提示词分叉过一次（一份在 system、一份在 user），不要再分叉
 * 第二次。
 */

export const JUDGE_INSTRUCTIONS = [
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

export interface JudgeEvidence {
  title: string;
  goal: string;
  candidateKind: string;
  candidateSummary: string;
  candidateDetail: string;
  trace: readonly { seq: number; name: string; argsDigest: string; ok: boolean | null }[];
}

/** 证据渲染成一段文本：目标 + 候选 + 最近动作。 */
export function buildJudgePrompt(evidence: JudgeEvidence): string {
  const lines = [
    // 指令同时放在 user 消息里：有的 provider 不转发 systemPrompt，
    // 而这条任务要求"只输出 JSON"，不能只靠可能存在的那一层。
    JUDGE_INSTRUCTIONS,
    '',
    '--- 证据 ---',
    `任务：${evidence.title}`,
    `目标（验收标准）：${evidence.goal.trim() || '（没有写验收标准）'}`,
    '',
    `触发的规则：${evidence.candidateKind}`,
    `规则给出的说法：${evidence.candidateSummary}`,
    `规则附带的证据：${evidence.candidateDetail}`,
    '',
    `最近 ${evidence.trace.length} 个动作（旧 → 新）：`,
  ];
  for (const row of evidence.trace) {
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

export type VerdictName =
  | 'progressing'
  | 'stalled'
  | 'looping'
  | 'deviating'
  | 'insufficient_evidence';

export interface ParsedVerdict {
  verdict: VerdictName;
  reason: string;
  confidence: number;
}

/**
 * 解析模型的回答。
 *
 * 解析不出来时给 `insufficient_evidence` 而不是抛：模型啰嗦是常态，
 * 而"这一轮没判出来"恰好是那个合法的结论。
 */
export function parseVerdict(text: string): ParsedVerdict {
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
        verdict: verdict as VerdictName,
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

  return {
    verdict: 'insufficient_evidence',
    reason: `模型没有给出可解析的结论（原文 ${text.length} 字：${debugRaw(text)}）`,
    confidence: 0,
  };
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

/** 解析失败时留一行原文，否则"判不了"会变成查不动的黑箱。 */
function debugRaw(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 300);
}
