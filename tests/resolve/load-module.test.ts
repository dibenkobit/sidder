import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleResolutionError, ModuleSyntaxError, SidderError } from '../../src/errors.ts';
import { importModule } from '../../src/resolve/load-module.ts';

/**
 * The modules under test are written here rather than kept in `tests/fixtures`, because
 * every one of them is a file `tsc --noEmit` would refuse — a missing import, a syntax
 * error — and the test suite is typechecked.
 */
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sidder-load-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, source: string): string {
  const file = join(dir, name);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, source, 'utf8');
  return file;
}

describe('importModule', () => {
  test('an import that does not resolve gets a hint, not ERR_MODULE_NOT_FOUND', async () => {
    const file = write('config-a.ts', `export { pool } from './src/db/index.ts';\n`);

    const attempt = importModule(file);

    await expect(attempt).rejects.toBeInstanceOf(ModuleResolutionError);
    await attempt.catch((error: ModuleResolutionError) => {
      expect(error.message).toContain('./src/db/index.ts');
      expect(error.message).toContain('config-a.ts');
      expect(error.hint.length).toBeGreaterThan(0);
    });
  });

  test('the file with the bad import is named, not the file sidder asked for', async () => {
    write('inner/schema.ts', `export { tables } from './tables.ts';\n`);
    const file = write('config-b.ts', `export { tables } from './inner/schema.ts';\n`);

    const attempt = importModule(file);

    await attempt.catch((error: ModuleResolutionError) => {
      expect(error.message).toContain('schema.ts');
      expect(error.message).toContain('./tables.ts');
      // The file sidder asked for is still on screen, demoted.
      expect(error.hint).toContain('Reached while importing');
      expect(error.hint).toContain('config-b.ts');
    });
  });

  test('a resolution code from any loader is answered, whatever the extension', async () => {
    // Bun's resolver never raises these two — one is Node's CommonJS `require()` and the
    // other is Node's ESM resolver meeting a directory — so the module raises one itself.
    // What is under test is the mapping from code to error; Node's own wording for both is
    // pinned below, and both were walked through the CLI under Node.
    const file = write(
      'sidder.config.js',
      `throw Object.assign(
         new Error("Cannot find module './src/db/index.js'\\nRequire stack:\\n- ${dir}/sidder.config.js"),
         { code: 'MODULE_NOT_FOUND' },
       );\n`,
    );

    await expect(importModule(file)).rejects.toBeInstanceOf(ModuleResolutionError);
  });

  test('a syntax error is still a syntax error', async () => {
    // A file that genuinely does not parse. It used to have to fake one by throwing a
    // SyntaxError at runtime, because Bun's parser throws a BuildMessage that the old
    // `instanceof SyntaxError` gate could not see — and that fake is now correctly refused,
    // since a module that compiled and then threw is not a module that failed to compile.
    // `isParseFailure` recognises the real thing under both runtimes, so the real thing is
    // what this uses. See parse-failure.test.ts.
    const file = write('broken.ts', `export default { name: 'unclosed'\n`);

    const attempt = importModule(file);

    await expect(attempt).rejects.toBeInstanceOf(ModuleSyntaxError);
    await expect(attempt).rejects.not.toBeInstanceOf(ModuleResolutionError);
  });

  test('an error the module raises for its own reasons is left alone', async () => {
    const file = write('angry.ts', `throw new Error('DATABASE_URL is not set');\n`);

    const attempt = importModule(file);

    await expect(attempt).rejects.toThrow('DATABASE_URL is not set');
    await expect(attempt).rejects.not.toBeInstanceOf(SidderError);
  });
});

/**
 * The messages below are what Node 24 and Bun 1.3 actually produce, copied out of a run.
 * They are the whole input to the error — the two facts it prints are parsed out of them —
 * so a runtime that rewords one of these is a runtime that breaks this file, on purpose.
 */
const project = (...parts: string[]) => join(process.cwd(), ...parts);

const raise = (message: string) => new Error(message);

describe('ModuleResolutionError from a Node ESM failure', () => {
  test('names the specifier and the importer, both relative to the project', () => {
    const error = new ModuleResolutionError(
      project('sidder.config.ts'),
      raise(
        `Cannot find module '${project('src/db/index.ts')}' imported from ${project('sidder.config.ts')}`,
      ),
    );

    expect(error.message).toBe(
      'Could not resolve "src/db/index.ts" — imported by sidder.config.ts',
    );
  });

  test("the config's own db import gets told about the placeholder", () => {
    const error = new ModuleResolutionError(
      project('sidder.config.ts'),
      raise(
        `Cannot find module '${project('src/db/index.ts')}' imported from ${project('sidder.config.ts')}`,
      ),
    );

    expect(error.hint).toContain('placeholder');
    expect(error.hint).not.toContain('Reached while importing');
  });

  test('a seed does not, because no placeholder wrote its imports', () => {
    const error = new ModuleResolutionError(
      project('seeds/roles.ts'),
      raise(
        `Cannot find module '${project('src/schema.ts')}' imported from ${project('seeds/roles.ts')}`,
      ),
    );

    expect(error.message).toBe('Could not resolve "src/schema.ts" — imported by seeds/roles.ts');
    expect(error.hint).not.toContain('placeholder');
    expect(error.hint).toContain('name the file with its extension');
  });

  test('a missing package leads with installing it', () => {
    const error = new ModuleResolutionError(
      project('seeds/roles.ts'),
      raise(`Cannot find package '@faker-js/faker' imported from ${project('seeds/roles.ts')}`),
    );

    expect(error.message).toBe('Could not resolve "@faker-js/faker" — imported by seeds/roles.ts');
    expect(error.hint.split('\n')[1]).toContain('A package');
  });

  test('a tsconfig alias leads with the alias, because @/db is no package', () => {
    const error = new ModuleResolutionError(
      project('seeds/roles.ts'),
      raise(`Cannot find package '@/db' imported from ${project('seeds/roles.ts')}`),
    );

    expect(error.hint.split('\n')[1]).toContain('An alias');
    expect(error.hint).toContain('does not read tsconfig paths');
  });

  test('a directory import is told it is a directory, and which file to name', () => {
    const error = new ModuleResolutionError(
      project('sidder.config.ts'),
      raise(
        `Directory import '${project('src/db')}' is not supported resolving ES modules imported from ${project('sidder.config.ts')}`,
      ),
    );

    expect(error.message).toBe('Could not resolve "src/db" — imported by sidder.config.ts');
    expect(error.hint).toContain('is a directory');
    expect(error.hint).toContain('src/db/index.ts');
  });
});

describe('ModuleResolutionError from the other loaders', () => {
  test("Bun's wording, which keeps the specifier as written", () => {
    const error = new ModuleResolutionError(
      project('sidder.config.ts'),
      raise(`Cannot find module './src/db/index.ts' from '${project('sidder.config.ts')}'`),
    );

    expect(error.message).toBe(
      'Could not resolve "./src/db/index.ts" — imported by sidder.config.ts',
    );
    expect(error.hint).toContain('placeholder');
  });

  test("Bun's ResolveMessage is not an Error, and is read anyway", () => {
    const notAnError = {
      message: `Cannot find module './src/db/index.ts' from '${project('sidder.config.ts')}'`,
      code: 'ERR_MODULE_NOT_FOUND',
    };

    const error = new ModuleResolutionError(project('sidder.config.ts'), notAnError);

    expect(error.message).toBe(
      'Could not resolve "./src/db/index.ts" — imported by sidder.config.ts',
    );
  });

  test('a CommonJS require() names the importer from the require stack', () => {
    const error = new ModuleResolutionError(
      project('sidder.config.js'),
      raise(
        `Cannot find module './src/db/index.js'\nRequire stack:\n- ${project('sidder.config.js')}`,
      ),
    );

    expect(error.message).toBe(
      'Could not resolve "./src/db/index.js" — imported by sidder.config.js',
    );
    expect(error.hint).toContain('placeholder');
  });
});

describe('ModuleResolutionError when the message is not one it knows', () => {
  test('falls back to the file sidder asked for, and quotes the runtime', () => {
    const error = new ModuleResolutionError(
      project('sidder.config.ts'),
      raise('the resolver has been rewritten and says something else entirely'),
    );

    expect(error.message).toBe('Could not resolve a module imported by sidder.config.ts');
    expect(error.hint).toContain('the resolver has been rewritten');
  });

  test('an importer it cannot find is a fallback too, rather than half a hint', () => {
    const error = new ModuleResolutionError(
      project('sidder.config.ts'),
      raise(`Cannot find module '${project('src/db/index.ts')}'`),
    );

    expect(error.message).toBe('Could not resolve a module imported by sidder.config.ts');
    expect(error.hint).toContain('Cannot find module');
  });

  test('something thrown that is not an error at all still produces a hint', () => {
    const error = new ModuleResolutionError(project('sidder.config.ts'), 'nope');

    expect(error.message).toBe('Could not resolve a module imported by sidder.config.ts');
    expect(error.hint).toContain('nope');
  });
});
