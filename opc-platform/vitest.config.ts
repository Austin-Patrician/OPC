import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests stay scoped to pure logic (tokenizer, theme math, platform
 * detection, IPC validation). UI and native behaviour are verified by building
 * and running the real Electron app (Settings → G0 自检).
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./apps/renderer/src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: [
      'apps/renderer/src/**/*.test.ts',
      // Components are tested by rendering to static markup (react-dom/server), which
      // needs no DOM — so a `.tsx` test is still a pure-logic test.
      'apps/renderer/src/**/*.test.tsx',
      'apps/main/src/**/*.test.ts',
      'packages/**/src/**/*.test.ts',
    ],
    reporters: 'dot',
  },
});
