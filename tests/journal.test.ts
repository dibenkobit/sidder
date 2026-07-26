import { describe, expect, test } from 'bun:test';
import { UnsafeTableNameError } from '../src/errors.ts';
import {
  assertSafeTableName,
  ensureJournal,
  forgetApplied,
  readJournal,
  recordApplied,
} from '../src/journal.ts';
import { createMemoryAdapter } from './helpers/memory-adapter.ts';

describe('assertSafeTableName', () => {
  test('accepts plain and schema-qualified identifiers', () => {
    for (const name of ['sowme_journal', 'seeds', '_private', 'public.sowme_journal', 'S1']) {
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

    await ensureJournal(adapter.root, 'sowme_journal');
    await recordApplied(adapter.root, 'sowme_journal', {
      name: 'roles',
      environment: 'staging',
      durationMs: 42,
    });

    const journal = await readJournal(adapter.root, 'sowme_journal');

    expect(journal.get('roles')).toMatchObject({
      name: 'roles',
      environment: 'staging',
      durationMs: 42,
    });
    expect(journal.get('roles')?.appliedAt).toBeInstanceOf(Date);
  });

  test('recording the same seed twice overwrites rather than duplicates', async () => {
    const { adapter } = createMemoryAdapter();
    await ensureJournal(adapter.root, 'sowme_journal');

    await recordApplied(adapter.root, 'sowme_journal', {
      name: 'roles',
      environment: 'development',
      durationMs: 1,
    });
    await recordApplied(adapter.root, 'sowme_journal', {
      name: 'roles',
      environment: 'production',
      durationMs: 2,
    });

    const journal = await readJournal(adapter.root, 'sowme_journal');

    expect(journal.size).toBe(1);
    expect(journal.get('roles')?.environment).toBe('production');
  });
});

describe('forgetApplied', () => {
  async function journalOf(...names: string[]) {
    const { adapter } = createMemoryAdapter();
    await ensureJournal(adapter.root, 'sowme_journal');
    for (const name of names) {
      await recordApplied(adapter.root, 'sowme_journal', {
        name,
        environment: 'development',
        durationMs: 1,
      });
    }
    return adapter;
  }

  test('deletes the named rows and leaves the rest', async () => {
    const adapter = await journalOf('roles', 'territory', 'demo');

    const forgotten = await forgetApplied(adapter.root, 'sowme_journal', ['demo', 'roles']);

    expect(forgotten.sort()).toEqual(['demo', 'roles']);
    expect([...(await readJournal(adapter.root, 'sowme_journal')).keys()]).toEqual(['territory']);
  });

  test('reports which names had no row, rather than failing on them', async () => {
    // `forget` works on the journal, not on the seed list — so a typo and an orphan row
    // left by a rename are both ordinary answers, not errors.
    const adapter = await journalOf('roles');

    expect(await forgetApplied(adapter.root, 'sowme_journal', ['nope'])).toEqual([]);
    expect((await readJournal(adapter.root, 'sowme_journal')).size).toBe(1);
  });

  test('issues no statement at all for an empty list', async () => {
    const { adapter, statements } = createMemoryAdapter();

    expect(await forgetApplied(adapter.root, 'sowme_journal', [])).toEqual([]);
    expect(statements).toEqual([]);
  });
});
