import { beforeEach, describe, expect, it } from 'vitest';
import { openCompanyDatabase, type CompanyDatabase } from '../data/companyDatabase';
import { DEFAULT_OCR_SETTINGS, OcrSettingsStore } from './settings';

/** The switch is a row in `app_setting`: it must survive a restart and never lie. */
let db: CompanyDatabase;
let store: OcrSettingsStore;

beforeEach(() => {
  db = openCompanyDatabase(':memory:');
  store = new OcrSettingsStore(db);
});

describe('OcrSettingsStore', () => {
  it('starts on, reading text, so a fresh install can read a picture', () => {
    expect(store.get()).toEqual(DEFAULT_OCR_SETTINGS);
    expect(store.get()).toEqual({ enabled: true, detail: 'text' });
  });

  it('persists the switch and the output shape', () => {
    expect(store.set({ enabled: false, detail: 'lines' })).toEqual({
      enabled: false,
      detail: 'lines',
    });

    // A new instance reads the same row, exactly as the next boot would.
    expect(new OcrSettingsStore(db).get()).toEqual({ enabled: false, detail: 'lines' });
  });

  it('falls back to the defaults instead of trusting a hand-edited row', () => {
    db.prepare('INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)').run(
      'ocr',
      '{"enabled":"yes","detail":"paragraphs"}',
      Date.now(),
    );
    expect(store.get()).toEqual({ enabled: true, detail: 'text' });

    db.prepare('UPDATE app_setting SET value = ? WHERE key = ?').run('not json', 'ocr');
    expect(store.get()).toEqual(DEFAULT_OCR_SETTINGS);
  });
});
