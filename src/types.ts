/**
 * Every type sowme has. If a concept is not in this file, sowme does not have it.
 */

/** One row of a raw SQL result. Adapters normalise whatever their driver returns into this. */
export type Row = Record<string, unknown>;

/**
 * A handle on the database at one transactional scope.
 *
 * `db` is your ORM client, untouched — it is what `seed.run()` receives.
 * `execute` runs raw SQL *in the same scope*, and exists for exactly one reason:
 * the journal must be written inside the same transaction as the seed it records.
 * That is what makes a crashed run resumable instead of half-applied.
 */
export interface Scope<TDb = unknown> {
  db: TDb;
  execute(sql: string, params?: readonly unknown[]): Promise<Row[]>;
}

/**
 * The whole surface sowme needs from your database library. Two members.
 *
 * Writing one by hand is about ten lines, and doing so is the recommended way to
 * understand what sowme does to your database. See README — "Write your own adapter".
 */
export interface Adapter<TDb = unknown> {
  /** The scope outside of any transaction. */
  root: Scope<TDb>;
  /**
   * Runs `fn` in a transaction: commit when it resolves, roll back when it throws.
   *
   * Leave the isolation level at the default. sowme decides whether a seed still needs
   * running by re-reading its journal row inside this transaction, which is only exact
   * under read committed; at repeatable read or above the re-read is too old to see a
   * concurrent run's row and the journal write fails with a serialization error instead.
   * Safe either way — see `executeSeed` in `run.ts` — but only quiet at the default.
   */
  transaction<T>(fn: (scope: Scope<TDb>) => Promise<T>): Promise<T>;
  /**
   * Releases connections.
   *
   * The CLI calls this when a run finishes. `runSeeds()` never does — a test suite
   * calls it many times over one long-lived pool and closing it would be wrong.
   */
  close?(): Promise<void>;
}

/**
 * When a seed is allowed to run again.
 *
 * - `once`   — run if the journal has no entry for it. The default.
 * - `always` — run on every invocation, journal or not. For idempotent seeds whose
 *              input lives outside the file (a permission catalogue, an enum, a CSV).
 *
 * There is deliberately no `on-change`: it is a speed optimisation over `always`,
 * not a correctness feature, and hashing "did this seed's inputs change" correctly
 * means hashing a module graph rather than a file. See README — "Why no on-change".
 */
export type SeedMode = 'once' | 'always';

/** What `seed.run()` is handed. */
export interface SeedContext<TDb = unknown> {
  /** Transaction-scoped when `transaction` is on (the default), the root handle otherwise. */
  db: TDb;
  /** The environment this run resolved to. */
  env: string;
  /** This seed's resolved name — the one the journal and `dependsOn` use. */
  name: string;
}

export interface Seed<TDb = unknown> {
  /**
   * How this seed is addressed by `dependsOn`, `--only` and the journal.
   * Defaults to the file's basename without extension.
   *
   * Set it explicitly as soon as anything depends on this seed: renaming the file
   * would otherwise rename the seed, and the journal would treat it as a new one.
   */
  name?: string;

  /**
   * Names of seeds that must have run before this one.
   *
   * This is not sort metadata — it is the replacement for importing another seed
   * and calling it. sowme guarantees each seed runs exactly once per invocation,
   * so "territory must exist" no longer has to mean `import { seedTerritory }`.
   *
   * Corollary: seeds talk to each other through the database, not through memory.
   * Need the region ids? Select them.
   */
  dependsOn?: string[];

  /** Environments this seed may run in. Omitted means all of them. */
  environments?: string[];

  /** Default: `'once'`. */
  mode?: SeedMode;

  /**
   * Wrap this seed and its journal entry in one transaction. Default: `true`.
   *
   * Set to `false` for bulk loads where one transaction would be too large — and
   * when wrapping legacy code that writes through an imported `db` global instead
   * of the `db` it is handed. Those writes escape the transaction silently, so the
   * atomicity would be a lie. See README — "Wrapping seeds you already have".
   *
   * It costs more than atomicity. Two concurrent runs are kept off the same seed by a
   * lock held for the length of its transaction, and a seed with no transaction has
   * nowhere to hold one: sowme re-reads the journal immediately before running it, which
   * catches a run that finished earlier but not one arriving at the same instant. Every
   * other seed is exclusive; this one is only careful.
   */
  transaction?: boolean;

  run(ctx: SeedContext<TDb>): Promise<void>;
}

/** A seed after discovery, when its name and origin are known. */
export interface ResolvedSeed<TDb = unknown> extends Seed<TDb> {
  name: string;
  /** Absolute path of the file it came from. Used in messages, never for addressing. */
  file: string;
}

export interface Config<TDb = unknown> {
  adapter: Adapter<TDb>;

  /**
   * Glob(s) of seed files, relative to the config file — or the seeds themselves.
   *
   * Handing over seed objects skips discovery entirely and touches no filesystem,
   * which is what a test suite wants: "set up exactly these three, right now".
   * Seeds given this way must have a `name`; there is no filename to take one from.
   *
   * Default: `'seeds/**\/*.ts'`.
   */
  seeds?: string | string[] | Seed<TDb>[];

  /**
   * The environment to run as.
   * Default: `process.env.NODE_ENV ?? 'development'`. `--env` overrides both.
   */
  env?: string;

  /** Journal table name. Default: `'sowme_journal'`. */
  journalTable?: string;
}

/** One row of the journal. */
export interface JournalEntry {
  name: string;
  appliedAt: Date;
  environment: string;
  durationMs: number;
}

/** Why a seed was not run. Every skip has a reason and the reason is always shown. */
export type SkipReason =
  | { kind: 'already-applied'; appliedAt: Date }
  | { kind: 'wrong-env'; allowed: string[] }
  | { kind: 'not-selected' };

export type SeedOutcome =
  | { name: string; status: 'applied'; durationMs: number }
  /**
   * A dry run's verdict: selected, ordered, and not executed.
   *
   * It is a status of its own rather than `applied` with a note, because the obvious
   * question a caller asks an outcome — `status === 'applied'` — has to come back false
   * for a seed that never touched the database. It carries no `durationMs`: nothing was
   * timed, and a `0` there would be the same lie in a smaller font.
   *
   * One result never mixes this with `applied`; `dryRun` is decided for the whole run.
   */
  | { name: string; status: 'would-run' }
  | { name: string; status: 'skipped'; reason: SkipReason }
  /**
   * `rolledBack` is false only for seeds that set `transaction: false`, whose partial
   * writes are still in the database. Reporting a failure without saying which of the
   * two happened would leave you guessing about the state of your database.
   *
   * `runSeeds` throws instead of returning here, so this variant reaches a caller on
   * `SeedFailedError.result` — as the last outcome, after everything that committed.
   */
  | { name: string; status: 'failed'; error: unknown; rolledBack: boolean };

/**
 * A seed file that imports another seed.
 *
 * `dependsOn` exists to replace exactly this. sowme guarantees each seed runs once per
 * invocation, so "territory must exist first" is a declaration; importing `seedTerritory`
 * and calling it is the old way, and doing both applies territory twice — once because
 * sowme ran it, once because demo called it. The second application is silent, because
 * both are ordinary writes.
 *
 * So sowme reports the coupling and names what it saw. It deliberately does not decide
 * whether a given binding is a seed's own work or a table of constants that happens to
 * live in the same file: `import { REGIONS, seedTerritory }` is one statement carrying
 * both, and no rule over names can separate them — a seed's work is not always the
 * default export, and shared data is not always a plain object. Naming the bindings and
 * letting the person reading decide is the honest version, and the advice that comes with
 * it — move shared data into a module that is not a seed — dissolves the warning properly
 * rather than silencing it.
 *
 * A warning and nothing else. `run` and `status` both report it, and it changes neither
 * what sowme does nor what it exits with. See `findCrossImports` in `cross-imports.ts`
 * for how the finding is made, and what a text scan can and cannot see.
 */
export interface CrossImport {
  /** Name of the seed doing the importing. */
  from: string;
  /** Name of the seed being imported. */
  to: string;
  /** The bindings the import statements named, deduplicated, in source order. */
  bindings: string[];
}

/** Emitted while a run is in progress, so the CLI can report as it goes. */
export type RunEvent =
  | { type: 'plan'; env: string; order: string[] }
  /**
   * Seed files that import each other: once, after the plan, before the first seed — and
   * not at all when there are none.
   *
   * An event rather than a field on `RunResult`, because this is news the person watching
   * a run needs before the seeds go past, and a result only reaches whoever inspects the
   * return value — which on a failed run is `SeedFailedError.result`, so one warning would
   * have to be read out of two places. Not a field on `plan` either: the plan is the
   * forecast the run acts on, and a finding here changes nothing about it.
   */
  | { type: 'cross-imports'; findings: CrossImport[] }
  | { type: 'start'; name: string }
  | { type: 'applied'; name: string; durationMs: number }
  /** Emitted in place of `applied` for every seed a dry run decided to run. */
  | { type: 'would-run'; name: string }
  | { type: 'skipped'; name: string; reason: SkipReason }
  | { type: 'failed'; name: string; error: unknown; rolledBack: boolean };

/**
 * Every field is `| undefined` on purpose. This is an options bag assembled by a
 * caller — the CLI builds it from flags that may simply be absent — and forcing them
 * to delete keys rather than pass `undefined` would buy nothing.
 */
export interface RunOptions {
  /** Run only these seeds. Dependencies are not pulled in — see `MissingDependencyError`. */
  only?: string[] | undefined;
  /**
   * Run seeds the journal says have already been applied. Default: `false`.
   *
   * This is the seed you are editing right now: it ran once, you changed a line, and
   * `once` is correctly refusing to run it again. Force says "I know, do it anyway",
   * and the journal row is rewritten with the new time.
   *
   * It defeats the journal and nothing else. `environments` still applies, because that
   * gate is a decision written into the seed file — forcing your way past it is not
   * impatience, it is running production data in development.
   */
  force?: boolean | undefined;
  /** Overrides `config.env`. */
  env?: string | undefined;
  /**
   * Directory that seed globs resolve against. Defaults to `process.cwd()`.
   * The CLI passes the directory of the config file it found.
   */
  baseDir?: string | undefined;
  /**
   * Consult and write the journal. Default: `true`.
   *
   * Pass `false` from a test suite: "run these now and forget it happened".
   * With no journal every seed runs, `mode` is ignored, and nothing is recorded.
   */
  journal?: boolean | undefined;
  /** Decide everything, execute nothing. */
  dryRun?: boolean | undefined;
  onEvent?: ((event: RunEvent) => void) | undefined;
}

export interface RunResult {
  env: string;
  outcomes: SeedOutcome[];
}
