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
    files: ['packages/context-engine/**/*.ts'],
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
    files: ['packages/context-engine/**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
