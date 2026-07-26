#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { displayPath, loadConfigFile, type ResolvedConfig, resolveConfig } from '../config.ts';
import { inspect } from '../inspect.ts';
import { ensureJournal, forgetApplied } from '../journal.ts';
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
  isInteractive,
  padder,
  style,
} from './format.ts';
import { runInit } from './init.ts';

const VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string })
  .version;

const HELP = `sowme ${VERSION} — a seed runner

  sowme run          run every seed that has not run yet, in dependency order
  sowme status       show what has run, what would run, and in what order
  sowme forget <a>   drop seeds from the journal so they run again
  sowme init         write a starting sowme.config.ts

Options
  -c, --config <path>   config file (default: nearest sowme.config.ts, searching upwards)
  -e, --env <name>      environment to run as (default: NODE_ENV, then "development")
      --only <a,b>      run exactly these seeds; dependencies are not pulled in
      --force           run: apply seeds the journal has already recorded
                        init: overwrite an existing config
      --dry-run         decide everything, execute nothing
      --json            status as JSON
      --trace           print stack traces instead of just the error
  -h, --help
  -v, --version

The seed you are editing right now is the one case the journal gets in the way of:

  sowme run --only demo --force   apply it again, journal or not
  sowme forget demo               drop its row, then run normally

sowme imports your seeds with the runtime it was launched with, so run it under Bun or
Node >= 22.18 for TypeScript to work without a loader.`;

const OPTIONS = {
  config: { type: 'string', short: 'c' },
  env: { type: 'string', short: 'e' },
  only: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  trace: { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
} as const;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
  });

  if (values.version) {
    console.log(VERSION);
    return 0;
  }

  const command = positionals[0];
  if (values.help || command === undefined) {
    console.log(HELP);
    return 0;
  }

  switch (command) {
    case 'init':
      return commandInit(values.force);
    case 'run':
      return await commandRun(values);
    case 'status':
      return await commandStatus(values);
    case 'forget':
      return await commandForget(values, positionals.slice(1).flatMap(splitNames));
    default:
      console.error(`${style.red('error')} unknown command "${command}"\n`);
      console.error(HELP);
      return 1;
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
  values: Values & { 'dry-run': boolean; force: boolean; trace: boolean },
): Promise<number> {
  const dryRun = values['dry-run'];
  const only = parseOnly(values.only);
  const {
    config,
    baseDir,
    resolved: { env, sources },
  } = await open(values, { dryRun, force: values.force });

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
    }
  };

  const startedAt = performance.now();
  try {
    const result = await runSeeds(config, {
      env: values.env,
      only,
      force: values.force,
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
        trace: values.trace,
      }),
    );
    return 1;
  } finally {
    await config.adapter.close?.();
  }
}

async function commandStatus(values: Values & { json: boolean }): Promise<number> {
  const only = parseOnly(values.only);
  const { config, baseDir } = await open(values, { json: values.json });

  try {
    const inspection = await inspect(config, {
      env: values.env,
      baseDir,
      ...(only ? { only } : {}),
    });

    console.log(
      values.json ? JSON.stringify(inspection, null, 2) : formatStatus(inspection, { only }),
    );
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
    console.error(style.dim('  sowme forget demo — `sowme status` lists the names'));
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

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // Read straight from argv: the failure may well be parseArgs itself.
  console.error(formatError(error, process.argv.includes('--trace')));
  process.exitCode = 1;
}
