# sowme — working notes

A seed runner for Postgres. The pitch is in `README.md`; this file is about how the
code is written and why.

## Toolchain

Bun for everything local: `bun install`, `bun test`, `bun run <script>`. The published
artifact targets Node — `tsc -p tsconfig.build.json` emits `dist/` mirroring `src/`
file for file, no bundler. Reading `dist/` should feel like reading `src/`.

The package has **zero runtime dependencies** and that is a feature, not an accident.
`node:fs.glob` and `node:util.parseArgs` do what a glob library and an arg parser would.
Adding a runtime dependency needs an argument.

```bash
bun test          # unit tests, in-memory adapter, no database
bun run db:up     # Postgres on :55432 for the integration tests
bun run test:pg   # the same suite with SOWME_TEST_DATABASE_URL set
bun run check     # lint + typecheck + test — run this before committing
```

## The rule the design answers to

**Guessing is fine. Guessing quietly is not.**

sowme infers plenty: the config location, the seed glob, the environment, every seed's
name, the run order. Every inference is printed with its provenance in the run header
(`env development (NODE_ENV)`), which is what `ResolvedConfig.sources` exists for.

When adding a feature, the test is: *how many concepts does this force someone to learn
in order to seed one table?* The answer today is three — the config, `defineSeed`, and
the `db` you are handed. Anything that raises that number needs to be worth it.

Verbose but transparent beats compact but opaque. `orderSeeds` is a rescan rather than
a queue-and-indegree table because it reads like the definition of a topological sort.
That is deliberate; do not "optimise" it.

## Where things live

| File | What it owns |
|---|---|
| `types.ts` | every concept sowme has. If it is not here, sowme does not have it |
| `errors.ts` | every way sowme can refuse to run, each with a `hint` saying what to do |
| `plan.ts` | `decide()` — pure, no I/O. Its interesting cases test without a database |
| `order.ts` | topological sort, deterministic, with real cycle paths in the error |
| `journal.ts` | three SQL statements against one table |
| `run.ts` | the whole tool. `runSeeds()` is what the CLI wraps |
| `inspect.ts` | everything `status` prints, as data |
| `cli/format.ts` | all output. The provenance rule above is enforced here |

## Things that are easy to get wrong

**The journal must be written through the same `Scope` the seed ran in.** That is the
only reason `Adapter.transaction` hands back a `Scope` rather than just a db handle.
Break it and resumability silently becomes half-application.

**`runSeeds` must never call `adapter.close()`.** A test suite runs it many times over
one pool. Closing is the CLI's job.

**Errors that guess get their own class.** `TypeScriptLoaderError` fires only on the two
Node error codes that mean "this runtime cannot read `.ts`". A plain `SyntaxError` gets
`ModuleSyntaxError` instead, which reports the real file and line from the parser's
stack — telling someone to upgrade Node when they left a quote open wastes their day.

**`exactOptionalPropertyTypes` is on.** `RunOptions` opts out with explicit `| undefined`
because it is an options bag a CLI assembles from absent flags; the domain types
(`Seed`, `Config`) do not, and should not.

## Commits

Conventional Commits: `type(scope): subject`, imperative, lowercase, no trailing period.
