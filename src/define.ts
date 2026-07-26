import type { Config, Seed } from './types.ts';

/**
 * Identity function. It exists only so TypeScript can infer the shape of what you wrote.
 *
 * `defineSeed(x)` returns `x`. It registers nothing, wraps nothing, and has no side
 * effects — you can delete the call and add `satisfies Seed` instead and sowme will
 * behave identically. It is here because autocomplete on the fields is worth one import,
 * and because a typo in a field name should be a compile error rather than silence.
 */
export function defineSeed<TDb = unknown>(seed: Seed<TDb>): Seed<TDb> {
  return seed;
}

/** Identity function, for the same reason as {@link defineSeed}. */
export function defineConfig<TDb = unknown>(config: Config<TDb>): Config<TDb> {
  return config;
}
