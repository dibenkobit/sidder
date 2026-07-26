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
 * A seed threw. Everything sowme knows about the run at that moment, on the throw.
 *
 * `runSeeds` throws rather than returning a result with a `failed` outcome in it, and
 * that is not negotiable: a deploy script that ignores the return value must not carry
 * on as if the seeds are in. But the outcomes collected before the throw answer "what
 * is committed", which is the difference between resuming and starting over — so they
 * ride along instead of being dropped on the floor.
 *
 * Deliberately **not** a `SowmeError`. Everything in `errors.ts` is a way sowme refuses
 * to run and carries a `hint` saying what to do about it; this is a report wrapped
 * around someone else's failure, and the remedy is in a seed sowme has no opinion
 * about. Inventing a hint here would be sowme guessing out loud.
 *
 * The original error is on `cause`, the standard property, because that is where every
 * consumer already looks — including the CLI, which reads a Postgres driver's `detail`
 * and `constraint` off it to say which row broke the constraint.
 */
export class SeedFailedError extends Error {
  /** The seed that threw. */
  readonly seed: string;
  /**
   * False only for a seed that set `transaction: false`, whose writes are still in the
   * database. Which of the two happened decides what you do next.
   */
  readonly rolledBack: boolean;
  /**
   * The run up to and including the failure: every `applied` outcome in it is committed
   * and journalled, and the last outcome is the `failed` one.
   */
  readonly result: RunResult;

  constructor(seed: string, cause: unknown, context: { rolledBack: boolean; result: RunResult }) {
    super(`Seed "${seed}" failed: ${messageOf(cause)}`, { cause });
    this.name = 'SeedFailedError';
    this.seed = seed;
    this.rolledBack = context.rolledBack;
    this.result = context.result;
  }
}

/**
 * Runs your seeds. One process, one connection, order worked out from `dependsOn`.
 *
 * This is the whole tool; the CLI is a formatter wrapped around this call. Tests are
 * the reason it is exported: persona two wants "run these three seeds now and forget
 * it happened", which is `{ only: [...], journal: false }` and no command line at all.
 *
 * Throws {@link SeedFailedError} on the first seed that fails, after emitting a `failed`
 * event. The seeds that already succeeded stay committed and journalled — the throw says
 * which ones — so the next run picks up where this one stopped.
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
  const force = options.force ?? false;
  const decisions = new Map<string, Decision>(
    ordered.map((seed) => [seed.name, decide(seed, { env, journal, only, force })]),
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
      // Decided, not executed — and said in those words, because a caller filtering for
      // `applied` is asking what reached the database.
      outcomes.push({ name: seed.name, status: 'would-run' });
      emit({ type: 'would-run', name: seed.name });
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
      throw new SeedFailedError(seed.name, error, { rolledBack, result: { env, outcomes } });
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

/**
 * The cause's own message, to repeat inside the wrapper's.
 *
 * A test suite asserting on the message a seed threw keeps matching once the throw is
 * wrapped, and an uncaught failure still reads as itself rather than as a sowme noun.
 */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
