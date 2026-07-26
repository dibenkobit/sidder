import { describe, expect, test } from 'bun:test';
import { JournalTableMismatchError, UnsafeTableNameError } from '../src/errors.ts';
import {
  assertSafeTableName,
  ensureJournal,
  forgetApplied,
  readJournal,
  recordApplied,
} from '../src/journal.ts';
import type { Scope } from '../src/types.ts';
import { createMemoryAdapter } from './helpers/memory-adapter.ts';

describe('assertSafeTableName', () => {
  test('accepts plain and schema-qualified identifiers', () => {
    for (const name of ['sidder_journal', 'seeds', '_private', 'public.sidder_journal', 'S1']) {
      expect(() => assertSafeTableName(name)).not.toThrow();
    }
  });

  test('rejects anything that is not an identifier', () => {
    // The table name is interpolated rather than bound, because SQL has no parameter
    // slot for it. That makes this check the only thing standing between a config
    // value and the statement, so it is deliberately narrow.
    for (const name of [
      'seeds; drop table users',
      'a.b.c',
      'seeds journal',
      '9lives',
      '',
      'seeds--',
      'seeds"',
    ]) {
      expect(() => assertSafeTableName(name)).toThrow(UnsafeTableNameError);
    }
  });
});

describe('journal round trip', () => {
  test('records an entry and reads it back', async () => {
    const { adapter } = createMemoryAdapter();

    await ensureJournal(adapter.root, 'sidder_journal');
    await recordApplied(adapter.root, 'sidder_journal', {
      name: 'roles',
      environment: 'staging',
      durationMs: 42,
    });

    const journal = await readJournal(adapter.root, 'sidder_journal');

    expect(journal.get('roles')).toMatchObject({
      name: 'roles',
      environment: 'staging',
      durationMs: 42,
    });
    expect(journal.get('roles')?.appliedAt).toBeInstanceOf(Date);
  });

  test('recording the same seed twice overwrites rather than duplicates', async () => {
    const { adapter } = createMemoryAdapter();
    await ensureJournal(adapter.root, 'sidder_journal');

    await recordApplied(adapter.root, 'sidder_journal', {
      name: 'roles',
      environment: 'development',
      durationMs: 1,
    });
    await recordApplied(adapter.root, 'sidder_journal', {
      name: 'roles',
      environment: 'production',
      durationMs: 2,
    });

    const journal = await readJournal(adapter.root, 'sidder_journal');

    expect(journal.size).toBe(1);
    expect(journal.get('roles')?.environment).toBe('production');
  });
});

/**
 * `journalTable` can be pointed at a table that is not a journal, and
 * `create table if not exists` will not say a word about it. The first sign is the read
 * below failing with the driver's `column "applied_at" does not exist`, which names
 * neither the table nor the setting that picked it.
 *
 * These drive a scope directly rather than through the memory adapter, because what is
 * being tested is what `readJournal` does with a read that failed — and the memory
 * adapter's reads cannot fail. The real thing is in postgres.test.ts.
 */
describe('a journal table that is not a journal', () => {
  const JOURNAL_COLUMNS = ['name', 'applied_at', 'environment', 'duration_ms'];

  /** A scope whose journal read fails and whose catalogue query answers with `columns`. */
  function scopeWhoseReadFails(columns: string[] | Error) {
    const readFailure = new Error('column "applied_at" does not exist');
    const calls: { sql: string; params: readonly unknown[] }[] = [];

    const scope: Scope = {
      db: {},
      execute: async (sql, params = []) => {
        calls.push({ sql, params });
        if (!sql.includes('pg_attribute')) throw readFailure;
        if (columns instanceof Error) throw columns;
        return columns.map((attname) => ({ attname }));
      },
    };

    return { scope, calls, readFailure };
  }

  async function readFailure(scope: Scope, table = 'sidder_journal'): Promise<unknown> {
    try {
      await readJournal(scope, table);
    } catch (error) {
      return error;
    }
    throw new Error('expected the read to fail');
  }

  test('says which table, which columns, and which setting chose the name', async () => {
    const { scope } = scopeWhoseReadFails(['id', 'label']);

    const error = await readFailure(scope, 'widgets');

    expect(error).toBeInstanceOf(JournalTableMismatchError);
    const { message, hint } = error as JournalTableMismatchError;
    expect(message).toBe(`Table "widgets" exists but is not sidder's journal`);
    expect(hint).toContain('It has id, label.');
    expect(hint).toContain('A journal has name, applied_at, environment, duration_ms.');
    expect(hint).toContain('`journalTable`');
  });

  test('names the missing columns when only some of them are missing', async () => {
    // A journal of sidder's own whose columns have drifted — an old one, or an edited one.
    const { scope } = scopeWhoseReadFails(['name', 'applied_at']);

    const { hint } = (await readFailure(scope)) as JournalTableMismatchError;

    expect(hint).toContain('Missing: environment, duration_ms.');
  });

  test("leaves the driver's error alone when the columns are all there", async () => {
    // Reading a journal can fail for reasons that are not its shape — a permission, a
    // connection. Replacing those with a guess about the shape would be a lie.
    const { scope, readFailure: original } = scopeWhoseReadFails(JOURNAL_COLUMNS);

    expect(await readFailure(scope)).toBe(original);
  });

  test('tolerates extra columns rather than refusing to run', async () => {
    const { scope, readFailure: original } = scopeWhoseReadFails([...JOURNAL_COLUMNS, 'note']);

    expect(await readFailure(scope)).toBe(original);
  });

  test("leaves the driver's error alone when there is no table to look at", async () => {
    // `to_regclass` on a name that resolves to nothing returns null, so the query finds
    // no columns. Whatever went wrong, it was not this.
    const { scope, readFailure: original } = scopeWhoseReadFails([]);

    expect(await readFailure(scope)).toBe(original);
  });

  test('does not let a failed introspection mask the failure it was explaining', async () => {
    // Not every adapter is Postgres, and a connection that has just dropped refuses the
    // second query as readily as the first.
    const { scope, readFailure: original } = scopeWhoseReadFails(
      new Error('relation "pg_attribute" does not exist'),
    );

    expect(await readFailure(scope)).toBe(original);
  });

  test('hands the name to Postgres to resolve, schema and all', async () => {
    // Bound as a parameter and resolved by `to_regclass`, so a bare name goes through
    // `search_path` exactly as the read above did, and a qualified one is not taken apart
    // here. Splitting it ourselves would risk describing a different table than the one
    // that failed.
    const { scope, calls } = scopeWhoseReadFails(['id']);

    await readFailure(scope, 'public.sidder_journal');

    expect(calls.map((call) => call.params)).toEqual([[], ['public.sidder_journal']]);
  });

  test('costs nothing when the journal is a journal, empty or not', async () => {
    // The check is on the failure path. A brand new journal with no rows in it is the
    // happy path, and the happy path must not pay for this.
    const { adapter, statements } = createMemoryAdapter();
    await ensureJournal(adapter.root, 'sidder_journal');

    expect((await readJournal(adapter.root, 'sidder_journal')).size).toBe(0);
    expect(statements.some((statement) => statement.includes('pg_attribute'))).toBe(false);
  });
});

describe('forgetApplied', () => {
  async function journalOf(...names: string[]) {
    const { adapter } = createMemoryAdapter();
    await ensureJournal(adapter.root, 'sidder_journal');
    for (const name of names) {
      await recordApplied(adapter.root, 'sidder_journal', {
        name,
        environment: 'development',
        durationMs: 1,
      });
    }
    return adapter;
  }

  test('deletes the named rows and leaves the rest', async () => {
    const adapter = await journalOf('roles', 'territory', 'demo');

    const forgotten = await forgetApplied(adapter.root, 'sidder_journal', ['demo', 'roles']);

    expect(forgotten.sort()).toEqual(['demo', 'roles']);
    expect([...(await readJournal(adapter.root, 'sidder_journal')).keys()]).toEqual(['territory']);
  });

  test('reports which names had no row, rather than failing on them', async () => {
    // `forget` works on the journal, not on the seed list — so a typo and an orphan row
    // left by a rename are both ordinary answers, not errors.
    const adapter = await journalOf('roles');

    expect(await forgetApplied(adapter.root, 'sidder_journal', ['nope'])).toEqual([]);
    expect((await readJournal(adapter.root, 'sidder_journal')).size).toBe(1);
  });

  test('issues no statement at all for an empty list', async () => {
    const { adapter, statements } = createMemoryAdapter();

    expect(await forgetApplied(adapter.root, 'sidder_journal', [])).toEqual([]);
    expect(statements).toEqual([]);
  });
});
