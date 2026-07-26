// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Single source of truth for Toran's public identity.
 *
 * Forks and white-label deployments should only need to edit this file (plus
 * the SVG mark in `packages/ui/src/Logo.tsx`) to rebrand the whole product.
 * Nothing else in the codebase hardcodes the product name for display.
 */
export const branding = {
  /** Product name, as shown to users. */
  name: 'Toran',
  /** Lowercase slug used for package names, containers and databases. */
  slug: 'toran',
  tagline: 'Share a file. Keep the keys.',
  description:
    'Toran is an open-source, self-hostable file-sharing service. Files move directly between the browser and your own object storage, never through the application server.',
  /** Where the source lives. Update when forking. */
  repositoryUrl: 'https://github.com/toran-project/toran',
  documentationUrl: 'https://github.com/toran-project/toran/tree/main/docs',
  license: 'AGPL-3.0-only',
  /** Brand colours, mirrored by the Tailwind theme. */
  colors: {
    /** Deep teal. Primary actions and the logo mark. */
    primary: '#0f766e',
    primaryDark: '#2dd4bf',
    accent: '#f59e0b',
  },
  /** Rendered into <meta name="theme-color">. */
  themeColor: { light: '#ffffff', dark: '#0b1120' },
} as const;

export type Branding = typeof branding;
