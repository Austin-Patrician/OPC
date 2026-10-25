import fs from 'node:fs';
import path from 'node:path';
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

/**
 * File-backed credential store for pi's `Models`.
 *
 * One JSON file, one credential per provider, per-provider serialization and an
 * atomic replace (write tmp + rename) so a crash cannot corrupt the file. It holds
 * whatever pi returns from `login()` — API keys and OAuth tokens alike — because
 * that is the only shape `Models.getAuth()` can consume.
 */
export class FileCredentialStore implements CredentialStore {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.load()[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.load()).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const all = this.load();
      const next = await fn(all[providerId]);
      if (next === undefined) return all[providerId];
      all[providerId] = next;
      this.save(all);
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(providerId, async () => {
      const all = this.load();
      if (!(providerId in all)) return;
      delete all[providerId];
      this.save(all);
    });
  }

  // ── internals ──────────────────────────────────────────────────────────

  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    this.chains.set(
      providerId,
      run.catch(() => undefined),
    );
    return run;
  }

  private load(): Record<string, Credential> {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, Credential>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private save(all: Record<string, Credential>): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
