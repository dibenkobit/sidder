import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { ConfigNotFoundError, InvalidConfigError } from '../errors.ts';
import type { Adapter, Config, Seed } from '../types.ts';
import { importModule } from './load-module.ts';

export const CONFIG_FILENAMES = [
  'sidder.config.ts',
  'sidder.config.mts',
  'sidder.config.js',
  'sidder.config.mjs',
];

export const DEFAULT_SEED_GLOB = 'seeds/**/*.ts';
export const DEFAULT_JOURNAL_TABLE = 'sidder_journal';

/**
 * A config with every default filled in — plus, for each value sidder worked out on
 * its own, a note saying where it came from.
 *
 * sidder is allowed to guess. It is not allowed to guess quietly: `sources` is what
 * the run header prints, so the answer to "why is it seeding staging?" is on screen
 * before anything touches the database.
 */
export interface ResolvedConfig<TDb = unknown> {
  adapter: Adapter<TDb>;
  env: string;
  seeds: string[] | Seed<TDb>[];
  journalTable: string;
  /** Seed globs resolve against this. The config file's directory, or cwd. */
  baseDir: string;
  sources: {
    env: string;
    seeds: string;
    journalTable: string;
  };
}

/**
 * Walks up from `startDir` looking for a config file, the way `tsconfig.json` and
 * `.git` are found. Returns the absolute path, or null if it reaches the filesystem
 * root without a hit.
 */
export function findConfigFile(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);

  for (;;) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = resolve(dir, filename);
      if (existsSync(candidate)) return candidate;
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Loads an explicit config path, or finds one by walking up from `startDir`. */
export async function loadConfigFile(
  explicitPath: string | undefined,
  startDir: string = process.cwd(),
): Promise<{ config: Config; file: string }> {
  const file = explicitPath ? resolve(startDir, explicitPath) : findConfigFile(startDir);

  if (file === null) {
    throw new ConfigNotFoundError(CONFIG_FILENAMES, startDir);
  }
  if (!existsSync(file)) {
    throw new ConfigNotFoundError([relative(startDir, file) || file], startDir);
  }

  const module = await importModule(file);
  const config = module['default'];

  if (typeof config !== 'object' || config === null) {
    throw new InvalidConfigError(file, 'it has no default export');
  }
  if (!('adapter' in config) || typeof config.adapter !== 'object' || config.adapter === null) {
    throw new InvalidConfigError(file, 'the default export has no `adapter`');
  }

  return { config: config as Config, file };
}

/**
 * Fills in every default and records where each value came from.
 *
 * Precedence is the boring one, highest first: command-line flag, config file,
 * environment variable, built-in default.
 */
export function resolveConfig<TDb>(
  config: Config<TDb>,
  options: { baseDir?: string | undefined; env?: string | undefined } = {},
): ResolvedConfig<TDb> {
  const baseDir = options.baseDir ?? process.cwd();
  const env = resolveEnv(config, options.env);
  const seeds = resolveSeeds(config);

  return {
    adapter: config.adapter,
    env: env.value,
    seeds: seeds.value,
    journalTable: config.journalTable ?? DEFAULT_JOURNAL_TABLE,
    baseDir,
    sources: {
      env: env.source,
      seeds: seeds.source,
      journalTable: config.journalTable ? 'config' : 'default',
    },
  };
}

function resolveEnv<TDb>(config: Config<TDb>, override: string | undefined) {
  if (override !== undefined) return { value: override, source: '--env' };
  if (config.env !== undefined) return { value: config.env, source: 'config' };

  const fromEnvironment = process.env['NODE_ENV'];
  if (fromEnvironment) return { value: fromEnvironment, source: 'NODE_ENV' };

  return { value: 'development', source: 'default' };
}

function resolveSeeds<TDb>(config: Config<TDb>): { value: string[] | Seed<TDb>[]; source: string } {
  if (config.seeds === undefined) {
    return { value: [DEFAULT_SEED_GLOB], source: 'default' };
  }
  if (typeof config.seeds === 'string') {
    return { value: [config.seeds], source: 'config' };
  }
  return { value: config.seeds, source: 'config' };
}
