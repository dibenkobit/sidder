import { describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSeeds, SeedFailedError } from '../src/run.ts';
import type { Config, RunEvent, Seed } from '../src/types.ts';
import { createMemoryAdapter, type MemoryDb } from './helpers/memory-adapter.ts';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function setup(seeds: Seed<MemoryDb>[], env = 'development') {
  const memory = createMemoryAdapter();
  const config: Config<MemoryDb> = { adapter: memory.adapter, seeds, env };
  return { config, memory };
}

/** A seed that records that it ran, and can be told to blow up. */
function writing(name: string, extra: Partial<Seed<MemoryDb>> = {}): Seed<MemoryDb> {
  return {
    name,
    run: async ({ db }) => {
      db.write(name);
    },
    ...extra,
  };
}

/** The failure a run threw. Fails the test if it did not throw one. */
async function failureOf(run: Promise<unknown>): Promise<SeedFailedError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof SeedFailedError) return error;
    throw error;
  }
  throw new Error('expected the run to throw SeedFailedError');
}

describe('runSeeds', () => {
  test('runs seeds in dependency order regardless of the order given', async () => {
    const { config, memory } = setup([
      writing('demo', { dependsOn: ['territory', 'roles'] }),
      writing('territory'),
      writing('roles'),
    ]);

    await runSeeds(config);

    expect(memory.committed.writes).toEqual(['territory', 'roles', 'demo']);
  });

  test('records every applied seed in the journal', async () => {
    const { config, memory } = setup([writing('roles'), writing('territory')]);

    const result = await runSeeds(config);

    expect([...memory.committed.journal.keys()].sort()).toEqual(['roles', 'territory']);
    expect(result.outcomes.map((o) => o.status)).toEqual(['applied', 'applied']);
    expect(memory.committed.journal.get('roles')?.environment).toBe('development');
  });

  test('a second run skips what the first one applied', async () => {
    const { config, memory } = setup([writing('roles')]);

    await runSeeds(config);
    const second = await runSeeds(config);

    expect(memory.committed.writes).toEqual(['roles']);
    expect(second.outcomes[0]).toMatchObject({ status: 'skipped' });
  });

  test('an always seed runs again on every invocation', async () => {
    const { config, memory } = setup([writing('roles', { mode: 'always' })]);

    await runSeeds(config);
    await runSeeds(config);

    expect(memory.committed.writes).toEqual(['roles', 'roles']);
  });

  test('a failing seed rolls back its own writes and its journal row', async () => {
    const { config, memory } = setup([
      writing('roles'),
      {
        name: 'demo',
        dependsOn: ['roles'],
        run: async ({ db }) => {
          db.write('demo');
          throw new Error('constraint violation');
        },
      },
      writing('never-reached', { dependsOn: ['demo'] }),
    ]);

    await expect(runSeeds(config)).rejects.toThrow('constraint violation');

    // The seed that succeeded stays committed, the one that failed left nothing behind,
    // and nothing after it ran at all.
    expect(memory.committed.writes).toEqual(['roles']);
    expect([...memory.committed.journal.keys()]).toEqual(['roles']);
  });

  test('a rolled back seed runs again on the next invocation', async () => {
    let shouldFail = true;
    const { config, memory } = setup([
      writing('roles'),
      {
        name: 'demo',
        dependsOn: ['roles'],
        run: async ({ db }) => {
          db.write('demo');
          if (shouldFail) throw new Error('transient');
        },
      },
    ]);

    await expect(runSeeds(config)).rejects.toThrow('transient');
    shouldFail = false;
    await runSeeds(config);

    // roles was applied once and skipped the second time; demo resumed.
    expect(memory.committed.writes).toEqual(['roles', 'demo']);
  });

  test('transaction: false means the writes survive the failure — that is the trade', async () => {
    const { config, memory } = setup([
      {
        name: 'bulk',
        transaction: false,
        run: async ({ db }) => {
          db.write('bulk');
          throw new Error('half way through');
        },
      },
    ]);

    await expect(runSeeds(config)).rejects.toThrow('half way through');

    expect(memory.committed.writes).toEqual(['bulk']);
    expect(memory.committed.journal.size).toBe(0);
  });

  test('locks the seed and re-reads its row before running it', async () => {
    // The order is the whole protection: a lock taken after the seed ran, or a journal
    // read taken before the lock, would leave the window this closes wide open. Nothing
    // in one process can prove the lock excludes anybody — postgres.test.ts does that —
    // but the sequence is checkable here, from inside the seed that comes after it.
    let seenWhenTheSeedRan: string[] = [];
    const { config, memory } = setup([
      {
        name: 'roles',
        run: async () => {
          seenWhenTheSeedRan = [...memory.statements];
        },
      },
    ]);

    await runSeeds(config);

    expect(seenWhenTheSeedRan).toEqual([
      'create table if not exists sowme_journal (',
      'select name, applied_at, environment, duration_ms from sowme_journal',
      'select pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      'select name, applied_at, environment, duration_ms from sowme_journal where name = $1',
    ]);
  });

  test('the throw says which seeds committed before it', async () => {
    const boom = new Error('constraint violation');
    const { config } = setup([
      writing('roles'),
      {
        name: 'demo',
        dependsOn: ['roles'],
        run: async () => {
          throw boom;
        },
      },
      writing('never-reached', { dependsOn: ['demo'] }),
    ]);

    const failure = await failureOf(runSeeds(config));

    expect(failure.seed).toBe('demo');
    expect(failure.rolledBack).toBe(true);
    expect(failure.result.env).toBe('development');
    // The whole point: resuming needs "roles is in, demo is not", without an onEvent
    // accumulator duplicating what the runner already built.
    expect(failure.result.outcomes).toEqual([
      { name: 'roles', status: 'applied', durationMs: expect.any(Number) },
      { name: 'demo', status: 'failed', error: boom, rolledBack: true },
      // Nothing for never-reached: the run stopped, it was not skipped.
    ]);
  });

  test('the throw keeps the seed error as its cause and in its message', async () => {
    const boom = new Error('duplicate key value violates unique constraint');
    const { config } = setup([
      {
        name: 'demo',
        run: async () => {
          throw boom;
        },
      },
    ]);

    const failure = await failureOf(runSeeds(config));

    // Identity, not equality: a formatter reading Postgres fields off the error needs
    // the driver's object, not a copy of its message.
    expect(failure.cause).toBe(boom);
    expect(failure.message).toContain('duplicate key value violates unique constraint');
    expect(failure.message).toContain('demo');
  });

  test('a transaction: false failure reports that its writes are still there', async () => {
    const { config } = setup([
      {
        name: 'bulk',
        transaction: false,
        run: async () => {
          throw new Error('half way through');
        },
      },
    ]);

    const failure = await failureOf(runSeeds(config));

    expect(failure.rolledBack).toBe(false);
    expect(failure.result.outcomes[0]).toMatchObject({ status: 'failed', rolledBack: false });
  });

  test('a failure after a skip keeps the skip in the outcomes', async () => {
    const { config } = setup([
      writing('fake-users', { environments: ['test'] }),
      {
        name: 'demo',
        run: async () => {
          throw new Error('nope');
        },
      },
    ]);

    const failure = await failureOf(runSeeds(config));

    expect(failure.result.outcomes.map((o) => o.status)).toEqual(['skipped', 'failed']);
  });

  test('journal: false runs everything and records nothing', async () => {
    const { config, memory } = setup([writing('roles')]);

    await runSeeds(config, { journal: false });
    await runSeeds(config, { journal: false });

    expect(memory.committed.writes).toEqual(['roles', 'roles']);
    expect(memory.committed.journal.size).toBe(0);
    expect(memory.statements).toEqual([]);
  });

  test('dry run decides everything and executes nothing', async () => {
    const { config, memory } = setup([writing('roles'), writing('demo', { dependsOn: ['roles'] })]);

    const result = await runSeeds(config, { dryRun: true });

    expect(result.outcomes).toEqual([
      { name: 'roles', status: 'would-run' },
      { name: 'demo', status: 'would-run' },
    ]);
    expect(memory.committed.writes).toEqual([]);
    expect(memory.committed.journal.size).toBe(0);
  });

  test('a dry run is distinguishable from a real one by the outcomes alone', async () => {
    const { config } = setup([writing('roles')]);

    const dry = await runSeeds(config, { dryRun: true });
    const real = await runSeeds(config);

    // The filter a caller reaches for first has to come back empty for the dry run.
    expect(dry.outcomes.filter((o) => o.status === 'applied')).toEqual([]);
    expect(real.outcomes.filter((o) => o.status === 'applied')).toHaveLength(1);
    // And no duration is claimed for something that was never timed.
    expect(dry.outcomes[0]).not.toHaveProperty('durationMs');
  });

  test('a dry run emits would-run events instead of applied ones', async () => {
    const { config } = setup([writing('roles'), writing('demo', { dependsOn: ['roles'] })]);
    const events: RunEvent[] = [];

    await runSeeds(config, { dryRun: true, onEvent: (event) => events.push(event) });

    expect(events).toEqual([
      { type: 'plan', env: 'development', order: ['roles', 'demo'] },
      { type: 'would-run', name: 'roles' },
      { type: 'would-run', name: 'demo' },
    ]);
  });

  test('skips seeds gated to another environment and says which', async () => {
    const { config, memory } = setup(
      [writing('roles'), writing('fake-users', { environments: ['development'] })],
      'production',
    );

    const result = await runSeeds(config);

    expect(memory.committed.writes).toEqual(['roles']);
    expect(result.outcomes[1]).toMatchObject({
      status: 'skipped',
      reason: { kind: 'wrong-env', allowed: ['development'] },
    });
  });

  test('--env overrides the config', async () => {
    const { config, memory } = setup(
      [writing('fake-users', { environments: ['development'] })],
      'production',
    );

    await runSeeds(config, { env: 'development' });

    expect(memory.committed.writes).toEqual(['fake-users']);
  });

  test('only runs the named seeds', async () => {
    const { config, memory } = setup([writing('roles'), writing('territory')]);

    await runSeeds(config, { only: ['roles'] });

    expect(memory.committed.writes).toEqual(['roles']);
  });

  test('force applies a seed the journal already has', async () => {
    const { config, memory } = setup([writing('demo')]);

    await runSeeds(config);
    await runSeeds(config, { force: true });

    // Ran twice, recorded once — the row is rewritten, not duplicated. That the new row
    // carries the *later* time needs a real timestamp, so postgres.test.ts proves it.
    expect(memory.committed.writes).toEqual(['demo', 'demo']);
    expect([...memory.committed.journal.keys()]).toEqual(['demo']);
  });

  test('force still respects environments', async () => {
    const { config, memory } = setup(
      [writing('fake-users', { environments: ['development'] })],
      'production',
    );

    const result = await runSeeds(config, { force: true });

    expect(memory.committed.writes).toEqual([]);
    expect(result.outcomes[0]).toMatchObject({ reason: { kind: 'wrong-env' } });
  });

  test('--only and --force compose: exactly that seed, journal or not', async () => {
    const { config, memory } = setup([writing('roles'), writing('demo')]);

    await runSeeds(config);
    await runSeeds(config, { only: ['demo'], force: true });

    expect(memory.committed.writes).toEqual(['roles', 'demo', 'demo']);
  });

  test('emits a plan before anything runs, then one event per seed', async () => {
    const { config } = setup([writing('roles'), writing('demo', { dependsOn: ['roles'] })]);
    const events: RunEvent[] = [];

    await runSeeds(config, { onEvent: (event) => events.push(event) });

    expect(events[0]).toEqual({ type: 'plan', env: 'development', order: ['roles', 'demo'] });
    expect(events.filter((e) => e.type === 'applied').map((e) => e.name)).toEqual([
      'roles',
      'demo',
    ]);
  });

  test('hands each seed its own name and the resolved environment', async () => {
    const seen: Array<{ name: string; env: string }> = [];
    const { config } = setup([
      { name: 'roles', run: async ({ name, env }) => void seen.push({ name, env }) },
    ]);

    await runSeeds(config, { env: 'staging' });

    expect(seen).toEqual([{ name: 'roles', env: 'staging' }]);
  });

  test('does not close the adapter — the caller owns the pool', async () => {
    const { config, memory } = setup([writing('roles')]);

    await runSeeds(config);

    expect(memory.closed).toBe(false);
  });
});

/**
 * Real files, because the finding is made by reading them. `tests/fixtures/cross` is the
 * real consumer's shape: `demo` imports `territory`'s constants and its work in one
 * statement, and sowme runs `territory` as a seed as well.
 */
describe('runSeeds and seeds that import each other', () => {
  /** A run over the fixture directory, with every event it emitted. */
  async function runFixtures(glob: string, options: { only?: string[] } = {}) {
    const memory = createMemoryAdapter();
    const config: Config<MemoryDb> = { adapter: memory.adapter, seeds: glob, env: 'development' };
    const events: RunEvent[] = [];

    const result = await runSeeds(config, {
      baseDir: fixtures,
      onEvent: (event) => events.push(event),
      ...options,
    });

    return { result, events, memory };
  }

  test('names the seeds and the bindings it read out of the files', async () => {
    const { events } = await runFixtures('cross/*.ts');

    expect(events.find((event) => event.type === 'cross-imports')).toEqual({
      type: 'cross-imports',
      findings: [{ from: 'demo', to: 'territory', bindings: ['REGIONS', 'seedTerritory'] }],
    });
  });

  /** The whole contract: a warning. It never throws, never skips and never changes a run. */
  test('changes nothing about the run it warns about', async () => {
    const { result, memory } = await runFixtures('cross/*.ts');

    expect(result.outcomes).toEqual([
      { name: 'territory', status: 'applied', durationMs: expect.any(Number) },
      { name: 'demo', status: 'applied', durationMs: expect.any(Number) },
    ]);
    expect([...memory.committed.journal.keys()]).toEqual(['territory', 'demo']);
  });

  test('arrives after the plan and before the first seed, so it can still be acted on', async () => {
    const { events } = await runFixtures('cross/*.ts');
    const types = events.map((event) => event.type);

    expect(types.indexOf('cross-imports')).toBe(types.indexOf('plan') + 1);
    expect(types.indexOf('cross-imports')).toBeLessThan(types.indexOf('start'));
  });

  /**
   * `--only territory` selects the seed being imported and leaves the importer out. The
   * import is still in `demo.ts`, and a narrowed run is where its second application is
   * least visible — so the selection does not narrow this.
   */
  test('is not narrowed by --only', async () => {
    const { events, result } = await runFixtures('cross/*.ts', { only: ['territory'] });

    expect(events.find((event) => event.type === 'cross-imports')).toMatchObject({
      findings: [{ from: 'demo', to: 'territory' }],
    });
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(['applied', 'skipped']);
  });

  test('emits nothing at all for a project where no seed imports another', async () => {
    const { events } = await runFixtures('seeds/**/*.ts');

    expect(events.filter((event) => event.type === 'cross-imports')).toEqual([]);
  });

  test('a dry run reports it too — checking is the point of a dry run', async () => {
    const memory = createMemoryAdapter();
    const config: Config<MemoryDb> = {
      adapter: memory.adapter,
      seeds: 'cross/*.ts',
      env: 'development',
    };
    const events: RunEvent[] = [];

    await runSeeds(config, {
      baseDir: fixtures,
      dryRun: true,
      onEvent: (event) => events.push(event),
    });

    expect(events.some((event) => event.type === 'cross-imports')).toBe(true);
    expect(memory.committed.journal.size).toBe(0);
  });
});
