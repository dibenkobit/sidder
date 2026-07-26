# sidder

A seed runner for Postgres.

> Migrations got a runner fifteen years ago. Seeds never did — even though it is the
> same task: an ordered set of steps that change the state of a database.

Migrations have a discovery convention, an inferred order, a record of what has been
applied, one entry point, a `status` command and a single process. Seeds have a folder
of scripts and a `&&`-chain in `package.json` that somebody maintains by hand.

sidder discovers seed files, orders them from declared dependencies, runs each in a
transaction, and records the result in the same transaction. `status` shows the complete
plan before you trust it with a database.

## Requirements

- Postgres.
- Node 22.18 or newer, Bun, or Node with a TypeScript loader.
- An existing node-postgres Pool or Drizzle instance. sidder does not create a second
  database client.

The quickstart uses node-postgres. [Adapters](#adapters) and the
[runtime matrix](#runtimes) are documented below.

## Quickstart

### 1. Install

```bash
npm i -D sidder
```

sidder is a local development dependency, so run its binary through your package manager:

| Package manager | Install | Command prefix |
|---|---|---|
| npm | `npm i -D sidder` | `npx sidder` |
| pnpm | `pnpm add -D sidder` | `pnpm exec sidder` |
| Yarn | `yarn add -D sidder` | `yarn sidder` |
| Bun | `bun add -d sidder` | `bun run --bun sidder` |

Commands below use npm. Substitute the prefix from the table if your project uses
something else.

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

Use the real extension of your database module. Node requires it. If the module is
TypeScript but is not directly loadable by Node, use Bun or your project's TypeScript
loader; the [runtime matrix](#runtimes) explains the trade-offs.

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

This example assumes the `roles` table already exists. Migrations still own schema;
sidder owns data.

### 4. Inspect, rehearse, run

```bash
npx sidder status
npx sidder run --dry-run
npx sidder run
```

`status` creates the journal table if it does not exist, but never runs a seed. `--dry-run`
performs discovery, validation, ordering and journal decisions without writing anything.
The final command applies the seed.

That is the whole authoring model: the config, `defineSeed`, and the `db` handed to
`run`. Everything below is optional and learned when the need appears.

`defineSeed` is an identity function — it returns its argument and does nothing else.
It exists so your editor can autocomplete the fields, and so a typo in one is a compile
error rather than silence.

---

## What one run looks like

```
$ npx sidder run
sidder 0.1.0  ·  sidder.config.mts  ·  env development (NODE_ENV)  ·  journal sidder_journal

  ✓ roles         7ms
  ✓ territory     5ms
  ✓ demo          7ms
  · bulk-metrics  already applied 2026-07-24
  · fake-users    development, staging only — running as production

  3 applied, 2 skipped in 52ms
```

```
$ npx sidder status
  ✓ roles         applied 2026-07-26  always
  ✓ territory     applied 2026-07-26
  ✓ demo          applied 2026-07-26  after territory, roles
  ✗ bulk-metrics  never run           after demo · no transaction
  ✗ fake-users    never run           development, staging only · after demo

  no transaction means more than lost atomicity:
    a failure leaves the seed's writes in the database, and nothing keeps a second run
    off it either — the lock that does that is held by a transaction, and there is none.
    A journal re-read immediately before it runs narrows that gap; it cannot close it.
    Set `transaction: true` if either matters.

  order: roles → territory → demo → bulk-metrics → fake-users
```

---

## The design rule

**Guessing is fine. Guessing quietly is not.**

sidder finds your config by walking up from the working directory, defaults your seeds
to `seeds/**/*.ts`, and takes the environment from `NODE_ENV`. Each of those saves you
a line of configuration — and each is named in the header of every run, along with
where it came from. `env development (NODE_ENV)` and `env development (--env)` are
different facts, so they print differently.

A seed's name is its filename; its position is worked out from `dependsOn`. Both are
printed before anything touches the database.

The same rule governs what is *not* here. An earlier draft of this tool had factories:
`defineFactory`, `ref()`, a context object, implicit graph traversal, `ctx.seq()`,
`weighted()`. Seven new concepts to seed one table, where a `for` loop and an `insert`
need zero. It was cut. A tool that sells clarity does not get to be magical about it.

---

## Concepts, and what each one buys

Every field below is optional. Reach for one when you have the problem it solves.

### `dependsOn` — the replacement for importing another seed

```ts
export default defineSeed({
  dependsOn: ['territory', 'roles'],
  async run({ db }) { /* ... */ },
});
```

This is not sort metadata. It is the answer to "my demo data needs regions to exist",
which without a runner can only be expressed as `import { seedTerritory }` followed by
calling it — at which point territory runs twice and nothing on the outside shows it.

sidder runs each seed exactly once per invocation, so declaring the dependency is enough.
The corollary is that **seeds talk to each other through the database, not through
memory**. Need the region ids? Select them.

If a name in `dependsOn` does not exist, or two seeds depend on each other, sidder says
so before running anything — and prints the actual cycle, not just that there is one.

And because the old way is the quiet one, `run` and `status` both point it out when they
see it:

```
  warning seed files that import another seed:
    demo imports territory  — REGIONS, seedTerritory
    Work imported from a seed and called runs twice — sidder runs that seed as
    well — and both are ordinary writes, so the journal records one.
    Which of those bindings is work and which is shared data, sidder does not decide.
    Move data two seeds share into a module that is not a seed. Where it is the
    work you want, `dependsOn` replaces the import and sidder still runs it once.
```

It is a warning and only a warning: nothing stops, and the exit code stays 0. The
bindings are named rather than judged, because one `import` statement can carry a
constants table and a seed's own work together and no rule over names separates them.
sidder finds them by scanning the import statements as text — a bare specifier or a
`tsconfig` alias is not resolved, so an import written that way is not reported.

### `environments` — a gate that cannot be forgotten

```ts
export default defineSeed({
  environments: ['development', 'staging'],
  async run({ db }) { /* ... */ },
});
```

The usual way to keep fake users out of production is that they are a different line in
`package.json`. That works right up until the two lines drift, which they do. Declaring
the environments inside the file makes the mistake structurally impossible rather than
merely unlikely.

### `mode` — `'once'` (default) or `'always'`

`once` consults the journal and skips what has already run. `always` ignores it.

`always` is for idempotent seeds whose input lives outside the file: a permission
catalogue that grows every sprint, an enum, a CSV. Adding a permission does not change
the seed file, so "has this file changed" is the wrong question — `always` is the right
answer, and re-running something idempotent costs milliseconds.

<a id="why-no-on-change"></a>
There is no `on-change` mode. It would be a speed optimisation over `always`, not a
correctness feature, and doing it properly means hashing a module graph rather than a
file. If you have an `always` seed slow enough to hurt, open an issue — that is the use
case the design would need.

### `transaction` — on by default

Each seed runs in a transaction, and its journal row is written **inside that same
transaction**. A crash rolls back the seed's writes and the record of them together.
There is no half-applied state to repair, and the next run simply does that seed again.

Set `transaction: false` for bulk loads where one transaction would be too large. When
you do, `sidder status` marks the seed `no transaction`, and if it fails, sidder says
plainly that its writes are still in the database:

```
error bulk-metrics failed
  NOT rolled back — transaction: false, so its writes are still there
```

### `name` — when the filename is not enough

A seed's name is its filename without the extension. That name is what `dependsOn`,
`--only` and the journal use, so renaming the file renames the seed. Set `name`
explicitly as soon as anything depends on it.

sidder catches both halves of that mistake: a `dependsOn` pointing at a name that no
longer exists is an error, and a journal row with no seed to match it is reported by
`status` as an orphan.

---

## Wrapping seeds you already have

Nobody rewrites sixteen hundred lines of working seed code for a new tool. The wrapper
is the adoption path:

```ts
// seed-demo.ts — the body is untouched
export default defineSeed({
  dependsOn: ['territory', 'roles'],
  environments: ['development', 'staging'],

  async run() {
    await seedReferenceData();   // your existing code
    await seedDomainData();      // exactly as it is
  },
});
```

Delete the `main()`, the `import.meta.url` guard, the `pool.end()`, and the chain of
scripts in `package.json`. Order, journal, environments and `status` work immediately.

**One trap, and it is worth reading.** If the code you are wrapping writes through an
imported `db` global rather than the `db` it is handed, those writes go around the
transaction sidder opened, silently. The atomicity would be a lie. Until you have
threaded the handle through, set `transaction: false` — `status` will show it, which is
better than a promise sidder cannot keep.

---

## Running it

```bash
npx sidder run                                  # everything not yet applied, in order
npx sidder run --env production                 # environment gates apply
npx sidder run --only roles,territory           # exactly these
npx sidder run --dry-run                        # decide everything, execute nothing
npx sidder status                               # what has run, what would, in what order
npx sidder status --json                        # the same, for scripts and agents
npx sidder forget demo                          # drop journal rows so their seeds run again
npx sidder init                                 # write a starting config
```

`--only` runs exactly what you name. It does **not** pull dependencies in — if
something you selected needs something you did not, sidder stops and prints the command
to run instead. A dependency skipped by `environments` is fine, because that gate is a
decision you wrote into a file; a name missing from `--only` is a typo you made thirty
seconds ago.

### The seed you are editing right now

`once` is right for a seed you wrote last month and wrong for the one open in your
editor. It ran, you changed a line, and the journal now says there is nothing to do.

```bash
npx sidder run --only demo --force   # apply it again, journal or not
npx sidder forget demo               # drop its row, then run normally
```

`--force` defeats the journal and nothing else: `environments` still applies, because
that gate is a decision written into the seed file rather than something sidder worked
out. Forcing past it would not be impatience, it would be seeding production data into
development.

`--only` alone stays a filter — it narrows the set and the ordinary rules still apply,
which is what keeps `--only a,b` safe in a deploy script. When that means nothing runs,
sidder says so and prints both commands above rather than leaving you to wonder.

`forget` works on the journal, not on the seed list. That is deliberate: the row left
behind by a renamed file — the one `status` reports as an orphan — is exactly a thing
you need to be able to delete, and it has no seed to look up.

---

## From a test suite

The CLI is a formatter wrapped around one function. Tests want the function.

```ts
import { runSeeds } from 'sidder';

await runSeeds(
  { adapter, seeds: [rolesSeed, territorySeed] },   // seed objects, no filesystem
  { journal: false },                                // run now, forget it happened
);
```

`journal: false` answers the conflict at the heart of this: a dev database wants "run
once and remember", a test wants "run now and forget". The journal is a mode, not a
fact of life.

`runSeeds` never closes your adapter — that is the CLI's job. A test suite calling it
fifty times over one pool would not survive otherwise.

`inspect(config)` returns everything `status` prints, as data.

---

## Adapters

The whole surface is two members:

```ts
interface Adapter<TDb> {
  root: Scope<TDb>;                                                  // outside a transaction
  transaction<T>(fn: (scope: Scope<TDb>) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

interface Scope<TDb> {
  db: TDb;                                                           // handed to seed.run()
  execute(sql: string, params?: readonly unknown[]): Promise<Row[]>; // used by the journal
}
```

`sidder/adapters/pg` and `sidder/adapters/drizzle` ship with it. Writing your own is
about ten lines, and doing so is the best way to see exactly what sidder does to your
database — which is a handful of statements against one table, plus one advisory lock.

```ts
const scope = (q) => ({ db: q, execute: async (sql, p) => (await q.query(sql, p)).rows });

const adapter = {
  root: scope(pool),
  async transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await fn(scope(client));
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  },
};
```

---

## The journal

One table, plain columns, readable in psql:

```sql
create table sidder_journal (
  name        text        primary key,
  applied_at  timestamptz not null default now(),
  environment text        not null,
  duration_ms integer     not null
);
```

It lives in your database rather than in a file for exactly one reason: so it can be
written inside the same transaction as the seed it records. Rename it with
`journalTable` in your config.

Deleting a row makes its seed runnable again, which is all `sidder forget` does — and
you are welcome to do it in psql instead. Nothing else in sidder depends on the row
existing.

---

## Two runs at once

Two replicas in a deploy, or two jobs in one pipeline, do not apply anything twice.

The reason the naive version of this is wrong is worth stating, because it is the bug
sidder had: reading the journal once at the start and deciding from it means two runs that
start together both read an empty journal and both decide to run everything. The journal
then covers its own tracks, since recording an applied seed upserts — so the table
afterwards reads exactly as it should while the data went in twice.

So the plan sidder prints is a forecast. The ruling is made per seed, immediately before
it runs, inside its own transaction: an advisory lock on the seed's name, then a re-read
of that one row. The second run waits for the first, sees the row, and reports `skipped`
— which is what actually happened to it. Nothing is configurable here and there is no
flag to pass.

The wait is announced, on a terminal and in a log both:

```
  ⋯ demo   waiting — another run is applying this seed; this one continues when it finishes
```

sidder asks for the lock without blocking first, so that line appears only when the
database has actually refused it. A run with no competition prints nothing extra and
costs the same one statement it always did.

Two exceptions, both honest:

- **`transaction: false` seeds** get the re-read but not the lock, because there is no
  transaction to scope one to. Two runs arriving at one simultaneously can both apply it.
  The alternatives are worse: a session-level lock through a pool can unlock on a
  different connection than it locked, and holding a second transaction open purely to
  own a lock deadlocks outright on a pool of one — a silent hang, in exactly the bulk-load
  case where small pools live.
- **`mode: 'always'` seeds** are supposed to run every time, so they take the lock and are
  never skipped by the re-read. Concurrent runs serialise rather than deduplicate.

---

## Runtimes

sidder runs your seeds in its own process, one seed at a time, so the runtime you launch
it with is the one that has to read TypeScript. It ships no loader:

| Runtime | TypeScript | `tsconfig` paths |
|---|---|---|
| `bun run --bun sidder run` | native | yes |
| `npx sidder run` on Node >= 22.18 | native type stripping | no |
| `node --import=tsx ./node_modules/sidder/dist/cli/main.js run` | via tsx | yes |
| Node < 22.18, no loader | no — sidder says so, and what to do about it | — |

Node's native type stripping does not transform enums, parameter properties or
`tsconfig` path aliases. It also determines `.ts` module format from `package.json`;
`.mts` is always ESM, which is why `init` generates it. Install `tsx` or use Bun when
your project needs the rest of TypeScript.

---

## Not done yet

- **Postgres only.** The journal statements are Postgres SQL. Other dialects are cheap
  to add and not yet added.
- **`transaction: false` is not concurrency-safe.** Everything else is — see
  [Two runs at once](#two-runs-at-once) — but a seed that opted out of its transaction
  has no transaction to scope a lock to, and two runs reaching one at the same instant
  can both apply it.
- **No `reset`.** There is no defined semantics for undoing a seed.
- **Seeds and migrations on one timeline** — `dependsOn: ['migration:0012_…']` — is the
  strongest thing on the roadmap and not in this version. A backfill that has to happen
  before a `NOT NULL` migration is currently held together by a comment, here and in
  every other codebase.
- **Assets.** Seeds that read `*.geojson` and friends are on their own for now.

---

## Development

```bash
bun install
bun test              # unit tests, in-memory adapter, no database
bun run db:up         # Postgres on :55432
bun run test:pg       # the same suite plus real-database integration tests
bun run check         # lint, typecheck, test
```

MIT.
