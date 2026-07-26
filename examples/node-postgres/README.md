# node-postgres example

This is a complete sidder project: one Postgres container, one application table, one
typed seed and the ordinary CLI lifecycle.

## Run it

From this directory:

```bash
npm install
npm run db:up
npm run check
npm run seed:status
npm run seed:dry-run
npm run seed
npm run seed
```

The first `run` inserts `admin` and `member`. The second skips `roles` because its
journal row committed with the first application.

Inspect both application data and sidder's plain journal table:

```bash
docker compose exec -T postgres psql -U sidder -d sidder -c 'table roles'
docker compose exec -T postgres psql -U sidder -d sidder -c 'table sidder_journal'
```

Stop the database and discard the example data:

```bash
npm run db:down
```

## What to copy

- [`sidder.config.mts`](sidder.config.mts) connects the existing Pool to sidder.
- [`seeds/roles.mts`](seeds/roles.mts) types `db` as the Pool/PoolClient shape and uses
  parameterized SQL.
- [`src/db/index.mts`](src/db/index.mts) owns the Pool. sidder does not create another.
- [`schema.sql`](schema.sql) represents migrations; seeds assume application tables
  already exist.

The connection string defaults to the local container. Set `DATABASE_URL` to point the
same files at another disposable database.

For production choices, read [Configuration](../../docs/configuration.md),
[Seeds](../../docs/seeds.md), and [Journal and concurrency](../../docs/journal.md).
