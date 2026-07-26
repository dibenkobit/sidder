import { JournalTableMismatchError, UnsafeTableNameError } from './errors.ts';
import type { JournalEntry, Row, Scope } from './types.ts';

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
 * The columns a journal is made of, in the order `ensureJournal` writes them.
 *
 * Kept as data because a table sowme did not create has to be compared against it — see
 * {@link mismatchOf}. Adding a column here means adding it to the DDL below as well.
 */
const JOURNAL_COLUMNS = ['name', 'applied_at', 'environment', 'duration_ms'] as const;

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

  let rows: Row[];
  try {
    rows = await scope.execute(`select name, applied_at, environment, duration_ms from ${table}`);
  } catch (error) {
    // This is the first statement that names the journal's columns, so it is where a table
    // that is not a journal announces itself. Ask why before passing the driver's answer on.
    throw (await mismatchOf(scope, table)) ?? error;
  }

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

/**
 * Why did reading the journal fail? Asked only once it already has.
 *
 * `journalTable` is configurable and `create table if not exists` is happy to find
 * somebody else's table under the name, so a typo or a collision with an application
 * table produces no complaint at all until this read — and then produces the driver's,
 * which names neither the table nor the setting.
 *
 * On the failure path rather than after `ensureJournal` on purpose. The check is worth a
 * query once in a project's life, and on the happy path it would cost one on every `run`,
 * every `status` and every `forget` forever — half again as many statements as `runSeeds`
 * issues before it reaches a seed. It would also quietly add "answer a Postgres catalogue
 * query" to an adapter interface whose selling point is two members you can write in ten
 * lines; the in-memory adapter these tests run on could not answer one.
 *
 * What that choice costs is on the line above: this explains a read that failed, and
 * nothing else. `sowme forget` against a foreign table that happens to have a `name`
 * column deletes from it and no read ever fails. Reaching that needs `forget` to be the
 * first command ever run against the mistake, because `run` and `status` both read.
 *
 * Columns are compared by name, not by type. A table that collides with the journal's
 * name almost never has the journal's four column names too, and comparing types would
 * mean teaching sowme that `timestamptz` and `timestamp with time zone` are one thing —
 * machinery whose failure mode is refusing to run against a journal that is fine.
 */
async function mismatchOf(scope: Scope, table: string): Promise<JournalTableMismatchError | null> {
  let found: string[];

  try {
    // `to_regclass` resolves the name the way every other statement in this file does:
    // through `search_path` when it is bare, as written when it is schema-qualified.
    // Looking it up in `information_schema` instead would mean guessing a schema for the
    // bare form, and a wrong guess would describe a different table than the one that
    // just failed. `attnum > 0` drops the system columns; `attisdropped` drops the slots
    // left behind by `drop column`.
    const rows = await scope.execute(
      `select attname from pg_attribute
        where attrelid = to_regclass($1) and attnum > 0 and not attisdropped
        order by attnum`,
      [table],
    );
    found = rows.map((row) => String(row['attname']));
  } catch {
    // The introspection failed too — no adapter is obliged to be Postgres, and a
    // connection that has just dropped will refuse this as readily as the read. Either
    // way the driver's error is the honest one and must not be replaced by a guess.
    return null;
  }

  // No columns means no table sowme can see, which is some other problem than this one.
  if (found.length === 0) return null;

  // A superset is a journal: an extra column of your own does not stop sowme reading its
  // four, so it is not something to refuse to run over.
  if (JOURNAL_COLUMNS.every((column) => found.includes(column))) return null;

  return new JournalTableMismatchError(table, JOURNAL_COLUMNS, found);
}

/** Drivers hand back a Date, a string, or a number depending on the driver. */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return new Date(Number.NaN);
}
