# sowme

A seed runner.

> Migrations got a runner fifteen years ago. Seeds never did — even though it is the
> same task: an ordered set of steps that change the state of a database.

Migrations have a discovery convention, an inferred order, a record of what has been
applied, one entry point, a `status` command and a single process. Seeds have a folder
of scripts and a `&&`-chain in `package.json` that somebody maintains by hand.

```bash
npm i -D sowme
```

**Status: 0.1, not on npm yet.** Until it is published, install it from git with npm,
pnpm or yarn:

```bash
npm i -D github:dibenkobit/sowme
```

Not with `bun add`, and this is bun's limitation rather than a missing script here: bun
does not run an installed dependency's `prepare`, and does not install the
devDependencies that building it would need
([oven-sh/bun#16548](https://github.com/oven-sh/bun/issues/16548)). You would get a
package with no `dist/`. Bun installs the published tarball perfectly well, because that
one arrives already built — so this stops being true the moment 0.1 is on npm.

Postgres, Drizzle and node-postgres. Working and tested, including against a real
database — but young. See [Not done yet](#not-done-yet).

---

## Seed one table

```ts
// sowme.config.ts
import { defineConfig } from 'sowme';
import { pgAdapter } from 'sowme/adapters/pg';
import { pool } from './src/db/index.ts';

export default defineConfig({
  adapter: pgAdapter(pool),
  seeds: 'seeds/*.ts',
});
```

```ts
// seeds/roles.ts
import { defineSeed } from 'sowme';

export default defineSeed({
  async run({ db }) {
    await db.query("insert into roles (name) values ('admin')");
  },
});
```

```bash
$ sowme run
```

That is three things to know: the config, `defineSeed`, and the `db` you are handed.
Everything below is optional and you learn it when you hit the need for it.

`defineSeed` is an identity function — it returns its argument and does nothing else.
It exists so your editor can autocomplete the fields, and so a typo in one is a compile
error rather than silence.

---

## What one run looks like

```
$ sowme run
sowme 0.1.0  ·  sowme.config.ts  ·  env development (NODE_ENV)  ·  journal sowme_journal

  ✓ roles         7ms
  ✓ territory     5ms
  ✓ demo          7ms
  · bulk-metrics  already applied 2026-07-24
  · fake-users    development, staging only — running as production

  3 applied, 2 skipped in 52ms
```

```
$ sowme status
  ✓ roles         applied 2026-07-26  always
  ✓ territory     applied 2026-07-26
  ✓ demo          applied 2026-07-26  after territory, roles
  ✗ bulk-metrics  never run           after demo · no transaction
  ✗ fake-users    never run           development, staging only · after demo

  order: roles → territory → demo → bulk-metrics → fake-users
```

---

## The design rule

**Guessing is fine. Guessing quietly is not.**

sowme finds your config by walking up from the working directory, defaults your seeds
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

sowme runs each seed exactly once per invocation, so declaring the dependency is enough.
The corollary is that **seeds talk to each other through the database, not through
memory**. Need the region ids? Select them.

If a name in `dependsOn` does not exist, or two seeds depend on each other, sowme says
so before running anything — and prints the actual cycle, not just that there is one.

And because the old way is the quiet one, `run` and `status` both point it out when they
see it:

```
  warning seed files that import another seed:
    demo imports territory  — REGIONS, seedTerritory
    Work imported from a seed and called runs twice — sowme runs that seed as
    well — and both are ordinary writes, so the journal records one.
    Which of those bindings is work and which is shared data, sowme does not decide.
    Move data two seeds share into a module that is not a seed. Where it is the
    work you want, `dependsOn` replaces the import and sowme still runs it once.
```

It is a warning and only a warning: nothing stops, and the exit code stays 0. The
bindings are named rather than judged, because one `import` statement can carry a
constants table and a seed's own work together and no rule over names separates them.
sowme finds them by scanning the import statements as text — a bare specifier or a
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
you do, `sowme status` marks the seed `no transaction`, and if it fails, sowme says
plainly that its writes are still in the database:

```
error bulk-metrics failed
  NOT rolled back — transaction: false, so its writes are still there
```

### `name` — when the filename is not enough

A seed's name is its filename without the extension. That name is what `dependsOn`,
`--only` and the journal use, so renaming the file renames the seed. Set `name`
explicitly as soon as anything depends on it.

sowme catches both halves of that mistake: a `dependsOn` pointing at a name that no
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
transaction sowme opened, silently. The atomicity would be a lie. Until you have
threaded the handle through, set `transaction: false` — `status` will show it, which is
better than a promise sowme cannot keep.

---

## Running it

```bash
sowme run                                  # everything not yet applied, in order
sowme run --env production                 # environment gates apply
sowme run --only roles,territory           # exactly these
sowme run --dry-run                        # decide everything, execute nothing
sowme status                               # what has run, what would, in what order
sowme status --json                        # the same, for scripts and agents
sowme forget demo                          # drop journal rows so their seeds run again
sowme init                                 # write a starting config
```

`--only` runs exactly what you name. It does **not** pull dependencies in — if
something you selected needs something you did not, sowme stops and prints the command
to run instead. A dependency skipped by `environments` is fine, because that gate is a
decision you wrote into a file; a name missing from `--only` is a typo you made thirty
seconds ago.

### The seed you are editing right now

`once` is right for a seed you wrote last month and wrong for the one open in your
editor. It ran, you changed a line, and the journal now says there is nothing to do.

```bash
sowme run --only demo --force   # apply it again, journal or not
sowme forget demo               # drop its row, then run normally
```

`--force` defeats the journal and nothing else: `environments` still applies, because
that gate is a decision written into the seed file rather than something sowme worked
out. Forcing past it would not be impatience, it would be seeding production data into
development.

`--only` alone stays a filter — it narrows the set and the ordinary rules still apply,
which is what keeps `--only a,b` safe in a deploy script. When that means nothing runs,
sowme says so and prints both commands above rather than leaving you to wonder.

`forget` works on the journal, not on the seed list. That is deliberate: the row left
behind by a renamed file — the one `status` reports as an orphan — is exactly a thing
you need to be able to delete, and it has no seed to look up.

---

## From a test suite

The CLI is a formatter wrapped around one function. Tests want the function.

```ts
import { runSeeds } from 'sowme';

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

`sowme/adapters/pg` and `sowme/adapters/drizzle` ship with it. Writing your own is
about ten lines, and doing so is the best way to see exactly what sowme does to your
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
create table sowme_journal (
  name        text        primary key,
  applied_at  timestamptz not null default now(),
  environment text        not null,
  duration_ms integer     not null
);
```

It lives in your database rather than in a file for exactly one reason: so it can be
written inside the same transaction as the seed it records. Rename it with
`journalTable` in your config.

Deleting a row makes its seed runnable again, which is all `sowme forget` does — and
you are welcome to do it in psql instead. Nothing else in sowme depends on the row
existing.

---

## Two runs at once

Two replicas in a deploy, or two jobs in one pipeline, do not apply anything twice.

The reason the naive version of this is wrong is worth stating, because it is the bug
sowme had: reading the journal once at the start and deciding from it means two runs that
start together both read an empty journal and both decide to run everything. The journal
then covers its own tracks, since recording an applied seed upserts — so the table
afterwards reads exactly as it should while the data went in twice.

So the plan sowme prints is a forecast. The ruling is made per seed, immediately before
it runs, inside its own transaction: an advisory lock on the seed's name, then a re-read
of that one row. The second run waits for the first, sees the row, and reports `skipped`
— which is what actually happened to it. Nothing is configurable here and there is no
flag to pass.

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

sowme runs your seeds in its own process — one process, one connection — so the runtime
you launch it with is the one that has to read TypeScript. It ships **no loader** and
has **no runtime dependencies**:

| Runtime | TypeScript | `tsconfig` paths |
|---|---|---|
| `bun --bun sowme run` | native | yes |
| Node >= 22.18 | native type stripping | no |
| `node --import tsx …/sowme run` | via tsx | yes |
| Node < 22.18, no loader | no — sowme says so, and what to do about it | — |

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
