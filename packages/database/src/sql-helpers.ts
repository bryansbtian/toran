import { sql, type SQL } from 'drizzle-orm';

/**
 * Binds a JavaScript `Date` into a raw SQL fragment.
 *
 * Inside `db.select()` / `db.update()` builders Drizzle knows the column type
 * and converts a `Date` for us. Inside a raw `sql` template it does not, and
 * the driver receives an untyped value. Passing an explicit ISO-8601 string
 * with a `timestamptz` cast makes the intent unambiguous to PostgreSQL and
 * keeps the value a bound parameter, never string-interpolated SQL.
 */
export function ts(value: Date): SQL {
  return sql`${value.toISOString()}::timestamptz`;
}
