import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface HarnessProbeResult {
  /** Entries visible in the root conversation after reopen. */
  entries: number;
  /** Entries this probe itself appended (kind `app.probe`). */
  probeEntries: number;
  storageFile: string;
}

/**
 * Proves the claim that makes crash recovery possible (§2.4 step 3c): an entry
 * committed to a Harness survives the Harness being closed and reopened over the
 * same SQLite file.
 *
 * It runs on a scratch file rather than the real `agents/` directory, so a failed
 * probe can never damage an employee's transcript.
 */
export async function probeHarnessPersistence(): Promise<HarnessProbeResult> {
  const dir = mkdtempSync(path.join(tmpdir(), 'opc-harness-probe-'));
  const storageFile = path.join(dir, 'probe.sqlite');

  try {
    const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
    const { Harness, createRegistry } = await import('@earendil-works/pi-durable');
    const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node');
    const { createModels } = await import('@earendil-works/pi-ai/models');

    const context = BACKGROUND_CONTEXT;
    const registry = createRegistry();
    // No tools installed: the probe tests persistence, not the model or the sandbox.
    const options = { models: createModels(), registry };

    const open = async () => {
      const harness = await Harness.open(await openNodeSqliteStorage(storageFile), options, context);
      return { harness, root: await harness.root(context) };
    };

    const first = await open();
    await first.root.submit({ type: 'write', entry: { kind: 'app.probe', data: { at: Date.now() } } }, context);
    // `close` seals admission and settles it before the storage closes.
    await first.harness.close(context);

    const second = await open();
    const page = await second.root.entries({}, 200, undefined, context);
    const result: HarnessProbeResult = {
      entries: page.items.length,
      probeEntries: page.items.filter((entry) => entry.kind === 'app.probe').length,
      storageFile,
    };
    await second.harness.close(context);

    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
