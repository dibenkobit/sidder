import { resolveConfig } from './config.ts';
import { discoverSeeds } from './discover.ts';
import {
  ensureJournal,
  lockSeed,
  readJournal,
  readJournalEntry,
  recordApplied,
} from './journal.ts';
import { orderSeeds } from './order.ts';
import { assertSelectionIsRunnable, type Decision, decide, decideFromJournal } from './plan.ts';
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
 *
 * Two of these at once — two replicas in a deploy, two jobs in one pipeline — do not
 * apply anything twice. The plan each of them prints is a forecast made from the journal
 * as it was; the ruling is made per seed, under a lock, against the row as it is. What
 * the loser reports is `skipped`, because that is what happened. The exception, and it is
 * a real one, is `transaction: false`; `executeSeed` says why.
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

    // Emitted before the seed's transaction, which is where a concurrent run is waited
    // out. A run that pauses here is a run that is queued behind another one, and saying
    // which seed it is stuck on beats printing nothing at all.
    emit({ type: 'start', name: seed.name });
    const startedAt = performance.now();

    let executed: Decision;
    try {
      executed = await executeSeed(seed, {
        adapter,
        env,
        journalTable: useJournal ? journalTable : null,
        force,
        startedAt,
      });
    } catch (error) {
      const rolledBack = seed.transaction !== false;
      outcomes.push({ name: seed.name, status: 'failed', error, rolledBack });
      emit({ type: 'failed', name: seed.name, error, rolledBack });
      throw new SeedFailedError(seed.name, error, { rolledBack, result: { env, outcomes } });
    }

    if (executed.action === 'skip') {
      outcomes.push({ name: seed.name, status: 'skipped', reason: executed.reason });
      emit({ type: 'skipped', name: seed.name, reason: executed.reason });
      continue;
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
 *
 * Returns the decision that was actually acted on, which is not always the one the plan
 * printed: the journal is read once before the run starts, and by the time a seed's turn
 * comes another process may have applied it. So the transaction opens by locking the
 * seed's name and reading that one row again. The plan is a forecast; this is the ruling.
 *
 * Two things make the second reading trustworthy rather than merely fresher. The lock is
 * held by whoever is applying the seed right now, so waiting for it means waiting for
 * them to finish; and a statement in a read-committed transaction sees everything that
 * committed before the statement began, so the row they wrote is visible the moment the
 * lock is handed over. Under repeatable read or serializable the re-read is instead too
 * old to see it — but then `recordApplied` collides with their row and Postgres aborts
 * the transaction with a serialization failure, so the seed's writes still roll back.
 * Correct and quiet at the default isolation level, correct and loud above it.
 */
async function executeSeed<TDb>(
  seed: ResolvedSeed<TDb>,
  context: {
    adapter: Adapter<TDb>;
    env: string;
    journalTable: string | null;
    force: boolean;
    startedAt: number;
  },
): Promise<Decision> {
  const record = async (scope: Scope<TDb>) => {
    if (context.journalTable === null) return;
    await recordApplied(scope, context.journalTable, {
      name: seed.name,
      environment: context.env,
      durationMs: Math.round(performance.now() - context.startedAt),
    });
  };

  /**
   * Asks the journal about this one seed again, in the scope it is about to run in.
   *
   * `journal: false` has nothing to ask and nothing to protect, and `force` and
   * `mode: 'always'` are instructions to run regardless of what any row says — which is
   * `decideFromJournal`'s job, so the answer stays in one place.
   */
  const reconsider = async (scope: Scope<TDb>): Promise<Decision> => {
    if (context.journalTable === null) return { action: 'run' };
    const entry = await readJournalEntry(scope, context.journalTable, seed.name);
    return decideFromJournal(seed, entry, context.force);
  };

  if (seed.transaction === false) {
    // The one seed sowme cannot make safe against a concurrent run, stated plainly.
    //
    // There is no transaction here to scope a lock to, and both ways around that are
    // worse than the gap. A session-level lock needs a connection that is nobody's to
    // hand out: `Adapter.root` is a pool for both shipped adapters, so the lock and the
    // unlock can land on different connections and the lock leaks until the first one is
    // recycled. Holding a second transaction open purely to own a lock would deadlock
    // outright on a pool of one — the seed's own writes could never get a connection —
    // and a bulk load is where small pools and idle-in-transaction timeouts live.
    //
    // So the re-read below is a narrowing, not a fix. It catches the ordinary case, where
    // another run applied this seed while this one worked through earlier ones, and it
    // cannot catch two runs reaching this seed at the same moment. A seed that has given
    // up atomicity has given up exclusion with it; if that matters for yours, the answer
    // is `transaction: true` and a smaller seed.
    const decision = await reconsider(context.adapter.root);
    if (decision.action === 'skip') return decision;

    await seed.run({ db: context.adapter.root.db, env: context.env, name: seed.name });
    await record(context.adapter.root);
    return { action: 'run' };
  }

  return await context.adapter.transaction(async (scope) => {
    // Before the re-read, and before the seed: whoever holds this is applying the seed,
    // and the point is to find out what they did rather than to do it as well. `always`
    // and forced seeds take it too — they will run anyway, and a seed serialised against
    // itself is a seed that cannot deadlock against its own second copy.
    if (context.journalTable !== null) {
      await lockSeed(scope, context.journalTable, seed.name);
    }

    const decision = await reconsider(scope);
    // Returning commits a transaction that wrote nothing, which is how the lock is
    // released.
    if (decision.action === 'skip') return decision;

    await seed.run({ db: scope.db, env: context.env, name: seed.name });
    await record(scope);
    return { action: 'run' };
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
