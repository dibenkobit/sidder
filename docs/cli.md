# CLI reference

Examples use npm's `npx sidder` prefix. The README lists equivalent pnpm, Yarn and Bun
commands.

```text
npx sidder run
npx sidder status
npx sidder forget <name...>
npx sidder init
npx sidder help <command>
```

Use `npx sidder <command> --help` for command-specific help. Known flags on the wrong
command and unexpected positional arguments are errors; they are never silently ignored.

## `run`

Discovers, validates and orders seeds, then applies eligible seeds one at a time.

```text
npx sidder run [options]

-c, --config <path>   explicit config path
-e, --env <name>      override config.env and NODE_ENV
    --only <a,b>      run exactly these seed names
    --force           ignore already-applied journal rows
    --dry-run         plan without database writes
    --trace           include stacks for unexpected errors
-h, --help
```

`--dry-run` reads an existing journal so its decisions match a real run. If the journal
does not exist, it treats history as empty and does not create the table. It never opens
a seed transaction or writes a journal row.

`--force` only overrides `already-applied`. It still respects `environments` and `--only`.

## `status`

Returns the complete inspection: seed state, resolved order, journal orphans and cross-seed
imports.

```text
npx sidder status [options]

-c, --config <path>   explicit config path
-e, --env <name>      override config.env and NODE_ENV
    --only <a,b>      narrow displayed seed rows
    --json            emit the Inspection object as JSON
    --trace           include stacks for unexpected errors
-h, --help
```

`status` never runs a seed. It does call `ensureJournal`, so the first status on a database
creates the journal table. This lets status distinguish an empty history from an
unreachable or incompatible table.

In the human-readable report, `--only` hides unselected seed rows but keeps the full
resolved order and all cross-import findings. JSON keeps every seed and gives unselected
ones a `not-selected` decision, so consumers retain the complete inspection.

### JSON shape

```json
{
  "env": "development",
  "journalTable": "sidder_journal",
  "sources": {
    "env": "default",
    "seeds": "config",
    "journalTable": "default"
  },
  "order": ["roles", "demo"],
  "seeds": [
    {
      "name": "roles",
      "file": "/project/seeds/roles.mts",
      "dependsOn": [],
      "environments": null,
      "mode": "once",
      "transaction": true,
      "entry": null,
      "decision": { "action": "run" }
    }
  ],
  "orphans": [],
  "crossImports": []
}
```

`entry.appliedAt` is an ISO 8601 string in CLI JSON. The programmatic `Inspection` carries
a `Date`. Additive fields may appear in 0.x minors; consumers should read the fields they
need rather than reject unknown ones.

## `forget`

Deletes journal rows by name:

```text
npx sidder forget <name...> [options]

-c, --config <path>   explicit config path
    --trace           include stacks for unexpected errors
-h, --help
```

Names may be space-separated or comma-separated. The command works on journal names, not
discovered seed files, so it can remove an orphan left by a rename.

Forgetting does not undo database writes. It only makes a once-mode seed eligible again.
If the journal table does not exist, `forget` creates it and reports every requested name
as absent.

## `init`

Writes a starting `sidder.config.mts`:

```text
npx sidder init [--force]
```

The chosen adapter and its evidence are printed. The database module path is a marked
placeholder. Existing supported config files are not touched unless `--force` is present.

## Global flags

- `-h`, `--help`: root help, or command help after a command.
- `-v`, `--version`: package version.
- `--trace`: stack traces for unexpected and seed errors. Curated sidder errors keep their
  actionable hint instead of replacing it with internals.

## Environment variables

| Variable | Effect |
|---|---|
| `NODE_ENV` | Environment fallback after CLI and config |
| `NO_COLOR` | Disable ANSI color |
| `FORCE_COLOR` | Force color in pipes and CI |
| `FORCE_COLOR=0` | Disable color |
| `TERM=dumb` | Disable color |

`NO_COLOR` wins if both color variables are present.

## Output streams

- Normal reports and progress use stdout.
- Errors use stderr.
- A seed's per-line progress is replaced in-place on an interactive terminal.
- In a non-TTY log, waits and outcomes remain separate durable lines.

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | Command completed, including legitimate all-skipped runs and warnings |
| `1` | Invalid usage, config/discovery refusal, database error or failed seed |

Warnings about cross-imports and an environment matching no seeds do not change the exit
code. The text explains the condition so CI logs do not silently look successful.
