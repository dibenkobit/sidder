import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isModuleFormatFailure,
  isParseFailure,
  ModuleFormatError,
  ModuleSyntaxError,
} from '../../src/errors.ts';
import { importModule } from '../../src/resolve/load-module.ts';

/**
 * Importing a seed has two failures that look alike from the outside and want opposite
 * answers: the file did not compile, and the file compiled, ran, and threw. Nearly every
 * case here is one of those two, because telling them apart is the only interesting thing
 * `importModule` does.
 *
 * Fixtures are written at run time rather than committed. A file with a deliberate syntax
 * error in it is a file `tsc --noEmit` and `biome check` are both right to complain about.
 */

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sidder-load-'));
  // Without this, a `.ts` file with no package.json above it is CommonJS to Node, and
  // every `export` below would be a syntax error for the wrong reason.
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes a module and returns its path. Names must be unique — imports are cached. */
async function fixture(name: string, source: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, source);
  return file;
}

async function caught(file: string): Promise<unknown> {
  try {
    await importModule(file);
  } catch (error) {
    return error;
  }
  throw new Error(`expected ${file} to fail to import`);
}

describe('importModule', () => {
  test('imports a module that is fine', async () => {
    const file = await fixture('fine.ts', 'export const label: string = "fine";\n');

    expect(await importModule(file)).toMatchObject({ label: 'fine' });
  });

  test('reports a stray quote against the file and line the parser named', async () => {
    const file = await fixture('stray-quote.ts', "export const label: string = 'oops;\n");

    const error = await caught(file);

    expect(error).toBeInstanceOf(ModuleSyntaxError);
    expect((error as ModuleSyntaxError).message).toContain(`${file}:1`);
  });

  test("reports the parser's own words when one mistake produces several", async () => {
    // Bun hands several messages for one file to `import()` as an AggregateError whose
    // own message is only a count — `2 errors building "…"` — which is what this file
    // used to print, and which says nothing about the stray quote that caused both.
    const file = await fixture(
      'two-messages.ts',
      "export const rows = query('insert into widgets values ('one'));\n",
    );

    const error = await caught(file);

    expect(error).toBeInstanceOf(ModuleSyntaxError);
    expect((error as ModuleSyntaxError).message).toContain(`${file}:1`);
    expect((error as ModuleSyntaxError).message).not.toContain('errors building');
  });

  test('names the imported file, not the importer, and says how it got there', async () => {
    // The usual shape of this failure: the seed is fine, the schema it imports is not.
    const inner = await fixture('inner-broken.ts', "export const x: string = 'oops;\n");
    const outer = await fixture('outer.ts', `export { x } from './inner-broken.ts';\n`);

    const error = await caught(outer);

    expect(error).toBeInstanceOf(ModuleSyntaxError);
    expect((error as ModuleSyntaxError).message).toContain(`${inner}:1`);
    expect((error as ModuleSyntaxError).hint).toContain(`Reached while importing ${outer}`);
  });

  test('a module that runs and throws is not a parse failure', async () => {
    // The seed that reads an env var at import time. Telling this person to fix their
    // syntax is the same wasted afternoon as telling them to upgrade Node.
    const file = await fixture(
      'throws.ts',
      "throw new Error('SEED_DATABASE_URL is not set');\nexport default 1;\n",
    );

    const error = await caught(file);

    expect(error).not.toBeInstanceOf(ModuleSyntaxError);
    expect((error as Error).message).toBe('SEED_DATABASE_URL is not set');
  });

  test('a module that throws a SyntaxError at runtime is not a parse failure', async () => {
    // The hard case, and the one a `instanceof SyntaxError` trigger gets wrong: the
    // module compiled perfectly and `JSON.parse` rejected a malformed fixture.
    const file = await fixture(
      'bad-fixture.ts',
      'export const rows = JSON.parse(\'[{ "label": "one" }\');\n',
    );

    const error = await caught(file);

    expect(error).toBeInstanceOf(SyntaxError);
    expect(error).not.toBeInstanceOf(ModuleSyntaxError);
  });
});

/**
 * The shapes both runtimes throw, written out.
 *
 * `bun test` only ever exercises Bun's, so Node's is asserted against a stack copied
 * from a real Node 24 failure. The distinction being tested is the same in both: a
 * parser reports a position in the source, a thrown error reports a call site.
 */
describe('isParseFailure', () => {
  const nodeParseFailure = () => {
    const error: SyntaxError & { code?: string } = new SyntaxError('Unterminated string constant');
    error.code = 'ERR_INVALID_TYPESCRIPT_SYNTAX';
    error.stack = [
      'file:///seeds/roles.ts:12',
      "const label: string = 'oops;",
      '                      ^^^^^^',
      '',
      'SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Unterminated string constant',
      '    at parseTypeScript (node:internal/modules/typescript:72:36)',
    ].join('\n');
    return error;
  };

  const bunParseFailure = () => ({
    name: 'BuildMessage',
    message: 'Unterminated string literal',
    level: 'error',
    position: {
      file: '/seeds/roles.ts',
      namespace: 'file',
      line: 12,
      column: 23,
      lineText: "const label: string = 'oops;",
    },
  });

  test("Node's compile-time SyntaxError, which names a source location", () => {
    const error = nodeParseFailure();

    expect(isParseFailure(error)).toBe(true);
    expect(new ModuleSyntaxError('/seeds/roles.ts', error).message).toBe(
      'Could not parse /seeds/roles.ts:12: Unterminated string constant',
    );
  });

  test("a raised --stack-trace-limit does not turn Node's parse failure into a throw", () => {
    // At a high limit the frames of a compile failure run past the runtime's internals
    // and into sidder's own importing frame, so "did any user code appear in the stack"
    // is not the question. The location above the frames is.
    const error = nodeParseFailure();
    error.stack += ['', '    at file:///node_modules/sidder/dist/load-module.js:18:12'].join('\n');

    expect(isParseFailure(error)).toBe(true);
  });

  test('a SyntaxError thrown at runtime, which names a call site instead', () => {
    const error = new SyntaxError('Unexpected end of JSON input');
    error.stack = [
      'SyntaxError: Unexpected end of JSON input',
      '    at JSON.parse (<anonymous>)',
      '    at file:///seeds/roles.ts:4:21',
    ].join('\n');

    expect(isParseFailure(error)).toBe(false);
  });

  test("Bun's BuildMessage, which is not an Error at all", () => {
    const message = bunParseFailure();

    // The reason this is recognised by shape: nothing about it is an Error, so the
    // `instanceof SyntaxError` this file used to test never matched.
    expect(message instanceof Error).toBe(false);
    expect(isParseFailure(message)).toBe(true);
    expect(new ModuleSyntaxError('/seeds/roles.ts', message).message).toBe(
      'Could not parse /seeds/roles.ts:12: Unterminated string literal',
    );
  });

  test('several BuildMessages, which arrive wrapped in an AggregateError', () => {
    const wrapped = new AggregateError(
      [bunParseFailure(), bunParseFailure()],
      '2 errors building "/seeds/roles.ts"',
    );

    expect(isParseFailure(wrapped)).toBe(true);
    expect(new ModuleSyntaxError('/seeds/roles.ts', wrapped).message).not.toContain(
      'errors building',
    );
  });

  test('an AggregateError of ordinary errors is not a parse failure', () => {
    // `Promise.any` produces one of these, and it is not this.
    const wrapped = new AggregateError([new Error('one'), new Error('two')], 'all rejected');

    expect(isParseFailure(wrapped)).toBe(false);
  });

  test('nothing else is', () => {
    for (const value of [
      null,
      undefined,
      'a string',
      new Error('an ordinary error'),
      new SyntaxError('a SyntaxError with no stack at all'),
      { name: 'BuildMessage' },
      { name: 'ResolveMessage', message: 'Cannot find module', position: null },
    ]) {
      expect(isParseFailure(value)).toBe(false);
    }
  });
});

describe('module format failures', () => {
  test('the Node report for ESM parsed as CommonJS gets its own actionable answer', () => {
    const cause = new SyntaxError('Cannot use import statement outside a module');

    expect(isModuleFormatFailure(cause)).toBe(true);

    const error = new ModuleFormatError('/project/sidder.config.ts', cause);
    expect(error.hint).toContain('rename TypeScript config and seed files from .ts to .mts');
    expect(error.hint).toContain('"type": "module"');
    expect(error.hint).not.toContain('Node >= 22.18');
  });

  test('an ordinary parse error is not assigned a module mode', () => {
    expect(isModuleFormatFailure(new SyntaxError('Unterminated string constant'))).toBe(false);
  });
});
