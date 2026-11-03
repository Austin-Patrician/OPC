import { DEFAULT_TRIAGE_POLICY, type TriagePolicy, type TriggerEvent } from '@opc/shared/domain';
import { describe, expect, it } from 'vitest';
import { bodyOf, createFastPath } from './triage';

/**
 * 程序层（§3.1 Fast Path）。
 *
 * 这一层挡错东西的代价是**丢活**，所以用例的重点不是"它挡得住"，而是
 * 「它只挡确定是噪声的」。下面每一条都在说清一件事为什么确定不是活。
 */
function event(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    id: 'evt-1',
    source: 'folder',
    kind: 'folder.added',
    payload: { path: 'inbox/a.md' },
    threadId: null,
    triage: 'pending',
    createdAt: 0,
    triagedAt: null,
    ...overrides,
  };
}

const policy = (patch: Partial<TriagePolicy> = {}) => (): TriagePolicy => ({
  ...DEFAULT_TRIAGE_POLICY,
  ...patch,
});

describe('程序层过滤', () => {
  it('自己的产出回环不算新工作', () => {
    const keep = createFastPath({ policy: policy() });
    expect(keep(event({ payload: { path: 'out/report.md', origin: 'self' } }))).toBe('drop');
  });

  it('没有正文可判的事件不交给模型', () => {
    const keep = createFastPath({ policy: policy() });
    expect(keep(event({ payload: {} }))).toBe('drop');
    // 只有线程身份、没有内容的也算空。
    expect(keep(event({ payload: { threadKey: 'folder:inbox/a.md' } }))).toBe('drop');
  });

  it('同一份文件在一分钟内被 touch 两次，只算一次', () => {
    let clock = 1_000;
    const keep = createFastPath({ policy: policy(), now: () => clock });
    expect(keep(event())).toBe('keep');
    clock += 5_000;
    expect(keep(event())).toBe('drop');
    // 窗口过去之后它是新事件了（人可能在那一刻又改了一次）。
    clock += 60_000;
    expect(keep(event())).toBe('keep');
  });

  it('人说的话不去重——连发两条"在吗"就是两条', () => {
    const keep = createFastPath({ policy: policy() });
    const said = () => event({ source: 'im', kind: 'user_message', payload: { text: '在吗' } });
    expect(keep(said())).toBe('keep');
    expect(keep(said())).toBe('keep');
  });

  it('默认不按来源挡：没登记的来源（日历、GitHub）照样进来', () => {
    const keep = createFastPath({ policy: policy() });
    expect(keep(event({ source: 'github', kind: 'pr.opened' }))).toBe('keep');
    expect(keep(event({ source: 'calendar', kind: 'meeting.soon' }))).toBe('keep');
  });

  it('名单模式下只放行登记过的来源', () => {
    const keep = createFastPath({
      policy: policy({ fastPath: 'allowlist', sources: ['folder'] }),
    });
    expect(keep(event({ source: 'folder' }))).toBe('keep');
    expect(keep(event({ source: 'github', kind: 'pr.opened' }))).toBe('drop');
  });

  it('指纹表不会无限长大：窗口外的旧指纹会被清掉', () => {
    let clock = 0;
    const keep = createFastPath({ policy: policy(), now: () => clock, repeatWindowMs: 1_000 });
    for (let index = 0; index < 600; index += 1) {
      clock += 10;
      keep(event({ payload: { path: `inbox/${index}.md` } }));
    }
    // 走到这里不炸、也不因为表满而把新的判成重复，就是它该做的事。
    expect(keep(event({ payload: { path: 'inbox/last.md' } }))).toBe('keep');
  });
});

describe('事件正文的取法', () => {
  it('按约定字段取，取不到就序列化剩下的部分', () => {
    expect(bodyOf({ text: ' 说话 ' })).toBe('说话');
    expect(bodyOf({ goal: '整理财报' })).toBe('整理财报');
    expect(bodyOf({ path: 'inbox/a.md' })).toBe('inbox/a.md');
    // threadKey / origin 是信封，不是内容。
    expect(bodyOf({ threadKey: 'k', origin: 'self' })).toBe('');
    expect(bodyOf({ count: 3 })).toBe('{"count":3}');
  });
});
