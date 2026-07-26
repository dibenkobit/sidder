import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { type DrizzleLike, drizzleAdapter } from '../src/adapters/drizzle.ts';
import { type PgPool, type PgQueryable, pgAdapter } from '../src/adapters/pg.ts';
import { JournalTableMismatchError } from '../src/errors.ts';
import { ensureJournal, forgetApplied, readJournal } from '../src/journal.ts';
import { runSeeds } from '../src/run.ts';
import type { Config, RunEvent, Scope, Seed } from '../src/types.ts';

/**
 * The integration tests. `bun run db:up && bun run test:pg`.
 *
 * Everything else in this suite runs against an in-memory adapter, which is fast and
 * proves the runner's decisions. It cannot prove the four things only a real database
 * can: that the journal statements are valid SQL on Postgres, that a failing seed really
 * does take its journal row down with it, that two runs at once apply each seed once, and
 * that an ORM's own query builders work on the transaction object its adapter hands a
 * seed. That is what is here.
 *
 * runSeeds never calls `adapter.close()` — that is the CLI's job — so these tests can
 * share one pool across every case and close it once at the end.
 */

const url = process.env['SIDDY_TEST_DATABASE_URL'];
const describeIf = url ? describe : describe.skip;

if (!url) {
  console.log('postgres.test.ts skipped — set SIDDY_TEST_DATABASE_URL to run it');
}

describeIf('against a real Postgres', () => {
  const pool = new Pool({ connectionString: url });
  const JOURNAL = 'siddy_test_journal';

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
     * Two `siddy run` at once — two replicas in a deploy, two jobs in one pipeline.
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

    test('the run that loses the lock says it is waiting, and still only skips', async () => {
      /**
       * The defect the `waiting` event exists for, proved where it is the only thing that
       * can be: a second process blocked on a lock the first one holds. Before it, that run
       * printed `⋯ widgets` and then nothing for as long as the wait lasted, and in a
       * pipeline printed nothing at all — a stuck deploy that looked exactly like a hang.
       *
       * A race, and deterministic anyway, with no sleep and no threshold in it. Whichever
       * run wins the lock parks inside its seed until a `waiting` event has been seen, and
       * it parks *holding* the lock — so the other run's attempt is certain to be refused,
       * and certain to be refused before there is a committed journal row for it to find
       * instead. Which of the two is which is still Postgres's business, so the assertions
       * below read the roles off the outcomes rather than assuming them.
       */
      const events: RunEvent[][] = [[], []];
      let sawWaiting = (): void => {};
      const someoneIsWaiting = new Promise<void>((resolve) => {
        sawWaiting = resolve;
      });

      const onEventFor = (index: number) => (event: RunEvent) => {
        events[index]!.push(event);
        if (event.type === 'waiting') sawWaiting();
      };

      const seeds: Seed<PgQueryable>[] = [
        {
          name: 'widgets',
          run: async ({ db }) => {
            // Only the run that took the lock gets here, and it is holding it.
            await someoneIsWaiting;
            await db.query("insert into widgets (label) values ('one')");
          },
        },
      ];

      const runs = await Promise.all([
        runSeeds(configOf(seeds), { onEvent: onEventFor(0) }),
        runSeeds(configOf(seeds), { onEvent: onEventFor(1) }),
      ]);

      const winner = runs.findIndex((run) => run.outcomes[0]?.status === 'applied');
      expect(winner).toBeGreaterThanOrEqual(0);
      const loser = 1 - winner;

      expect(await countWidgets()).toBe(1);
      expect(await journalNames()).toEqual(['widgets']);
      expect(runs[loser]!.outcomes[0]).toMatchObject({
        name: 'widgets',
        status: 'skipped',
        reason: { kind: 'already-applied' },
      });

      // Where the event lands is as much the point as that it lands: after the `⋯` line
      // the report already prints, and instead of the silence that used to follow it.
      expect(events[loser]!.map((event) => event.type)).toEqual([
        'plan',
        'start',
        'waiting',
        'skipped',
      ]);
      expect(events[loser]!).toContainEqual({ type: 'waiting', name: 'widgets' });

      // And the run that waited for nobody says nothing about waiting, which is the whole
      // reason the lock is asked for before it is waited on.
      expect(events[winner]!.map((event) => event.type)).toEqual(['plan', 'start', 'applied']);
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

  /**
   * `journalTable` pointed at a table siddy did not create.
   *
   * Only a real database can prove this one: it turns on `create table if not exists`
   * finding somebody else's table and saying nothing, and on what Postgres does with a
   * name that may or may not carry a schema.
   */
  describe('a journal table that is not a journal', () => {
    const adapter = pgAdapter(pool as unknown as PgPool);
    const noop: Seed<PgQueryable>[] = [{ name: 'noop', run: async () => {} }];

    const failureOf = (promise: Promise<unknown>): Promise<unknown> =>
      promise.then(
        () => null,
        (error: unknown) => error,
      );

    test('a run against an application table says so, and says which setting to change', async () => {
      // The collision as it actually happens: `journalTable` names a table that is
      // already there and is somebody else's.
      await pool.query(`create table ${JOURNAL} (id serial primary key, label text not null)`);

      const error = await failureOf(
        runSeeds({ adapter, seeds: noop, env: 'test', journalTable: JOURNAL }),
      );

      expect(error).toBeInstanceOf(JournalTableMismatchError);
      const { message, hint } = error as JournalTableMismatchError;
      expect(message).toBe(`Table "${JOURNAL}" exists but is not siddy's journal`);
      expect(hint).toContain('It has id, label.');
      expect(hint).toContain('A journal has name, applied_at, environment, duration_ms.');
      expect(hint).toContain('`journalTable`');
    });

    test('a schema-qualified name is diagnosed too', async () => {
      // `assertSafeTableName` allows `public.siddy_journal`, so the introspection has to
      // survive the qualified form rather than assuming a bare one.
      await pool.query(`create table ${JOURNAL} (id serial primary key)`);

      const error = await failureOf(
        runSeeds({ adapter, seeds: noop, env: 'test', journalTable: `public.${JOURNAL}` }),
      );

      expect(error).toBeInstanceOf(JournalTableMismatchError);
      expect((error as JournalTableMismatchError).message).toContain(`public.${JOURNAL}`);
    });

    test('an empty journal of the right shape is read, not diagnosed', async () => {
      await ensureJournal(adapter.root, JOURNAL);

      expect((await readJournal(adapter.root, JOURNAL)).size).toBe(0);
    });

    test('a journal with a column of your own added to it still runs', async () => {
      await ensureJournal(adapter.root, JOURNAL);
      await pool.query(`alter table ${JOURNAL} add column note text`);

      const result = await runSeeds({ adapter, seeds: noop, env: 'test', journalTable: JOURNAL });

      expect(result.outcomes[0]).toMatchObject({ name: 'noop', status: 'applied' });
    });

    test('describes the table the read reached, which search_path may have chosen', async () => {
      // A bare name is resolved by Postgres, and not necessarily to `public`. So the
      // diagnosis is resolved the same way — `to_regclass` on the name as configured.
      // Here the name resolves to the wrong-shaped table in `siddy_alt` while a perfectly
      // good journal of the same name sits in `public`: an introspection that assumed
      // `public` would find four valid columns and report nothing at all.
      const client = await pool.connect();

      try {
        await client.query('create schema siddy_alt');
        await client.query(`create table siddy_alt.${JOURNAL} (id serial primary key)`);
        await ensureJournal(adapter.root, `public.${JOURNAL}`);
        await client.query('set search_path to siddy_alt, public');

        // The same scope the adapter builds, over one connection instead of the pool, so
        // that `set search_path` applies to the statements under test.
        const queryable = client as unknown as PgQueryable;
        const scope: Scope<PgQueryable> = {
          db: queryable,
          execute: async (sql, params) => (await queryable.query(sql, params)).rows,
        };

        const error = await failureOf(readJournal(scope, JOURNAL));

        expect(error).toBeInstanceOf(JournalTableMismatchError);
        expect((error as JournalTableMismatchError).hint).toContain('It has id.');
      } finally {
        // The connection goes back to the pool, so the search_path has to go back with it.
        await client.query('reset search_path');
        await client.query('drop schema siddy_alt cascade');
        client.release();
      }
    });
  });

  /**
   * The adapter as the consumer migrating onto it uses it: writing with query builders,
   * never with `sql`.
   *
   * Those builders reach a seed through a cast — `drizzleAdapter` hands `fn` a
   * `scopeFor(tx as TDb)`, because Drizzle's transaction object carries the builders but
   * is not literally the database. Nothing about that is visible from a raw-SQL test,
   * which needs only `execute`. So the block below writes the way a consumer writes.
   */
  describe('drizzleAdapter', () => {
    const db = drizzle(pool);
    type Db = typeof db;

    /**
     * What a consumer writes. No cast: `TDb` infers as the database type itself, so
     * `ctx.db` arrives with every builder on it. Typing the config `Config<DrizzleLike>`
     * instead — as the two raw-SQL tests below do — erases them, and a seed typed that way
     * cannot call `.insert()` at all.
     */
    const adapter = drizzleAdapter(db);

    /**
     * The same database seen through only the two members the adapter is documented to
     * need. The annotation is the assertion: a real `NodePgDatabase` satisfies
     * `DrizzleLike` structurally and needs no cast to do it, so this really is what a
     * driver this suite never loads would get.
     */
    const narrowed: DrizzleLike = db;
    const narrowedAdapter = drizzleAdapter(narrowed);

    const widgets = pgTable('widgets', {
      id: serial('id').primaryKey(),
      label: text('label').notNull(),
    });

    // `widget_tags` belongs to this block alone, so it is created here rather than in the
    // shared fixture. No foreign key: the outer `beforeEach` drops `widgets` first, and a
    // reference would make that fail. The join in the test is what checks the ids anyway.
    const widgetTags = pgTable('widget_tags', {
      id: serial('id').primaryKey(),
      widgetId: integer('widget_id').notNull(),
      tag: text('tag').notNull(),
    });

    beforeEach(async () => {
      await pool.query('drop table if exists widget_tags');
      await pool.query(
        'create table widget_tags (id serial primary key, widget_id integer not null, tag text not null)',
      );
    });

    afterAll(async () => {
      await pool.query('drop table if exists widget_tags');
    });

    // Read back through the pool rather than through a builder: the assertion has to come
    // from somewhere other than the thing under test.
    async function widgetLabels(): Promise<string[]> {
      const { rows } = await pool.query<{ label: string }>(
        'select label from widgets order by label',
      );
      return rows.map((row) => row.label);
    }

    test('drives the same journal through Drizzle', async () => {
      const config: Config<DrizzleLike> = {
        adapter: narrowedAdapter,
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
        adapter: narrowedAdapter,
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

    test('a seed writing with query builders commits, and is journalled', async () => {
      const config: Config<Db> = {
        adapter,
        env: 'test',
        journalTable: JOURNAL,
        seeds: [
          {
            name: 'widgets',
            run: async ({ db }) => {
              await db.insert(widgets).values([{ label: 'built' }, { label: 'by builder' }]);
            },
          },
        ],
      };

      await runSeeds(config);

      // The labels, not the count: a builder that inserted defaults would pass a count.
      expect(await widgetLabels()).toEqual(['built', 'by builder']);
      expect(await journalNames()).toEqual(['widgets']);
    });

    test('a builder seed that throws leaves neither its rows nor its journal entry', async () => {
      const config: Config<Db> = {
        adapter,
        env: 'test',
        journalTable: JOURNAL,
        seeds: [
          {
            name: 'widgets',
            run: async ({ db }) => {
              await db.insert(widgets).values({ label: 'rolled back' });
              // Deliberately not a constraint violation, unlike the raw-SQL test above.
              // Postgres has aborted nothing here, so the row disappears for exactly one
              // reason: what the cast handed the seed was the transaction, not the
              // database. Had it been the database, this row would still be there.
              throw new Error('half way through');
            },
          },
        ],
      };

      await expect(runSeeds(config)).rejects.toThrow('half way through');

      expect(await countWidgets()).toBe(0);
      expect(await journalNames()).toEqual([]);
    });

    test('a dependent seed reads back with a builder what the seed before it wrote', async () => {
      const config: Config<Db> = {
        adapter,
        env: 'test',
        journalTable: JOURNAL,
        seeds: [
          {
            name: 'widgets',
            run: async ({ db }) => {
              await db.insert(widgets).values([{ label: 'left' }, { label: 'right' }]);
            },
          },
          {
            name: 'tags',
            dependsOn: ['widgets'],
            run: async ({ db }) => {
              // Each seed runs in its own transaction, so a select is the only way the
              // generated ids reach here. That is what `dependsOn` is for, and it has to
              // hold through the cast in both directions: the read sees another
              // transaction's committed rows, the write goes into this one.
              const rows = await db.select().from(widgets).orderBy(widgets.label);
              expect(rows).toHaveLength(2);

              await db
                .insert(widgetTags)
                .values(rows.map((row) => ({ widgetId: row.id, tag: `${row.label}-tag` })));
            },
          },
        ],
      };

      await runSeeds(config);

      // Joined rather than read straight out: two tag rows carrying the wrong ids would
      // still be two tag rows.
      const { rows } = await pool.query<{ label: string; tag: string }>(
        'select w.label, t.tag from widget_tags t join widgets w on w.id = t.widget_id order by t.tag',
      );
      expect(rows).toEqual([
        { label: 'left', tag: 'left-tag' },
        { label: 'right', tag: 'right-tag' },
      ]);
      expect(await journalNames()).toEqual(['tags', 'widgets']);
    });

    test('$client is absent inside a transaction, though the types promise a Pool', async () => {
      /**
       * The one place the cast is visible to a seed, pinned so that a Drizzle release
       * which starts forwarding the handle shows up here rather than in production.
       *
       * `drizzle()` assigns `$client` onto the database object it returns. The transaction
       * object is a different object — `NodePgTransaction` — and never gets one, so a
       * transactional seed reading `db.$client` gets `undefined` and any call through it
       * throws a TypeError. The type says `Pool`, because `tx as TDb` is the same cast
       * that makes the builders typecheck; it cannot promise one without the other.
       *
       * A seed that genuinely needs the driver handle wants `transaction: false`, which
       * hands it `adapter.root.db` — the database, so the real pool.
       */
      let insideTransaction: unknown = 'never ran';
      let insideHasTheKey: unknown = 'never ran';
      let outsideTransaction: unknown = 'never ran';

      const config: Config<Db> = {
        adapter,
        env: 'test',
        journalTable: JOURNAL,
        seeds: [
          {
            name: 'inside',
            run: async ({ db }) => {
              insideTransaction = db.$client;
              insideHasTheKey = '$client' in db;
            },
          },
          {
            name: 'outside',
            transaction: false,
            run: async ({ db }) => {
              outsideTransaction = db.$client;
            },
          },
        ],
      };

      await runSeeds(config);

      expect(insideTransaction).toBeUndefined();
      expect(insideHasTheKey).toBe(false);
      expect(outsideTransaction).toBe(pool);
    });
  });
});
