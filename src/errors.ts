import { fileURLToPath } from 'node:url';

/**
 * Every way sowme can refuse to run, in one file.
 *
 * Each error carries a `hint`: a sentence saying what to do about it. The CLI prints
 * the message, then the hint, indented. A tool that sells clarity does not get to
 * throw "Error: invalid configuration".
 */

export class SowmeError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'SowmeError';
    this.hint = hint;
  }
}

export class ConfigNotFoundError extends SowmeError {
  constructor(searched: string[], dir: string) {
    super(
      `No config file found in ${dir}`,
      `Looked for: ${searched.join(', ')}. Run \`sowme init\` to write one, or pass --config <path>.`,
    );
    this.name = 'ConfigNotFoundError';
  }
}

export class InvalidConfigError extends SowmeError {
  constructor(file: string, problem: string) {
    super(
      `${file} is not a valid sowme config: ${problem}`,
      `A config module must \`export default\` an object with an \`adapter\`.`,
    );
    this.name = 'InvalidConfigError';
  }
}

export class NoSeedsFoundError extends SowmeError {
  constructor(patterns: string[], baseDir: string) {
    super(
      `No seed files matched ${patterns.map((p) => `"${p}"`).join(' or ')}`,
      `Searched relative to ${baseDir}. Set \`seeds\` in your config to point at your seed files.`,
    );
    this.name = 'NoSeedsFoundError';
  }
}

export class InvalidSeedError extends SowmeError {
  constructor(file: string, problem: string) {
    super(
      `${file} is not a seed: ${problem}`,
      `A seed file must \`export default defineSeed({ async run({ db }) { ... } })\`.`,
    );
    this.name = 'InvalidSeedError';
  }
}

export class DuplicateSeedNameError extends SowmeError {
  constructor(name: string, files: string[]) {
    super(
      `Two seeds are both named "${name}"`,
      `${files.join('\n  ')}\nGive one of them an explicit \`name\` — names are how dependsOn and the journal address a seed.`,
    );
    this.name = 'DuplicateSeedNameError';
  }
}

export class UnknownDependencyError extends SowmeError {
  constructor(seed: string, missing: string, known: string[]) {
    super(
      `Seed "${seed}" depends on "${missing}", which does not exist`,
      `Known seeds: ${known.join(', ')}. Note that a seed's name comes from its filename unless it sets \`name\` — renaming a file renames the seed.`,
    );
    this.name = 'UnknownDependencyError';
  }
}

export class DependencyCycleError extends SowmeError {
  constructor(cycle: string[]) {
    super(
      `Seeds depend on each other in a cycle: ${cycle.join(' → ')}`,
      `Break the cycle by having the later seed read what it needs from the database instead of declaring a dependency.`,
    );
    this.name = 'DependencyCycleError';
  }
}

export class MissingDependencyError extends SowmeError {
  constructor(seed: string, dependency: string) {
    super(
      `"${seed}" depends on "${dependency}", which is neither selected nor already applied`,
      `--only runs exactly what you name, it does not pull dependencies in. Run \`sowme run --only ${dependency},${seed}\` or drop --only.`,
    );
    this.name = 'MissingDependencyError';
  }
}

export class UnnamedInlineSeedError extends SowmeError {
  constructor(index: number) {
    super(
      `The seed at index ${index} of \`seeds\` has no \`name\``,
      `Seeds passed as objects rather than discovered from files have no filename to take a name from. Set \`name\` on it.`,
    );
    this.name = 'UnnamedInlineSeedError';
  }
}

export class UnsafeTableNameError extends SowmeError {
  constructor(table: string) {
    super(
      `Journal table name "${table}" is not a plain SQL identifier`,
      `The table name is interpolated into SQL, so it must match [a-z_][a-z0-9_]* (optionally schema-qualified).`,
    );
    this.name = 'UnsafeTableNameError';
  }
}

const RUNTIME_CHOICES = [
  'sowme runs your seeds in its own process, so whatever launched sowme has to be able to import .ts.',
  'Pick one:',
  '  bun --bun sowme run          # Bun: native TypeScript, honours tsconfig paths',
  '  node >= 22.18                # native type stripping, no tsconfig paths',
  '  node --import tsx node_modules/.bin/sowme run',
];

/**
 * The runtime refused the file outright — it does not read TypeScript at all, or it
 * hit syntax it cannot erase. This is the most likely first-run failure, so it gets a
 * real answer rather than `ERR_UNKNOWN_FILE_EXTENSION`.
 *
 * Only raised on the two Node error codes that mean exactly this. A plain syntax error
 * is a different problem and gets {@link ModuleSyntaxError}, because telling someone
 * to upgrade Node when they actually left a quote open wastes their afternoon.
 */
export class TypeScriptLoaderError extends SowmeError {
  constructor(file: string, cause: unknown) {
    super(
      `Could not load ${file} — this runtime does not read TypeScript`,
      [...RUNTIME_CHOICES, '', `Original error: ${describe(cause)}`].join('\n'),
    );
    this.name = 'TypeScriptLoaderError';
  }
}

/**
 * The file was parsed and rejected. Whatever the parser said is the headline.
 *
 * The file sowme imported is rarely the file with the mistake — a seed imports your
 * schema, which imports your client. So the location comes from the parser's own
 * report, and the file sowme asked for is demoted to a footnote.
 */
export class ModuleSyntaxError extends SowmeError {
  constructor(file: string, cause: unknown) {
    const location = locationOf(cause);

    super(
      `Could not parse ${location ?? file}: ${describe(cause)}`,
      [
        ...(location && !location.startsWith(file) ? [`Reached while importing ${file}.`, ''] : []),
        'Fix the syntax above.',
        '',
        'If that syntax is in fact valid TypeScript, then the runtime is reading it as',
        'plain JavaScript, and the fix is the runtime instead:',
        ...RUNTIME_CHOICES.slice(1),
      ].join('\n'),
    );
    this.name = 'ModuleSyntaxError';
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Digs `path/to/file.ts:12` out of a parse error.
 *
 * A syntax error's stack starts with the offending location rather than a call frame,
 * because there was never a call — the module did not compile.
 */
function locationOf(cause: unknown): string | null {
  if (!(cause instanceof Error) || typeof cause.stack !== 'string') return null;

  const firstLine = cause.stack.split('\n')[0] ?? '';
  const match = /^(file:\/\/\S+?):(\d+)$/.exec(firstLine.trim());
  if (!match) return null;

  try {
    return `${fileURLToPath(match[1]!)}:${match[2]}`;
  } catch {
    return null;
  }
}
