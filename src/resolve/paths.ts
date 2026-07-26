import { isAbsolute, parse as parsePath, relative } from 'node:path';

/**
 * Path formatting, and nothing else.
 *
 * These two live apart from `config.ts` because `errors.ts` needs `displayPath` and
 * `config.ts` needs the error classes. Left together, that is an import cycle; the
 * only thing either side actually wanted was a `node:path` call with no dependencies
 * of its own.
 */

/** Formats a file path the way the run header shows it: relative when that is shorter. */
export function displayPath(file: string, from: string = process.cwd()): string {
  const rel = relative(from, file);
  if (rel === '') return file;
  if (isAbsolute(rel) || rel.startsWith('..')) return file;
  return rel;
}

/** A seed file's default name: its basename with the extension removed. */
export function nameFromFile(file: string): string {
  return parsePath(file).name;
}
