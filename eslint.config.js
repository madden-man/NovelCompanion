import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules',
      'out',
      'dist',
      'release',
      'coverage',
      'source-material',
      'mockups',
      'test-results',
      'playwright-report',
      '.claude',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^_', argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // A58: the handler table runs where Electron cannot, so only the host and the Electron
    // entry files may import Electron, the keychain or the Agent SDK.
    files: ['src/**/*.{ts,tsx}', 'netlify/**/*.mts'],
    ignores: [
      'src/main/host/electron.ts',
      'src/main/index.ts',
      'src/main/csp.ts',
      'src/main/ipc/handle.ts',
      'src/main/secrets.ts',
      'src/main/claude/keys.ts',
      'src/main/claude/sdk.ts',
      'src/preload/index.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['electron', '@napi-rs/keyring', '@anthropic-ai/claude-agent-sdk'].map((name) => ({
            name,
            message: 'Only the host files may import this (A58). Reach it through Host.',
          })),
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
