import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // VS Code 1.85 (engines.vscode) runs Node 18.15; the type definitions accept these newer APIs
      'no-restricted-properties': ['error',
        { object: 'AbortSignal', property: 'any', message: 'VS Code 1.85 runs Node 18.15, which has no AbortSignal.any: link the signals by hand.' },
        { object: 'Promise', property: 'withResolvers', message: 'VS Code 1.85 runs Node 18.15, which has no Promise.withResolvers.' },
      ],
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'test/', '*.js', '*.mjs'],
  },
];
