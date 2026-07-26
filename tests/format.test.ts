import { describe, expect, test } from 'bun:test';
import {
  formatCrossImports,
  formatNothingApplied,
  formatNotSelected,
  formatStatus,
} from '../src/cli/format.ts';
import type { Inspection, SeedStatus } from '../src/inspect.ts';
import type { SeedOutcome } from '../src/types.ts';

/**
 * `format.ts` decides once at import whether it may use colour, from `isTTY` and the
 * usual environment variables. Which of the two it picked is not what these tests are
 * about, so they strip the escapes and assert on the words.
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, 'g');
const plain = (text: string) => text.replace(ANSI, '');

const applied = (name: string): SeedOutcome => ({ name, status: 'applied', durationMs: 1 });
const notSelected = (name: string): SeedOutcome => ({
  name,
  status: 'skipped',
  reason: { kind: 'not-selected' },
});
const wrongEnv = (name: string, allowed: string[]): SeedOutcome => ({
  name,
  status: 'skipped',
  reason: { kind: 'wrong-env', allowed },
});
const alreadyApplied = (name: string): SeedOutcome => ({
  name,
  status: 'skipped',
  reason: { kind: 'already-applied', appliedAt: new Date('2026-07-20T00:00:00Z') },
});

/** The boring arguments filled in, so each test states only the thing it is about. */
function explain(
  outcomes: SeedOutcome[],
  context: { only?: string[]; env?: string; envSource?: string } = {},
): string | null {
  const block = formatNothingApplied({
    outcomes,
    only: context.only,
    env: context.env ?? 'development',
    envSource: context.envSource ?? 'default',
  });
  return block === null ? null : plain(block);
}

function seed(name: string, extra: Partial<SeedStatus> = {}): SeedStatus {
  return {
    name,
    file: `seeds/${name}.ts`,
    dependsOn: [],
    environments: null,
    mode: 'once',
    transaction: true,
    entry: null,
    decision: { action: 'run' },
    ...extra,
  };
}

function inspection(seeds: SeedStatus[], extra: Partial<Inspection> = {}): Inspection {
  return {
    env: 'development',
    journalTable: 'sowme_journal',
    sources: { env: 'default', seeds: 'config', journalTable: 'default' },
    order: seeds.map((each) => each.name),
    seeds,
    orphans: [],
    crossImports: [],
    ...extra,
  };
}

describe('formatNotSelected', () => {
  test('counts what --only left out, against the total, and names the flag', () => {
    const line = formatNotSelected({ notSelected: 11, total: 12, only: ['demo'] });

    expect(plain(line ?? '')).toBe('  · 11 of 12 not selected  (--only demo)');
  });

  test('names every selected seed, so a typo in one of them is visible', () => {
    const line = formatNotSelected({ notSelected: 10, total: 12, only: ['demo', 'roles'] });

    expect(plain(line ?? '')).toContain('(--only demo,roles)');
  });

  test('says nothing when --only left nothing out', () => {
    expect(formatNotSelected({ notSelected: 0, total: 12, only: ['demo'] })).toBeNull();
  });

  test('says nothing when the command was not narrowed at all', () => {
    expect(formatNotSelected({ notSelected: 0, total: 12, only: undefined })).toBeNull();
  });
});

describe('formatStatus', () => {
  test('lists every seed when nothing narrowed the report', () => {
    const report = plain(formatStatus(inspection([seed('roles'), seed('demo')])));

    expect(report).toContain('roles');
    expect(report).toContain('demo');
    expect(report).not.toContain('not selected');
  });

  test('replaces the seeds --only left out with one line, and keeps the count honest', () => {
    const report = plain(
      formatStatus(
        inspection([
          seed('roles'),
          seed('demo', { decision: { action: 'skip', reason: { kind: 'not-selected' } } }),
          seed('fake-users', { decision: { action: 'skip', reason: { kind: 'not-selected' } } }),
        ]),
        { only: ['roles'] },
      ),
    );

    expect(report).toContain('roles');
    expect(report).toContain('· 2 of 3 not selected  (--only roles)');
    // The rows are gone, but the run order still names every seed: a narrowed report
    // must not read like a project with one seed in it.
    expect(report).toContain('order: roles → demo → fake-users');
  });

  test('keeps a row whose skip carries information a count could not', () => {
    const report = plain(
      formatStatus(
        inspection([
          seed('roles'),
          seed('fake-users', {
            environments: ['development'],
            decision: { action: 'skip', reason: { kind: 'wrong-env', allowed: ['development'] } },
          }),
        ]),
        { only: ['roles', 'fake-users'] },
      ),
    );

    expect(report).toContain('fake-users');
    expect(report).not.toContain('not selected');
  });

  test('warns when no seed it listed runs in the environment', () => {
    const report = plain(
      formatStatus(
        inspection(
          [
            seed('demo', {
              environments: ['development', 'staging'],
              decision: {
                action: 'skip',
                reason: { kind: 'wrong-env', allowed: ['development', 'staging'] },
              },
            }),
          ],
          { env: 'prodution', sources: { env: '--env', seeds: 'config', journalTable: 'default' } },
        ),
      ),
    );

    expect(report).toContain('warning prodution is not an environment these seeds run in');
    expect(report).toContain('they run in: development, staging');
  });

  test('reports seed files that import each other, under the resolved order', () => {
    const report = plain(
      formatStatus(
        inspection([seed('territory'), seed('demo', { dependsOn: ['territory'] })], {
          crossImports: [{ from: 'demo', to: 'territory', bindings: ['REGIONS'] }],
        }),
      ),
    );

    expect(report).toContain('warning seed files that import another seed:');
    expect(report).toContain('demo imports territory');
    expect(report.indexOf('order:')).toBeLessThan(report.indexOf('warning'));
  });

  /**
   * The one thing `--only` does not narrow. A cross-import between two seeds you did not
   * select is still in the file, and `--only demo` is the run where the second application
   * is least visible — so hiding the warning there would hide it where it costs the most.
   */
  test('keeps the warning when --only narrowed the rows away from it', () => {
    const report = plain(
      formatStatus(
        inspection(
          [
            seed('roles'),
            seed('territory', {
              decision: { action: 'skip', reason: { kind: 'not-selected' } },
            }),
            seed('demo', { decision: { action: 'skip', reason: { kind: 'not-selected' } } }),
          ],
          { crossImports: [{ from: 'demo', to: 'territory', bindings: ['seedTerritory'] }] },
        ),
        { only: ['roles'] },
      ),
    );

    expect(report).toContain('demo imports territory');
    expect(report).toContain('seedTerritory');
  });
});

describe('formatCrossImports', () => {
  /** The finding the real consumer produced, which is what the wording was written for. */
  const territory = { from: 'demo', to: 'territory', bindings: ['REGIONS', 'seedTerritory'] };

  test('says nothing when no seed imports another', () => {
    expect(formatCrossImports([])).toBeNull();
  });

  test('names both seeds and every binding, so the statement can be found', () => {
    const block = plain(formatCrossImports([territory]) ?? '');

    expect(block).toContain('demo imports territory');
    expect(block).toContain('REGIONS, seedTerritory');
  });

  test('gives the advice that dissolves the finding rather than silencing it', () => {
    const block = plain(formatCrossImports([territory]) ?? '');

    // Both halves are mandatory: the reader whose bindings are data has somewhere to put
    // them, and the reader whose bindings are work has the feature that replaces the call.
    expect(block).toContain('Move data two seeds share into a module that is not a seed.');
    expect(block).toContain('`dependsOn` replaces the import');
  });

  /**
   * The honesty constraint. `import { REGIONS, seedTerritory }` is one statement carrying
   * data and work, and the scan reports names rather than meanings — so the text says what
   * happens when the work is *called*, and says out loud that it did not decide which is
   * which. A warning that asserted "territory runs twice" would be guessing.
   */
  test('does not claim to know which bindings are data and which are work', () => {
    const block = plain(formatCrossImports([territory]) ?? '');

    expect(block).toContain('sowme does not decide');
    expect(block).toContain('imported from a seed and called');
  });

  test('lines the bindings up when there is more than one finding', () => {
    const block = plain(
      formatCrossImports([
        territory,
        { from: 'fake-users', to: 'roles', bindings: ['ROLE_NAMES'] },
      ]) ?? '',
    );
    const rows = block.split('\n').filter((line) => line.includes(' imports '));

    expect(rows).toHaveLength(2);
    expect(rows[0]?.indexOf('—')).toBe(rows[1]?.indexOf('—') ?? -1);
  });

  test('says so when the import named nothing at all', () => {
    const block = plain(
      formatCrossImports([{ from: 'demo', to: 'territory', bindings: [] }]) ?? '',
    );

    expect(block).toContain('demo imports territory  — no bindings named');
  });
});

describe('formatNothingApplied', () => {
  test('says nothing when a seed ran', () => {
    expect(explain([applied('roles'), wrongEnv('demo', ['development'])])).toBeNull();
  });

  test('says nothing when the journal simply has everything already', () => {
    expect(explain([alreadyApplied('roles'), alreadyApplied('demo')])).toBeNull();
  });

  test('offers --force and forget when everything --only named is in the journal', () => {
    const block = explain([alreadyApplied('demo'), notSelected('roles')], { only: ['demo'] });

    expect(block).toContain('nothing ran — every seed you selected is already in the journal');
    expect(block).toContain('sowme run --only demo --force');
    expect(block).toContain('sowme forget demo');
  });

  test('says so when nothing --only named is a seed at all', () => {
    const block = explain([notSelected('roles'), notSelected('demo')], { only: ['dem0'] });

    expect(block).toContain('nothing ran — no seed is named "dem0"');
    expect(block).toContain('sowme status');
  });

  test('names each name when several of them matched nothing', () => {
    const block = explain([notSelected('roles')], { only: ['dem0', 'rolez'] });

    expect(block).toContain('no seed is named "dem0" or "rolez"');
  });

  /**
   * The distinction defect 2 turns on. Both runs applied nothing and both exit 0; only
   * one of them is a typo, and what separates them is whether any seed got past the
   * environment gate at all.
   */
  test('warns when every seed refused the environment', () => {
    const block = explain(
      [wrongEnv('demo', ['development', 'staging']), wrongEnv('prod', ['production'])],
      {
        env: 'prodution',
        envSource: '--env',
      },
    );

    expect(block).toContain('warning prodution is not an environment these seeds run in');
    expect(block).toContain('they run in: development, production, staging');
  });

  test('stays quiet when a seed does accept the environment and has already run in it', () => {
    expect(
      explain([alreadyApplied('prod-config'), wrongEnv('demo', ['development'])], {
        env: 'production',
        envSource: '--env',
      }),
    ).toBeNull();
  });

  test('answers about --only before it remarks on environments', () => {
    const block = explain([alreadyApplied('demo'), wrongEnv('fake-users', ['staging'])], {
      only: ['demo', 'fake-users'],
      env: 'development',
      envSource: '--env',
    });

    expect(block).toContain('already in the journal');
    expect(block).not.toContain('warning');
  });

  test('points at --env for the spelling', () => {
    expect(
      explain([wrongEnv('demo', ['development'])], { env: 'prodution', envSource: '--env' }),
    ).toContain('it came from --env — check it against that list');
  });

  test('points at NODE_ENV when that is where the environment came from', () => {
    expect(
      explain([wrongEnv('demo', ['development'])], { env: 'prodution', envSource: 'NODE_ENV' }),
    ).toContain('it came from NODE_ENV');
  });

  test('points at the config when that is where the environment came from', () => {
    expect(
      explain([wrongEnv('demo', ['development'])], { env: 'prodution', envSource: 'config' }),
    ).toContain('it came from `env` in your config');
  });

  test('says nobody chose one when the environment is only the default', () => {
    const block = explain([wrongEnv('demo', ['staging', 'production'])], { envSource: 'default' });

    expect(block).toContain('nothing chose an environment, so sowme used development');
    expect(block).toContain('pass --env or set NODE_ENV');
  });
});
