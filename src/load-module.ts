import { pathToFileURL } from 'node:url';
import { ModuleSyntaxError, TypeScriptLoaderError } from './errors.ts';

/**
 * `await import()`, with two failures answered properly.
 *
 * sowme deliberately ships no TypeScript loader. It imports your files with the
 * runtime it was launched with, so Bun and Node >= 22.18 read `.ts` natively and
 * nobody pays for a transpiler they already have. The cost of that choice is one
 * confusing failure mode — an old Node meeting a `.ts` file — which is caught here.
 *
 * A syntax error is deliberately kept separate. The two look alike from the outside
 * and the wrong guess is expensive: told to upgrade Node, you will go and upgrade
 * Node, and the quote you left open will still be open.
 */
export async function importModule(file: string): Promise<Record<string, unknown>> {
  try {
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (error) {
    if (!isTypeScriptFile(file)) throw error;

    // Node with no type stripping refuses the extension; Node with type stripping
    // refuses syntax it cannot erase (enums, namespaces, parameter properties).
    const code = (error as { code?: string } | null)?.code;
    if (code === 'ERR_UNKNOWN_FILE_EXTENSION' || code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
      throw new TypeScriptLoaderError(file, error);
    }
    if (error instanceof SyntaxError) {
      throw new ModuleSyntaxError(file, error);
    }
    throw error;
  }
}

function isTypeScriptFile(file: string): boolean {
  return file.endsWith('.ts') || file.endsWith('.mts') || file.endsWith('.cts');
}
