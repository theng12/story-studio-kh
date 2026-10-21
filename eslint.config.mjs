import js from '@eslint/js'
import ts from 'typescript-eslint'

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.nuxt/**', '**/.output/**', 'frontend/**', 'bundled/**', 'electron/server/__tests__/**'],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: ['./electron/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
      'no-control-regex': 'warn',
      'no-irregular-whitespace': 'warn',
      'no-misleading-character-class': 'warn',
      'prefer-const': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
  {
    // Pure ESM modules shared with node release scripts; not part of the typed tsconfig.json program (hand-written .d.ts siblings).
    files: ['electron/server/lib/final-render-strict-json.js', 'electron/server/lib/final-render-provenance-contract.js'],
    languageOptions: { parserOptions: { project: false }, globals: { Buffer: 'readonly', TextDecoder: 'readonly' } },
    rules: ts.configs.disableTypeChecked.rules,
  },
]
