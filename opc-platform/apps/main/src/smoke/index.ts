import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The end-to-end smoke script, kept as a real `.js` file instead of a template
 * literal inside `index.ts`.
 *
 * Why: the old version lived in a template string, so nothing type-checked or even
 * parsed it until Electron executed it — a stray brace in it cost several rounds of
 * debugging. It is now a normal file (lintable, unit-tested for parseability) that
 * is copied next to the bundle by `electron.vite.config.ts`.
 */
const SMOKE_SCRIPT_PATH = path.join(__dirname, 'smokeScript.js');

let cached: string | null = null;

export function loadSmokeScript(): string {
  if (cached === null) cached = readFileSync(SMOKE_SCRIPT_PATH, 'utf8');
  return cached;
}
