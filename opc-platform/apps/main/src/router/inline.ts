/**
 * Inline & Spill（§3.3）。
 *
 * 一句话：**把能读懂的那部分放进上下文，把剩下的留在库里，并告诉模型去哪读。**
 *
 * 这里最容易做错的是"截断"这个词。截断是"前 600 个字 + …"，它给模型的是一句被砍断
 * 的话和一个它不知道自己漏了多少的黑洞。Spill 给的是**可推断的摘要**：开头是什么、
 * 结尾是什么、一共多大、去哪读全的。
 *
 * 三条设计约束：
 *
 * 1. **预算属于"一次输入"，不属于"一条对象"**。同样的 600 字，批里有 3 条时是浪费，
 *    有 40 条时是灾难（24k 字符）。所以按条数分摊：条数越多，每条越短——这是对的，
 *    因为批很大时 Router 的首要任务是"挑出哪几条值得看"，不是把每条都读全。
 * 2. **切在行边界上**。中文正文没有空格，按字符硬切会切开词；按行切永远切在结构与
 *    结构之间。只有单行超长（一整段 markdown、一行压缩过的 JSON）才退回按字符切。
 * 3. **读侧也要限长**。`recall` 把全文倒回上下文，等于把 spill 白做了。所以取回是
 *    分页的，页与页之间用同一个 id + 页码寻址。
 *
 * **无损**：全文永远在库里（`event.payload`、`report.body`、`task.brief`）。spill 只
 * 决定"这次显示多少"，从不删除、从不总结——总结要花钱、要时间，而这件事每轮都要做。
 */

export interface InlineBudget {
  /** 一次输入里所有正文加起来的上限（字符）。 */
  total: number;
  /** 单条最少给多少：再少就只剩一句"有个东西"，那不如不给。 */
  floor: number;
  /** 单条最多给多少：批很小时也不让一条把预算吃光。 */
  ceiling: number;
}

export const DEFAULT_INLINE_BUDGET: InlineBudget = {
  total: 6_000,
  floor: 160,
  ceiling: 1_200,
};

/** 取回一页的上限。比一次输入的预算大：用户/模型明确要看，就多看一点。 */
export const RECALL_PAGE = 4_000;

/**
 * 每条对象能分到多少字符。
 *
 * 条数为 0 时给 `ceiling`（没有正文要放，别算出个 0 来）。
 */
export function perItemBudget(budget: InlineBudget, count: number): number {
  if (count <= 0) return budget.ceiling;
  const share = Math.floor(budget.total / count);
  return Math.max(budget.floor, Math.min(budget.ceiling, share));
}

/**
 * 一条正文的上下文表示。
 *
 * 放得下就原样给（不要为了"看起来统一"把短文本也砍一刀）；放不下就取头、取尾，
 * 中间标出略去了多少，末尾给出规模与读取入口。
 */
export function spillText(text: string, hint: string, budget: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= budget) return trimmed;

  const lines = trimmed.split('\n');
  const linesCount = lines.length;
  const chars = trimmed.length;

  // 单行超长：没有行边界可用。按字符切，但尾部的信息不能丢——很多日志与 webhook
  // 的结论就在最后一句。
  if (linesCount === 1) {
    const head = Math.max(1, Math.floor(budget * 0.7));
    const tail = Math.max(0, Math.floor(budget * 0.25));
    const omitted = chars - head - tail;
    return [
      trimmed.slice(0, head),
      `…（略去 ${omitted} 字）…`,
      tail > 0 ? trimmed.slice(-tail) : '',
      trailer(linesCount, chars, hint),
    ]
      .filter((part) => part.length > 0)
      .join('\n');
  }

  // 多行：头部占预算的大头，尾部留一份——结论通常不在第一行。
  const headLines = Math.max(1, Math.floor(linesCount * 0.65));
  const tailLines = Math.max(1, Math.floor(linesCount * 0.25));
  const head = takeHead(lines, headLines, Math.floor(budget * 0.72));
  // 头尾重叠时（正文只有几行，却因为单行很长被切开）从尾部让开，别把同一行印两遍。
  const overlap = Math.max(0, head.length + tailLines - linesCount);
  const tail = takeTail(lines, tailLines, Math.floor(budget * 0.22), overlap);
  const omitted = linesCount - (head.length + tail.length);

  return [
    ...head,
    omitted > 0 ? `…（略去 ${omitted} 行）…` : '',
    ...tail,
    trailer(linesCount, chars, hint),
  ]
    .filter((part) => part.length > 0)
    .join('\n');
}

/** 从开头数 `count` 行，字符不超过 `limit`。 */
function takeHead(lines: string[], count: number, limit: number): string[] {
  const picked: string[] = [];
  let used = 0;
  for (let index = 0; index < count; index += 1) {
    const line = lines[index] ?? '';
    if (used + line.length > limit && picked.length > 0) break;
    picked.push(line);
    used += line.length + 1;
  }
  return picked;
}

/**
 * 从**末尾**往回数 `count` 行，字符不超过 `limit`。
 *
 * 必须倒着数：正着数会拿到"尾部区间的开头"，而尾部区间恰恰是标题之后那几句废话。
 * 最后一行才是结论——CI 的失败原因、日志的报错、邮件的落款。
 */
function takeTail(lines: string[], count: number, limit: number, skipFromEnd = 0): string[] {
  const picked: string[] = [];
  let used = 0;
  const last = lines.length - 1 - skipFromEnd;
  for (let index = last; index >= 0 && index > last - count; index -= 1) {
    const line = lines[index] ?? '';
    if (used + line.length > limit && picked.length > 0) break;
    picked.push(line);
    used += line.length + 1;
  }
  return picked.reverse();
}

/** 规模 + 指针。两样都不能省：一个是"我漏了多少"，一个是"怎么去看"。 */
function trailer(linesCount: number, chars: number, hint: string): string {
  return `（共 ${linesCount} 行 / ${chars} 字，全文用 ${hint}）`;
}

export interface Page<T> {
  items: T[];
  /** 从 1 开始。 */
  page: number;
  pages: number;
  total: number;
}

/**
 * 按行分页。
 *
 * 按行而不是按字符：一页的边界落在两句之间，模型读到的第一句就不会是半句。
 * 一页里塞不下一行时也要塞（否则超长行会让翻页永远前进不了）。
 */
export function paginateLines(text: string, page: number, size = RECALL_PAGE): Page<string> {
  const lines = text.split('\n');
  const pages: string[] = [];
  let current: string[] = [];
  let used = 0;

  for (const line of lines) {
    if (used + line.length + 1 > size && current.length > 0) {
      pages.push(current.join('\n'));
      current = [];
      used = 0;
    }
    current.push(line);
    used += line.length + 1;
  }
  if (current.length > 0) pages.push(current.join('\n'));
  if (pages.length === 0) pages.push('');

  const index = Math.min(Math.max(1, Math.floor(page)), pages.length) - 1;
  return { items: pages, page: index + 1, pages: pages.length, total: lines.length };
}

/**
 * 取回一页并加上导航。
 *
 * 只有一页时什么都不加：给模型看"第 1/1 页"是噪音，它没有别的页可翻。
 */
export function recallView(text: string, id: string, page = 1): string {
  const paged = paginateLines(text, page);
  if (paged.pages <= 1) return paged.items[0] ?? '';
  const body = paged.items[paged.page - 1] ?? '';
  return [
    body,
    `（第 ${paged.page}/${paged.pages} 页，共 ${paged.total} 行；` +
      (paged.page < paged.pages ? `下一段用 recall ${id} ${paged.page + 1}）` : `已经是最后一段）`),
  ].join('\n');
}
