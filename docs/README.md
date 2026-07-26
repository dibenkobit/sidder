# sidder documentation

Start with the [README quickstart](../README.md#quickstart). It is the shortest path from
an installed package to a seed that has run. Come here when you need the exact contract.

## Authoring and operation

| Need | Document |
|---|---|
| Every config field, default and precedence rule | [Configuration](configuration.md) |
| Every seed field and the reason to use it | [Seeds](seeds.md) |
| Commands, flags, exit codes and JSON output | [CLI reference](cli.md) |
| node-postgres, Drizzle or a custom adapter | [Adapters](adapters.md) |
| Node, Bun, `.mts`, loaders and path aliases | [Runtimes](runtimes.md) |
| Journal schema, permissions, resumability and concurrent runs | [Journal and concurrency](journal.md) |
| `runSeeds`, `inspect`, events, results and errors | [Programmatic API](programmatic-api.md) |
| A failure in front of you right now | [Troubleshooting](troubleshooting.md) |

## Project information

- [Current limitations and support policy](../SUPPORT.md)
- [Contributing](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md)
- [Changelog](../CHANGELOG.md)

These files describe the current branch. TypeScript declarations in the package are the
source of truth for exact structural types; the prose here owns their meaning and
consequences.
