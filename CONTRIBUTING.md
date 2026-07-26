# Contributing to sidder

Thank you for improving sidder. The project optimizes for a small authoring model,
transparent decisions and failures that say what to do next. A change is complete when a
person can use it end to end, not merely when its implementation exists.

Please read the repository's `AGENTS.md` before starting. It records design constraints
that are easy to violate without producing an obvious test failure.

## Before writing code

- Search existing issues and pull requests.
- Open an issue before a new public API, dependency, command or journal change. These
  choices are expensive to reverse after release.
- Treat an issue or design note as a draft. If an assumption is wrong, say so before
  implementing it.
- Check that a proposed dependency is maintained and compatible with the supported
  runtimes. Explain why the new dependency is worth its ownership cost.

Small fixes, tests and documentation corrections can go directly to a pull request.

## Local setup

You need Bun, Docker and a checkout of the repository:

```bash
git clone https://github.com/dibenkobit/sidder.git
cd sidder
bun install
bun run check
```

The published CLI targets Node 22.18 or newer even though Bun runs the local toolchain.

## Useful commands

```bash
bun test          # in-memory unit tests
bun run db:up     # Postgres on localhost:55432
bun run test:pg   # unit and real-Postgres integration tests
bun run check     # lint, typecheck and unit tests
```

Run `bun run check` before each commit. For a database, adapter, journal, transaction or
CLI execution change, also run `bun run test:pg`.

## Test the user path

The unit suite is necessary but not enough. Exercise the real command in a project laid
out like a consumer:

1. install the packed tarball rather than importing repository source;
2. run `init`;
3. replace the generated database import;
4. run `status`, `run --dry-run`, `run`, and the same `run` again;
5. trigger the failure path your change affects and read it as a user would.

The CI package job is the executable example. Keep its oldest-Node smoke test working.

## Project shape

`src/` follows the execution pipeline:

| Area | Responsibility |
|---|---|
| `src/types.ts` | Every public concept |
| `src/errors.ts` | Curated refusals and actionable hints |
| `src/resolve/` | Config, discovery and module loading |
| `src/plan/` | Pure ordering and run decisions |
| `src/journal.ts` | Journal SQL and locks |
| `src/run.ts` | End-to-end execution |
| `src/inspect.ts` | Structured status data |
| `src/cli/` | Parsing, commands and all terminal output |

Tests mirror that structure under `tests/`. Avoid barrel files; import the module that
owns the behavior.

## Change checklist

- Add or update a test for observable behavior.
- Run the actual command when the change affects a user path.
- Preserve the journal and seed writes in the same transaction scope.
- Keep `runSeeds()` from closing an adapter owned by its caller.
- Give every new curated error an actionable hint.
- Print the source of every newly inferred value.
- Update the README only when the first-use path changes.
- Update the relevant page under `docs/` when a public contract changes.
- Add a changelog entry for a user-visible change.

Documentation links and headings are checked by `tests/docs.test.ts`.

## Style and commits

Biome owns formatting and linting. Do not manually restyle unrelated files.

Use Conventional Commits:

```text
type(scope): imperative lowercase subject
```

Keep the subject at 72 characters or fewer, with no trailing period. Use the body to
explain why the change is necessary; the diff already says what changed.

Examples:

```text
fix(run): keep dry runs read-only
docs(cli): explain status JSON stability
test(pg): cover concurrent always seeds
```

Keep commits reviewable: one logical behavior or documentation block per commit.

## Pull requests

A useful pull request explains:

- the user-visible problem;
- the chosen behavior and rejected alternatives;
- what was exercised end to end;
- database and runtime consequences;
- documentation or compatibility changes.

Draft pull requests are welcome for early design feedback. By contributing, you agree
that your contribution is licensed under the repository's [MIT license](LICENSE).

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). For usage help,
bug routing and version support, see [Support](SUPPORT.md).
