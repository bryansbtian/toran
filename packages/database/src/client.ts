import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;
export type Sql = ReturnType<typeof postgres>;

export interface CreateDatabaseOptions {
  readonly url: string;
  readonly poolMax?: number;
  /** `postgres.js` connection options passthrough for TLS and similar. */
  readonly ssl?: boolean | 'require' | 'prefer';
  readonly onNotice?: (notice: unknown) => void;
}

export interface DatabaseHandle {
  readonly db: Database;
  readonly sql: Sql;
  close(): Promise<void>;
}

export function createDatabase(options: CreateDatabaseOptions): DatabaseHandle {
  // Built as an absent key rather than `ssl: undefined`, which postgres.js
  // reads as an explicit "no TLS" instead of falling back to its own default.
  const tls: { ssl?: CreateDatabaseOptions['ssl'] } = {};
  if (options.ssl !== undefined) {
    tls.ssl = options.ssl;
  }

  const sql = postgres(options.url, {
    max: options.poolMax ?? 10,
    // Toran maps every timestamp itself; disabling prepared statements keeps
    // the client compatible with transaction-mode connection poolers such as
    // PgBouncer, which many managed Postgres providers put in front of the DB.
    prepare: false,
    ...tls,
    onnotice: options.onNotice ?? (() => {}),
  });

  return {
    db: drizzle(sql, { schema }),
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/** Cheap liveness probe used by `/api/ready`. */
export async function pingDatabase(handle: Pick<DatabaseHandle, 'sql'>): Promise<void> {
  await handle.sql`select 1`;
}
