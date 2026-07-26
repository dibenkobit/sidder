# Configuration

sidder loads one default-exported config object. `defineConfig` is an identity function:
it adds editor inference and compile-time checking, but no runtime behavior.

```ts
// sidder.config.mts
import { defineConfig } from 'sidder';
import { pgAdapter } from 'sidder/adapters/pg';
import { pool } from './src/db/index.mts';

export default defineConfig({
  adapter: pgAdapter(pool),
  seeds: 'seeds/**/*.mts',
  env: 'development',
  journalTable: 'sidder_journal',
});
```

Only `adapter` is required.

## Fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `adapter` | `Adapter<TDb>` | required | Database handle, transactions and journal SQL |
| `seeds` | `string \| string[] \| Seed<TDb>[]` | `'seeds/**/*.ts'` | File globs or inline seed objects |
| `env` | `string` | `NODE_ENV`, then `'development'` | Environment used by seed gates |
| `journalTable` | `string` | `'sidder_journal'` | Table storing applied seeds |

`sidder init` writes explicit `.mts` files and therefore sets `seeds:
'seeds/**/*.mts'`. The library default remains `seeds/**/*.ts` for existing TypeScript
projects that already define their module mode.

## Finding the config

Without `--config`, the CLI starts at the working directory and walks upward. In each
directory it checks, in this order:

1. `sidder.config.ts`
2. `sidder.config.mts`
3. `sidder.config.js`
4. `sidder.config.mjs`

Keep one config per project. If several supported filenames exist in one directory, the
first one above wins. An explicit path bypasses the search:

```bash
npx sidder status --config ./config/seed.mts
```

Seed globs are relative to the config file in the CLI. Programmatic calls resolve them
from `options.baseDir`, or from `process.cwd()` when `baseDir` is absent.

## Seed globs and inline seeds

One glob:

```ts
seeds: 'seeds/**/*.mts'
```

Several globs:

```ts
seeds: ['seeds/reference/**/*.mts', 'seeds/demo/**/*.mts']
```

The discovered file list is sorted by path before dependency ordering, making independent
seeds deterministic across filesystems.

Tests can skip discovery and pass objects:

```ts
seeds: [rolesSeed, territorySeed]
```

Inline seeds must set `name`; there is no filename from which to derive one. A config
cannot mix globs and objects in the same array.

## Environment precedence

Highest precedence wins:

1. CLI `--env` or programmatic `RunOptions.env`
2. `config.env`
3. `NODE_ENV`
4. `'development'`

The resolved value and its source are printed before a CLI run:

```text
env production (--env)
env staging (config)
env test (NODE_ENV)
env development (default)
```

`Inspection.sources` exposes the same provenance to code.

## Journal table names

The name must be a plain SQL identifier, optionally schema-qualified:

```ts
journalTable: 'sidder_journal'
journalTable: 'internal.sidder_journal'
```

Quoted names, spaces, punctuation, more than one dot, and interpolated SQL are rejected.
The accepted shape is `[A-Za-z_][A-Za-z0-9_]*`, once or on both sides of one dot.

The schema must already exist. sidder creates the table, not the schema. See
[Journal permissions](journal.md#permissions) before using a restricted production role.

## What `init` infers

`npx sidder init` reads dependencies and devDependencies from the nearest `package.json`.
If it finds `drizzle-orm`, it writes a Drizzle config; otherwise it writes node-postgres.
The command prints both the choice and the evidence.

It deliberately does not scan the source tree for a database module. Instead it writes
`./src/db/index.mts` as a marked placeholder and tells you to replace it. A guessed path
that happens to exist but exports the wrong thing is harder to diagnose than an honest
placeholder.

If any supported config already exists, `init` leaves it alone. `--force` overwrites the
same config sidder would resolve; it does not create a competing file.
