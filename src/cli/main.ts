#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { UsageError } from '../errors.ts';
import { inspect } from '../inspect.ts';
import { ensureJournal, forgetApplied } from '../journal.ts';
import { loadConfigFile, type ResolvedConfig, resolveConfig } from '../resolve/config.ts';
import { displayPath } from '../resolve/paths.ts';
import { runSeeds, SeedFailedError } from '../run.ts';
import type { Config, RunEvent } from '../types.ts';
import {
  CLEAR_LINE,
  formatCrossImports,
  formatDuration,
  formatError,
  formatForgotten,
  formatHeader,
  formatNothingApplied,
  formatNotSelected,
  formatSeedFailure,
  formatSkipReason,
  formatStatus,
  formatWaiting,
  isInteractive,
  padder,
  style,
} from './format.ts';
import { runInit } from './init.ts';

const VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string })
  .version;

const HELP = `sidder ${VERSION} — a seed runner

  sidder run          run every seed that has not run yet, in dependency order
  sidder status       show what has run, what would run, and in what order
  sidder forget <a>   drop seeds from the journal so they run again
  sidder init         write a starting sidder.config.mts
  sidder help <cmd>   show the options and examples for one command

Global options
      --trace           print stack traces for unexpected errors
  -h, --help
  -v, --version

Run \`npx sidder help <command>\` for command-specific options and examples.

The seed you are editing right now is the one case the journal gets in the way of:

  npx sidder run --only demo --force   apply it again, journal or not
  npx sidder forget demo               drop its row, then run normally

sidder imports your seeds with the runtime it was launched with, so run it under Bun or
Node >= 22.18 for TypeScript to work without a loader.`;

const RUN_HELP = `sidder run — apply seeds in dependency order

Usage
  npx sidder run [options]

Options
  -c, --config <path>   config file (default: nearest sidder.config.*, searching upwards)
  -e, --env <name>      environment (default: config, NODE_ENV, then "development")
      --only <a,b>      run exactly these seeds; dependencies are not pulled in
      --force           apply seeds the journal has already recorded
      --dry-run         decide and print everything, execute nothing
      --trace           print stack traces for unexpected errors
  -h, --help

Examples
  npx sidder run
  npx sidder run --env production
  npx sidder run --only roles,territory
  npx sidder run --only demo --force`;

const STATUS_HELP = `sidder status — inspect seeds and journal state

Usage
  npx sidder status [options]

Options
  -c, --config <path>   config file (default: nearest sidder.config.*, searching upwards)
  -e, --env <name>      environment (default: config, NODE_ENV, then "development")
      --only <a,b>      narrow seed rows without changing the resolved order
      --json            print the inspection object as JSON
      --trace           print stack traces for unexpected errors
  -h, --help

Examples
  npx sidder status
  npx sidder status --env production
  npx sidder status --json`;

const FORGET_HELP = `sidder forget — remove journal rows so seeds can run again

Usage
  npx sidder forget <name...> [options]

Options
  -c, --config <path>   config file (default: nearest sidder.config.*, searching upwards)
      --trace           print stack traces for unexpected errors
  -h, --help

Examples
  npx sidder forget demo
  npx sidder forget roles territory
  npx sidder forget old-name --config ./sidder.config.mts`;

const INIT_HELP = `sidder init — write a starting configuration

Usage
  npx sidder init [--force]

Options
      --force           overwrite the config sidder would resolve
  -h, --help

The generated .mts files are explicit ES modules, so they do not depend on the nearest
package.json having "type": "module".`;

const COMMAND_HELP = {
  run: RUN_HELP,
  status: STATUS_HELP,
  forget: FORGET_HELP,
  init: INIT_HELP,
} as const;

type Command = keyof typeof COMMAND_HELP;
type OptionName = keyof typeof OPTIONS;

const OPTIONS = {
  config: { type: 'string', short: 'c' },
  env: { type: 'string', short: 'e' },
  only: { type: 'string' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  trace: { type: 'boolean' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

const ALLOWED_OPTIONS: Record<Command, ReadonlySet<OptionName>> = {
  run: new Set(['config', 'env', 'only', 'dry-run', 'force', 'trace', 'help', 'version']),
  status: new Set(['config', 'env', 'only', 'json', 'trace', 'help', 'version']),
  forget: new Set(['config', 'trace', 'help', 'version']),
  init: new Set(['force', 'trace', 'help', 'version']),
};

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv);

  if (values.version) {
    console.log(VERSION);
    return 0;
  }

  const command = positionals[0];
  if (command === 'help') {
    validateRootOptions(values);
    const target = positionals[1];
    if (positionals.length > 2) {
      throw usage('help accepts at most one command name', 'npx sidder help run');
    }
    if (target === undefined) {
      console.log(HELP);
      return 0;
    }
    if (!isCommand(target)) throw unknownCommand(target);
    console.log(COMMAND_HELP[target]);
    return 0;
  }

  if (command === undefined) {
    validateRootOptions(values);
    console.log(HELP);
    return 0;
  }
  if (!isCommand(command)) throw unknownCommand(command);

  validateOptions(command, values);

  if (values.help) {
    console.log(COMMAND_HELP[command]);
    return 0;
  }

  validatePositionals(command, positionals);

  switch (command) {
    case 'init':
      return commandInit(values.force ?? false);
    case 'run':
      return await commandRun(values);
    case 'status':
      return await commandStatus(values);
    case 'forget':
      return await commandForget(values, positionals.slice(1).flatMap(splitNames));
  }
}

function commandInit(force: boolean): number {
  const { message } = runInit(process.cwd(), force);
  console.log(message);
  return 0;
}

type Values = { config?: string | undefined; env?: string | undefined; only?: string | undefined };

/**
 * Loads the config and prints the header, which is where every inferred value is named.
 *
 * `display` is separate from `values` because it is about this command's output, not
 * about which config to load: `status` suppresses the header for `--json`, and only
 * `run` announces the two modes that make it behave unlike itself.
 */
async function open(
  values: Values,
  display: { json?: boolean; dryRun?: boolean; force?: boolean } = {},
): Promise<{ config: Config; baseDir: string; resolved: ResolvedConfig }> {
  const { config, file } = await loadConfigFile(values.config);
  const baseDir = dirname(file);
  const resolved = resolveConfig(config, { env: values.env, baseDir });

  if (!display.json) {
    console.log(
      formatHeader({
        version: VERSION,
        configFile: displayPath(file),
        env: resolved.env,
        envSource: resolved.sources.env,
        journalTable: resolved.journalTable,
      }),
    );
    if (display.dryRun) console.log(style.yellow('dry run — nothing will be written'));
    if (display.force) {
      console.log(style.yellow('--force — applied seeds will run again, journal or not'));
    }
    console.log('');
  }

  return { config, baseDir, resolved };
}

async function commandRun(
  values: Values & {
    'dry-run'?: boolean | undefined;
    force?: boolean | undefined;
    trace?: boolean | undefined;
  },
): Promise<number> {
  const dryRun = values['dry-run'] ?? false;
  const force = values.force ?? false;
  const only = parseOnly(values.only);
  const {
    config,
    baseDir,
    resolved: { env, sources },
  } = await open(values, { dryRun, force });

  let pad = (name: string) => name;
  const write = (text: string) => {
    if (isInteractive) process.stdout.write(CLEAR_LINE);
    console.log(text);
  };

  const onEvent = (event: RunEvent): void => {
    switch (event.type) {
      case 'plan':
        // Padded to the names that will print rather than to every name in the project:
        // under `--only` the rest never reach the report, and a column left wide enough
        // for them is a gap standing in for a seed the reader cannot see.
        pad = padder(
          only === undefined ? event.order : event.order.filter((name) => only.includes(name)),
        );
        break;
      case 'cross-imports': {
        // Before the first seed, so it is read before the run it is about rather than
        // after. Never null here — the event is only emitted for a non-empty list — but
        // `formatStatus` asks the same question of a project that has none.
        const warning = formatCrossImports(event.findings);
        if (warning !== null) write(`${warning}\n`);
        break;
      }
      case 'start':
        if (isInteractive) process.stdout.write(`  ${style.dim('⋯')} ${pad(event.name)}`);
        break;
      case 'applied':
        write(
          `  ${style.green('✓')} ${pad(event.name)}  ${style.dim(formatDuration(event.durationMs))}`,
        );
        break;
      case 'would-run':
        write(`  ${style.green('✓')} ${pad(event.name)}  ${style.dim('would run')}`);
        break;
      case 'skipped':
        // Every skip but one gets its own line. `--only`'s are counted and reported in a
        // single line once the run is over, because forty-nine of them is not a report.
        if (event.reason.kind === 'not-selected') break;
        write(
          `  ${style.dim('·')} ${pad(event.name)}  ${style.dim(formatSkipReason(event.reason, env))}`,
        );
        break;
      case 'failed':
        write(`  ${style.red('✗')} ${pad(event.name)}  ${style.red('failed')}`);
        break;
      case 'waiting': {
        const line = formatWaiting(pad(event.name));
        // On a terminal this takes over the `⋯` line and leaves no newline behind it, so
        // the seed's own result replaces it in turn — the trick `write` plays, from the
        // other side. In a pipeline there is no `⋯` line to take over and nothing that
        // will come back and tidy up, and a run stuck here with nothing in the log is the
        // defect this event exists for, so it prints a line and keeps it.
        if (isInteractive) process.stdout.write(`${CLEAR_LINE}${line}`);
        else console.log(line);
        break;
      }
    }
  };

  const startedAt = performance.now();
  try {
    const result = await runSeeds(config, {
      env: values.env,
      only,
      force,
      dryRun,
      baseDir,
      onEvent,
    });

    // A dry run's outcomes say `would-run` where a real run's say `applied`, and one
    // result never holds both — so a single count is right either way, and the verb
    // below is what says which of the two happened.
    const ran = result.outcomes.filter(
      (o) => o.status === 'applied' || o.status === 'would-run',
    ).length;
    const skipped = result.outcomes.filter((o) => o.status === 'skipped').length;
    const notSelected = result.outcomes.filter(
      (o) => o.status === 'skipped' && o.reason.kind === 'not-selected',
    ).length;

    // The seeds `--only` left out, as the last line of the list they were left out of.
    const filtered = formatNotSelected({ notSelected, total: result.outcomes.length, only });
    if (filtered !== null) write(filtered);

    const verb = dryRun ? 'would apply' : 'applied';
    console.log('');
    console.log(
      style.dim(
        `  ${ran} ${verb}, ${skipped} skipped in ${formatDuration(performance.now() - startedAt)}`,
      ),
    );

    // A run that applied nothing is a legitimate outcome and it is also what every typo in
    // this area looks like. Saying which of the two happened is the report's job.
    const explanation = formatNothingApplied({
      outcomes: result.outcomes,
      only,
      env,
      envSource: sources.env,
    });
    if (explanation !== null) {
      console.log('');
      console.log(explanation);
    }
    return 0;
  } catch (error) {
    // A seed threw. The runner stopped there and the transaction already resolved, so the
    // useful report is which seed, why, and whether its writes survived — all of which
    // the throw carries. Anything else is a refusal to start and belongs to `formatError`.
    if (!(error instanceof SeedFailedError)) throw error;
    console.log('');
    console.error(
      // `error.cause`, not `error`: the fields worth printing — a driver's `detail`,
      // `constraint` and `code` — are on the seed's own error, not on the wrapper.
      formatSeedFailure(error.seed, error.cause, {
        rolledBack: error.rolledBack,
        trace: values.trace ?? false,
      }),
    );
    return 1;
  } finally {
    await config.adapter.close?.();
  }
}

async function commandStatus(values: Values & { json?: boolean | undefined }): Promise<number> {
  const json = values.json ?? false;
  const only = parseOnly(values.only);
  const { config, baseDir } = await open(values, { json });

  try {
    const inspection = await inspect(config, {
      env: values.env,
      baseDir,
      ...(only ? { only } : {}),
    });

    console.log(json ? JSON.stringify(inspection, null, 2) : formatStatus(inspection, { only }));
    return 0;
  } finally {
    await config.adapter.close?.();
  }
}

/**
 * Deletes journal rows so their seeds run again.
 *
 * Discovers no seeds, on purpose. It works on the journal rather than on the seed list,
 * which is what lets it delete the orphan row `status` complains about after a rename —
 * and what lets it work at all when the seed file no longer imports.
 */
async function commandForget(values: Values, names: string[]): Promise<number> {
  if (names.length === 0) {
    console.error(`${style.red('error')} forget needs at least one seed name`);
    console.error(style.dim('  npx sidder forget demo — `npx sidder status` lists the names'));
    return 1;
  }

  const { config, resolved } = await open(values);

  try {
    await ensureJournal(resolved.adapter.root, resolved.journalTable);
    const forgotten = new Set(
      await forgetApplied(resolved.adapter.root, resolved.journalTable, names),
    );

    console.log(formatForgotten(names.map((name) => ({ name, forgotten: forgotten.has(name) }))));
    return 0;
  } finally {
    await config.adapter.close?.();
  }
}

/** `a,b` and `a, b` are both two names. */
function splitNames(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function parseOnly(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : splitNames(value);
}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw usage(message, 'npx sidder --help');
  }
}

function isCommand(value: string): value is Command {
  return value in COMMAND_HELP;
}

function validateOptions(command: Command, values: Record<string, unknown>): void {
  const allowed = ALLOWED_OPTIONS[command];
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && !allowed.has(name as OptionName)) {
      throw usage(
        `--${name} is not valid with \`sidder ${command}\``,
        `npx sidder ${command} --help`,
      );
    }
  }
}

function validateRootOptions(values: Record<string, unknown>): void {
  const allowed = new Set<OptionName>(['trace', 'help', 'version']);
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && !allowed.has(name as OptionName)) {
      throw usage(`--${name} needs a command`, 'npx sidder --help');
    }
  }
}

function validatePositionals(command: Command, positionals: string[]): void {
  if (command === 'forget') return;
  if (positionals.length > 1) {
    throw usage(
      `\`sidder ${command}\` does not accept positional arguments`,
      `npx sidder ${command} --help`,
    );
  }
}

function usage(message: string, example: string): UsageError {
  return new UsageError(message, `Run \`${example}\` for the supported usage.`);
}

function unknownCommand(command: string): UsageError {
  return new UsageError(
    `Unknown command "${command}"`,
    'Run `npx sidder --help` to see the supported commands.',
  );
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // Read straight from argv: the failure may well be parseArgs itself.
  console.error(formatError(error, process.argv.includes('--trace')));
  process.exitCode = 1;
}
