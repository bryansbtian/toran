// SPDX-License-Identifier: MIT
import { loadConfig } from '@toran/config';
import { createDatabase } from '../client.js';
import { runMigrations } from '../migrate.js';

/** Entry point for `npm run db:migrate`. Safe to run repeatedly. */
async function main(): Promise<void> {
  const config = loadConfig();
  const handle = createDatabase({ url: config.database.url, poolMax: 1 });
  try {
    console.log('[toran:db] applying migrations');
    await runMigrations(handle.db);
    console.log('[toran:db] migrations up to date');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('[toran:db] migration failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
