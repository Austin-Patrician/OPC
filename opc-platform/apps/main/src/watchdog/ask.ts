import type { ModelConfigService } from '../models/modelConfigService';
import type { SystemEventRepository } from '../data/systemEventRepository';
import type { WatchdogActionRepository } from '../data/watchdogActionRepository';
import type { WatchdogIncidentRepository } from '../data/watchdogIncidentRepository';

/**
 * 「问它」：用库里的证据回答一句人话（`11-watchdog-spec.md` W7）。
 *
 * 它不是聊天机器人，是一个**带证据的查询口**。三条自我约束：
 *
 * 1. **证据之外不回答。** 只看 incident、动作账本、未处理的系统故障；模型可以
 *    说"我不知道"，这比编一个像样的原因有用。
 * 2. **必须引用编号。** 每条结论要挂上 `[i:…]` / `[a:…]` / `[e:…]`，人能顺着编号
 *    去库里核对——这是它和"一个懂语气的猜测"的区别。
 * 3. **只读。** 它不能改任何东西：要改规则去设置页，要修去 W6 的白名单。
 */

export interface AskResult {
  ok: boolean;
  answer?: string;
  /** 这次真的喂给模型的证据编号。 */
  evidence?: string[];
  /** 模型实际引用、且确实存在于上面的编号。 */
  citations?: string[];
  /** 被剔除的伪造/越界引用条数（回答里出现、但不在证据里）。 */
  invalidCitations?: number;
  error?: string;
  model?: string;
}

export function createWatchdogAnswerer(deps: {
  models: ModelConfigService;
  incidents: WatchdogIncidentRepository;
  actions: WatchdogActionRepository;
  events: SystemEventRepository;
}) {
  return async (question: string): Promise<AskResult> => {
    const trimmed = question.trim();
    if (!trimmed) return { ok: false, error: '问点什么' };

    const defaults = deps.models.getDefaults().llm;
    if (!defaults) return { ok: false, error: '没有配置默认模型（设置 → 模型）' };

    const evidence = collect(deps);
    if (evidence.lines.length === 0) {
      return { ok: true, answer: '现在没有任何未处理的问题：没有活跃的 incident，也没有失败记录。', evidence: [] };
    }

    try {
      const runtime = await deps.models.runtime.createModels();
      const model = await deps.models.runtime.resolveModel(defaults.providerId, defaults.modelId);
      if (!model) return { ok: false, error: '找不到默认模型' };

      const answer = await runtime.complete(model, {
        messages: [{ role: 'user', content: [{ type: 'text', text: promptOf(trimmed, evidence.lines) }] }],
      } as never);

      const text = ((answer as { content?: { type: string; text?: string }[] }).content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
        .trim();

      // 模型可以编一个不存在的证据编号。**引用是我们唯一的可核对性**，
      // 所以这里不信它：只留真的在本次证据里的，其余从回答里删掉并计数。
      const allowed = new Set(evidence.ids);
      const cited = [...text.matchAll(/\[([iae]):([0-9a-z]+)\]/gi)].map(
        (match) => `${(match[1] ?? '').toLowerCase()}:${match[2]}`,
      );
      const citations = [...new Set(cited.filter((id) => allowed.has(id)))];
      const invalid = cited.filter((id) => !allowed.has(id)).length;
      const cleaned =
        invalid > 0
          ? text.replace(/\[([iae]):([0-9a-z]+)\]/gi, (whole, kind: string, id: string) =>
              allowed.has(`${kind.toLowerCase()}:${id}`) ? whole : '',
            )
          : text;

      return {
        ok: true,
        answer: cleaned.trim() || '（模型没有给出回答）',
        evidence: evidence.ids,
        citations,
        invalidCitations: invalid,
        model: `${defaults.providerId}/${defaults.modelId}`,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

const INSTRUCTIONS = [
  '你在回答一个关于「本机 Agent 系统最近发生了什么」的问题。',
  '只能用下面给出的证据回答；证据里没有的，直接说不知道，不要推测。',
  '每条结论后面用方括号标出依据，例如 [i:1a2b] / [a:9f3c] / [e:77dd]。',
  '用中文，三句话以内。不要给修复建议——这个系统只让你解释，不让你动手。',
].join('\n');

function promptOf(question: string, lines: readonly string[]): string {
  return [INSTRUCTIONS, '', '--- 证据 ---', ...lines, '', '--- 问题 ---', question].join('\n');
}

/** 证据的收集与编号都在这里：回答里出现的编号必须来自这一页。 */
function collect(deps: {
  incidents: WatchdogIncidentRepository;
  actions: WatchdogActionRepository;
  events: SystemEventRepository;
}): { lines: string[]; ids: string[] } {
  const lines: string[] = [];
  const ids: string[] = [];

  const incidents = deps.incidents.listOpen(10);
  incidents.forEach((incident, index) => {
    const id = short(incident.id);
    ids.push(`i:${id}`);
    lines.push(
      `[i:${id}] ${incident.kind} · 状态 ${incident.state}` +
        (incident.subjectId ? ` · 对象 ${incident.subjectType}/${incident.subjectId}` : '') +
        ` · 首次 ${when(incident.firstAt)} · 复发 ${incident.reopenCount} 次\n    说明：${incident.summary}`,
    );
    if (incident.detail) {
      // 证据是 JSON：判"为什么"要靠它（哪个工具、哪几步、成没成），不是靠摘要。
      lines.push(`    证据：${incident.detail.slice(0, 600)}`);
    }
    if (index === incidents.length - 1 && incidents.length > 5) {
      lines.push('（更早的 incident 省略）');
    }
  });

  for (const action of deps.actions.listRecent(5)) {
    const id = short(`${action.incidentId}:${action.action}`.padEnd(8, '0'));
    ids.push(`a:${id}`);
    lines.push(
      `[a:${id}] 动作 ${action.action} · ${action.status} · ${when(action.at)}\n    结果：${action.result || '（没有记录）'}`,
    );
  }

  for (const event of deps.events.listOpen(5)) {
    const id = short(event.id);
    ids.push(`e:${id}`);
    lines.push(`[e:${id}] 系统事件 ${event.kind} · ${when(event.at)}\n    摘要：${event.summary}`);
  }

  return { lines, ids };
}

/**
 * 8 个字符：4 个在 UUID 上撞车太容易，而撞车之后"引用"就变成了摆设。
 */
function short(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

function when(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.round(minutes / 60)} 小时前`;
}
