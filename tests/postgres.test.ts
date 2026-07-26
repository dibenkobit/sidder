import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { type DrizzleLike, drizzleAdapter } from '../src/adapters/drizzle.ts';
import { type PgPool, type PgQueryable, pgAdapter } from '../src/adapters/pg.ts';
import { forgetApplied } from '../src/journal.ts';
import { runSeeds } from '../src/run.ts';
import type { Config, RunEvent, Seed } from '../src/types.ts';

/**
 * The integration tests. `bun run db:up && bun run test:pg`.
 *
 * Everything else in this suite runs against an in-memory adapter, which is fast and
 * proves the runner's decisions. It cannot prove the three things only a real database
 * can: that the journal statements are valid SQL on Postgres, that a failing seed really
 * does take its journal row down with it, and that two runs at once apply each seed once.
 * That is what is here.
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

    /**
     * Two `sowme run` at once — two replicas in a deploy, two jobs in one pipeline.
     *
     * The dangerous window is between reading the journal and committing the seed: both
     * runs read an empty journal, both decide to run, and the second one's `on conflict
     * do update` then absorbs its own duplicate journal row, so the table afterwards
     * reads exactly as it should while the data was applied twice.
     *
     * The barrier holds the first seed inside its transaction until both runs have
     * planned, which is precisely that window, held open on purpose. Without the per-seed
     * lock and the re-read behind it these tests insert two rows and report two `applied`.
     */
    function planBarrier(runs: number) {
      let release = (): void => {};
      const bothPlanned = new Promise<void>((resolve) => {
        release = resolve;
      });
      let planned = 0;

      return {
        bothPlanned,
        // The plan event is emitted once the journal has been read and every decision
        // made, so counting them is how a test knows both runs hold a stale view.
        onEvent: (event: RunEvent) => {
          if (event.type === 'plan' && ++planned === runs) release();
        },
      };
    }

    test('two concurrent runs apply a seed exactly once', async () => {
      const { bothPlanned, onEvent } = planBarrier(2);

      const seeds: Seed<PgQueryable>[] = [
        {
          name: 'widgets',
          run: async ({ db }) => {
            await bothPlanned;
            await db.query("insert into widgets (label) values ('one')");
          },
        },
      ];

      const runs = await Promise.all([
        runSeeds(configOf(seeds), { onEvent }),
        runSeeds(configOf(seeds), { onEvent }),
      ]);

      expect(await countWidgets()).toBe(1);
      expect(await journalNames()).toEqual(['widgets']);

      // Which run wins the lock is not ours to decide; that one of them loses and says so
      // is. The loser reports `skipped`, because skipping is what it did.
      expect(runs.map((run) => run.outcomes[0]?.status).sort()).toEqual(['applied', 'skipped']);
      expect(
        runs.flatMap((run) => run.outcomes).filter((o) => o.status === 'skipped')[0],
      ).toMatchObject({ reason: { kind: 'already-applied' } });
    });

    test('two concurrent runs of a two-seed project apply each seed once, in order', async () => {
      const { bothPlanned, onEvent } = planBarrier(2);

      const seeds: Seed<PgQueryable>[] = [
        {
          name: 'first',
          run: async ({ db }) => {
            await bothPlanned;
            await db.query("insert into widgets (label) values ('first')");
          },
        },
        {
          name: 'second',
          dependsOn: ['first'],
          run: async ({ db }) => {
            // Proves the dependency survived the interleaving: both runs walk the seeds in
            // dependency order and each seed is a barrier, so whichever run reaches
            // `second` does so with `first` committed — by itself or by the other one.
            const { rows } = await db.query("select 1 from widgets where label = 'first'");
            expect(rows).toHaveLength(1);
            await db.query("insert into widgets (label) values ('second')");
          },
        },
      ];

      await Promise.all([
        runSeeds(configOf(seeds), { onEvent }),
        runSeeds(configOf(seeds), { onEvent }),
      ]);

      expect(await countWidgets()).toBe(2);
      expect(await journalNames()).toEqual(['first', 'second']);
    });

    test('two concurrent runs of an always seed both apply it', async () => {
      const { bothPlanned, onEvent } = planBarrier(2);

      // `always` means every invocation, and two invocations are two. The lock serialises
      // them so they cannot collide inside the database; it must not silence one of them.
      const seeds: Seed<PgQueryable>[] = [
        {
          name: 'widgets',
          mode: 'always',
          run: async ({ db }) => {
            await bothPlanned;
            await db.query("insert into widgets (label) values ('again')");
          },
        },
      ];

      const runs = await Promise.all([
        runSeeds(configOf(seeds), { onEvent }),
        runSeeds(configOf(seeds), { onEvent }),
      ]);

      expect(await countWidgets()).toBe(2);
      expect(await journalNames()).toEqual(['widgets']);
      expect(runs.map((run) => run.outcomes[0]?.status)).toEqual(['applied', 'applied']);
    });

    test('a transaction: false seed re-reads the journal and skips a row that arrived late', async () => {
      /**
       * The one seed that cannot hold a lock, so all it gets is a look before it leaps.
       *
       * `first` writes `bulk`'s journal row through the pool rather than through its own
       * transaction, so the row commits immediately — which is what another process
       * finishing `bulk` looks like from in here. This run planned before it existed.
       */
      const seeds: Seed<PgQueryable>[] = [
        {
          name: 'first',
          run: async () => {
            await pool.query(
              `insert into ${JOURNAL} (name, environment, duration_ms) values ('bulk', 'test', 1)`,
            );
          },
        },
        {
          name: 'bulk',
          dependsOn: ['first'],
          transaction: false,
          run: async ({ db }) => {
            await db.query("insert into widgets (label) values ('applied twice')");
          },
        },
      ];

      const result = await runSeeds(configOf(seeds));

      expect(await countWidgets()).toBe(0);
      expect(result.outcomes[1]).toMatchObject({
        status: 'skipped',
        reason: { kind: 'already-applied' },
      });
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
