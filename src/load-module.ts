import { pathToFileURL } from 'node:url';
import { ModuleResolutionError, ModuleSyntaxError, TypeScriptLoaderError } from './errors.ts';

/**
 * `await import()`, with three failures answered properly.
 *
 * sowme deliberately ships no TypeScript loader. It imports your files with the
 * runtime it was launched with, so Bun and Node >= 22.18 read `.ts` natively and
 * nobody pays for a transpiler they already have. The cost of that choice is one
 * confusing failure mode — an old Node meeting a `.ts` file — which is caught here.
 *
 * The other two are kept apart from it on purpose, because they look alike from the
 * outside and each wrong guess is expensive. Told to upgrade Node you will go and
 * upgrade Node, and the quote you left open will still be open; told to fix your
 * syntax you will read a line that is fine, when the import above it is not.
 */
export async function importModule(file: string): Promise<Record<string, unknown>> {
  try {
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;

    // Asked before the TypeScript question below, because an import that does not
    // resolve has nothing to do with the extension of the file that wrote it: a
    // CommonJS sowme.config.js fails the same way, one loader further down.
    if (code !== undefined && RESOLUTION_CODES.includes(code)) {
      throw new ModuleResolutionError(file, error);
    }

    if (!isTypeScriptFile(file)) throw error;

    // Node with no type stripping refuses the extension; Node with type stripping
    // refuses syntax it cannot erase (enums, namespaces, parameter properties).
    if (code === 'ERR_UNKNOWN_FILE_EXTENSION' || code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
      throw new TypeScriptLoaderError(file, error);
    }
    if (error instanceof SyntaxError) {
      throw new ModuleSyntaxError(file, error);
    }
    throw error;
  }
}

/**
 * The codes that mean "a specifier did not resolve", and nothing wider.
 *
 * `ERR_MODULE_NOT_FOUND` is Node's ESM resolver and Bun's both. `MODULE_NOT_FOUND` is
 * the CommonJS `require()` that a `sowme.config.js` in a project without
 * `"type": "module"` is made of — a supported config filename, so a supported failure.
 * `ERR_UNSUPPORTED_DIR_IMPORT` is resolution failing too, and the same question ("which
 * file did you mean?") with a known answer, so it is answered here rather than passed
 * through as `Directory import '/abs/path' is not supported resolving ES modules`.
 */
const RESOLUTION_CODES = ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT'];

function isTypeScriptFile(file: string): boolean {
  return file.endsWith('.ts') || file.endsWith('.mts') || file.endsWith('.cts');
}
