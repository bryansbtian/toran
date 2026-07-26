// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

/**
 * Toran's Next.js configuration.
 *
 * Security headers are NOT set here. They are set in `src/middleware.ts`,
 * because the Content-Security-Policy depends on the object-storage origin,
 * which is a runtime deployment setting - `headers()` would bake the builder's
 * value into the image.
 */

// Next only reads `.env` from the app directory. Toran keeps a single `.env`
// at the monorepo root, so load it here for build-time settings.
const here = path.dirname(fileURLToPath(import.meta.url));
for (const candidate of [path.join(here, '.env'), path.join(here, '..', '..', '.env')]) {
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate, quiet: true });
    break;
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output is what the Docker image ships. It is opt-in so that a
  // plain `npm run build && npm run start` on a host still uses `next start`,
  // which does not support standalone output.
  ...(process.env.TORAN_STANDALONE === 'true' ? { output: 'standalone' } : {}),
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship as ESM with .js specifiers; Next transpiles them
  // so they can be bundled for both the server and the client.
  transpilePackages: ['@toran/ui', '@toran/shared'],
  outputFileTracingRoot: path.join(here, '..', '..'),
  experimental: {
    // The API validates every body itself; this is a cheap outer bound so a
    // huge body cannot be buffered before validation runs.
    serverActions: { bodySizeLimit: '1mb' },
  },
};

export default nextConfig;
