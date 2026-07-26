# sidder

[![npm version](https://img.shields.io/npm/v/sidder.svg)](https://www.npmjs.com/package/sidder)
[![CI](https://github.com/dibenkobit/sidder/actions/workflows/ci.yml/badge.svg)](https://github.com/dibenkobit/sidder/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A seed runner for Postgres.

> Migrations got a runner fifteen years ago. Seeds never did, even though they have the
> same operational problem: ordered steps, one entry point, application history and a
> clear answer to “what will run?”

sidder discovers seed files, orders them from declared dependencies, runs each in a
transaction and records the result in that same transaction. `status` shows the complete
plan before you trust it with a database.

## Requirements

- Postgres.
- Node 22.18 or newer, or Bun.
- An existing node-postgres Pool or Drizzle instance. sidder does not create a second
  database client.

Node's native TypeScript support is enough for erasable syntax and explicit relative
imports. Projects that need `tsconfig` paths or transforms can launch sidder through
`tsx` or Bun; see [Runtimes](docs/runtimes.md).

## Quickstart

### 1. Install

```bash
npm i -D sidder
```

sidder is a local development dependency. Run its binary through your package manager:

| Package manager | Install | Command prefix |
|---|---|---|
| npm | `npm i -D sidder` | `npx sidder` |
| pnpm | `pnpm add -D sidder` | `pnpm exec sidder` |
| Yarn | `yarn add -D sidder` | `yarn sidder` |
| Bun | `bun add -d sidder` | `bun run --bun sidder` |

The examples below use npm. Substitute your command prefix when needed.

### 2. Create the config

```bash
npx sidder init
```

This writes `sidder.config.mts`. It chooses the pg or Drizzle adapter from your
`package.json` and prints the evidence for that choice. It does not guess where your
database handle lives: the generated import is visibly marked as a placeholder.

Point that import at the Pool you already have. A complete pg config looks like this:

```ts
// sidder.config.mts
import { defineConfig } from 'sidder';
import { pgAdapter } from 'sidder/adapters/pg';
import { pool } from './src/db/index.mts';

export default defineConfig({
  adapter: pgAdapter(pool),
  seeds: 'seeds/**/*.mts',
});
```

Use the real extension of your database module. Node requires it.

### 3. Seed one table

```ts
// seeds/roles.mts
import { defineSeed } from 'sidder';

export default defineSeed({
  async run({ db }) {
    await db.query("insert into roles (name) values ('admin')");
  },
});
```

This assumes the `roles` table already exists. Migrations own schema; sidder owns data.

### 4. Inspect, rehearse, run

```bash
npx sidder status
npx sidder run --dry-run
npx sidder run
```

`status` creates the journal table if it is missing but never runs a seed. `--dry-run`
performs discovery, validation, ordering and journal decisions without creating the
journal or writing anything. The final command applies the seed.

That is the whole authoring model: one config, `defineSeed`, and the `db` handed to
`run`. `defineSeed` is an identity function; it exists for editor inference and
compile-time checking.

## What a run tells you

```text
$ npx sidder run
sidder 0.1.0  ·  sidder.config.mts  ·  env development (NODE_ENV)  ·  journal sidder_journal

  ✓ roles         7ms
  ✓ territory     5ms
  ✓ demo          7ms
  · bulk-metrics  already applied 2026-07-24
  · fake-users    development, staging only — running as production

  3 applied, 2 skipped in 52ms
```

Every inferred value includes its source. Every skipped seed includes its reason. A
failed seed says whether its writes rolled back. A process waiting on another run says
so instead of appearing hung.

## The design rule

**Guessing is fine. Guessing quietly is not.**

sidder finds the config by walking upward, defaults the seed glob and reads `NODE_ENV`.
Each inference is named before anything reaches the database. `env development
(NODE_ENV)` and `env development (--env)` are different facts and print differently.

A seed's default name comes from its filename; its position comes from `dependsOn`.
Both are visible through `status`.

The same rule governs what is absent. There is no factory DSL, hidden graph traversal or
`on-change` hash that pretends one source file represents a seed's complete inputs. Seed
code stays ordinary TypeScript.

## Guarantees worth knowing

- Dependencies are topologically ordered, with an actionable cycle path on failure.
- Transactional seed writes and their journal row commit or roll back together.
- Two concurrent runs lock and re-check each transactional seed before applying it.
- `--only` is exact: dependencies are validated but never silently pulled in.
- `mode: 'once'` resumes after failure; `mode: 'always'` supports idempotent refreshes.
- Seed source cross-imports are reported before execution because they can apply work
  twice.
- Programmatic callers can run inline seeds with `journal: false` for test setup.

## Documentation

| Need | Guide |
|---|---|
| Config fields, defaults and precedence | [Configuration](docs/configuration.md) |
| Seed fields, dependencies, modes and transactions | [Seeds](docs/seeds.md) |
| Commands, flags, JSON and exit codes | [CLI reference](docs/cli.md) |
| node-postgres, Drizzle and custom adapters | [Adapters](docs/adapters.md) |
| Node, Bun, loaders and path aliases | [Runtimes](docs/runtimes.md) |
| Journal schema, permissions and concurrent runs | [Journal and concurrency](docs/journal.md) |
| `runSeeds`, `inspect`, events and public errors | [Programmatic API](docs/programmatic-api.md) |
| Diagnosis by symptom | [Troubleshooting](docs/troubleshooting.md) |

The [documentation index](docs/README.md) is the stable entry point for the complete
reference.

## Current limitations

- **Postgres only.** Journal statements and locking are PostgreSQL-specific.
- **`transaction: false` is not concurrency-safe.** Without a transaction there is no
  safe scope for the advisory lock. sidder re-reads the journal immediately before the
  seed, but simultaneous arrivals can both apply it.
- **No reset or down contract.** Forgetting a journal row does not reverse database
  writes.
- **No shared migration timeline.** A seed cannot currently declare a migration as a
  dependency.
- **No asset graph.** A seed that reads CSV, GeoJSON or another external input owns its
  own change detection.

## Development

```bash
bun install
bun test
bun run db:up
bun run test:pg
bun run check
```

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing a
public contract, and use [SUPPORT.md](SUPPORT.md) for issue routing and version policy.
Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md).

See the [changelog](CHANGELOG.md) for released changes.

MIT licensed. See [LICENSE](LICENSE).
