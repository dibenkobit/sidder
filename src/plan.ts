import { MissingDependencyError } from './errors.ts';
import type { JournalEntry, ResolvedSeed, SkipReason } from './types.ts';

export type Decision = { action: 'run' } | { action: 'skip'; reason: SkipReason };

export interface PlanInput {
  env: string;
  /** The journal, or null when running without one (`journal: false`). */
  journal: Map<string, JournalEntry> | null;
  /** The `--only` selection, or null for "everything". */
  only: Set<string> | null;
}

/**
 * Decides whether one seed runs. No I/O, no ordering, no side effects — everything
 * this needs is in its arguments, which is why the interesting cases are all covered
 * by tests that never touch a database.
 *
 * The order of the checks is the order of the answers you want to hear. Asking for a
 * dev-only seed in production should say "wrong environment", not "you didn't select
 * it" — so selection is checked first and everything that survives it gets a real reason.
 */
export function decide<TDb>(seed: ResolvedSeed<TDb>, input: PlanInput): Decision {
  if (input.only !== null && !input.only.has(seed.name)) {
    return { action: 'skip', reason: { kind: 'not-selected' } };
  }

  if (seed.environments !== undefined && !seed.environments.includes(input.env)) {
    return { action: 'skip', reason: { kind: 'wrong-env', allowed: seed.environments } };
  }

  // Without a journal there is nothing to consult, so `mode` has nothing to mean.
  if (input.journal === null) return { action: 'run' };

  if ((seed.mode ?? 'once') === 'always') return { action: 'run' };

  const entry = input.journal.get(seed.name);
  if (entry !== undefined) {
    return { action: 'skip', reason: { kind: 'already-applied', appliedAt: entry.appliedAt } };
  }

  return { action: 'run' };
}

/**
 * Refuses to start a run where something about to execute depends on something that
 * will neither run nor has already run.
 *
 * Only `--only` triggers this. A dependency skipped for the environment is fine and
 * deliberate: `environments` is a gate you wrote into the file, so a dev-only seed
 * genuinely does not exist in production and depending on it there is your decision.
 * `--only` is a thing you typed thirty seconds ago, and forgetting a name in it is a
 * mistake worth stopping for. sowme does not quietly widen your selection to fix it.
 */
export function assertSelectionIsRunnable<TDb>(
  seeds: readonly ResolvedSeed<TDb>[],
  decisions: ReadonlyMap<string, Decision>,
  journal: Map<string, JournalEntry> | null,
): void {
  for (const seed of seeds) {
    if (decisions.get(seed.name)?.action !== 'run') continue;

    for (const dependency of seed.dependsOn ?? []) {
      if (journal?.has(dependency)) continue;

      const decision = decisions.get(dependency);
      if (decision?.action === 'run') continue;
      if (decision?.action === 'skip' && decision.reason.kind !== 'not-selected') continue;

      throw new MissingDependencyError(seed.name, dependency);
    }
  }
}
