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
 *
 * The lock that keeps two runs from applying the same seed lives in this file too. It is
 * not part of the table, but it is keyed on it, and it exists to answer the same question
 * the table does.
 */

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The columns a journal is made of, in the order `ensureJournal` writes them.
 *
 * Kept as data because a table sidder did not create has to be compared against it — see
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

/**
 * Creates the journal table if it is not there, and tolerates another run creating it at
 * the same moment.
 *
 * `if not exists` looks in the catalogue and then creates, and those are not one atomic
 * step: two runs starting together both see no table, and the loser fails on pg_type's
 * unique index rather than being told the table already exists. Measured at eight-way
 * concurrency on Postgres 18 that happens on roughly half of all attempts, so two
 * replicas booting against a fresh database hit it routinely rather than rarely.
 *
 * Hence the second attempt, which is the one that finds the table there and does nothing.
 * If it fails as well then the race was never the problem — a missing privilege, a name
 * already taken by something that is not a journal — and the first error is the one that
 * says so, which is why the retry is not allowed to replace it.
 */
export async function ensureJournal(scope: Scope, table: string): Promise<void> {
  assertSafeTableName(table);

  const create = () =>
    scope.execute(
      `create table if not exists ${table} (
       name        text        primary key,
       applied_at  timestamptz not null default now(),
       environment text        not null,
       duration_ms integer     not null
     )`,
    );

  try {
    await create();
  } catch (firstAttempt) {
    try {
      await create();
    } catch {
      throw firstAttempt;
    }
  }
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

  return new Map(rows.map(toEntry).map((entry) => [entry.name, entry]));
}

/**
 * Reads one seed's row, for asking the journal question a second time inside the scope a
 * seed is about to run in. See `executeSeed` for why once is not enough.
 */
export async function readJournalEntry(
  scope: Scope,
  table: string,
  name: string,
): Promise<JournalEntry | undefined> {
  assertSafeTableName(table);
  const rows = await scope.execute(
    `select name, applied_at, environment, duration_ms from ${table} where name = $1`,
    [name],
  );

  const row = rows[0];
  return row === undefined ? undefined : toEntry(row);
}

/**
 * Asks for one seed's lock without waiting for it. True means this transaction has it now.
 *
 * The first half of {@link lockSeed}'s protocol, and it exists so that sidder can say it is
 * waiting for another run only when it has been told that it is. Blocking straight away is
 * silent — the symptom this splits the call in two to fix — and announcing a wait before
 * every lock would announce one on every seed of every run, including the overwhelming
 * majority that are contended by nobody. Asking and being refused is an observation; being
 * about to ask is not.
 *
 * Anything other than an explicit `true` is read as "somebody else has it", which is the
 * safe direction of the two. Being wrong that way costs one message and one extra
 * statement, because {@link lockSeed} then grants immediately on a lock this transaction
 * already holds; being wrong the other way would skip {@link lockSeed} and run the seed
 * with no exclusion at all. The cost falls on an adapter whose driver hands a Postgres
 * boolean back as text rather than as a boolean — pg and Drizzle both parse it — and it
 * lands as a wait reported that is not happening, never as a lock that is not held.
 */
export async function tryLockSeed(scope: Scope, table: string, name: string): Promise<boolean> {
  assertSafeTableName(table);
  const rows = await scope.execute('select pg_try_advisory_xact_lock(hashtext($1), hashtext($2))', [
    table,
    name,
  ]);

  // `Scope.execute` promises rows and nothing about their shape, so the column is read by
  // the name Postgres gives it — the function's own — and compared rather than coerced.
  return rows[0]?.['pg_try_advisory_xact_lock'] === true;
}

/**
 * Waits for one seed's lock, and holds it until the surrounding transaction ends.
 *
 * The blocking half, reached only once {@link tryLockSeed} has been refused. Together they
 * are what stops two `sidder run` processes from both applying the same seed. It is an
 * advisory lock rather than a row or table lock because there is nothing to lock yet — the
 * whole question is whether the row should come into existence — and `_xact_` because that
 * variant releases on commit or rollback with nothing to unlock by hand. A session-level
 * lock would need a connection of its own: `Adapter.root` is a pool for both shipped
 * adapters, so the unlock could land on a different connection than the lock and leak.
 *
 * The key is a pair rather than a single bigint so it cannot collide with a lock your
 * application takes — Postgres keeps the one-argument and two-argument keyspaces apart —
 * and hashing the table name means two projects sharing one database with different
 * `journalTable`s never wait on each other. `hashtext` is undocumented but ancient and
 * stable; nothing here depends on its output being the same across Postgres versions,
 * only on two sessions on one server agreeing, which is by definition true.
 *
 * Collisions between two seed names are possible in an int4 and harmless: the cost is one
 * seed waiting for an unrelated one, and a transaction only ever holds one of these locks
 * at a time, so no ordering deadlock exists to worry about.
 */
export async function lockSeed(scope: Scope, table: string, name: string): Promise<void> {
  assertSafeTableName(table);
  await scope.execute('select pg_advisory_xact_lock(hashtext($1), hashtext($2))', [table, name]);
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

function toEntry(row: Row): JournalEntry {
  return {
    name: String(row['name']),
    appliedAt: toDate(row['applied_at']),
    environment: String(row['environment']),
    durationMs: Number(row['duration_ms']),
  };
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
 * nothing else. `sidder forget` against a foreign table that happens to have a `name`
 * column deletes from it and no read ever fails. Reaching that needs `forget` to be the
 * first command ever run against the mistake, because `run` and `status` both read.
 *
 * Columns are compared by name, not by type. A table that collides with the journal's
 * name almost never has the journal's four column names too, and comparing types would
 * mean teaching sidder that `timestamptz` and `timestamp with time zone` are one thing —
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

  // No columns means no table sidder can see, which is some other problem than this one.
  if (found.length === 0) return null;

  // A superset is a journal: an extra column of your own does not stop sidder reading its
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
