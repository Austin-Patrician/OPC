import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { CompanyService, DEFAULT_BOSS_NAME, DEFAULT_COMPANY_COLOR } from './companyService';

/**
 * The company profile against a real SQLite file.
 *
 * What matters is where each field ends up: name/industry must be `company` columns
 * (business data), the rest `app_setting` rows — and a patch must never clobber the
 * fields it did not mention. Launching Electron is the only other way to see this.
 */
let dir: string;
let db: CompanyDatabase;
let company: CompanyService;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-company-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  company = new CompanyService(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('CompanyService', () => {
  it('reads the seeded row with profile defaults', () => {
    const profile = company.get();
    expect(profile.id).toBe('company-local');
    expect(profile.name).toBe('我的公司');
    expect(profile.industry).toBe('');
    expect(profile.bossName).toBe(DEFAULT_BOSS_NAME);
    expect(profile.colorId).toBe(DEFAULT_COMPANY_COLOR);
  });

  it('writes name and industry into the company row', () => {
    const updated = company.update({ name: '星河内容工作室', industry: 'content' });
    expect(updated.name).toBe('星河内容工作室');
    expect(updated.industry).toBe('content');

    const row = db.prepare('SELECT name, industry FROM company WHERE id = ?').get('company-local') as {
      name: string;
      industry: string;
    };
    expect(row).toEqual({ name: '星河内容工作室', industry: 'content' });
  });

  it('keeps vision and brand colour in app_setting, and the boss in app_user', () => {
    company.update({ name: '星河', vision: '做内容工厂', colorId: 'violet', bossName: '阿星' });
    const afterName = company.update({ name: '星河工作室' });

    expect(afterName.name).toBe('星河工作室');
    // Untouched fields survive a later patch.
    expect(afterName.vision).toBe('做内容工厂');
    expect(afterName.colorId).toBe('violet');
    expect(afterName.bossName).toBe('阿星');

    // Presentation lives in app_setting…
    const keys = db
      .prepare("SELECT key FROM app_setting WHERE key LIKE 'profile.%' ORDER BY key")
      .all() as { key: string }[];
    expect(keys.map((entry) => entry.key)).toEqual(['profile.colorId', 'profile.vision']);

    // …but the human is a row, so a preferences reset cannot wipe their name.
    const boss = db.prepare('SELECT id, name FROM app_user').all() as { id: string; name: string }[];
    expect(boss).toEqual([{ id: 'boss', name: '阿星' }]);
  });

  it('has exactly one human, enforced by the schema', () => {
    // The product decision is "one company, one human", so it is a constraint rather
    // than a convention: a second user row cannot be inserted at all.
    expect(() =>
      db
        .prepare('INSERT INTO app_user (id, name, avatar, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('user-2', '另一个人类', '', Date.now(), Date.now()),
    ).toThrow(/CHECK constraint failed/);

    expect((db.prepare('SELECT COUNT(*) AS n FROM app_user').get() as { n: number }).n).toBe(1);
  });

  it('brings a hand-deleted boss row back instead of failing the write', () => {
    db.exec('DELETE FROM app_user');
    expect(company.get().bossName).toBe(DEFAULT_BOSS_NAME);

    const updated = company.update({ bossName: '阿星' });

    expect(updated.bossName).toBe('阿星');
    expect(company.boss()).toEqual({ id: 'boss', name: '阿星', avatar: '' });
  });

  it('survives a reopen: the profile is not renderer state', () => {
    company.update({ name: '持久化公司', bossName: '老张' });
    const file = path.join(dir, 'company.db');
    db.close();
    db = openCompanyDatabase(file);

    const reopened = new CompanyService(db).get();
    expect(reopened.name).toBe('持久化公司');
    expect(reopened.bossName).toBe('老张');
  });

  it('clamps input instead of trusting the renderer', () => {
    const updated = company.update({
      name: `  ${'长'.repeat(60)}\n  `,
      bossName: '   ',
      vision: 'v'.repeat(200),
    });

    expect(updated.name).toHaveLength(40);
    expect(updated.name).not.toContain('\n');
    // A blank boss name falls back rather than leaving the title bar empty.
    expect(updated.bossName).toBe(DEFAULT_BOSS_NAME);
    expect(updated.vision).toHaveLength(60);
  });

  it('stores uploaded logos as validated data URLs only', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const svg = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
    company.update({ logo: png, bossAvatar: svg });

    const stored = company.get();
    expect(stored.logo).toBe(png);
    expect(stored.bossAvatar).toBe(svg);

    // Unrelated patches keep both uploads.
    const renamed = company.update({ name: '带 Logo 的公司' });
    expect(renamed.logo).toBe(png);
    expect(renamed.bossAvatar).toBe(svg);

    // Remote/script URLs and oversized payloads are refused, not stored.
    company.update({ logo: 'https://example.com/a.png' });
    expect(company.get().logo).toBeUndefined();
    company.update({ logo: `data:image/png;base64,${'A'.repeat(700_000)}` });
    expect(company.get().logo).toBeUndefined();
  });
});
