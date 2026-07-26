# sowme — working agreement

Read this before starting anything: a feature, a fix, a doc change, a review.

The first half is how work happens here. The second half is what the project is and
what will break if you get it wrong.

---

## 1. Specs are drafts. Audit them before you build them

A design document, an issue, or a paragraph in this file is the current best guess, not
a contract. Before implementing one, say which parts you think are wrong and why.
Several decisions in this repo were reversed *while being implemented* — that is the
normal outcome of thinking properly, not a failure of planning.

- If a spec asks for something you cannot implement correctly, say so **before** writing
  the code, rather than shipping something that technically matches the words. A default
  that depends on a property the runtime cannot observe is not a default; it is a bug
  with documentation.
- If a claim in a doc is checkable — a package is dormant, an API behaves a certain way,
  a name is free — check it and report the result, including when the doc was right.
- Disagreement is the deliverable, not friction. Deliver it early, with the reason.

## 2. Decide the expensive things first, and say why

Toolchain, dependencies, file layout, the shape of public API: settle these before there
is code to retrofit. Late is when they get expensive.

When choosing between named options, the choice is yours and the reason is owed.
*"Biome, because oxlint has no formatter yet and oxfmt is pre-1.0, so oxlint means two
tools and two configs"* is an answer. *"Biome"* is not.

Before adding any dependency, check that it is maintained and compatible with the stack
here. A recommendation built on an abandoned package costs far more than the search that
would have caught it. This project has **zero runtime dependencies** and every proposal
to change that needs an argument.

## 3. Corrections arrive mid-task. Apply them immediately

Direction gets adjusted while work is in flight. When it does, change course from that
point. Do not finish the old approach first, do not relitigate, do not defend what was
already written. If the correction invalidates work, say what is being thrown away and
throw it away.

## 4. The bar is "good to use", not "the feature exists"

The acceptance question is never *is it implemented*. It is: **what does the person
using this type, see, and misunderstand?**

So run it end to end before calling anything done — not the unit tests, the actual
command, in a project laid out like a real one. Every real defect found in this repo so
far came from doing that, and none came from the test suite: the broken `Config.seeds`
type, the error that blamed the runtime for a missing quote, the stack trace where a
constraint violation should have been.

A feature checklist does not measure this. A runner that does everything and still makes
you `delete from sowme_journal` by hand to re-run the seed you are editing is not done.

## 5. Craft counts outside `src/` too

Commit messages, error text, CLI output, README, this file. They are read more often than
the code, and they are how the work is judged.

Errors especially. Every failure this tool produces says what happened *and what to do
about it* — that is why `errors.ts` exists as a single catalogue with a `hint` on every
class. An error that guesses at the cause gets its own class, so a wrong guess can be
narrowed later without touching the right ones.

---

# The project

A seed runner for Postgres. Migrations have had one for fifteen years; seeds have not,
despite being the same problem. `README.md` is the pitch; this is the map.

## The one design rule

**Guessing is fine. Guessing quietly is not.**

sowme infers the config path, the seed glob, the environment, every seed's name and the
run order. Each inference is printed with its provenance before anything reaches the
database — `env development (NODE_ENV)` and `env development (--env)` are different
facts and print differently. `ResolvedConfig.sources` exists for exactly this.

The corollary, applied to every new feature: **how many concepts does this force someone
to learn in order to seed one table?** Today the answer is three — the config,
`defineSeed`, and the `db` you are handed. Raising that number needs to be worth it.
A factory DSL was designed and cut for failing this test at seven.

Verbose but transparent beats compact but opaque. `orderSeeds` is a rescan rather than a
queue-and-indegree table because it reads like the definition of a topological sort. That
is deliberate — do not "optimise" it.

## Toolchain

Bun locally: `bun install`, `bun test`, `bun run <script>`. The published artifact targets
Node — `tsc -p tsconfig.build.json` emits `dist/` mirroring `src/` file for file, no
bundler. Reading `dist/` should feel like reading `src/`.

```bash
bun test          # unit tests, in-memory adapter, no database
bun run db:up     # Postgres on :55432 for the integration tests
bun run test:pg   # the same suite with SOWME_TEST_DATABASE_URL set
bun run check     # lint + typecheck + test — run before committing
```

## Where things live

| File | What it owns |
|---|---|
| `types.ts` | every concept sowme has. If it is not here, sowme does not have it |
| `errors.ts` | every way sowme can refuse to run, each with a `hint` saying what to do |
| `plan.ts` | `decide()` — pure, no I/O. Its interesting cases test without a database |
| `order.ts` | topological sort, deterministic, with real cycle paths in the error |
| `journal.ts` | the SQL. One table, plain columns, readable in psql |
| `run.ts` | the whole tool. `runSeeds()` is what the CLI wraps |
| `inspect.ts` | everything `status` prints, as data |
| `cli/format.ts` | all output. Rule 1 of the product is enforced here |

## Invariants that are easy to break

**The journal is written through the same `Scope` the seed ran in.** That is the only
reason `Adapter.transaction` hands back a `Scope` rather than a bare db handle. Break it
and resumability silently becomes half-application.

**`runSeeds` never calls `adapter.close()`.** A test suite runs it many times over one
pool. Closing is the CLI's job.

**`TypeScriptLoaderError` fires only on the two Node error codes that mean "this runtime
cannot read `.ts`".** A plain `SyntaxError` gets `ModuleSyntaxError`, which digs the real
file and line out of the parser's stack. Telling someone to upgrade Node when they left a
quote open wastes their day.

**`exactOptionalPropertyTypes` is on.** `RunOptions` opts out with explicit `| undefined`
because it is an options bag a CLI assembles from absent flags. The domain types (`Seed`,
`Config`) do not, and should not.

**The plan is a forecast; the ruling happens per seed, under a lock.** `decide()` runs
against one journal read taken at the start, which is right for printing an order and
wrong for authorising a write — two runs starting together both read an empty journal.
So each seed re-asks inside its own transaction, after `lockSeed`. Anything that moves
the journal check back to plan time reintroduces silent double-application, and the
journal's upsert will hide it. `transaction: false` cannot take the lock; that gap is
documented in `executeSeed` rather than papered over.

## Distribution

`prepare` is `tsc -p tsconfig.build.json` and **not** `bun run build`, on purpose. It runs
on a consumer's machine during a git install, where neither bun nor npm is guaranteed to
exist as a binary — `tsc` resolves from `node_modules/.bin`, which is on PATH for any
package manager. It also drops the `chmod`, which npm's own bin-linking does anyway and
which does not exist on Windows.

That fixes git installs for npm, pnpm and yarn. It does **not** fix `bun add github:…`:
bun does not run an installed dependency's lifecycle scripts, and does not install the
devDependencies `prepare` would need (oven-sh/bun#16548, open). Publishing to npm is the
real fix, because a published tarball ships `dist/` already built and needs no consumer
build at all. Do not "solve" this by committing `dist/`.

CI proves the artifact, not just the source: the `package` job installs the packed tarball
into a project that has never seen this repo and runs the CLI on the oldest supported Node.

## Commits

Conventional Commits: `type(scope): subject`. Imperative, lowercase, no trailing period,
≤72 chars. Scope when it clarifies. The body explains **why**, not what — the diff
already says what.
