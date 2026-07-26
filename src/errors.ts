import { basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayPath } from './resolve/paths.ts';

/**
 * Every way sidder can refuse to run, in one file.
 *
 * Each error carries a `hint`: a sentence saying what to do about it. The CLI prints
 * the message, then the hint, indented. A tool that sells clarity does not get to
 * throw "Error: invalid configuration".
 */

export class SidderError extends Error {
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = 'SidderError';
    this.hint = hint;
  }
}

/** A command or flag combination the CLI cannot act on without guessing. */
export class UsageError extends SidderError {
  constructor(message: string, hint = 'Run `npx sidder --help` to see the supported commands.') {
    super(message, hint);
    this.name = 'UsageError';
  }
}

export class ConfigNotFoundError extends SidderError {
  constructor(searched: string[], dir: string) {
    super(
      `No config file found in ${dir}`,
      `Looked for: ${searched.join(', ')}. Run \`sidder init\` to write one, or pass --config <path>.`,
    );
    this.name = 'ConfigNotFoundError';
  }
}

export class InvalidConfigError extends SidderError {
  constructor(file: string, problem: string) {
    super(
      `${file} is not a valid sidder config: ${problem}`,
      `A config module must \`export default\` an object with an \`adapter\`.`,
    );
    this.name = 'InvalidConfigError';
  }
}

export class NoSeedsFoundError extends SidderError {
  constructor(patterns: string[], baseDir: string) {
    super(
      `No seed files matched ${patterns.map((p) => `"${p}"`).join(' or ')}`,
      `Searched relative to ${baseDir}. Set \`seeds\` in your config to point at your seed files.`,
    );
    this.name = 'NoSeedsFoundError';
  }
}

export class InvalidSeedError extends SidderError {
  constructor(file: string, problem: string) {
    super(
      `${file} is not a seed: ${problem}`,
      `A seed file must \`export default defineSeed({ async run({ db }) { ... } })\`.`,
    );
    this.name = 'InvalidSeedError';
  }
}

export class DuplicateSeedNameError extends SidderError {
  constructor(name: string, files: string[]) {
    super(
      `Two seeds are both named "${name}"`,
      `${files.join('\n  ')}\nGive one of them an explicit \`name\` — names are how dependsOn and the journal address a seed.`,
    );
    this.name = 'DuplicateSeedNameError';
  }
}

export class UnknownDependencyError extends SidderError {
  constructor(seed: string, missing: string, known: string[]) {
    super(
      `Seed "${seed}" depends on "${missing}", which does not exist`,
      `Known seeds: ${known.join(', ')}. Note that a seed's name comes from its filename unless it sets \`name\` — renaming a file renames the seed.`,
    );
    this.name = 'UnknownDependencyError';
  }
}

export class DependencyCycleError extends SidderError {
  constructor(cycle: string[]) {
    super(
      `Seeds depend on each other in a cycle: ${cycle.join(' → ')}`,
      `Break the cycle by having the later seed read what it needs from the database instead of declaring a dependency.`,
    );
    this.name = 'DependencyCycleError';
  }
}

export class MissingDependencyError extends SidderError {
  constructor(seed: string, dependency: string) {
    super(
      `"${seed}" depends on "${dependency}", which is neither selected nor already applied`,
      `--only runs exactly what you name, it does not pull dependencies in. Run \`sidder run --only ${dependency},${seed}\` or drop --only.`,
    );
    this.name = 'MissingDependencyError';
  }
}

export class UnnamedInlineSeedError extends SidderError {
  constructor(index: number) {
    super(
      `The seed at index ${index} of \`seeds\` has no \`name\``,
      `Seeds passed as objects rather than discovered from files have no filename to take a name from. Set \`name\` on it.`,
    );
    this.name = 'UnnamedInlineSeedError';
  }
}

export class UnsafeTableNameError extends SidderError {
  constructor(table: string) {
    super(
      `Journal table name "${table}" is not a plain SQL identifier`,
      `The table name is interpolated into SQL, so it must match [a-z_][a-z0-9_]* (optionally schema-qualified).`,
    );
    this.name = 'UnsafeTableNameError';
  }
}

/**
 * The name in `journalTable` belongs to a table that is not a journal.
 *
 * `create table if not exists` is perfectly happy to find somebody else's table sitting
 * under the name, so a typo or a collision with an application table gets no complaint
 * until the first read, which fails as `column "applied_at" does not exist` — naming
 * neither the table nor the setting that chose it. This says both.
 */
export class JournalTableMismatchError extends SidderError {
  constructor(table: string, expected: readonly string[], found: readonly string[]) {
    const missing = expected.filter((column) => !found.includes(column));

    super(
      `Table "${table}" exists but is not sidder's journal`,
      [
        `It has ${found.join(', ')}. A journal has ${expected.join(', ')}.`,
        // Spelled out only when the two lists overlap, which is a journal whose columns
        // have drifted rather than somebody else's table. When nothing matches, the two
        // lists above already say so and repeating them adds a line and no fact.
        ...(missing.length < expected.length ? [`Missing: ${missing.join(', ')}.`] : []),
        `\`journalTable\` is what chose this name. Point it at a name of sidder's own — the`,
        `default is \`sidder_journal\`, and sidder creates the table itself, so the name only`,
        `has to be free.`,
      ].join('\n'),
    );
    this.name = 'JournalTableMismatchError';
  }
}

const RUNTIME_CHOICES = [
  'sidder runs your seeds in its own process, so whatever launched sidder has to be able to import .ts.',
  'Pick one:',
  '  bun run --bun sidder run   # native TypeScript, honours tsconfig paths',
  '  Node >= 22.18          # native type stripping; use .mts, or "type": "module" with .ts',
  '  a loader               # npm i -D tsx, then see README — Runtimes',
];

/**
 * The runtime parsed ESM syntax as CommonJS.
 *
 * This is observable rather than inferred: Node says exactly that an import appeared
 * outside a module. It happens most often when a `.ts` file containing imports sits in a
 * package without `"type": "module"`. A separate class keeps that answer out of genuine
 * syntax failures, where renaming a file would be useless.
 */
export class ModuleFormatError extends SidderError {
  constructor(file: string, cause: unknown) {
    super(
      `Could not load ${file} as an ES module`,
      [
        'The runtime treated this file as CommonJS, but it contains ESM import/export syntax.',
        'Pick one:',
        '  rename TypeScript config and seed files from .ts to .mts',
        '  set "type": "module" in the nearest package.json',
        '  run sidder through Bun or a TypeScript loader — see README — Runtimes',
        '',
        `Original error: ${describe(cause)}`,
      ].join('\n'),
    );
    this.name = 'ModuleFormatError';
  }
}

/**
 * The runtime refused the file outright — it does not read TypeScript at all, or it
 * hit syntax it cannot erase. This is the most likely first-run failure, so it gets a
 * real answer rather than `ERR_UNKNOWN_FILE_EXTENSION`.
 *
 * Only raised on the two Node error codes that mean exactly this. A plain syntax error
 * is a different problem and gets {@link ModuleSyntaxError}, because telling someone
 * to upgrade Node when they actually left a quote open wastes their afternoon.
 */
export class TypeScriptLoaderError extends SidderError {
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
 * The file sidder imported is rarely the file with the mistake — a seed imports your
 * schema, which imports your client. So the location comes from the parser's own
 * report, and the file sidder asked for is demoted to a footnote.
 */
export class ModuleSyntaxError extends SidderError {
  constructor(file: string, cause: unknown) {
    const parsed = parseFailureOf(cause);
    const location = parsed?.location ?? null;

    super(
      `Could not parse ${location ?? file}: ${parsed?.message ?? describe(cause)}`,
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

/**
 * An import did not resolve. The file sidder asked for was found; something it imports
 * is not where the import says it is.
 *
 * Every new project meets this one: the import of your database handle that `sidder init`
 * writes into the config is a placeholder, wrong until you fix it. Raw, the runtime
 * reports that as two absolute paths and an error code, and never mentions that the line
 * it is complaining about is the line `sidder init` told you to edit.
 *
 * The specifier and the file that imports it are the only two facts worth printing, and
 * they pick the hint. The config's own db import, an import inside a seed, a package that
 * is not installed and a directory where the resolver wants a file are four mistakes with
 * four different fixes; one hint covering all of them would cover none of them.
 */
export class ModuleResolutionError extends SidderError {
  constructor(file: string, cause: unknown) {
    const failure = resolutionOf(cause);

    super(headlineFor(file, failure), adviceFor(file, failure, cause));
    this.name = 'ModuleResolutionError';
  }
}

/** What a resolution failure is about, once dug out of the runtime's prose. */
interface Resolution {
  /** As the resolver reported it: Bun keeps what you typed, Node resolves it first. */
  specifier: string;
  /** The file the failing import is written in — rarely the file sidder asked for. */
  importer: string;
  /** The path is a directory and the resolver wants a file. Node only; Bun resolves these. */
  directory: boolean;
}

function headlineFor(file: string, failure: Resolution | null): string {
  if (failure === null) return `Could not resolve a module imported by ${displayPath(file)}`;
  return `Could not resolve "${shownSpecifier(failure.specifier)}" — imported by ${displayPath(failure.importer)}`;
}

function adviceFor(file: string, failure: Resolution | null, cause: unknown): string {
  if (failure === null) {
    return [
      "Check that file's imports — one of them does not point at anything. The runtime",
      'described which one in a shape sidder does not recognise, so here it is verbatim:',
      '',
      `  ${describe(cause)}`,
    ].join('\n');
  }

  return [
    // The same demotion ModuleSyntaxError does: the file holding the bad import is
    // rarely the file sidder asked for, so the one it asked for becomes a footnote.
    ...(failure.importer === file ? [] : [`Reached while importing ${displayPath(file)}.`, '']),
    ...adviceLines(failure),
  ].join('\n');
}

function adviceLines({ specifier, importer, directory }: Resolution): string[] {
  const shown = shownSpecifier(specifier);

  if (directory) {
    // The suggestion is a path, not text to paste: the import is written relative to the
    // importing file, and what Node handed back is relative to nothing.
    return [
      `That is a directory, and Node's ESM resolver does not look inside one for an index`,
      'file the way a bundler does. Name the file in the import, relative to the importing',
      `file: ${shown}/index.ts is the usual candidate.`,
    ];
  }

  if (isBareSpecifier(specifier)) {
    const aPackage = ['  A package — install it where the importing file can see it.'];
    const anAlias = [
      "  An alias — sidder imports with the runtime it was launched with, and Node's type",
      '  stripping does not read tsconfig paths. Bun does (`bun run --bun sidder run`), and a',
      '  relative path works under both.',
    ];
    // `@/db` has no scope name, so it cannot be a package: npm has no such thing. When the
    // specifier is shaped like an alias, that reading goes first.
    const readings = looksLikeAlias(specifier)
      ? [...anAlias, ...aPackage]
      : [...aPackage, ...anAlias];

    return [
      `${shown} is not a path, so it is a package name or a tsconfig path alias.`,
      ...readings,
    ];
  }

  if (isConfigFile(importer)) {
    return [
      "That is the config's import of your database handle. `sidder init` writes it as a",
      'placeholder — a guess at your layout, not something it read — so it stays wrong until',
      'you point it at the module that really exports it.',
      '',
      'The path is resolved from the config file, and resolved literally: name the file with',
      'its extension (`./src/db/client.ts`), not the directory (`./src/db`).',
    ];
  }

  return [
    'Nothing is at that path. It is resolved from the importing file, and resolved literally:',
    'name the file with its extension (`./schema.ts`, not `./schema`) — Node needs it even',
    'where your tsconfig lets you leave it out.',
  ];
}

/**
 * Digs the specifier and the importing file out of a resolution failure.
 *
 * Both facts live in the message and nowhere portable: Node puts the unresolved specifier
 * on `error.url` but never the importer, and Bun's `specifier`/`referrer` fields are Bun's
 * alone. So this parses prose, which means a runtime release could invalidate it — when
 * that happens it returns null and the caller quotes the runtime verbatim instead of
 * inventing facts. The shapes it knows, verbatim:
 *
 *   Node ESM  Cannot find module '/abs/db.ts' imported from /abs/sidder.config.ts
 *   Node ESM  Cannot find package 'pg' imported from /abs/sidder.config.ts
 *   Node ESM  Directory import '/abs/db' is not supported resolving ES modules imported from /abs/x.ts
 *   Node CJS  Cannot find module './db.js'\nRequire stack:\n- /abs/sidder.config.js
 *   Bun       Cannot find module './db.ts' from '/abs/sidder.config.ts'
 */
function resolutionOf(cause: unknown): Resolution | null {
  const message = describe(cause);
  const found = NOT_FOUND.exec(message);
  const directory = DIRECTORY_IMPORT.exec(message);

  const specifier = (found ?? directory)?.[1];
  if (specifier === undefined) return null;

  for (const pattern of IMPORTERS) {
    const importer = pattern.exec(message)?.[1];
    if (importer !== undefined) {
      return {
        specifier: asPath(specifier),
        importer: asPath(importer),
        directory: directory !== null,
      };
    }
  }

  // Both facts or neither: an importer sidder cannot name turns every hint into a guess,
  // since which of them applies depends on where the failing import is written.
  return null;
}

// Searched for rather than anchored, so a runtime or loader that prefixes the message
// with something of its own does not cost us both facts.
const NOT_FOUND = /Cannot find (?:module|package) '([^']+)'/;
const DIRECTORY_IMPORT = /Directory import '([^']+)'/;
const IMPORTERS = [
  / imported from (.+)$/, // Node, ESM
  / from '(.+)'$/, // Bun
  /\nRequire stack:\n- (.+)/, // Node, a require() inside a CommonJS config
];

/**
 * The text a thrown thing carries.
 *
 * `message` is read structurally rather than behind an `instanceof Error` check because
 * Bun's resolver throws a `ResolveMessage`, which has a perfectly good `message` and does
 * not inherit from `Error` at all — `String()` on it prepends the class name.
 */
function describe(cause: unknown): string {
  const message = (cause as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(cause);
}

/** Some resolvers name files by URL, and a URL through `relative()` comes out as nonsense. */
function asPath(value: string): string {
  if (!value.startsWith('file://')) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return value;
  }
}

/** A specifier is only a path when it was written as one: `pg` must not be relativised. */
function shownSpecifier(specifier: string): string {
  return isAbsolute(specifier) ? displayPath(specifier) : specifier;
}

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !isAbsolute(specifier);
}

function looksLikeAlias(specifier: string): boolean {
  return /^[@~]\//.test(specifier);
}

/**
 * The config is the one file whose name sidder fixes, so recognising it needs no plumbing.
 * A config renamed by --config falls through to the generic advice, which is still true —
 * only less specific.
 */
function isConfigFile(file: string): boolean {
  return basename(file).startsWith('sidder.config.');
}

/**
 * Whether this is a module that did not compile, as opposed to one that ran and threw.
 *
 * The distinction is the whole reason this is a function rather than an `instanceof`
 * check, and getting it backwards is expensive in both directions. A seed that reads a
 * malformed fixture with `JSON.parse` throws a real `SyntaxError` from its top level;
 * calling that a syntax error in the seed is the same wasted afternoon as telling
 * someone to upgrade Node when they left a quote open.
 *
 * What separates the two is that a parser reports a position in a source file and no
 * call site — it could not report a call site, because nothing had run yet.
 */
export function isParseFailure(cause: unknown): boolean {
  return parseFailureOf(cause) !== null;
}

/** Node's exact report for ESM syntax in a file it classified as CommonJS. */
export function isModuleFormatFailure(cause: unknown): boolean {
  return describe(cause).includes('Cannot use import statement outside a module');
}

/** What the parser said, and where it said it — the two things a report needs. */
interface ParseFailure {
  /** The parser's own words, with no class name or error count in front of them. */
  message: string;
  /** `file:line`, or null when the parser did not say where. */
  location: string | null;
}

/**
 * Reads a parse failure out of whatever the runtime threw, or returns null.
 *
 * Both supported runtimes expose "the parser rejected this" and neither does it the same
 * way, so this is two answers to one question:
 *
 * - Bun throws a `BuildMessage`, which is not an `Error` at all — its prototype chain is
 *   `BuildMessage → Object`, so every `instanceof` against it is false and it has to be
 *   recognised by shape. In exchange it carries a structured `position`, which beats
 *   digging through a stack.
 * - Node throws a `SyntaxError` and prepends the source location to `stack`, above the
 *   frames. It does that only for errors raised while compiling, so the preamble's
 *   presence *is* the fact being tested — and unlike the frames it survives
 *   `--stack-trace-limit`, which at a high setting puts sidder's own importing frame in a
 *   compile failure's stack and would fool any test based on "did user code run".
 */
function parseFailureOf(cause: unknown): ParseFailure | null {
  const built = buildMessageOf(cause);
  if (built !== null) return built;

  if (cause instanceof SyntaxError) {
    const location = locationOf(cause);
    if (location !== null) return { message: cause.message, location };

    // Node labels a type-stripping parse failure outright. Believe the label even when
    // the location preamble is missing, so a stack this file cannot read costs a line
    // number rather than the whole diagnosis.
    if ((cause as { code?: unknown }).code === 'ERR_INVALID_TYPESCRIPT_SYNTAX') {
      return { message: cause.message, location: null };
    }
  }

  return null;
}

/** As much of Bun's `BuildMessage` as this file reads. */
interface BuildMessageLike {
  name?: unknown;
  message?: unknown;
  position?: { file?: unknown; line?: unknown } | null;
}

function buildMessageOf(cause: unknown): ParseFailure | null {
  // More than one message for one file arrives wrapped in an `AggregateError` whose own
  // message is only a count — `2 errors building "…"`. The first message is the one to
  // report: the rest normally cascade from it, as both of them do from one stray quote.
  const wrapped = (cause as { errors?: unknown } | null)?.errors;
  const message = (Array.isArray(wrapped) ? wrapped[0] : cause) as BuildMessageLike | null;

  if (message?.name !== 'BuildMessage' || typeof message.message !== 'string') return null;

  const file = message.position?.file;
  const line = message.position?.line;

  return {
    message: message.message,
    // Already an absolute path rather than a URL, and it names the file the parser
    // choked on, which for a seed that imports your schema is not the file sidder asked
    // for. That is the file worth printing.
    location: typeof file === 'string' && typeof line === 'number' ? `${file}:${line}` : null,
  };
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
