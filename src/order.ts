import { DependencyCycleError, UnknownDependencyError } from './errors.ts';
import type { ResolvedSeed } from './types.ts';

/**
 * Sorts seeds so that every seed comes after everything it depends on.
 *
 * Deterministic: among the seeds that are ready to run, the one that came first in
 * the input wins. Discovery sorts files by path, so the same set of files always
 * produces the same order, and that order is the one printed by `sowme status`.
 *
 * This is Kahn's algorithm written as a plain rescan rather than with a queue and an
 * in-degree table. It is O(n²) in the number of seeds, which for any realistic project
 * is a few hundred comparisons, and it reads like the definition of the problem.
 */
export function orderSeeds<TDb>(seeds: readonly ResolvedSeed<TDb>[]): ResolvedSeed<TDb>[] {
  const known = new Set(seeds.map((s) => s.name));

  for (const seed of seeds) {
    for (const dependency of seed.dependsOn ?? []) {
      if (!known.has(dependency)) {
        throw new UnknownDependencyError(seed.name, dependency, [...known].sort());
      }
    }
  }

  const ordered: ResolvedSeed<TDb>[] = [];
  const emitted = new Set<string>();
  const remaining = [...seeds];

  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((seed) =>
      (seed.dependsOn ?? []).every((dependency) => emitted.has(dependency)),
    );

    if (readyIndex === -1) {
      throw new DependencyCycleError(findCycle(remaining));
    }

    const [seed] = remaining.splice(readyIndex, 1);
    ordered.push(seed!);
    emitted.add(seed!.name);
  }

  return ordered;
}

/**
 * Finds one concrete cycle among seeds that are all blocked.
 *
 * Walking dependencies from any blocked seed must eventually revisit a seed, because
 * nothing here can be satisfied. The returned path starts and ends at the same name,
 * so the error message can print `a → b → c → a` instead of "cycle detected".
 */
function findCycle<TDb>(blocked: readonly ResolvedSeed<TDb>[]): string[] {
  const byName = new Map(blocked.map((seed) => [seed.name, seed]));
  const path: string[] = [];
  const onPath = new Set<string>();

  let current = blocked[0]!.name;
  while (!onPath.has(current)) {
    path.push(current);
    onPath.add(current);

    const next = (byName.get(current)?.dependsOn ?? []).find((d) => byName.has(d));
    if (next === undefined) break; // Should be unreachable: every blocked seed has a blocked dep.
    current = next;
  }

  return [...path.slice(path.indexOf(current)), current];
}
