import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCrossImports } from '../../src/resolve/cross-imports.ts';
import type { ResolvedSeed } from '../../src/types.ts';

/**
 * The sources live in a temp directory rather than in `tests/fixtures`, because several of
 * them import modules that do not exist and one imports itself — `tsconfig.json` includes
 * `tests`, so a fixture would have to typecheck and these must not have to.
 */
let dir: string;

async function seedFile(basename: string, source: string): Promise<ResolvedSeed> {
  const file = join(dir, basename);
  await writeFile(file, source);
  return { name: basename.replace(/\.\w+$/, ''), file, run: async () => {} };
}

/** A seed handed over as an object, the way a test suite does it. Has no file to read. */
const inline = (name: string): ResolvedSeed => ({ name, file: '<inline>', run: async () => {} });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'siddy-cross-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('findCrossImports', () => {
  test('reports a seed that imports another seed, naming the bindings', async () => {
    const territory = await seedFile('territory.ts', 'export const REGIONS = [];\n');
    const demo = await seedFile(
      'demo.ts',
      "import { REGION_CENTERS, REGIONS, seedTerritory } from './territory.ts';\n",
    );

    expect(await findCrossImports([territory, demo])).toEqual([
      { from: 'demo', to: 'territory', bindings: ['REGION_CENTERS', 'REGIONS', 'seedTerritory'] },
    ]);
  });

  test('says nothing about imports that leave the seed set', async () => {
    const roles = await seedFile(
      'roles.ts',
      "import { db } from '../src/db/index.ts';\nimport { eq } from 'drizzle-orm';\n",
    );
    const other = await seedFile('other.ts', 'export const x = 1;\n');

    expect(await findCrossImports([roles, other])).toEqual([]);
  });

  test('ignores a type-only import — it is erased before anything runs', async () => {
    const territory = await seedFile('t-types.ts', 'export type Region = { code: string };\n');
    const demo = await seedFile('d-types.ts', "import type { Region } from './t-types.ts';\n");

    expect(await findCrossImports([territory, demo])).toEqual([]);
  });

  test('keeps the value bindings of a mixed import and drops the type ones', async () => {
    const territory = await seedFile('t-mixed.ts', 'export const REGIONS = [];\n');
    const demo = await seedFile(
      'd-mixed.ts',
      "import { type Region, REGIONS } from './t-mixed.ts';\n",
    );

    expect(await findCrossImports([territory, demo])).toEqual([
      { from: 'd-mixed', to: 't-mixed', bindings: ['REGIONS'] },
    ]);
  });

  test('catches a default import, a namespace import and a side-effect import', async () => {
    const target = await seedFile('target.ts', 'export default {};\n');
    const byDefault = await seedFile('by-default.ts', "import target from './target.ts';\n");
    const byNamespace = await seedFile('by-namespace.ts', "import * as t from './target.ts';\n");
    const bySideEffect = await seedFile('by-side-effect.ts', "import './target.ts';\n");

    const found = await findCrossImports([target, byDefault, byNamespace, bySideEffect]);

    expect(found).toEqual([
      { from: 'by-default', to: 'target', bindings: ['target'] },
      { from: 'by-namespace', to: 'target', bindings: ['* as t'] },
      { from: 'by-side-effect', to: 'target', bindings: [] },
    ]);
  });

  test('follows a dynamic import and a re-export', async () => {
    const target = await seedFile('t-dyn.ts', 'export const x = 1;\n');
    const dynamic = await seedFile(
      'd-dyn.ts',
      "export async function go() { await import('./t-dyn.ts'); }\n",
    );
    const reexport = await seedFile('r-dyn.ts', "export { x } from './t-dyn.ts';\n");

    const found = await findCrossImports([target, dynamic, reexport]);

    expect(found.map((f) => f.from).sort()).toEqual(['d-dyn', 'r-dyn']);
    expect(found.find((f) => f.from === 'r-dyn')?.bindings).toEqual(['x']);
  });

  test('resolves ./x.js to the seed file x.ts, and ./x with no extension', async () => {
    const target = await seedFile('ext.ts', 'export const x = 1;\n');
    const viaJs = await seedFile('via-js.ts', "import { x } from './ext.js';\n");
    const viaBare = await seedFile('via-bare.ts', "import { x } from './ext';\n");

    const found = await findCrossImports([target, viaJs, viaBare]);

    expect(found.map((f) => f.from).sort()).toEqual(['via-bare', 'via-js']);
  });

  test('merges several statements between one pair of files into one finding', async () => {
    const target = await seedFile('m-target.ts', 'export const a = 1;\nexport const b = 2;\n');
    const importer = await seedFile(
      'm-importer.ts',
      "import { a } from './m-target.ts';\nimport { b } from './m-target.ts';\n",
    );

    expect(await findCrossImports([target, importer])).toEqual([
      { from: 'm-importer', to: 'm-target', bindings: ['a', 'b'] },
    ]);
  });

  test('reads bindings written across several lines', async () => {
    const target = await seedFile('ml-target.ts', 'export const a = 1;\n');
    const importer = await seedFile(
      'ml-importer.ts',
      "import {\n  a,\n  b as c,\n} from './ml-target.ts';\n",
    );

    expect(await findCrossImports([target, importer])).toEqual([
      { from: 'ml-importer', to: 'ml-target', bindings: ['a', 'b as c'] },
    ]);
  });

  test('a seed that imports itself is not reported', async () => {
    const self = await seedFile('self.ts', "import { x } from './self.ts';\nexport const x = 1;\n");

    expect(await findCrossImports([self, await seedFile('bystander.ts', '')])).toEqual([]);
  });

  test('inline seeds have no file to read and are skipped', async () => {
    expect(await findCrossImports([inline('a'), inline('b')])).toEqual([]);
  });

  test('a single seed cannot cross-import, so nothing is read at all', async () => {
    expect(
      await findCrossImports([{ name: 'only', file: '/nope/gone.ts', run: async () => {} }]),
    ).toEqual([]);
  });

  test('an unreadable file is skipped rather than raised — discovery already imported it', async () => {
    const present = await seedFile('present.ts', 'export const x = 1;\n');
    const missing: ResolvedSeed = {
      name: 'missing',
      file: join(dir, 'never-written.ts'),
      run: async () => {},
    };

    expect(await findCrossImports([present, missing])).toEqual([]);
  });
});
