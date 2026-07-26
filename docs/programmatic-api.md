# Programmatic API

The package root exports the authoring functions, runner, inspection API, journal helpers,
errors and all public types. Adapters are separate exports:

```ts
import { defineConfig, defineSeed, inspect, runSeeds, SeedFailedError } from 'sidder';
import { pgAdapter } from 'sidder/adapters/pg';
import { drizzleAdapter } from 'sidder/adapters/drizzle';
```

## `defineSeed` and `defineConfig`

Both are identity functions. They return the object passed in and exist for generic
inference, autocomplete and excess-property checking.

## `runSeeds`

```ts
const result = await runSeeds(config, options);
```

### Options

| Option | Type | Default | Effect |
|---|---|---|---|
| `only` | `string[]` | every seed | Exact selection; dependencies are not added |
| `force` | `boolean` | `false` | Ignore already-applied rows |
| `env` | `string` | config resolution | Override environment |
| `baseDir` | `string` | `process.cwd()` | Base for seed globs |
| `journal` | `boolean` | `true` | Read and write application history |
| `dryRun` | `boolean` | `false` | Return `would-run` without database writes |
| `onEvent` | `(event: RunEvent) => void` | none | Observe plan and progress |

Every optional property explicitly accepts `undefined`, making `RunOptions` suitable for
objects assembled from absent CLI flags.

### Test-suite setup

```ts
await runSeeds(
  {
    adapter,
    seeds: [
      { name: 'roles', run: seedRoles },
      { name: 'territory', run: seedTerritory },
    ],
  },
  { journal: false },
);
```

`journal: false` executes every environment-eligible selected seed and records nothing.
`mode` has no meaning without history.

### Result

```ts
interface RunResult {
  env: string;
  outcomes: SeedOutcome[];
}
```

Outcome statuses:

- `applied` with `durationMs`;
- `would-run` for a dry run, with no fake duration;
- `skipped` with `already-applied`, `wrong-env` or `not-selected`;
- `failed`, available on `SeedFailedError.result`.

### Events

`onEvent` receives, in chronological order:

- `plan`: resolved environment and complete order;
- `cross-imports`: emitted only when findings exist;
- `start`: immediately before a seed begins;
- `waiting`: another run owns the seed lock;
- `applied`;
- `would-run`;
- `skipped`;
- `failed`.

One dry run emits `would-run`, never `applied`. `waiting` can occur between `start` and
the final outcome.

### Failure

A thrown seed becomes `SeedFailedError`:

```ts
try {
  await runSeeds(config);
} catch (error) {
  if (error instanceof SeedFailedError) {
    console.error(error.seed);
    console.error(error.rolledBack);
    console.error(error.cause);
    console.error(error.result.outcomes);
  }
}
```

- `cause` is the original thrown value.
- `rolledBack` is false only for `transaction: false`.
- `result` contains every committed/skipped outcome and the final failed outcome.

Earlier transactional seeds remain committed. The next ordinary run resumes from the
failure.

`runSeeds` never calls `adapter.close()`. The caller owns a pool shared across test cases
or repeated invocations.

## `inspect`

```ts
const inspection = await inspect(config, {
  env: 'staging',
  baseDir: import.meta.dirname,
  only: ['roles'],
});
```

It returns the same data as `status --json` before JSON serialization:

```ts
interface Inspection {
  env: string;
  journalTable: string;
  sources: {
    env: string;
    seeds: string;
    journalTable: string;
  };
  order: string[];
  seeds: SeedStatus[];
  orphans: JournalEntry[];
  crossImports: CrossImport[];
}
```

Dates are `Date` objects. `inspect` ensures the journal exists, so its first call may
create the table. It never closes the adapter.

## Journal helpers

Advanced callers can use:

```ts
await ensureJournal(scope, table);
const entries = await readJournal(scope, table);
const forgotten = await forgetApplied(scope, table, ['roles']);
```

All validate the table identifier. `readJournal` returns `Map<string, JournalEntry>`.
`forgetApplied` returns only names that actually existed.

Call these with a `Scope`, not a bare driver. The scope decides whether the operation is
inside a transaction.

## Public errors

Every sidder refusal extends `SidderError` and carries `message` plus an actionable
`hint`:

- `UsageError`
- `ConfigNotFoundError`
- `InvalidConfigError`
- `NoSeedsFoundError`
- `InvalidSeedError`
- `DuplicateSeedNameError`
- `UnknownDependencyError`
- `DependencyCycleError`
- `MissingDependencyError`
- `UnnamedInlineSeedError`
- `UnsafeTableNameError`
- `JournalTableMismatchError`
- `TypeScriptLoaderError`
- `ModuleFormatError`
- `ModuleSyntaxError`
- `ModuleResolutionError`

`SeedFailedError` deliberately does not extend `SidderError`: sidder can report the
aftermath, but it cannot invent a remedy for user seed code.

## Public types

The root exports:

```text
Adapter, Config, CrossImport, Decision, Inspection, JournalEntry, ResolvedSeed,
Row, RunEvent, RunOptions, RunResult, Scope, Seed, SeedContext, SeedMode,
SeedOutcome, SeedStatus, SkipReason
```

The shipped adapter modules additionally export their structural driver interfaces.
