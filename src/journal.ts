import { UnsafeTableNameError } from './errors.ts';
import type { JournalEntry, Scope } from './types.ts';

/**
 * The journal: one row per seed that has been applied.
 *
 * It lives in your database rather than in a file for one reason — so that a seed and
 * the record of that seed can be written in the same transaction. That is the whole
 * trick behind resumable runs. If the process dies mid-seed, the seed's writes and its
 * journal row roll back together, and the next run simply does it again. There is no
 * "in progress" state to repair because there is no window in which one exists
 * without the other.
 *
 * It is a plain table with obvious column names. Read it with psql whenever you want.
 */

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The table name is interpolated into SQL rather than bound as a parameter, because
 * SQL does not allow parameters in that position. So it gets checked instead.
 */
export function assertSafeTableName(table: string): void {
  const parts = table.split('.');
  if (parts.length > 2 || parts.some((part) => !SQL_IDENTIFIER.test(part))) {
    throw new UnsafeTableNameError(table);
  }
}

export async function ensureJournal(scope: Scope, table: string): Promise<void> {
  assertSafeTableName(table);
  await scope.execute(
    `create table if not exists ${table} (
       name        text        primary key,
       applied_at  timestamptz not null default now(),
       environment text        not null,
       duration_ms integer     not null
     )`,
  );
}

export async function readJournal(scope: Scope, table: string): Promise<Map<string, JournalEntry>> {
  assertSafeTableName(table);
  const rows = await scope.execute(
    `select name, applied_at, environment, duration_ms from ${table}`,
  );

  return new Map(
    rows.map((row) => {
      const entry: JournalEntry = {
        name: String(row['name']),
        appliedAt: toDate(row['applied_at']),
        environment: String(row['environment']),
        durationMs: Number(row['duration_ms']),
      };
      return [entry.name, entry];
    }),
  );
}

/**
 * Records an applied seed, overwriting any previous entry.
 *
 * `always` seeds overwrite their own row on every run, so `applied_at` answers
 * "when did this last run" for every mode rather than only for `once`.
 */
export async function recordApplied(
  scope: Scope,
  table: string,
  entry: { name: string; environment: string; durationMs: number },
): Promise<void> {
  assertSafeTableName(table);
  await scope.execute(
    `insert into ${table} (name, applied_at, environment, duration_ms)
     values ($1, now(), $2, $3)
     on conflict (name) do update set
       applied_at  = excluded.applied_at,
       environment = excluded.environment,
       duration_ms = excluded.duration_ms`,
    [entry.name, entry.environment, entry.durationMs],
  );
}

/** Drivers hand back a Date, a string, or a number depending on the driver. */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return new Date(Number.NaN);
}
