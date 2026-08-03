// @ts-check

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/*.d.ts',
    ],
  },
  {
    files: [
      'packages/orchestrator/**/*.ts',
      'packages/context-engine/**/*.ts',
      'packages/memory/**/*.ts',
      'packages/orchestrator-postgres/**/*.ts',
      'packages/eval/**/*.ts',
    ],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: [
      'packages/orchestrator/**/test/**/*.ts',
      'packages/context-engine/**/test/**/*.ts',
      'packages/memory/**/test/**/*.ts',
      'packages/orchestrator-postgres/**/test/**/*.ts',
      'packages/eval/**/test/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
