# Troubleshooting

Start with the complete error, including its indented hint. Curated sidder errors already
separate failures that need different remedies. Add `--trace` when the error came from a
driver, loader or seed and the call stack matters:

```bash
npx sidder run --trace
```

## No config found

Run from the project or pass an explicit path:

```bash
npx sidder init
npx sidder status --config ./config/sidder.mts
```

The implicit search walks upward and checks the supported `sidder.config.*` names.

## The generated database import does not resolve

`init` writes `./src/db/index.mts` as a placeholder. Edit that import to the module that
actually exports your Pool or Drizzle instance. The path is relative to the config file
and must include its extension under Node.

## “Cannot use import statement outside a module”

Node classified a `.ts` file as CommonJS. Rename ESM config/seeds to `.mts`, add
`"type": "module"` to the nearest `package.json`, or use Bun/`tsx`.

This is `ModuleFormatError`, not a broken TypeScript statement.

## Unsupported or unreadable TypeScript

Node native type stripping requires Node 22.18+ and erasable syntax. It ignores
`tsconfig.json`, aliases and transforms. Use the commands in [Runtimes](runtimes.md).

## A path alias or package does not resolve

For an actual package, install it where the importing config/seed can see it.

For a `tsconfig` alias, use Bun, `tsx`, or a relative path with its extension. Node native
type stripping does not read `paths`.

## No seeds matched

Globs are relative to the config file in the CLI:

```ts
seeds: 'seeds/**/*.mts'
```

Check the extension as well as the directory. `init` generates `.mts`; the library default
without an explicit field is `seeds/**/*.ts`.

## Unknown dependency

`dependsOn` uses resolved seed names, not paths. A seed name defaults to the file basename:
`seeds/reference/roles.mts` is `roles`.

Set explicit names on long-lived dependencies and compare with `npx sidder status`.

## Dependency missing under `--only`

`--only` is exact. Include the dependency:

```bash
npx sidder run --only roles,demo
```

or omit `--only`. Already-applied dependencies do not need to be selected.

## Dependency cycle

The error prints the cycle path. Break it by choosing the later seed and having it read
the earlier data from the database. Dependencies are prerequisites, not a way to exchange
in-memory values.

## Duplicate seed name

Two files share a basename or explicit name. Give one a distinct stable `name`.

## Journal table mismatch

`journalTable` points at an existing table without the journal's columns. Choose a free
name or correct the config. sidder does not alter or drop the conflicting table.

If the journal itself drifted, compare it with [the schema](journal.md).

## Permission denied

The first real `run`, `status` or `forget` may create the journal. Grant schema `CREATE`,
or create the table in a migration and grant DML. Then grant the separate privileges
needed by the seed body.

`run --dry-run` does not create a missing journal and is useful for separating discovery
problems from write privileges.

## Nothing ran

The summary distinguishes:

- every seed already applied;
- every seed rejected the environment;
- `--only` names that matched nothing;
- a narrowed selection.

Check the header's environment source before changing seeds:

```text
env prodution (--env)
```

Here `prodution` is the misspelled value the command received; sidder does not reserve or
spell-check environment names.

## A seed failed

The CLI says whether it rolled back.

- `rolled back`: the seed and its journal row did not commit; fix it and run again.
- `NOT rolled back`: it declared `transaction: false`; inspect and repair partial writes
  before rerunning.

Postgres `detail`, `constraint`, `table` and `code` fields are printed when the driver
provides them.

## A seed is stuck on “waiting”

Another sidder process owns that seed's transaction lock. This run continues when the
other commits or rolls back. Do not kill the waiting run merely because the line appears.

Investigate the other process and database transaction if the wait outlives the seed's
normal duration.

## Cross-import warning

A seed imports another seed file. If it calls imported work, that work can run once through
the import and once through sidder.

Move shared constants into a non-seed module. Express work ordering with `dependsOn`.
The warning is informational and exits zero because one import statement can contain both
shared data and executable work.

## Before opening an issue

Include:

```bash
npx sidder --version
node --version
```

Also include:

- package manager and operating system;
- pg or Drizzle adapter and driver;
- the command, with secrets removed;
- full error and hint;
- whether the same command behaves differently under `--dry-run`;
- a minimal config and seed if possible.

When filing the issue, keep the runtime and transaction-aftermath details above together.
