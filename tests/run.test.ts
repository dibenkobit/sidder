import { describe, expect, test } from 'bun:test';
import { runSeeds } from '../src/run.ts';
import type { Config, RunEvent, Seed } from '../src/types.ts';
import { createMemoryAdapter, type MemoryDb } from './helpers/memory-adapter.ts';

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

    expect(result.outcomes.map((o) => o.status)).toEqual(['applied', 'applied']);
    expect(memory.committed.writes).toEqual([]);
    expect(memory.committed.journal.size).toBe(0);
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
