import { ensureJournal, readJournal } from './journal.ts';
import { orderSeeds } from './plan/order.ts';
import { type Decision, decide } from './plan/plan.ts';
import { type ResolvedConfig, resolveConfig } from './resolve/config.ts';
import { findCrossImports } from './resolve/cross-imports.ts';
import { discoverSeeds } from './resolve/discover.ts';
import type { Config, CrossImport, JournalEntry, SeedMode } from './types.ts';

export interface SeedStatus {
  name: string;
  file: string;
  dependsOn: string[];
  /** null means "every environment". */
  environments: string[] | null;
  mode: SeedMode;
  transaction: boolean;
  /** The journal row, or null if this seed has never run. */
  entry: JournalEntry | null;
  /** What `sidder run` would do with it right now. */
  decision: Decision;
}

export interface Inspection {
  env: string;
  journalTable: string;
  /** Where each value sidder worked out on its own came from. */
  sources: ResolvedConfig['sources'];
  /** The resolved run order, as names. */
  order: string[];
  seeds: SeedStatus[];
  /**
   * Journal rows with no seed to match them.
   *
   * Almost always a renamed file: a seed's name defaults to its filename, so renaming
   * one leaves its old row behind and the seed looks like it has never run. Surfacing
   * the leftover is how you find that out before it re-inserts everything.
   */
  orphans: JournalEntry[];
  /**
   * Seed files that import another seed.
   *
   * The one thing here `only` does not narrow. Every other field answers "what would
   * `sidder run` do", which the selection is part of; this one answers "what is in these
   * files", which it is not — the import statement is there whether or not you asked
   * about either seed, and the run that selects only the importer is the one where the
   * second application is hardest to see. `run` reports the same set.
   */
  crossImports: CrossImport[];
}

/**
 * Everything `sidder status` prints, as data.
 *
 * Exported because the answer to "what state is this database in" should be available
 * to a script or an agent without parsing a terminal table.
 */
export async function inspect<TDb>(
  config: Config<TDb>,
  options: {
    env?: string | undefined;
    baseDir?: string | undefined;
    only?: string[] | undefined;
  } = {},
): Promise<Inspection> {
  const resolved = resolveConfig(config, { env: options.env, baseDir: options.baseDir });
  const { adapter, env, journalTable } = resolved;

  const ordered = orderSeeds(await discoverSeeds(resolved.seeds, resolved.baseDir));

  await ensureJournal(adapter.root, journalTable);
  const journal = await readJournal(adapter.root, journalTable);

  const only = options.only ? new Set(options.only) : null;

  const seeds: SeedStatus[] = ordered.map((seed) => ({
    name: seed.name,
    file: seed.file,
    dependsOn: seed.dependsOn ?? [],
    environments: seed.environments ?? null,
    mode: seed.mode ?? 'once',
    transaction: seed.transaction ?? true,
    entry: journal.get(seed.name) ?? null,
    // Deliberately unforced: `status` answers "what would `sidder run` do", and the
    // answer under --force is "all of them", which is not worth printing.
    decision: decide(seed, { env, journal, only, force: false }),
  }));

  const known = new Set(ordered.map((seed) => seed.name));
  const orphans = [...journal.values()]
    .filter((entry) => !known.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    env,
    journalTable,
    sources: resolved.sources,
    order: ordered.map((seed) => seed.name),
    seeds,
    orphans,
    crossImports: await findCrossImports(ordered),
  };
}
