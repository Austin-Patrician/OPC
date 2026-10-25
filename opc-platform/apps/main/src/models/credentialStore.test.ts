import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCredentialStore } from './credentialStore';

const dirs: string[] = [];

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-cred-'));
  dirs.push(dir);
  return new FileCredentialStore(path.join(dir, 'credentials.json'));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('FileCredentialStore', () => {
  it('persists a credential to disk and reads it back', async () => {
    const first = store();
    await first.modify('anthropic', async () => ({ type: 'api_key', key: 'sk-1' }));

    const reopened = new FileCredentialStore(firstPath(first));
    expect(await reopened.read('anthropic')).toMatchObject({ key: 'sk-1' });
  });

  it('serializes concurrent writes for one provider', async () => {
    const target = store();
    await Promise.all(
      [1, 2, 3].map((n) =>
        target.modify('a', async (current) => ({
          type: 'api_key',
          key: `${(current as { key?: string } | undefined)?.key ?? ''}${n}`,
        })),
      ),
    );

    expect((await target.read('a')) as { key?: string }).toMatchObject({ key: '123' });
  });

  it('leaves the entry unchanged when the callback returns undefined, and deletes on logout', async () => {
    const target = store();
    await target.modify('a', async () => ({ type: 'api_key', key: 'k' }));

    await target.modify('a', async () => undefined);
    expect(await target.read('a')).toMatchObject({ key: 'k' });

    await target.delete('a');
    expect(await target.read('a')).toBeUndefined();
  });

  it('lists provider ids and types without exposing secrets', async () => {
    const target = store();
    await target.modify('a', async () => ({ type: 'api_key', key: 'secret' }));
    expect(await target.list()).toEqual([{ providerId: 'a', type: 'api_key' }]);
  });
});

function firstPath(target: FileCredentialStore): string {
  // The store's file path is private; reconstruct it from the temp dir it lives in.
  const anyTarget = target as unknown as { file: string };
  return anyTarget.file;
}
