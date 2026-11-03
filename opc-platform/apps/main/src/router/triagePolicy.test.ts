import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_TRIAGE_POLICY } from '@opc/shared/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { normalizeTriagePolicy, TriagePolicyStore } from './triagePolicy';

/**
 * 策略本身。它读的是一份可能被手改过、被旧版本写过、被未来版本写过的东西，
 * 所以这里的重点是**坏输入不能让调度停摆**：识别不了就退回默认。
 */
let dir: string;
let db: CompanyDatabase;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-triage-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('两层过滤的配置', () => {
  it('什么都没配时就是默认：只挡噪声、语义层交给 Router', () => {
    expect(normalizeTriagePolicy(undefined)).toEqual(DEFAULT_TRIAGE_POLICY);
    expect(normalizeTriagePolicy('不是对象')).toEqual(DEFAULT_TRIAGE_POLICY);
  });

  it('坏值逐项兜底，不会因为一个字段毁掉整份配置', () => {
    const normalized = normalizeTriagePolicy({
      fastPath: 'whatever',
      semantic: 'gpt',
      noiseThreshold: 12,
      sources: ['im', '不存在的来源'],
    });
    expect(normalized.fastPath).toBe('noise');
    expect(normalized.semantic).toBe('router');
    // 阈值被夹回可用区间，而不是把 12 当成"永远丢掉"。
    expect(normalized.noiseThreshold).toBe(0.95);
    expect(normalized.sources).toEqual(['im']);
  });

  it('空名单等于没配——它不能变成"什么都不放行"', () => {
    expect(normalizeTriagePolicy({ fastPath: 'allowlist', sources: [] }).sources).toEqual(
      DEFAULT_TRIAGE_POLICY.sources,
    );
  });

  it('写进库、再读回来是同一份；没提到的字段保持原值', () => {
    const store = new TriagePolicyStore(db);
    expect(store.get()).toEqual(DEFAULT_TRIAGE_POLICY);

    store.set({ semantic: 'decision', noiseThreshold: 0.8 });
    expect(store.get()).toMatchObject({ semantic: 'decision', noiseThreshold: 0.8 });

    // 部分更新：只换程序层，语义层那两行不动。
    store.set({ fastPath: 'allowlist', sources: ['folder'] });
    expect(store.get()).toMatchObject({
      fastPath: 'allowlist',
      sources: ['folder'],
      semantic: 'decision',
      noiseThreshold: 0.8,
    });
  });

  it('库里存了坏 JSON 时退回默认，而不是让调度抛异常', () => {
    db.prepare(
      "INSERT INTO app_setting (key, value, updated_at) VALUES ('router.triage', '{坏', 1)",
    ).run();
    expect(new TriagePolicyStore(db).get()).toEqual(DEFAULT_TRIAGE_POLICY);
  });
});
