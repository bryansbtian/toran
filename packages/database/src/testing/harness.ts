import { loadConfig } from '@toran/config';
import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseHandle } from '../client.js';
import { runMigrations } from '../migrate.js';

/**
 * Integration-test harness backed by a real PostgreSQL.
 *
 * Toran's hardest correctness guarantees - atomic download reservation, safe
 * job claiming, idempotent upload completion - are properties of PostgreSQL's
 * concurrency semantics. Testing them against a fake would test the fake, so
 * these tests use the real database and are skipped when it is unavailable.
 */
export interface TestDatabase {
  readonly handle: DatabaseHandle;
  readonly db: DatabaseHandle['db'];
  truncateAll(): Promise<void>;
  close(): Promise<void>;
}

export async function isDatabaseReachable(): Promise<boolean> {
  try {
    const config = loadConfig({ onWarning: () => {} });
    const handle = createDatabase({ url: config.database.url, poolMax: 1 });
    try {
      await handle.sql`select 1`;
      return true;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/**
 * Decides whether an integration suite may skip itself.
 *
 * Skipping keeps `npm test` and a local `npm run test:integration` usable
 * without Docker running. In CI the services are provisioned, so "unreachable"
 * means something is broken rather than absent - and a suite that skips there
 * reports green having asserted nothing. `TORAN_REQUIRE_INTEGRATION=true` turns
 * the skip into a hard failure; CI sets it.
 *
 * Throwing at module scope fails the whole test file, which is the point: the
 * job must not pass.
 */
export function allowIntegrationSkip(reachable: boolean, label: string): boolean {
  if (reachable) {
    return true;
  }

  const detail =
    `${label}: DATABASE_URL is unreachable.\n` +
    '        Start the development stack with `npm run dev:setup`.';

  if (process.env.TORAN_REQUIRE_INTEGRATION === 'true') {
    throw new Error(
      `[toran] ${detail}\n` +
        '        TORAN_REQUIRE_INTEGRATION=true, so this is a failure rather than a skip.',
    );
  }

  console.warn(`[toran] Skipping ${detail}`);
  return false;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const config = loadConfig({ onWarning: () => {} });
  if (config.isProduction) {
    throw new Error('refusing to run integration tests against a production database');
  }

  const handle = createDatabase({ url: config.database.url, poolMax: 8 });
  await runMigrations(handle.db);

  const truncateAll = async (): Promise<void> => {
    // RESTART IDENTITY CASCADE keeps referential integrity while emptying
    // every table in one statement.
    await handle.sql`
      truncate table
        download_events, share_links, upload_sessions,
        files, jobs, rate_limits, users
      restart identity cascade
    `;
  };

  await truncateAll();

  return {
    handle,
    db: handle.db,
    truncateAll,
    close: () => handle.close(),
  };
}

/** Convenience for asserting on raw counts. */
export async function countRows(handle: DatabaseHandle, table: string): Promise<number> {
  const rows = await handle.db.execute<{ count: string }>(
    sql.raw(`select count(*)::int as count from ${table}`),
  );
  return Number(rows[0]?.count ?? 0);
}
