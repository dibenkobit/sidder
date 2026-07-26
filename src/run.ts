import { resolveConfig } from './config.ts';
import { discoverSeeds } from './discover.ts';
import { ensureJournal, readJournal, recordApplied } from './journal.ts';
import { orderSeeds } from './order.ts';
import { assertSelectionIsRunnable, type Decision, decide } from './plan.ts';
import type {
  Adapter,
  Config,
  JournalEntry,
  ResolvedSeed,
  RunEvent,
  RunOptions,
  RunResult,
  Scope,
  SeedOutcome,
} from './types.ts';

/**
 * Runs your seeds. One process, one connection, order worked out from `dependsOn`.
 *
 * This is the whole tool; the CLI is a formatter wrapped around this call. Tests are
 * the reason it is exported: persona two wants "run these three seeds now and forget
 * it happened", which is `{ only: [...], journal: false }` and no command line at all.
 *
 * Throws on the first seed that fails, after emitting a `failed` event. The seeds that
 * already succeeded stay committed and journalled, so the next run picks up where this
 * one stopped.
 */
export async function runSeeds<TDb>(
  config: Config<TDb>,
  options: RunOptions = {},
): Promise<RunResult> {
  const resolved = resolveConfig(config, { env: options.env, baseDir: options.baseDir });
  const { adapter, env, journalTable } = resolved;

  const useJournal = options.journal ?? true;
  const emit = (event: RunEvent) => options.onEvent?.(event);

  const discovered = await discoverSeeds(resolved.seeds, resolved.baseDir);
  const ordered = orderSeeds(discovered);

  let journal: Map<string, JournalEntry> | null = null;
  if (useJournal) {
    await ensureJournal(adapter.root, journalTable);
    journal = await readJournal(adapter.root, journalTable);
  }

  const only = options.only ? new Set(options.only) : null;
  const decisions = new Map<string, Decision>(
    ordered.map((seed) => [seed.name, decide(seed, { env, journal, only })]),
  );
  assertSelectionIsRunnable(ordered, decisions, journal);

  emit({ type: 'plan', env, order: ordered.map((seed) => seed.name) });

  const outcomes: SeedOutcome[] = [];

  for (const seed of ordered) {
    const decision = decisions.get(seed.name)!;

    if (decision.action === 'skip') {
      outcomes.push({ name: seed.name, status: 'skipped', reason: decision.reason });
      emit({ type: 'skipped', name: seed.name, reason: decision.reason });
      continue;
    }

    if (options.dryRun) {
      // Decided, not executed. Reported as applied with no duration so the plan reads
      // the same shape as a real run would.
      outcomes.push({ name: seed.name, status: 'applied', durationMs: 0 });
      emit({ type: 'applied', name: seed.name, durationMs: 0 });
      continue;
    }

    emit({ type: 'start', name: seed.name });
    const startedAt = performance.now();

    try {
      await executeSeed(seed, {
        adapter,
        env,
        journalTable: useJournal ? journalTable : null,
        startedAt,
      });
    } catch (error) {
      const rolledBack = seed.transaction !== false;
      outcomes.push({ name: seed.name, status: 'failed', error, rolledBack });
      emit({ type: 'failed', name: seed.name, error, rolledBack });
      throw error;
    }

    const durationMs = Math.round(performance.now() - startedAt);
    outcomes.push({ name: seed.name, status: 'applied', durationMs });
    emit({ type: 'applied', name: seed.name, durationMs });
  }

  return { env, outcomes };
}

/**
 * Runs one seed, and records it in the same scope it ran in.
 *
 * When the seed is transactional, `recordApplied` is called with the transaction's own
 * scope, so the journal row commits with the seed's writes or not at all. When it is
 * not — `transaction: false` — the record is written afterwards through the root scope
 * and the two can diverge. That is exactly the risk you opted into, and `sowme status`
 * says so out loud for any seed that opted into it.
 */
async function executeSeed<TDb>(
  seed: ResolvedSeed<TDb>,
  context: {
    adapter: Adapter<TDb>;
    env: string;
    journalTable: string | null;
    startedAt: number;
  },
): Promise<void> {
  const record = async (scope: Scope<TDb>) => {
    if (context.journalTable === null) return;
    await recordApplied(scope, context.journalTable, {
      name: seed.name,
      environment: context.env,
      durationMs: Math.round(performance.now() - context.startedAt),
    });
  };

  if (seed.transaction === false) {
    await seed.run({ db: context.adapter.root.db, env: context.env, name: seed.name });
    await record(context.adapter.root);
    return;
  }

  await context.adapter.transaction(async (scope) => {
    await seed.run({ db: scope.db, env: context.env, name: seed.name });
    await record(scope);
  });
}
