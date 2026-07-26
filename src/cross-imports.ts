import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ResolvedSeed } from './types.ts';

/**
 * Finds seed files that import each other.
 *
 * `dependsOn` exists to replace exactly this. sowme guarantees each seed runs once per
 * invocation, so "territory must exist first" is a declaration; importing `seedTerritory`
 * and calling it is the old way, and doing both applies territory twice — once because
 * sowme ran it, once because demo called it. The second application is silent, because
 * both are ordinary writes.
 *
 * So this reports the coupling and names what it saw. It deliberately does not decide
 * whether a given binding is a seed's own work or a table of constants that happens to
 * live in the same file: `import { REGIONS, seedTerritory }` is one statement carrying
 * both, and no rule over names can separate them — a seed's work is not always the
 * default export, and shared data is not always a plain object. Naming the bindings and
 * letting the person reading decide is the honest version, and the advice that comes with
 * it — move shared data into a module that is not a seed — dissolves the warning properly
 * rather than silencing it.
 */
export interface CrossImport {
  /** Name of the seed doing the importing. */
  from: string;
  /** Name of the seed being imported. */
  to: string;
  /** The bindings the import statements named, deduplicated, in source order. */
  bindings: string[];
}

/**
 * Reads every seed's source and reports the imports that land on another seed's file.
 *
 * Text, not a parse. sowme has no runtime dependencies and a parser is a large thing to
 * take on for a warning, so this matches import statements with a regular expression.
 * That has two consequences worth stating rather than hiding: an import inside a comment
 * or a string can be reported, and unusual formatting can be missed. Both are acceptable
 * for something that only ever prints a warning naming the file it read — and neither can
 * make sowme refuse to run or change what it does.
 *
 * Type-only imports are skipped, because they are erased before anything executes and so
 * cannot apply anything twice. Seeds handed over as objects are skipped too — there is no
 * file to read.
 */
export async function findCrossImports<TDb>(
  seeds: readonly ResolvedSeed<TDb>[],
): Promise<CrossImport[]> {
  const seedByFile = new Map<string, string>();
  for (const seed of seeds) {
    if (seed.file !== INLINE) seedByFile.set(seed.file, seed.name);
  }
  if (seedByFile.size < 2) return [];

  const found: CrossImport[] = [];

  for (const seed of seeds) {
    if (seed.file === INLINE) continue;

    const source = await readSource(seed.file);
    if (source === null) continue;

    // Keyed by the imported seed so several statements between one pair of files read as
    // one finding, which is what it is.
    const bindingsBySeed = new Map<string, string[]>();

    for (const statement of importStatements(source)) {
      const target = resolveToSeed(seed.file, statement.specifier, seedByFile);
      if (target === undefined || target === seed.name) continue;

      const bindings = bindingsBySeed.get(target) ?? [];
      for (const binding of statement.bindings) {
        if (!bindings.includes(binding)) bindings.push(binding);
      }
      bindingsBySeed.set(target, bindings);
    }

    for (const [to, bindings] of bindingsBySeed) {
      found.push({ from: seed.name, to, bindings });
    }
  }

  return found;
}

const INLINE = '<inline>';

/**
 * A missing or unreadable seed file is not this function's problem to report. Discovery
 * imported the same file moments ago, so anything that fails here is a race with the
 * filesystem, and a warning is the wrong place to raise it.
 */
async function readSource(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

interface ImportStatement {
  specifier: string;
  /** Empty for `import './x.ts'` and for `export * from './x.ts'`. */
  bindings: string[];
}

/**
 * `import … from '…'` and `export … from '…'`, plus the two forms that name nothing:
 * a bare `import './x.ts'` and a dynamic `import('./x.ts')`.
 *
 * The clause between the keyword and `from` excludes quotes, parentheses and semicolons
 * so that a match cannot run past the end of one statement into the next. Newlines are
 * allowed through, because a long list of bindings is usually written over several lines.
 */
function* importStatements(source: string): Generator<ImportStatement> {
  const withClause = /\b(?:import|export)\b([^'";()]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(withClause)) {
    const clause = match[1] ?? '';
    // `import type { … }` is erased before anything runs, so it cannot apply anything.
    if (/^\s*type\b/.test(clause)) continue;
    yield { specifier: match[2] ?? '', bindings: bindingsOf(clause) };
  }

  const sideEffectOnly = /\bimport\s*(?:\(\s*)?['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(sideEffectOnly)) {
    yield { specifier: match[1] ?? '', bindings: [] };
  }
}

/**
 * The names an import statement introduces, as written.
 *
 * Reported rather than interpreted, so `* as territory` and `seedTerritory as seed` come
 * out looking like the source they came from — the point is to hand back something the
 * reader can find in their own file.
 */
function bindingsOf(clause: string): string[] {
  const bindings: string[] = [];

  const named = /\{([^}]*)\}/.exec(clause);
  const beforeBraces = named ? clause.slice(0, named.index) : clause;

  for (const part of beforeBraces.split(',')) {
    const binding = part.trim();
    if (binding.length > 0) bindings.push(binding);
  }

  for (const part of (named?.[1] ?? '').split(',')) {
    const binding = part.trim();
    // A `type` marker inside the braces erases just that one name.
    if (binding.length > 0 && !/^type\b/.test(binding)) bindings.push(binding);
  }

  return bindings;
}

/**
 * Which seed, if any, a specifier points at.
 *
 * Membership in the discovered set answers this, so no filesystem lookup is needed: the
 * candidates are generated and checked against the map. A bare specifier is never a seed
 * file — a package cannot be one, and a tsconfig alias is not resolvable here anyway,
 * which is a limitation worth knowing about rather than guessing around.
 *
 * The extension swap covers the TypeScript convention of importing `./x.js` to mean the
 * file `./x.ts`, which is what a project without `allowImportingTsExtensions` writes.
 */
function resolveToSeed(
  fromFile: string,
  specifier: string,
  seedByFile: ReadonlyMap<string, string>,
): string | undefined {
  if (!specifier.startsWith('.')) return undefined;

  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.mts`, `${base}.js`, `${base}.mjs`];

  const swap: Record<string, string> = { '.js': '.ts', '.mjs': '.mts', '.cjs': '.cts' };
  for (const [written, real] of Object.entries(swap)) {
    if (base.endsWith(written)) candidates.push(base.slice(0, -written.length) + real);
  }

  for (const candidate of candidates) {
    const name = seedByFile.get(candidate);
    if (name !== undefined) return name;
  }

  return undefined;
}
