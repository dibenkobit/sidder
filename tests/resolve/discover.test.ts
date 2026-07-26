import { describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DuplicateSeedNameError,
  InvalidSeedError,
  NoSeedsFoundError,
  UnnamedInlineSeedError,
} from '../../src/errors.ts';
import { discoverSeeds } from '../../src/resolve/discover.ts';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures');

describe('discoverSeeds from files', () => {
  test('names a seed after its file when it does not name itself', async () => {
    const seeds = await discoverSeeds(['seeds/*.ts'], fixtures);

    expect(seeds.map((s) => s.name)).toEqual(['alpha', 'renamed-on-purpose']);
  });

  test('an explicit name wins over the filename', async () => {
    const [, beta] = await discoverSeeds(['seeds/*.ts'], fixtures);

    expect(beta?.name).toBe('renamed-on-purpose');
    expect(beta?.file.endsWith('beta.ts')).toBe(true);
  });

  test('carries every declared field through', async () => {
    const [, beta] = await discoverSeeds(['seeds/*.ts'], fixtures);

    expect(beta).toMatchObject({
      dependsOn: ['alpha'],
      environments: ['development'],
      mode: 'always',
      transaction: false,
    });
  });

  test('** descends into subdirectories', async () => {
    const seeds = await discoverSeeds(['seeds/**/*.ts'], fixtures);

    expect(seeds.map((s) => s.name).sort()).toEqual(['alpha', 'gamma', 'renamed-on-purpose']);
  });

  test('discovery order is sorted by path, so run order is reproducible', async () => {
    const first = await discoverSeeds(['seeds/**/*.ts'], fixtures);
    const again = await discoverSeeds(['seeds/**/*.ts'], fixtures);

    expect(first.map((s) => s.file)).toEqual(again.map((s) => s.file));
  });

  test('refuses two seeds with the same name and names both files', async () => {
    const attempt = discoverSeeds(['duplicates/*.ts'], fixtures);

    await expect(attempt).rejects.toThrow(DuplicateSeedNameError);
    await attempt.catch((error: DuplicateSeedNameError) => {
      expect(error.hint).toContain('one.ts');
      expect(error.hint).toContain('two.ts');
    });
  });

  test('refuses a default export with no run function', async () => {
    await expect(discoverSeeds(['invalid/*.ts'], fixtures)).rejects.toThrow(InvalidSeedError);
  });

  test('says so when a glob matches nothing', async () => {
    const attempt = discoverSeeds(['nowhere/*.ts'], fixtures);

    await expect(attempt).rejects.toThrow(NoSeedsFoundError);
    await attempt.catch((error: NoSeedsFoundError) => {
      expect(error.message).toContain('nowhere/*.ts');
    });
  });
});

describe('discoverSeeds from objects', () => {
  test('takes seeds handed over directly, touching no filesystem', async () => {
    const seeds = await discoverSeeds([{ name: 'inline', run: async () => {} }], '/nonexistent');

    expect(seeds).toMatchObject([{ name: 'inline', file: '<inline>' }]);
  });

  test('an inline seed must name itself — there is no filename to borrow', async () => {
    await expect(discoverSeeds([{ run: async () => {} }], '/nonexistent')).rejects.toThrow(
      UnnamedInlineSeedError,
    );
  });

  test('an empty list is not an error — it is a run with nothing to do', async () => {
    expect(await discoverSeeds([], fixtures)).toEqual([]);
  });
});
