import { describe, expect, test } from 'bun:test';
import { MissingDependencyError } from '../../src/errors.ts';
import {
  assertSelectionIsRunnable,
  type Decision,
  decide,
  type PlanInput,
} from '../../src/plan/plan.ts';
import type { JournalEntry, ResolvedSeed, Seed } from '../../src/types.ts';

function seed(name: string, extra: Partial<Seed> = {}): ResolvedSeed {
  return { name, file: `${name}.ts`, run: async () => {}, ...extra };
}

function journalOf(...names: string[]): Map<string, JournalEntry> {
  return new Map(
    names.map((name) => [
      name,
      { name, appliedAt: new Date('2026-07-20'), environment: 'development', durationMs: 1 },
    ]),
  );
}

/** The boring parts filled in, so each test states only the thing it is about. */
function input(extra: Partial<PlanInput> = {}): PlanInput {
  return { env: 'development', journal: journalOf(), only: null, force: false, ...extra };
}

describe('decide', () => {
  test('runs a once seed that has never run', () => {
    expect(decide(seed('roles'), input())).toEqual({ action: 'run' });
  });

  test('skips a once seed that is already in the journal', () => {
    const decision = decide(seed('roles'), input({ journal: journalOf('roles') }));

    expect(decision.action).toBe('skip');
    expect(decision.action === 'skip' && decision.reason.kind).toBe('already-applied');
  });

  test('runs an always seed even though it is in the journal', () => {
    const decision = decide(
      seed('roles', { mode: 'always' }),
      input({ journal: journalOf('roles') }),
    );

    expect(decision).toEqual({ action: 'run' });
  });

  test('skips a seed whose environments do not include this one', () => {
    const decision = decide(
      seed('fake-users', { environments: ['development', 'staging'] }),
      input({ env: 'production' }),
    );

    expect(decision).toEqual({
      action: 'skip',
      reason: { kind: 'wrong-env', allowed: ['development', 'staging'] },
    });
  });

  test('runs a seed with no environments declared in any environment', () => {
    expect(decide(seed('roles'), input({ env: 'production' }))).toEqual({ action: 'run' });
  });

  test('skips anything outside the selection', () => {
    const decision = decide(seed('demo'), input({ only: new Set(['roles']) }));

    expect(decision).toEqual({ action: 'skip', reason: { kind: 'not-selected' } });
  });

  test('a selected seed still gets the environment answer, not "not selected"', () => {
    // Asking for a dev-only seed in production should say why it cannot run there,
    // rather than pretending you did not ask for it.
    const decision = decide(
      seed('fake-users', { environments: ['development'] }),
      input({ env: 'production', only: new Set(['fake-users']) }),
    );

    expect(decision.action === 'skip' && decision.reason.kind).toBe('wrong-env');
  });

  test('without a journal every mode runs', () => {
    for (const mode of ['once', 'always'] as const) {
      expect(decide(seed('roles', { mode }), input({ journal: null }))).toEqual({ action: 'run' });
    }
  });

  test('environments still gate a run with no journal', () => {
    const decision = decide(
      seed('fake-users', { environments: ['development'] }),
      input({ env: 'production', journal: null }),
    );

    expect(decision.action).toBe('skip');
  });

  test('force runs a seed the journal has already recorded', () => {
    const decision = decide(seed('demo'), input({ journal: journalOf('demo'), force: true }));

    expect(decision).toEqual({ action: 'run' });
  });

  test('force does not defeat environments — that gate is declared, not remembered', () => {
    const decision = decide(
      seed('fake-users', { environments: ['development'] }),
      input({ env: 'production', force: true }),
    );

    expect(decision).toEqual({
      action: 'skip',
      reason: { kind: 'wrong-env', allowed: ['development'] },
    });
  });

  test('force does not widen the selection', () => {
    const decision = decide(seed('demo'), input({ only: new Set(['roles']), force: true }));

    expect(decision).toEqual({ action: 'skip', reason: { kind: 'not-selected' } });
  });
});

describe('assertSelectionIsRunnable', () => {
  const decisions = (entries: Record<string, Decision>) => new Map(Object.entries(entries));

  test('refuses when --only leaves a dependency behind', () => {
    expect(() =>
      assertSelectionIsRunnable(
        [seed('demo', { dependsOn: ['territory'] }), seed('territory')],
        decisions({
          demo: { action: 'run' },
          territory: { action: 'skip', reason: { kind: 'not-selected' } },
        }),
        journalOf(),
      ),
    ).toThrow(MissingDependencyError);
  });

  test('accepts a dependency that already ran', () => {
    expect(() =>
      assertSelectionIsRunnable(
        [seed('demo', { dependsOn: ['territory'] }), seed('territory')],
        decisions({
          demo: { action: 'run' },
          territory: { action: 'skip', reason: { kind: 'not-selected' } },
        }),
        journalOf('territory'),
      ),
    ).not.toThrow();
  });

  test('accepts a dependency skipped for the environment — that gate is declared, not typed', () => {
    expect(() =>
      assertSelectionIsRunnable(
        [seed('demo', { dependsOn: ['fake-users'] }), seed('fake-users')],
        decisions({
          demo: { action: 'run' },
          'fake-users': { action: 'skip', reason: { kind: 'wrong-env', allowed: ['development'] } },
        }),
        journalOf(),
      ),
    ).not.toThrow();
  });

  test('says which seed and which dependency', () => {
    try {
      assertSelectionIsRunnable(
        [seed('demo', { dependsOn: ['territory'] })],
        decisions({ demo: { action: 'run' } }),
        journalOf(),
      );
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as MissingDependencyError).message).toContain('demo');
      expect((error as MissingDependencyError).message).toContain('territory');
      expect((error as MissingDependencyError).hint).toContain('--only territory,demo');
    }
  });
});
