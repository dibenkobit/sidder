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

/**
 * Deletes journal rows, and reports which names actually had one.
 *
 * The counterpart to `once`: a seed is skipped because the journal remembers it, so
 * forgetting the row is how you make it runnable again without opening psql. It works on
 * names rather than seeds on purpose — an orphan row left behind by a renamed file is a
 * thing `status` tells you about and therefore a thing you must be able to delete.
 *
 * Names are bound one parameter each rather than as one array, because arrays are a
 * driver feature and positional parameters are the whole of what `Scope.execute` promises.
 */
export async function forgetApplied(
  scope: Scope,
  table: string,
  names: readonly string[],
): Promise<string[]> {
  assertSafeTableName(table);
  if (names.length === 0) return [];

  const placeholders = names.map((_, index) => `$${index + 1}`).join(', ');
  const rows = await scope.execute(
    `delete from ${table} where name in (${placeholders}) returning name`,
    names,
  );

  return rows.map((row) => String(row['name']));
}

/** Drivers hand back a Date, a string, or a number depending on the driver. */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return new Date(Number.NaN);
}
