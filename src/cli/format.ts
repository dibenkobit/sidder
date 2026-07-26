import { SowmeError } from '../errors.ts';
import type { Inspection } from '../inspect.ts';
import type { SkipReason } from '../types.ts';

/**
 * Everything sowme prints.
 *
 * The rule this file exists to enforce: nothing sowme worked out on its own goes
 * unmentioned. Which config, which environment and where the environment came from
 * are on screen before the first statement reaches the database, and every seed that
 * does not run says why in the same line that says it did not run.
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
    case 'not-selected':
      return 'not selected';
  }
}

/** Pads to the widest name so the second column lines up. */
export function padder(names: readonly string[]): (name: string) => string {
  const width = names.reduce((max, name) => Math.max(max, name.length), 0);
  return (name) => name.padEnd(width);
}

/** Width of the longest thing the second column holds, so the notes line up. */
const STATE_WIDTH = 'applied 0000-00-00'.length;

export function formatStatus(inspection: Inspection): string {
  const lines: string[] = [];
  const pad = padder(inspection.seeds.map((seed) => seed.name));

  for (const seed of inspection.seeds) {
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

  return lines.join('\n');
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
