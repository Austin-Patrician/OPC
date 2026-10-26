import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Architecture is enforced here, not by convention.
 *
 * Renderer layering:  app → pages → widgets → features → entities → shared
 * Process boundary:   renderer may not import Electron/Node/native modules; the
 *                     main process may not import the renderer; `packages/*` may
 *                     not import either app.
 */
const FORBIDDEN_IN_RENDERER = [
  'electron',
  'electron/*',
  'node:*',
  'fs',
  'fs/*',
  'path',
  'child_process',
  'better-sqlite3',
  'sqlite-vec',
  '@earendil-works/*',
];

const layerRules = [
  {
    files: ['apps/renderer/src/shared/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/entities/*', '@/features/*', '@/widgets/*', '@/pages/*', '@/app/*'],
              allowTypeImports: true,
              message: 'shared/ 必须位于依赖图最底层。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/renderer/src/entities/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/*', '@/widgets/*', '@/pages/*', '@/app/*'],
              allowTypeImports: true,
              message: 'entities/ 只能依赖 shared/。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/renderer/src/features/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/widgets/*', '@/pages/*', '@/app/*'],
              allowTypeImports: true,
              message: 'features/ 只能依赖 entities/ 与 shared/。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/renderer/src/widgets/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/pages/*', '@/app/*'],
              allowTypeImports: true,
              message: 'widgets/ 只能依赖 features/、entities/ 与 shared/。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/renderer/src/pages/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/app/*'],
              allowTypeImports: true,
              message: 'pages/ 由 app/ 组装，不能反向依赖。',
            },
          ],
        },
      ],
    },
  },
];

export default tseslint.config(
  { ignores: ['**/node_modules/**', 'out/**', 'release/**', 'dist/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  // The renderer must stay a pure view layer: no Node, no Electron, no native addons.
  {
    files: ['apps/renderer/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: FORBIDDEN_IN_RENDERER, message: '渲染进程只能通过 window.opc 访问主进程能力。' }] },
      ],
    },
  },
  // The main process owns OS/native access and must not reach into the UI.
  {
    files: ['apps/main/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@/*', 'react', 'react-dom', 'react-router-dom'], message: '主进程不能依赖渲染层。' }] },
      ],
    },
  },
  // Shared contracts stay dependency-free.
  {
    files: ['packages/shared/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@opc/*', '@/', 'electron', 'node:*'], message: 'packages/shared 只能包含纯类型/纯函数。' }] },
      ],
    },
  },
  ...layerRules,
  {
    // The smoke script is renderer code executed by Electron; it needs browser globals.
    files: ['apps/main/src/smoke/smokeScript.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
);
