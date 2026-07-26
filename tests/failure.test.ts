import { describe, expect, test } from 'bun:test';
import { formatSeedFailure } from '../src/cli/format.ts';
import { runSeeds, SeedFailedError } from '../src/run.ts';
import type { Config } from '../src/types.ts';
import { createMemoryAdapter, type MemoryDb } from './helpers/memory-adapter.ts';

/**
 * What the CLI prints when a seed throws, and what it needs from the throw to print it.
 *
 * The trap this file exists to pin: `formatSeedFailure` reads `detail`, `constraint`,
 * `table` and `code` off the error object it is handed. Wrapping a seed's failure and
 * then handing the *wrapper* to the formatter would compile, pass every other test, and
 * silently replace "which row violated which constraint" with a generic headline.
 */

/** A pg error, as `pg` actually hands one over: fields on the error, not in the message. */
function databaseError(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint "roles_pkey"'), {
    code: '23505',
    detail: 'Key (id)=(1) already exists.',
    table: 'roles',
    constraint: 'roles_pkey',
    severity: 'ERROR',
  });
}

function failing(error: unknown, extra: { transaction?: boolean } = {}) {
  const memory = createMemoryAdapter();
  const config: Config<MemoryDb> = {
    adapter: memory.adapter,
    env: 'development',
    seeds: [
      {
        name: 'roles',
        ...extra,
        run: async () => {
          throw error;
        },
      },
    ],
  };
  return config;
}

async function failureOf(run: Promise<unknown>): Promise<SeedFailedError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof SeedFailedError) return error;
    throw error;
  }
  throw new Error('expected the run to throw SeedFailedError');
}

describe('reporting a seed failure', () => {
  test('the CLI path reports every Postgres field the driver attached', async () => {
    const failure = await failureOf(runSeeds(failing(databaseError())));

    // Exactly what cli/main.ts does with what it caught.
    const report = formatSeedFailure(failure.seed, failure.cause, {
      rolledBack: failure.rolledBack,
      trace: false,
    });

    expect(report).toContain('roles failed');
    expect(report).toContain('rolled back');
    expect(report).toContain('duplicate key value violates unique constraint "roles_pkey"');
    expect(report).toContain('detail: Key (id)=(1) already exists.');
    expect(report).toContain('constraint: roles_pkey');
    expect(report).toContain('table: roles');
    expect(report).toContain('code: 23505');
  });

  test('handing the wrapper to the formatter would lose them — which is why it is not', async () => {
    const failure = await failureOf(runSeeds(failing(databaseError())));

    const wrong = formatSeedFailure(failure.seed, failure, {
      rolledBack: failure.rolledBack,
      trace: false,
    });

    // Not a rule, a warning shot: if this ever starts passing, the wrapper grew the
    // driver's fields and the assertion above stopped being the thing that protects them.
    expect(wrong).not.toContain('detail: Key (id)=(1) already exists.');
  });

  test('names the seed and says the writes survived when transaction is false', async () => {
    const failure = await failureOf(runSeeds(failing(databaseError(), { transaction: false })));

    const report = formatSeedFailure(failure.seed, failure.cause, {
      rolledBack: failure.rolledBack,
      trace: false,
    });

    expect(report).toContain('NOT rolled back');
    expect(report).toContain('constraint: roles_pkey');
  });

  test('a seed that throws a string is still reported', async () => {
    const failure = await failureOf(runSeeds(failing('just a string')));

    expect(failure.cause).toBe('just a string');
    expect(failure.message).toContain('just a string');
    expect(
      formatSeedFailure(failure.seed, failure.cause, { rolledBack: true, trace: false }),
    ).toContain('just a string');
  });
});
