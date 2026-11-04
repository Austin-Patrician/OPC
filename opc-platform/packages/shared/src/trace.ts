import type { TaskTrace } from './domain';

/**
 * 动作流的**渲染**（`09-worker-spec.md` §3.4）。
 *
 * 放在 shared 而不是主进程里：同一段痕迹要给三个地方看——界面（它现在在干什么）、
 * Router 的 `recall`（我问它一句答得上来）、以及事后读库的人。三处各写一份格式化，
 * 迟早会出现"界面显示略去 12 步、recall 显示略去 0 步"。
 *
 * 这里只做文本，不碰数据形状：裁剪是主进程的事，渲染只负责让空洞**看得出来**。
 */

/** 一条动作的一行表示：`12:03:41 ✓ tool/bash — node --test（820ms）`。 */
export function describeTrace(row: TaskTrace): string {
  const when = new Date(row.at).toISOString().slice(11, 19);
  const flag = row.ok === null ? '·' : row.ok ? '✓' : '✗';
  const cost = [
    row.ms === undefined ? '' : `${row.ms}ms`,
    row.tokens === undefined ? '' : `${row.tokens} tokens`,
  ]
    .filter((part) => part.length > 0)
    .join(' · ');
  return (
    `${when} ${flag} ${row.kind}/${row.name}` +
    (row.argsDigest ? ` — ${row.argsDigest}` : '') +
    (cost ? `（${cost}）` : '')
  );
}

/**
 * 一串动作，按发生顺序。
 *
 * `seq` 的空洞折成一行「略去 N 步」：裁剪过之后，中间那一段是真的存在过、只是没留，
 * 静默跳过会让读的人以为"它一直没动"。
 */
export function renderTrace(rows: readonly TaskTrace[]): string[] {
  const lines: string[] = [];
  let previous: TaskTrace | null = null;
  for (const row of rows) {
    if (previous && row.seq > previous.seq + 1) {
      lines.push(`…（略去 ${row.seq - previous.seq - 1} 步）…`);
    }
    lines.push(describeTrace(row));
    previous = row;
  }
  return lines;
}
