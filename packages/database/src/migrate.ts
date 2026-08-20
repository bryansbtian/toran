import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Database } from './client.js';

/**
 * Location of the generated SQL migrations. Resolved relative to this module so
 * it works from source, from `dist/`, and from inside a container image.
 */
export function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'drizzle');
}

/**
 * Applies pending migrations.
 *
 * Only ever additive: `drizzle-kit generate` produces forward migrations and
 * Toran never runs a destructive statement automatically. Dropping a column or
 * table is a deliberate, reviewed migration a maintainer writes by hand.
 */
export async function runMigrations(db: Database, folder = migrationsFolder()): Promise<void> {
  await migrate(db, { migrationsFolder: folder });
}
