import { copyFileSync } from 'node:fs';
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
    plugins: [
      // `@earendil-works/pi-mcp` is ESM-only (its `exports` has no `require` condition),
      // and the main bundle is CommonJS. Leave it out of the external list so Rollup
      // compiles it in; requiring it at runtime fails with "No exports main defined".
      externalizeDepsPlugin({ exclude: ['@opc/shared', '@earendil-works/pi-mcp'] }),
      {
        // The smoke script is read at runtime, not bundled: ship it verbatim next to
        // the main bundle so `loadSmokeScript()` works in dev and in the packaged app.
        name: 'copy-smoke-script',
        closeBundle() {
          copyFileSync(
            resolve(__dirname, 'apps/main/src/smoke/smokeScript.js'),
            resolve(__dirname, 'out/main/smokeScript.js'),
          );
        },
      },
    ],
    build: {
      outDir: resolve(__dirname, 'out/main'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'apps/main/src/index.ts'),
          // Watchdog 是**独立进程**（`docs/v2/11-watchdog-spec.md` W2），所以它
          // 需要自己的入口文件：`utilityProcess.fork` 加载的是磁盘上的一个文件，
          // 不是主 bundle 里的一个函数。
          watchdog: resolve(__dirname, 'apps/main/src/watchdog/child.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@opc/shared'] })],
    build: {
      outDir: resolve(__dirname, 'out/preload'),
      // A sandboxed preload cannot be an ES module.
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'apps/main/src/preload.ts'),
          ocr: resolve(__dirname, 'apps/main/src/ocrPreload.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'apps/renderer'),
    resolve: {
      alias: { '@': resolve(__dirname, 'apps/renderer/src') },
      // `onnxruntime-web` ships a bundled build that inlines a `new URL(...wasm)`
      // reference; bundlers then emit a second 23 MB copy of the binary. The
      // extern-wasm build reads `ort.env.wasm.wasmPaths` only, which we point at
      // `opc-ocr://app/ort/` (the copy in resources/ocr).
      conditions: ['onnxruntime-web-use-extern-wasm', 'module', 'browser', 'development|production'],
    },
    plugins: [react(), tailwindcss()],
    // The OCR page loads ~5 MB of ESM (ONNX Runtime + the OCR pipeline). Pre-
    // bundling it makes the first dev call slower than loading it as-is.
    optimizeDeps: {
      exclude: ['onnxruntime-web', 'ppu-paddle-ocr', 'ppu-ocv'],
    },
    worker: { format: 'es' },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      target: 'es2022',
      // electron-vite leaves renderer minification off by default; the shipped
      // bundle must be minified (it was 665 kB unminified before).
      minify: true,
      sourcemap: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'apps/renderer/index.html'),
          ocr: resolve(__dirname, 'apps/renderer/ocr.html'),
        },
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
