// SPDX-License-Identifier: MIT
import type { Config } from 'tailwindcss';

/**
 * Semantic colour tokens are declared as CSS variables in `globals.css` and
 * referenced here, so light and dark themes are a variable swap rather than a
 * `dark:` prefix on every element.
 */
const config: Config = {
  content: [
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
    '../../packages/ui/dist/**/*.js',
  ],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: 'rgb(var(--toran-surface) / <alpha-value>)',
          raised: 'rgb(var(--toran-surface-raised) / <alpha-value>)',
          sunken: 'rgb(var(--toran-surface-sunken) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--toran-ink) / <alpha-value>)',
          muted: 'rgb(var(--toran-ink-muted) / <alpha-value>)',
          subtle: 'rgb(var(--toran-ink-subtle) / <alpha-value>)',
        },
        line: 'rgb(var(--toran-line) / <alpha-value>)',
        brand: {
          50: 'rgb(var(--toran-brand-50) / <alpha-value>)',
          200: 'rgb(var(--toran-brand-200) / <alpha-value>)',
          500: 'rgb(var(--toran-brand-500) / <alpha-value>)',
          600: 'rgb(var(--toran-brand-600) / <alpha-value>)',
          700: 'rgb(var(--toran-brand-700) / <alpha-value>)',
          800: 'rgb(var(--toran-brand-800) / <alpha-value>)',
        },
        success: {
          50: 'rgb(var(--toran-success-50) / <alpha-value>)',
          200: 'rgb(var(--toran-success-200) / <alpha-value>)',
          800: 'rgb(var(--toran-success-800) / <alpha-value>)',
        },
        warning: {
          50: 'rgb(var(--toran-warning-50) / <alpha-value>)',
          200: 'rgb(var(--toran-warning-200) / <alpha-value>)',
          800: 'rgb(var(--toran-warning-800) / <alpha-value>)',
        },
        danger: {
          50: 'rgb(var(--toran-danger-50) / <alpha-value>)',
          200: 'rgb(var(--toran-danger-200) / <alpha-value>)',
          600: 'rgb(var(--toran-danger-600) / <alpha-value>)',
          700: 'rgb(var(--toran-danger-700) / <alpha-value>)',
          800: 'rgb(var(--toran-danger-800) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: [
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
