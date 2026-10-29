import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { PiExtensionHost } from './host';
import type { LoadedPiExtension } from './shim';

/**
 * The host decides when third-party code runs, so these tests pin the two
 * promises the UI makes: scanning never imports, and enabling needs trust.
 */

let root: string;
let home: string;
let project: string;
let userData: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'opc-ext-'));
  home = path.join(root, 'home');
  project = path.join(root, 'project');
  userData = path.join(root, 'userData');
  mkdirSync(path.join(home, '.pi', 'agent', 'extensions'), { recursive: true });
  mkdirSync(path.join(project, '.pi', 'extensions'), { recursive: true });
  mkdirSync(userData, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A loader that records calls and returns one no-op tool named after the entry. */
function fakeLoader() {
  const calls: string[] = [];
  const load = async (entry: string, options: { name: string }): Promise<LoadedPiExtension> => {
    calls.push(entry);
    return {
      extension: defineExtension({
        name: options.name,
        tools: [
          defineTool({
            name: 'echo',
            description: 'echo',
            parameters: Type.Object({ text: Type.String() }),
            execute: async () => ({ output: [{ type: 'text' as const, text: 'ok' }] }),
          }),
        ],
      }),
      tools: ['echo'],
      events: ['tool_call'],
      commands: [],
      unsupported: ['event:session_start'],
    };
  };
  return { load, calls };
}

function writeExtension(scope: 'global' | 'project', name: string) {
  const base =
    scope === 'global'
      ? path.join(home, '.pi', 'agent', 'extensions')
      : path.join(project, '.pi', 'extensions');
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.ts'), 'export default function () {}\n');
  // A directory extension is identified by the directory, not by its entry file.
  return dir;
}

const host = (load = fakeLoader().load) =>
  new PiExtensionHost({ userDataDir: userData, homeDir: home, projectDir: project, load });

describe('PiExtensionHost', () => {
  it('lists discovered extensions without importing them', async () => {
    writeExtension('global', 'alpha');
    const { load, calls } = fakeLoader();
    const instance = host(load);

    const catalog = await instance.list();

    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]).toMatchObject({
      name: 'alpha',
      scope: 'global',
      enabled: false,
      trusted: false,
      loaded: false,
      tools: [],
    });
    expect(calls).toEqual([]);
    expect(instance.slots()).toEqual([]);
  });

  it('refuses to enable without explicit trust', async () => {
    writeExtension('global', 'alpha');
    const instance = host();
    const [entry] = (await instance.list()).entries;

    await expect(instance.setEnabled(entry!.id, true)).rejects.toThrow(/信任/);
    expect(instance.slots()).toEqual([]);
  });

  it('loads a trusted extension and exposes it under a stable registry name', async () => {
    writeExtension('global', 'alpha-tools');
    const { load, calls } = fakeLoader();
    const instance = host(load);
    const [entry] = (await instance.list()).entries;

    const catalog = await instance.setEnabled(entry!.id, true, true);

    expect(calls).toEqual([entry!.entry]);
    expect(catalog.entries[0]).toMatchObject({
      enabled: true,
      trusted: true,
      loaded: true,
      tools: ['echo'],
      events: ['tool_call'],
      unsupported: ['event:session_start'],
    });
    expect(instance.slots().map((slot) => slot.name)).toEqual(['pi.alpha-tools']);
    expect(instance.slots()[0]?.extension.name).toBe('pi.alpha-tools');
  });

  it('remembers the choice across restarts without re-trusting', async () => {
    writeExtension('global', 'alpha');
    const first = host();
    const [entry] = (await first.list()).entries;
    await first.setEnabled(entry!.id, true, true);

    const restarted = host();
    await restarted.ensureLoaded();

    expect(restarted.slots().map((slot) => slot.name)).toEqual(['pi.alpha']);
    const [view] = (await restarted.list()).entries;
    expect(view).toMatchObject({ enabled: true, trusted: true, loaded: true });
  });

  it('drops the slot when disabled', async () => {
    writeExtension('global', 'alpha');
    const instance = host();
    const [entry] = (await instance.list()).entries;
    await instance.setEnabled(entry!.id, true, true);
    expect(instance.slots()).toHaveLength(1);

    const catalog = await instance.setEnabled(entry!.id, false);

    expect(instance.slots()).toEqual([]);
    expect(catalog.entries[0]).toMatchObject({ enabled: false, loaded: false });
  });

  it('keeps a broken extension enabled and surfaces the import error', async () => {
    writeExtension('global', 'broken');
    const instance = host(async () => {
      throw new Error('boom');
    });
    const [entry] = (await instance.list()).entries;

    const catalog = await instance.setEnabled(entry!.id, true, true);

    expect(catalog.entries[0]).toMatchObject({ enabled: true, loaded: false, error: 'boom' });
    expect(instance.slots()).toEqual([]);
  });

  it('deduplicates registry names so two same-named extensions both install', async () => {
    writeExtension('global', 'same');
    writeExtension('project', 'same');
    const instance = host();
    for (const entry of (await instance.list()).entries) {
      await instance.setEnabled(entry.id, true, true);
    }

    expect(instance.slots().map((slot) => slot.name).sort()).toEqual(['pi.same', 'pi.same-2']);
  });

  it('reports a human error for an id that no longer exists', async () => {
    const instance = host();
    await expect(instance.setEnabled(path.join(root, 'gone.ts'), true, true)).rejects.toThrow(/扩展不存在/);
  });

  it('forgets an id whose folder was removed, including its trust', async () => {
    const dir = writeExtension('global', 'temporary');
    const instance = host();
    const [entry] = (await instance.list()).entries;
    await instance.setEnabled(entry!.id, true, true);

    rmSync(dir, { recursive: true, force: true });
    await instance.list();

    const store = JSON.parse(readFileSync(path.join(userData, 'pi-extensions.json'), 'utf8'));
    expect(store).toEqual({ version: 1, enabled: [], trusted: [] });

    // Re-creating the folder must not resurrect the old consent.
    writeExtension('global', 'temporary');
    const [again] = (await instance.list()).entries;
    expect(again).toMatchObject({ enabled: false, trusted: false, loaded: false });
  });
});
