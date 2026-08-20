import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import nextPlugin from '@next/eslint-plugin-next';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'packages/database/drizzle/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Import typed config from @toran/config instead.' },
      ],
    },
  },
  // Process entry points, config parsing, scripts and tooling. These are the
  // places where reading `process` directly is correct: signal handling, exit
  // codes, and the one module whose job is to parse the environment.
  {
    files: [
      'packages/config/**/*.ts',
      'scripts/**/*.mjs',
      '**/*.config.{ts,mts,mjs,js}',
      'apps/worker/src/main.ts',
      'apps/worker/src/cli/**/*.ts',
      'packages/database/src/scripts/**/*.ts',
      'apps/**/instrumentation.ts',
    ],
    rules: {
      'no-restricted-globals': 'off',
      'no-console': 'off',
    },
  },
  // Browser / React surface.
  {
    files: ['apps/web/src/**/*.{ts,tsx}', 'packages/ui/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-globals': 'off',
    },
  },
  // Next.js rules apply only to the Next.js app. `@toran/ui` is a plain React
  // library with no pages directory, and the plugin warns about its absence.
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
  // Tests and the harnesses they share. `**/testing/**` is test infrastructure,
  // not shipped code: it reads test-runner switches such as
  // TORAN_REQUIRE_INTEGRATION, which are deliberately not part of ToranConfig.
  {
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/tests/**/*.ts',
      '**/testing/**/*.ts',
      '**/e2e/**/*.ts',
    ],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-console': 'off',
      'no-restricted-globals': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
  // Deliberately after `prettier`. `eslint-config-prettier` switches `curly`
  // off because it conflicts with `curly: ["error", "multi-line"]`, which lets
  // Prettier and ESLint disagree about a wrapped single statement. The "all"
  // form has no such conflict: Prettier never adds or removes braces, so this
  // only ever fixes what Prettier has no opinion about.
  //
  // These three encode the non-negotiable style rules in CLAUDE.md. They were
  // absent, which is how 416 violations of them accumulated without `npm run
  // lint` ever going red.
  {
    rules: {
      curly: ['error', 'all'],
      'no-ternary': 'error',
      'no-nested-ternary': 'error',
    },
  },
);
