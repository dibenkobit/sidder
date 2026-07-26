# Seeds

A seed file default-exports one object. `defineSeed` returns that object unchanged; it
exists for type inference and autocomplete.

```ts
// seeds/roles.mts
import { defineSeed } from 'sidder';
import type { PgQueryable } from 'sidder/adapters/pg';

export default defineSeed<PgQueryable>({
  name: 'roles',
  dependsOn: ['permissions'],
  environments: ['development', 'staging'],
  mode: 'once',
  transaction: true,

  async run({ db, env, name }) {
    await db.query('insert into roles (name) values ($1)', ['admin']);
  },
});
```

Only `run` is required.

## Fields

| Field | Type | Default | Use it when |
|---|---|---|---|
| `run` | `(ctx) => Promise<void>` | required | This is the seed's work |
| `name` | `string` | filename without extension | A dependency or long-lived journal row addresses it |
| `dependsOn` | `string[]` | `[]` | Other seeds must run first |
| `environments` | `string[]` | every environment | The data must never enter some environments |
| `mode` | `'once' \| 'always'` | `'once'` | An idempotent seed must refresh every invocation |
| `transaction` | `boolean` | `true` | A bulk operation cannot fit in one transaction |

## The context

`run` receives:

```ts
interface SeedContext<TDb> {
  db: TDb;
  env: string;
  name: string;
}
```

With the default transaction, `db` is the transaction-scoped handle. With
`transaction: false`, it is the adapter's root handle. `env` and `name` are the resolved
values printed by the CLI.

## Typing `db`

A seed file is loaded independently from the config, so TypeScript cannot infer its
database type from `config.adapter`. Pass that type to `defineSeed`.

For node-postgres, sidder exports the exact common shape of a Pool and transactional
PoolClient:

```ts
import { defineSeed } from 'sidder';
import type { PgQueryable } from 'sidder/adapters/pg';

export default defineSeed<PgQueryable>({
  async run({ db }) {
    await db.query('insert into roles (name) values ($1)', ['admin']);
  },
});
```

For Drizzle, take the type of the existing instance with a type-only import. The import
is erased and does not initialize a second database connection:

```ts
import { defineSeed } from 'sidder';
import type { db } from '../src/db/index.mts';

export default defineSeed<typeof db>({
  async run({ db }) {
    await db.insert(roles).values({ name: 'admin' });
  },
});
```

Import the schema value normally; only the database handle import needs to be
type-only. Inside a transaction, Drizzle supplies its transaction object. Query builders
are available, but root-only driver properties such as `$client` are not.

## Names

Without `name`, `seeds/reference/roles.mts` is named `roles`. That name is used by
`dependsOn`, `--only` and the journal.

Set a stable explicit name as soon as another seed depends on it:

```ts
export default defineSeed({
  name: 'reference-roles',
  async run({ db }) {
    // ...
  },
});
```

Renaming a file with an implicit name creates a new seed and leaves the old journal row
as an orphan. `status` reports both facts. Remove the old row with:

```bash
npx sidder forget old-name
```

## Dependencies

`dependsOn` describes a data requirement, not a preferred sort order:

```ts
export default defineSeed({
  dependsOn: ['territory', 'roles'],
  async run({ db }) {
    const regions = await db.query('select id from regions');
    // ...
  },
});
```

Seeds communicate through the database. Do not import another seed and call its work.
That bypasses the runner's once-per-invocation guarantee and can apply the imported work
twice.

sidder scans seed source imports and warns when one seed imports another. It names the
bindings but does not guess whether they are work or shared constants. Move shared data
to a module that is not itself a seed; replace imported work with `dependsOn`.

The scan follows relative imports, dynamic imports and re-exports. It does not resolve
bare specifiers or `tsconfig` aliases.

An unknown dependency or dependency cycle stops before any seed runs. Cycle errors print
the actual path.

### `--only` and dependencies

`--only` does not pull dependencies in:

```bash
npx sidder run --only demo
```

If `demo` needs `roles` and `roles` is neither selected nor already applied, sidder
refuses and prints the complete selection:

```bash
npx sidder run --only roles,demo
```

A dependency skipped by its own environment gate is accepted. That gate is a declaration
in the seed; a missing `--only` name is usually a command typo.

## Environment gates

```ts
environments: ['development', 'staging']
```

A seed outside the resolved environment is skipped with the allowed list printed. `--force`
does not bypass this field: force overrules journal history, never a safety declaration.

Environment names are project-defined strings. sidder does not reserve `development`,
`test`, `staging` or `production`.

## Modes

### `once`

The default. The seed runs when its name is absent from the journal and is skipped after
a successful application.

### `always`

Runs once per invocation even when the journal has a row. It still records the latest
application time, environment and duration.

Use it for idempotent data whose inputs live outside the seed file: permission catalogues,
enums or CSV files. There is no `on-change` mode because correctly detecting change would
require hashing the full imported module and asset graph.

## Transactions

The default is `transaction: true`. The seed writes and journal row use the same scope.
A failure rolls both back, and the next run resumes at that seed.

`transaction: false` is for a bulk load that cannot fit in one transaction. It gives up:

- atomic rollback;
- the transaction-scoped advisory lock;
- exact protection from two simultaneous runs.

sidder re-reads the journal immediately before a non-transactional seed, which catches a
run that already finished but not one arriving at the same instant. A failure message says
that writes may remain.

Legacy seed code that writes through an imported global database handle also escapes the
transaction, even if the seed field says `true`. Thread the handed-in `db` through the
code. Until then, declare `transaction: false` so status does not promise atomicity the
runtime cannot enforce.

## Editing a seed that already ran

For a deliberate re-run:

```bash
npx sidder run --only demo --force
```

`--force` keeps the journal row and replaces its timestamp after success. To return to
ordinary once-mode behavior:

```bash
npx sidder forget demo
npx sidder run --only demo
```

Neither operation undoes the seed's earlier database writes. sidder has no reset or down
contract.
