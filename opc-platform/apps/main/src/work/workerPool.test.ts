import { describe, expect, it } from 'vitest';
import { inferTemplate, pickWorker, type WorkerCandidate } from './workerPool';

/**
 * 「为什么是他」必须可解释。
 *
 * 在这之前派活就是「第一个在职员工」——公司里有几个人时，谁接到活看运气。
 * 这些用例把规则钉住：按模板匹配技能，目标里点名的技能优先。
 */
const people: WorkerCandidate[] = [
  { ownerId: 'emp-1', name: '李雷', skills: ['TypeScript', 'React', 'SQLite'] },
  { ownerId: 'emp-2', name: '韩梅梅', skills: ['调研', '写作', '分析'] },
  { ownerId: 'emp-3', name: '王五', skills: ['部署', '运维', '脚本'] },
];

describe('pickWorker', () => {
  it('sends code work to the engineer', () => {
    expect(pickWorker(people, 'code')?.ownerId).toBe('emp-1');
  });

  it('sends research to the writer', () => {
    expect(pickWorker(people, 'research')?.ownerId).toBe('emp-2');
  });

  it('sends ops to the person who runs things', () => {
    expect(pickWorker(people, 'ops')?.ownerId).toBe('emp-3');
  });

  it('lets a skill named in the goal outrank the template match', () => {
    // "用 Python 抓一下" should not land on the TypeScript person just because
    // the template is `code`.
    const withPython: WorkerCandidate[] = [
      { ownerId: 'emp-1', name: '李雷', skills: ['TypeScript'] },
      { ownerId: 'emp-4', name: '赵六', skills: ['Python'] },
    ];
    expect(pickWorker(withPython, 'code', '用 python 抓一下这个站点')?.ownerId).toBe('emp-4');
  });

  it('still picks someone when nobody matches: work has to happen', () => {
    const strangers: WorkerCandidate[] = [{ ownerId: 'emp-9', name: '新人', skills: ['音乐'] }];
    expect(pickWorker(strangers, 'code')?.ownerId).toBe('emp-9');
  });

  it('returns null only when there is nobody at all', () => {
    expect(pickWorker([], 'code')).toBeNull();
  });
});

describe('inferTemplate', () => {
  it('recognises code work from the wording', () => {
    expect(inferTemplate('修一下这个接口的报错')).toBe('code');
  });

  it('recognises ops work', () => {
    expect(inferTemplate('加一个每天定时巡检的部署脚本')).toBe('ops');
  });

  it('defaults to research for everything else', () => {
    expect(inferTemplate('整理这份财报，输出一页摘要')).toBe('research');
  });
});
