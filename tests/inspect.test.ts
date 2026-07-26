import { describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from '../src/inspect.ts';
import type { Config } from '../src/types.ts';
import { createMemoryAdapter, type MemoryDb } from './helpers/memory-adapter.ts';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** `status` over real files, which is what a cross-import needs: sources to read. */
async function inspectFixtures(glob: string, options: { only?: string[] } = {}) {
  const memory = createMemoryAdapter();
  const config: Config<MemoryDb> = { adapter: memory.adapter, seeds: glob, env: 'development' };

  return await inspect(config, { baseDir: fixtures, ...options });
}

describe('inspect and seeds that import each other', () => {
  /**
   * On `Inspection` rather than only in the formatter, which is what puts it in
   * `sowme status --json` without anything further being written.
   */
  test('reports the finding as data, naming both seeds and the bindings', async () => {
    const inspection = await inspectFixtures('cross/*.ts');

    expect(inspection.crossImports).toEqual([
      { from: 'demo', to: 'territory', bindings: ['REGIONS', 'seedTerritory'] },
    ]);
  });

  test('is empty for a project where no seed imports another', async () => {
    expect((await inspectFixtures('seeds/**/*.ts')).crossImports).toEqual([]);
  });

  /**
   * `--only` narrows the seed rows and does not narrow this — the same answer `run` gives.
   * The import statement is in `demo.ts` whether or not anybody selected `demo`.
   */
  test('answers about every seed even when --only narrowed the rows', async () => {
    const inspection = await inspectFixtures('cross/*.ts', { only: ['territory'] });

    expect(inspection.seeds.find((seed) => seed.name === 'demo')?.decision).toEqual({
      action: 'skip',
      reason: { kind: 'not-selected' },
    });
    expect(inspection.crossImports).toMatchObject([{ from: 'demo', to: 'territory' }]);
  });

  test('says nothing about it in the decisions — a finding is not a reason to skip', async () => {
    const inspection = await inspectFixtures('cross/*.ts');

    expect(inspection.seeds.map((seed) => seed.decision)).toEqual([
      { action: 'run' },
      { action: 'run' },
    ]);
  });
});
