import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase } from '../data/companyDatabase';
import { DEFAULT_SHELL_EXECUTION_SETTINGS, ShellExecutionSettingsStore } from './settings';

describe('ShellExecutionSettingsStore', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opc-shell-settings-'));
    dirs.push(dir);
    const db = openCompanyDatabase(path.join(dir, 'company.sqlite'));
    return { db, store: new ShellExecutionSettingsStore(db) };
  }

  it('defaults to ask and persists auto / disabled modes', () => {
    const { db, store } = makeStore();
    try {
      expect(store.get()).toEqual(DEFAULT_SHELL_EXECUTION_SETTINGS);
      expect(store.set({ windowsMode: 'auto' })).toEqual({ windowsMode: 'auto' });
      expect(store.get()).toEqual({ windowsMode: 'auto' });
      expect(store.set({ windowsMode: 'disabled' })).toEqual({ windowsMode: 'disabled' });
      expect(store.status().settings).toEqual({ windowsMode: 'disabled' });

      // Corrupt JSON falls back safely to default `ask`.
      db.prepare('UPDATE app_setting SET value = ? WHERE key = ?').run('{bad-json', 'sandbox.shellExecution');
      expect(store.get()).toEqual({ windowsMode: 'ask' });
    } finally {
      db.close();
    }
  });
});
