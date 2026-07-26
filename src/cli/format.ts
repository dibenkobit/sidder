import { SowmeError } from '../errors.ts';
import type { Inspection } from '../inspect.ts';
import type { Decision } from '../plan.ts';
import type { SeedOutcome, SkipReason } from '../types.ts';

/**
 * Everything sowme prints.
 *
 * The rule this file exists to enforce: nothing sowme worked out on its own goes
 * unmentioned. Which config, which environment and where the environment came from
 * are on screen before the first statement reaches the database, and every seed that
 * does not run says why in the same line that says it did not run.
 *
 * The rule is about sowme's own guesses being visible, not about volume. The one skip
 * that does not get a line each is `--only`'s, because "you did not select this" is
 * something you typed rather than something sowme worked out, and forty-nine of them
 * hide the one line you asked for. It is counted instead — see `formatNotSelected`.
 */

const ESC = '\u001b';

export const isInteractive = process.stdout.isTTY === true;

const useColor = isInteractive && !process.env['NO_COLOR'] && process.env['TERM'] !== 'dumb';

const wrap = (code: string) => (text: string) =>
  useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text;

export const style = {
  dim: wrap('2'),
  bold: wrap('1'),
  green: wrap('32'),
  yellow: wrap('33'),
  red: wrap('31'),
  cyan: wrap('36'),
};

/** Returns the cursor to the start of the line and erases it. */
export const CLEAR_LINE = `\r${ESC}[K`;

export function formatHeader(parts: {
  version: string;
  configFile: string;
  env: string;
  envSource: string;
  journalTable?: string;
}): string {
  const segments = [
    style.bold('sowme') + style.dim(` ${parts.version}`),
    parts.configFile,
    `env ${style.cyan(parts.env)} ${style.dim(`(${parts.envSource})`)}`,
  ];
  if (parts.journalTable) segments.push(style.dim(`journal ${parts.journalTable}`));
  return segments.join(style.dim('  ·  '));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatDate(date: Date): string {
  return Number.isNaN(date.getTime()) ? '?' : date.toISOString().slice(0, 10);
}

export function formatSkipReason(reason: SkipReason, env: string): string {
  switch (reason.kind) {
    case 'already-applied':
      return `already applied ${formatDate(reason.appliedAt)}`;
    case 'wrong-env':
      return `${reason.allowed.join(', ')} only — running as ${env}`;
    // Complete because `SkipReason` is, though the reports collapse this one rather
    // than printing it per seed. `formatNotSelected` is what they print instead.
    case 'not-selected':
      return 'not selected';
  }
}

/**
 * The seeds `--only` filtered out, as one line rather than one line each.
 *
 * Every other skip is news. "Already applied" and "wrong environment" are things sowme
 * worked out from the journal and the seed file; "you did not select it" is a restatement
 * of the flag you just typed, and on a fifty-seed project it is forty-nine lines burying
 * the one line you asked for.
 *
 * It still prints, because a run that silently reports on a subset is worse than a noisy
 * one. `11 of 12` is what keeps the summary's skip count honest and stops a narrowed run
 * from reading like a project with one seed in it, and naming the flag is how you spot
 * that you typed `--only demmo`.
 */
export function formatNotSelected(parts: {
  notSelected: number;
  total: number;
  /** The `--only` names, or undefined when the command did not narrow anything. */
  only: readonly string[] | undefined;
}): string | null {
  if (parts.only === undefined || parts.notSelected === 0) return null;

  const note = `${parts.notSelected} of ${parts.total} not selected  (--only ${parts.only.join(',')})`;
  return `  ${style.dim('·')} ${style.dim(note)}`;
}

/** Pads to the widest name so the second column lines up. */
export function padder(names: readonly string[]): (name: string) => string {
  const width = names.reduce((max, name) => Math.max(max, name.length), 0);
  return (name) => name.padEnd(width);
}

/** Width of the longest thing the second column holds, so the notes line up. */
const STATE_WIDTH = 'applied 0000-00-00'.length;

/**
 * `--only` narrows what `status` reports, the same way it narrows a run: the seeds it
 * filtered out are counted at the end instead of listed. Asking about two seeds and
 * being handed fifty rows is the same defect as a run that prints fifty skips, and the
 * `order:` footer below still names every seed, so nothing looks smaller than it is.
 */
export function formatStatus(
  inspection: Inspection,
  options: { only?: readonly string[] | undefined } = {},
): string {
  const lines: string[] = [];
  const selected = inspection.seeds.filter(
    (seed) => !(seed.decision.action === 'skip' && seed.decision.reason.kind === 'not-selected'),
  );
  const pad = padder(selected.map((seed) => seed.name));

  for (const seed of selected) {
    const glyph = seed.entry ? style.green('✓') : style.dim('✗');
    // Padded before styling, so the escape codes do not count towards the width.
    const state = seed.entry
      ? `applied ${formatDate(seed.entry.appliedAt)}`.padEnd(STATE_WIDTH)
      : style.dim('never run'.padEnd(STATE_WIDTH));

    const notes: string[] = [];
    if (seed.mode === 'always') notes.push('always');
    if (seed.environments) notes.push(`${seed.environments.join(', ')} only`);
    if (seed.dependsOn.length > 0) notes.push(`after ${seed.dependsOn.join(', ')}`);
    if (!seed.transaction) notes.push(style.yellow('no transaction'));

    const suffix = notes.length > 0 ? style.dim(`  ${notes.join(' · ')}`) : '';
    lines.push(`  ${glyph} ${pad(seed.name)}  ${state}${suffix}`);
  }

  const filtered = formatNotSelected({
    notSelected: inspection.seeds.length - selected.length,
    total: inspection.seeds.length,
    only: options.only,
  });
  if (filtered !== null) lines.push(filtered);

  if (inspection.orphans.length > 0) {
    lines.push('');
    lines.push(style.yellow('  journal rows with no seed to match them:'));
    for (const orphan of inspection.orphans) {
      lines.push(`  ? ${orphan.name}  ${style.dim(`applied ${formatDate(orphan.appliedAt)}`)}`);
    }
    lines.push(
      style.dim('    A seed takes its name from its filename — renaming one leaves this behind.'),
    );
  }

  lines.push('');
  lines.push(style.dim(`  order: ${inspection.order.join(' → ')}`));

  // The warning `run` gives, from the command you would reach for to check first. It asks
  // the question of the seeds this listing covers, so `--only` narrows it here exactly as
  // it narrows a run.
  const declared = environmentsSeedsAccept(selected.map((seed) => seed.decision));
  if (declared !== null) {
    lines.push('');
    lines.push(
      formatUnknownEnvironment({ env: inspection.env, source: inspection.sources.env, declared }),
    );
  }

  return lines.join('\n');
}

/**
 * A run that applied nothing, explained — or null when there is nothing to explain,
 * because seeds ran, or because the journal simply has everything already and you did
 * not ask for anything in particular.
 *
 * `0 applied, 12 skipped` and exit 0 is the truth, and it is also what every mistake in
 * this area looks like: a misspelled `--only`, a misspelled `--env`, a seed you are
 * editing that the journal is quietly refusing. Deciding which of them happened is a
 * decision about what the report says, which is why it lives here rather than in the
 * command, and why it is one function over the run's own outcomes.
 *
 * The order is the order of the answers you want to hear, following `decide`: what you
 * typed before what sowme observed. A `--only` that named nothing runnable is a better
 * answer than a remark about environments.
 */
export function formatNothingApplied(parts: {
  outcomes: readonly SeedOutcome[];
  /** The `--only` names, or undefined when the run was not narrowed. */
  only: readonly string[] | undefined;
  env: string;
  /** `ResolvedConfig.sources.env` — where the environment came from. */
  envSource: string;
}): string | null {
  if (parts.outcomes.some((outcome) => outcome.status !== 'skipped')) return null;

  if (parts.only !== undefined) {
    const stale = skippedFor(parts.outcomes, 'already-applied');
    if (stale.length > 0) return formatNothingSelected(stale);

    // Nothing survived the filter at all, so nothing you named is a seed.
    if (skippedFor(parts.outcomes, 'not-selected').length === parts.outcomes.length) {
      return formatNothingMatched(parts.only);
    }
  }

  const declared = environmentsSeedsAccept(decisionsOf(parts.outcomes));
  return declared === null
    ? null
    : formatUnknownEnvironment({ env: parts.env, source: parts.envSource, declared });
}

/** The seeds a run skipped for one particular reason. */
function skippedFor(outcomes: readonly SeedOutcome[], kind: SkipReason['kind']): string[] {
  return outcomes
    .filter((outcome) => outcome.status === 'skipped' && outcome.reason.kind === kind)
    .map((outcome) => outcome.name);
}

/**
 * A finished run, read back as the decisions that produced it.
 *
 * `status` holds decisions and a run reports outcomes; the question below is about
 * decisions. A failure maps to `run` because it is one — the seed got past every gate.
 */
function decisionsOf(outcomes: readonly SeedOutcome[]): Decision[] {
  return outcomes.map((outcome) =>
    outcome.status === 'skipped' ? { action: 'skip', reason: outcome.reason } : { action: 'run' },
  );
}

/**
 * The environments these seeds are willing to run in — but only when not one of them was
 * willing to run in the environment the command used. Null means at least one was, which
 * makes that environment a real one that happens to have nothing to do right now.
 *
 * The environment gate is checked before the journal, so a seed that reports `wrong-env`
 * will never run under this name however many times you try. Every seed reporting one is
 * therefore not a fact about the database but a fact about the name, and the only thing
 * sowme can offer in its place is the set of names that would have worked.
 */
function environmentsSeedsAccept(decisions: readonly Decision[]): string[] | null {
  const accepted = new Set<string>();

  for (const decision of decisions) {
    // Ran, or the journal had already recorded it: either way the gate let it through.
    if (decision.action === 'run') return null;
    if (decision.reason.kind === 'already-applied') return null;
    if (decision.reason.kind === 'wrong-env') {
      for (const environment of decision.reason.allowed) accepted.add(environment);
    }
  }

  return accepted.size > 0 ? [...accepted].sort() : null;
}

/** Commands and what they do, in two aligned columns. */
function commandLines(commands: readonly [string, string][]): string[] {
  const width = commands.reduce((max, [command]) => Math.max(max, command.length), 0);
  return commands.map(([command, note]) => `    ${command.padEnd(width)}  ${style.dim(note)}`);
}

/**
 * A `--only` run that did nothing, because everything named was already in the journal.
 *
 * `--only` is a filter, not an imperative — it narrows the set and the ordinary rules
 * still apply, which is what keeps it safe in a deploy script. But you typed a name and
 * nothing happened, and that gap is where an afternoon goes. So the two commands that
 * resolve it are printed rather than described.
 */
function formatNothingSelected(names: readonly string[]): string {
  return [
    `  ${style.yellow('nothing ran')} — every seed you selected is already in the journal.`,
    ...commandLines([
      [`sowme run --only ${names.join(',')} --force`, 'run it anyway'],
      [
        `sowme forget ${names.join(' ')}`,
        names.length === 1 ? 'drop its journal row' : 'drop their journal rows',
      ],
    ]),
  ].join('\n');
}

/**
 * A `--only` run that did nothing, because none of the names is a seed.
 *
 * The sibling of {@link formatNothingSelected}: those are the two ways `--only` applies
 * nothing, and this one is indistinguishable from a working filter — a count of skips and
 * exit 0. `--only` deliberately does not error on a name it cannot find, since that check
 * belongs to the run and not to the parser, so this is where a misspelling surfaces.
 */
function formatNothingMatched(names: readonly string[]): string {
  const quoted = names.map((name) => `"${name}"`).join(' or ');

  return [
    `  ${style.yellow('nothing ran')} — no seed is named ${quoted}.`,
    style.dim('    A seed takes its name from its filename unless it sets `name`.'),
    ...commandLines([['sowme status', 'every name, as sowme resolved it']]),
  ].join('\n');
}

/**
 * A run in an environment that every seed refused.
 *
 * This is `sowme run --env prodution`: no seed matches, everything skips, and CI reads a
 * successful deploy step. The per-seed lines do each say `production only — running as
 * prodution`, but nothing in them separates "this environment has no work today" — a real
 * state, and a quiet one — from "no seed has ever heard of this name". Every seed being
 * turned away at the environment gate is that second fact and it is provable: the gate is
 * checked before the journal, so a seed that reports `wrong-env` will never run under this
 * name no matter how often you try.
 *
 * The exit code stays 0. sowme cannot tell a misspelling from an environment that
 * legitimately has no seeds — a project whose seeds are all `development` and whose
 * deploy runs `sowme run` in every environment is doing nothing wrong — and failing that
 * pipeline in order to catch a typo is the more expensive of the two mistakes. What is
 * within sowme's power is to be impossible to miss, and to name where the value came
 * from, since the place to fix it differs for each source.
 *
 * Which environment to use instead is deliberately not suggested. The list is right
 * there, and a tool that offers `sowme run --env production` as a hint is a tool that
 * talked someone into seeding production.
 *
 * "these seeds" rather than "no seed", because the claim is only as wide as the lines
 * above it: under `--only` the seeds nobody asked about were never consulted, and sowme
 * does not know what they would have said.
 */
function formatUnknownEnvironment(parts: {
  env: string;
  /** `ResolvedConfig.sources.env` — where this environment came from. */
  source: string;
  /** Every environment the seeds sowme consulted are willing to run in. */
  declared: readonly string[];
}): string {
  return [
    `  ${style.yellow('warning')} ${style.cyan(parts.env)} is not an environment these seeds run in`,
    style.dim(`    they run in: ${parts.declared.join(', ')}`),
    style.dim(`    ${environmentOrigin(parts.env, parts.source)}`),
  ].join('\n');
}

/**
 * Where the environment came from, phrased as the place to go and fix it.
 *
 * This is what `sources.env` is for. A typo in `--env` is in your shell history, a typo
 * in `NODE_ENV` is in your CI configuration, and `default` means nobody chose an
 * environment at all — so there is no spelling to correct and the advice is to choose one.
 */
function environmentOrigin(env: string, source: string): string {
  if (source === 'default') {
    return `nothing chose an environment, so sowme used ${env} — pass --env or set NODE_ENV`;
  }

  const where = source === 'config' ? '`env` in your config' : source;
  return `it came from ${where} — check it against that list`;
}

export function formatForgotten(results: readonly { name: string; forgotten: boolean }[]): string {
  const pad = padder(results.map((result) => result.name));

  return results
    .map(({ name, forgotten }) =>
      forgotten
        ? `  ${style.green('✓')} ${pad(name)}  ${style.dim('forgotten — it will run again')}`
        : `  ${style.dim('·')} ${pad(name)}  ${style.dim('not in the journal')}`,
    )
    .join('\n');
}

const indent = (text: string) =>
  text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');

const TRACE_HINT = 'Run again with --trace for the stack.';

/** A sowme error is a message and a hint. Anything else is a message and, on request, a stack. */
export function formatError(error: unknown, trace = false): string {
  return `${style.red('error')} ${headlineOf(error)}\n${style.dim(indent(bodyOf(error, trace)))}`;
}

/**
 * A seed threw. Says which one, and — the part you need before deciding what to do
 * next — whether its writes are still in the database.
 */
export function formatSeedFailure(
  seed: string,
  error: unknown,
  options: { rolledBack: boolean; trace: boolean },
): string {
  const aftermath = options.rolledBack
    ? style.dim('rolled back — the database is as it was before this seed started')
    : style.yellow('NOT rolled back — transaction: false, so its writes are still there');

  return [
    `${style.red('error')} ${seed} failed`,
    indent(aftermath),
    '',
    indent(headlineOf(error)),
    style.dim(indent(bodyOf(error, options.trace))),
  ].join('\n');
}

function headlineOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bodyOf(error: unknown, trace: boolean): string {
  if (error instanceof SowmeError) return error.hint;
  if (!(error instanceof Error)) return '';

  const lines = [...databaseDetails(error)];
  lines.push(trace ? (error.stack ?? '') : TRACE_HINT);
  return lines.join('\n');
}

/**
 * Pulls the fields a Postgres driver attaches to its errors.
 *
 * `message` alone says a constraint was violated; `detail` says which row did it.
 * Reading them off the error is cheaper for everyone than reading a stack trace.
 */
function databaseDetails(error: Error): string[] {
  const fields = error as unknown as Record<string, unknown>;
  const lines: string[] = [];

  for (const key of ['detail', 'hint', 'table', 'constraint', 'code'] as const) {
    const value = fields[key];
    if (typeof value === 'string' && value.length > 0) lines.push(`${key}: ${value}`);
  }

  return lines.length > 0 ? [...lines, ''] : [];
}
