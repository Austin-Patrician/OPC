import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

/**
 * One Electron app built from three roots:
 *   apps/main/src/index.ts   → out/main     (Node, CommonJS)
 *   apps/main/src/preload.ts → out/preload  (sandbox-compatible CommonJS)
 *   apps/renderer            → out/renderer (React UI; never deployed as a website)
 *
 * `@opc/shared` is workspace source and must be bundled, not externalized.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@opc/shared'] })],
    build: {
      outDir: resolve(__dirname, 'out/main'),
      rollupOptions: { input: resolve(__dirname, 'apps/main/src/index.ts') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@opc/shared'] })],
    build: {
      outDir: resolve(__dirname, 'out/preload'),
      // A sandboxed preload cannot be an ES module.
      rollupOptions: {
        input: resolve(__dirname, 'apps/main/src/preload.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'apps/renderer'),
    resolve: {
      alias: { '@': resolve(__dirname, 'apps/renderer/src') },
    },
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      target: 'es2022',
      // electron-vite leaves renderer minification off by default; the shipped
      // bundle must be minified (it was 665 kB unminified before).
      minify: true,
      sourcemap: false,
      rollupOptions: {
        input: resolve(__dirname, 'apps/renderer/index.html'),
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('i18next')) return 'i18n';
            if (/react(-dom|-router)?\//.test(id)) return 'react';
            return 'vendor';
          },
        },
      },
    },
  },
});
