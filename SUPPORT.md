# Support

## What is supported

| Component | Policy |
|---|---|
| sidder | Latest published `0.x` minor |
| Node | 22.18 or newer |
| Bun | Current stable release |
| Database | PostgreSQL |
| node-postgres adapter | `pg` Pool and PoolClient-shaped handles |
| Drizzle adapter | `drizzle-orm/node-postgres` |
| Custom adapters | The structural contract in the adapter guide |

Before 1.0, a minor release may change a public contract. Release notes call out required
migration steps. Patch releases are intended to be backward compatible.

Other Postgres-backed Drizzle drivers may work, but only the node-postgres integration is
covered as a supported adapter. TypeScript transpilers other than native Node, Bun and
the documented `tsx` invocation are best effort.

## Get help

Start with:

1. the [quickstart](README.md#quickstart);
2. [Troubleshooting](docs/troubleshooting.md);
3. `npx sidder <command> --help`;
4. existing [GitHub issues](https://github.com/dibenkobit/sidder/issues).

If the behavior still looks wrong, open a bug report. Include a minimal config and seed,
but remove connection strings, credentials and production data.

Usage questions are welcome as GitHub issues while the project has no separate discussion
forum. Use a descriptive title and explain the end goal, not only the command that failed.

## What maintainers can diagnose

The strongest reports include:

```bash
npx sidder --version
node --version
```

and:

- package manager and operating system;
- exact command and complete error plus hint;
- pg or Drizzle adapter and driver version;
- `transaction`, `mode`, environment and relevant dependency declarations;
- whether `status` and `run --dry-run` behave differently;
- what committed or rolled back;
- a small reproduction.

Maintainers cannot debug private database state, review production data or recover writes
from arbitrary seed code. A minimal schema and anonymized seed usually turns those into a
reproducible project bug.

## Security

Do not put suspected vulnerabilities, credentials or sensitive data in an issue. Follow
the private process in [Security](SECURITY.md).
