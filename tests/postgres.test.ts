import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { type DrizzleLike, drizzleAdapter } from '../src/adapters/drizzle.ts';
import { type PgPool, type PgQueryable, pgAdapter } from '../src/adapters/pg.ts';
import { forgetApplied } from '../src/journal.ts';
import { runSeeds } from '../src/run.ts';
import type { Config, Seed } from '../src/types.ts';

/**
 * The integration tests. `bun run db:up && bun run test:pg`.
 *
 * Everything else in this suite runs against an in-memory adapter, which is fast and
 * proves the runner's decisions. It cannot prove the two things only a real database
 * can: that the journal statements are valid SQL on Postgres, and that a failing seed
 * really does take its journal row down with it. That is what is here.
 *
 * runSeeds never calls `adapter.close()` — that is the CLI's job — so these tests can
 * share one pool across every case and close it once at the end.
 */

const url = process.env['SOWME_TEST_DATABASE_URL'];
const describeIf = url ? describe : describe.skip;

if (!url) {
  console.log('postgres.test.ts skipped — set SOWME_TEST_DATABASE_URL to run it');
}

describeIf('against a real Postgres', () => {
  const pool = new Pool({ connectionString: url });
  const JOURNAL = 'sowme_test_journal';

  afterAll(async () => {
    await pool.query(`drop table if exists ${JOURNAL}`);
    await pool.query('drop table if exists widgets');
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`drop table if exists ${JOURNAL}`);
    await pool.query('drop table if exists widgets');
    await pool.query('create table widgets (id serial primary key, label text not null)');
  });

  async function countWidgets(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>('select count(*)::text from widgets');
    return Number(rows[0]?.count ?? 0);
  }

  async function journalNames(): Promise<string[]> {
    const { rows } = await pool.query<{ name: string }>(
      `select name from ${JOURNAL} order by name`,
    );
    return rows.map((row) => row.name);
  }

  async function appliedAt(name: string): Promise<Date> {
    const { rows } = await pool.query<{ applied_at: Date }>(
      `select applied_at from ${JOURNAL} where name = $1`,
      [name],
    );
    return rows[0]!.applied_at;
  }

  describe('pgAdapter', () => {
    const adapter = pgAdapter(pool as unknown as PgPool);

    const configOf = (seeds: Seed<PgQueryable>[]): Config<PgQueryable> => ({
      adapter,
      seeds,
      env: 'test',
      journalTable: JOURNAL,
    });

    test('creates the journal, applies seeds, and skips them next time', async () => {
      const seeds: Seed<PgQueryable>[] = [
        {
          name: 'widgets',
          run: async ({ db }) => {
            await db.query("insert into widgets (label) values ('one'), ('two')");
          },
        },
      ];

      await runSeeds(configOf(seeds));
      expect(await countWidgets()).toBe(2);
      expect(await journalNames()).toEqual(['widgets']);

      const second = await runSeeds(configOf(seeds));
      expect(await countWidgets()).toBe(2);
      expect(second.outcomes[0]).toMatchObject({ status: 'skipped' });
    });

    test('a failing seed leaves neither its rows nor its journal entry', async () => {
      const seeds: Seed<PgQueryable>[] = [
        {
          name: 'good',
          run: async ({ db }) => {
            await db.query("insert into widgets (label) values ('kept')");
          },
        },
        {
          name: 'bad',
          dependsOn: ['good'],
          run: async ({ db }) => {
            await db.query("insert into widgets (label) values ('rolled back')");
            await db.query('insert into widgets (label) values (null)'); // NOT NULL violation
          },
        },
      ];

      await expect(runSeeds(configOf(seeds))).rejects.toThrow();

      expect(await countWidgets()).toBe(1);
      expect(await journalNames()).toEqual(['good']);
    });

    test('transaction: false keeps the rows a failing seed wrote', async () => {
      const seeds: Seed<PgQueryable>[] = [
        {
          name: 'bulk',
          transaction: false,
          run: async ({ db }) => {
            await db.query("insert into widgets (label) values ('committed anyway')");
            throw new Error('half way through');
          },
        },
      ];

      await expect(runSeeds(configOf(seeds))).rejects.toThrow('half way through');

      expect(await countWidgets()).toBe(1);
      expect(await journalNames()).toEqual([]);
    });

    test('records the environment and a real duration', async () => {
      await runSeeds(configOf([{ name: 'noop', run: async () => {} }]), { env: 'staging' });

      const { rows } = await pool.query<{ environment: string; duration_ms: number }>(
        `select environment, duration_ms from ${JOURNAL} where name = 'noop'`,
      );
      expect(rows[0]?.environment).toBe('staging');
      expect(rows[0]?.duration_ms).toBeGreaterThanOrEqual(0);
    });

    test('force re-runs an applied seed and moves its journal row forward', async () => {
      const seeds: Seed<PgQueryable>[] = [
        {
          name: 'widgets',
          run: async ({ db }) => {
            await db.query("insert into widgets (label) values ('again')");
          },
        },
      ];

      await runSeeds(configOf(seeds));
      const first = await appliedAt('widgets');

      await runSeeds(configOf(seeds), { force: true });

      expect(await countWidgets()).toBe(2);
      expect(await journalNames()).toEqual(['widgets']);
      expect((await appliedAt('widgets')).getTime()).toBeGreaterThan(first.getTime());
    });

    test('forget deletes the row, and the seed runs again on the next ordinary run', async () => {
      const seeds: Seed<PgQueryable>[] = [
        {
          name: 'widgets',
          run: async ({ db }) => {
            await db.query("insert into widgets (label) values ('once more')");
          },
        },
      ];

      await runSeeds(configOf(seeds));
      expect(await forgetApplied(adapter.root, JOURNAL, ['widgets', 'never-existed'])).toEqual([
        'widgets',
      ]);
      expect(await journalNames()).toEqual([]);

      await runSeeds(configOf(seeds));

      expect(await countWidgets()).toBe(2);
      expect(await journalNames()).toEqual(['widgets']);
    });

    test('an always seed re-runs and its journal row moves forward', async () => {
      const seeds: Seed<PgQueryable>[] = [
        {
          name: 'widgets',
          mode: 'always',
          run: async ({ db }) => {
            await db.query("insert into widgets (label) values ('again')");
          },
        },
      ];

      await runSeeds(configOf(seeds));
      await runSeeds(configOf(seeds));

      expect(await countWidgets()).toBe(2);
      expect(await journalNames()).toEqual(['widgets']);
    });
  });

  describe('drizzleAdapter', () => {
    const adapter = drizzleAdapter(drizzle(pool) as unknown as DrizzleLike);

    test('drives the same journal through Drizzle', async () => {
      const config: Config<DrizzleLike> = {
        adapter,
        env: 'test',
        journalTable: JOURNAL,
        seeds: [
          {
            name: 'widgets',
            run: async ({ db }) => {
              await db.execute(sql`insert into widgets (label) values ('via drizzle')`);
            },
          },
        ],
      };

      await runSeeds(config);

      expect(await countWidgets()).toBe(1);
      expect(await journalNames()).toEqual(['widgets']);
    });

    test('rolls back through Drizzle too', async () => {
      const config: Config<DrizzleLike> = {
        adapter,
        env: 'test',
        journalTable: JOURNAL,
        seeds: [
          {
            name: 'widgets',
            run: async ({ db }) => {
              await db.execute(sql`insert into widgets (label) values ('doomed')`);
              await db.execute(sql`insert into widgets (label) values (null)`);
            },
          },
        ],
      };

      await expect(runSeeds(config)).rejects.toThrow();

      expect(await countWidgets()).toBe(0);
      expect(await journalNames()).toEqual([]);
    });
  });
});
