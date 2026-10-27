import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { NetworkProxyService, type SecretCipher } from './proxyService';
import type { ResolvedProxy } from './proxyConfig';

/**
 * The proxy config against a real SQLite file.
 *
 * What matters is that the secret never leaves the main process, that the three
 * password states survive a round-trip, and that a saved config is applied — plus
 * that no failure mode (corrupt row, missing keyring) can take networking down.
 */

/** Stand-in for `safeStorage`: reversible, obviously not encrypted, test-only. */
const cipher: SecretCipher = {
  encrypt: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decrypt: (payload) => {
    const text = payload.toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('bad ciphertext');
    return text.slice(4);
  },
};

let dir: string;
let db: CompanyDatabase;
let applied: ResolvedProxy[];
let service: NetworkProxyService;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'opc-proxy-'));
  db = openCompanyDatabase(path.join(dir, 'company.db'));
  applied = [];
  service = new NetworkProxyService(db, {
    cipher,
    apply: async (config) => {
      applied.push(config);
    },
    now: () => 1_700_000_000_000,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('NetworkProxyService', () => {
  it('starts on the system proxy with no server', () => {
    const config = service.get();
    expect(config.mode).toBe('system');
    expect(config.host).toBe('');
    expect(config.hasPassword).toBe(false);
  });

  it('persists a manual config and applies it', async () => {
    const saved = await service.update({
      mode: 'manual',
      protocol: 'socks5',
      host: 'http://127.0.0.1:1080',
      port: 1080,
      username: '',
      bypass: 'a.com, b.com a.com',
    });

    expect(saved).toMatchObject({ mode: 'manual', protocol: 'socks5', host: '127.0.0.1', port: 1080, bypass: 'a.com,b.com' });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ mode: 'manual', host: '127.0.0.1', port: 1080 });
  });

  it('stores the password encrypted and never returns it', async () => {
    await service.update({ mode: 'manual', protocol: 'http', host: 'p.corp', port: 3128, username: 'boss', password: 's3cret', bypass: '' });

    const row = db.prepare("SELECT value FROM app_setting WHERE key = 'network.proxyPassword'").get() as {
      value: string;
    };
    expect(Buffer.from(row.value, 'base64').toString('utf8')).toBe('enc:s3cret');
    expect(service.get().hasPassword).toBe(true);
    expect(service.resolve().password).toBe('s3cret');
    expect(JSON.stringify(service.get())).not.toContain('s3cret');
  });

  it('keeps a stored password when the field is omitted, clears it with an empty string', async () => {
    const base = { mode: 'manual' as const, protocol: 'http' as const, host: 'p.corp', port: 3128, username: 'boss', bypass: '' };
    await service.update({ ...base, password: 's3cret' });

    await service.update({ ...base, username: 'boss2' });
    expect(service.resolve()).toMatchObject({ username: 'boss2', password: 's3cret' });

    await service.update({ ...base, password: '' });
    expect(service.get().hasPassword).toBe(false);
    expect(service.resolve().password).toBe('');
  });

  it('refuses to save a half-typed manual server', async () => {
    await expect(
      service.update({ mode: 'manual', protocol: 'http', host: '', port: 0, username: '', bypass: '' }),
    ).rejects.toThrow();
    expect(applied).toHaveLength(0);
    expect(service.get().mode).toBe('system');
  });

  it('does not write the config when the keyring is unavailable', async () => {
    const failing = new NetworkProxyService(db, {
      cipher: {
        encrypt: () => {
          throw new Error('当前系统密钥环不可用');
        },
        decrypt: cipher.decrypt,
      },
      apply: async () => undefined,
    });

    await expect(
      failing.update({ mode: 'manual', protocol: 'http', host: 'p.corp', port: 3128, username: 'b', password: 'x', bypass: '' }),
    ).rejects.toThrow('密钥环');
    expect(service.get().mode).toBe('system');
  });

  it('reports a saved config that failed to apply, without losing it', async () => {
    const failing = new NetworkProxyService(db, {
      cipher,
      apply: async () => {
        throw new Error('proxy rules rejected');
      },
    });

    await expect(
      failing.update({ mode: 'manual', protocol: 'http', host: 'p.corp', port: 3128, username: '', bypass: '' }),
    ).rejects.toThrow('已保存');
    expect(failing.get().mode).toBe('manual');
  });

  it('falls back to the defaults instead of throwing on a corrupt row', () => {
    db.prepare('INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)').run(
      'network.proxy',
      '{not json',
      Date.now(),
    );
    expect(service.get()).toMatchObject({ mode: 'system', port: 7890 });
  });

  it('treats an undecryptable password as no password', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    db.prepare('INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)').run(
      'network.proxyPassword',
      Buffer.from('plaintext').toString('base64'),
      Date.now(),
    );
    expect(service.get().hasPassword).toBe(false);
    expect(service.resolve().password).toBe('');
    warn.mockRestore();
  });

  it('builds a test candidate from the draft, borrowing the stored secret', async () => {
    await service.update({ mode: 'manual', protocol: 'http', host: 'p.corp', port: 3128, username: 'boss', password: 's3cret', bypass: '' });

    const candidate = service.candidate({ mode: 'manual', protocol: 'http', host: 'q.corp', port: 8080, username: 'boss', bypass: '' });
    expect(candidate).toMatchObject({ host: 'q.corp', port: 8080, password: 's3cret', hasPassword: true });
    // Testing must not persist anything.
    expect(service.get().host).toBe('p.corp');
  });
});
