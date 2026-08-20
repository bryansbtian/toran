/**
 * Single source of truth for Toran's public identity.
 *
 * Editing this file (plus the SVG mark in `packages/ui/src/Logo.tsx`) rebrands
 * the whole product. Nothing else in the codebase hardcodes the product name
 * for display.
 */
export const branding = {
  /** Product name, as shown to users. */
  name: 'Toran',
  /** Lowercase slug used for package names, containers and databases. */
  slug: 'toran',
  tagline: 'Share a file. Keep the keys.',
  description:
    'Toran is a secure file-sharing service. Files move directly between the browser and object storage, never through the application server.',
  /** Brand colours, mirrored by the Tailwind theme. */
  colors: {
    /** Burnt orange. Primary actions and the logo mark. */
    primary: '#c2410c',
    /** Orange. The dark theme runs warm greys with an orange accent. */
    primaryDark: '#f97316',
    accent: '#f59e0b',
  },
  /** Rendered into <meta name="theme-color">. */
  themeColor: { light: '#ffffff', dark: '#121212' },
} as const;

export type Branding = typeof branding;
