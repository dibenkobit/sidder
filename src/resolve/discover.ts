import { glob } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  DuplicateSeedNameError,
  InvalidSeedError,
  NoSeedsFoundError,
  UnnamedInlineSeedError,
} from '../errors.ts';
import type { ResolvedSeed, Seed } from '../types.ts';
import { importModule } from './load-module.ts';
import { nameFromFile } from './paths.ts';

/**
 * Turns whatever `config.seeds` holds into a list of named seeds.
 *
 * Two inputs, because there are two ways to use sowme. From the CLI you give globs
 * and files are found and imported. From a test you hand over seed objects directly,
 * and no filesystem is touched at all — that is the difference between "seed my dev
 * database" and "set up these three tables for this test".
 */
export async function discoverSeeds<TDb>(
  seeds: string[] | Seed<TDb>[],
  baseDir: string,
): Promise<ResolvedSeed<TDb>[]> {
  if (seeds.length === 0) return [];

  const resolved = isGlobList(seeds)
    ? await discoverFromFiles<TDb>(seeds, baseDir)
    : resolveInlineSeeds(seeds);

  assertNamesAreUnique(resolved);
  return resolved;
}

function isGlobList<TDb>(seeds: string[] | Seed<TDb>[]): seeds is string[] {
  return typeof seeds[0] === 'string';
}

async function discoverFromFiles<TDb>(
  patterns: string[],
  baseDir: string,
): Promise<ResolvedSeed<TDb>[]> {
  const matches: string[] = [];
  for await (const match of glob(patterns, { cwd: baseDir })) {
    matches.push(match);
  }

  if (matches.length === 0) {
    throw new NoSeedsFoundError(patterns, baseDir);
  }

  // Sorted so discovery order is stable, which is what makes the resolved run order
  // stable for seeds that do not depend on each other.
  matches.sort();

  const seeds: ResolvedSeed<TDb>[] = [];
  for (const match of matches) {
    const file = resolve(baseDir, match);
    seeds.push(await loadSeedFile<TDb>(file));
  }
  return seeds;
}

async function loadSeedFile<TDb>(file: string): Promise<ResolvedSeed<TDb>> {
  const module = await importModule(file);
  const exported = module['default'];

  if (typeof exported !== 'object' || exported === null) {
    throw new InvalidSeedError(file, 'it has no default export');
  }
  const seed = exported as Seed<TDb>;
  if (typeof seed.run !== 'function') {
    throw new InvalidSeedError(file, 'its default export has no `run` function');
  }

  return { ...seed, name: seed.name ?? nameFromFile(file), file };
}

function resolveInlineSeeds<TDb>(seeds: Seed<TDb>[]): ResolvedSeed<TDb>[] {
  return seeds.map((seed, index) => {
    if (!seed.name) throw new UnnamedInlineSeedError(index);
    return { ...seed, name: seed.name, file: '<inline>' };
  });
}

function assertNamesAreUnique<TDb>(seeds: readonly ResolvedSeed<TDb>[]): void {
  const filesByName = new Map<string, string[]>();

  for (const seed of seeds) {
    const files = filesByName.get(seed.name) ?? [];
    files.push(seed.file);
    filesByName.set(seed.name, files);
  }

  for (const [name, files] of filesByName) {
    if (files.length > 1) throw new DuplicateSeedNameError(name, files);
  }
}
