import type { WorkerTemplate } from '@opc/shared/domain';

/**
 * 派活的时候，谁来做？
 *
 * 在这之前这一步是「第一个在职员工」，也就是说公司里有几个人时，谁接到活看运气。
 * 这个文件把它换成一条可解释的规则：**按模板匹配技能**。
 *
 * 纯函数，不碰数据库、不调模型——所以「为什么是他」可以在测试里被钉住，
 * 而不是靠观察日志猜。
 */

export interface WorkerCandidate {
  employeeId: string;
  name: string;
  skills: readonly string[];
}

/**
 * 每个模板希望执行体具备什么。
 *
 * 不是评分卡，是关键词：命中越多越合适，一个都不命中也不淘汰——
 * 人少的时候总得有人干，只是排在最后。真正的技能目录属于 worker 自己，
 * 等 B4 删掉 employee 之后这里会变成 `worker.skills` 的直接比较。
 */
const TEMPLATE_SKILLS: Record<WorkerTemplate, readonly string[]> = {
  code: [
    'typescript',
    'javascript',
    'node',
    'python',
    'react',
    'sql',
    'sqlite',
    'go',
    'rust',
    '前端',
    '后端',
    '全栈',
    '工程师',
  ],
  research: [
    '研究',
    '分析',
    '调研',
    '检索',
    '写作',
    '文档',
    '总结',
    'research',
    'analysis',
    'writing',
  ],
  ops: ['运维', '运营', '自动化', '脚本', '部署', '测试', 'ops', 'automation', 'deploy'],
};

/**
 * Picks the best match, or the first candidate when nothing matches.
 *
 * `hint` is free text from the goal (the thread title, usually): tapping it in
 * lets "写一个抓取脚本" land on the person who lists Python without asking the
 * boss to tag anything.
 */
export function pickWorker(
  candidates: readonly WorkerCandidate[],
  template: WorkerTemplate,
  hint = '',
): WorkerCandidate | null {
  if (candidates.length === 0) return null;

  const wanted = TEMPLATE_SKILLS[template];
  const hintText = hint.toLowerCase();
  let best: WorkerCandidate | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const skills = candidate.skills.map((skill) => skill.toLowerCase());
    // A skill that the goal literally mentions outweighs one that merely fits
    // the template: "用 Python 抓一下" is a stronger signal than "this is code work".
    const mentioned = skills.filter((skill) => skill.length > 1 && hintText.includes(skill)).length;
    const matched = skills.filter((skill) => wanted.some((entry) => skill.includes(entry))).length;
    const score = mentioned * 10 + matched;

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

/**
 * The template a goal is asking for, from an event payload or the goal text.
 *
 * Ops is checked first on purpose: 「部署脚本」 is ops work that happens to say
 * 脚本, and the more specific signal should win over the more common word.
 */
export function inferTemplate(text: string): WorkerTemplate {
  const value = text.toLowerCase();
  const opsHits = ['部署', '运维', '定时', '巡检', 'automation', 'deploy', 'cron'];
  if (opsHits.some((hit) => value.includes(hit))) return 'ops';
  const codeHits = ['代码', '脚本', '程序', '接口', 'api', 'bug', '报错', '测试', 'code', 'script', 'build'];
  if (codeHits.some((hit) => value.includes(hit))) return 'code';
  return 'research';
}
