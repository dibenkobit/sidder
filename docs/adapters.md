# Adapters

sidder needs a root database scope and a way to open a transaction:

```ts
interface Scope<TDb> {
  db: TDb;
  execute(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
}

interface Adapter<TDb> {
  root: Scope<TDb>;
  transaction<T>(fn: (scope: Scope<TDb>) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}
```

`db` is handed to seeds. `execute` is reserved for sidder's journal SQL and must use the
same connection or transaction as `db`. Splitting those scopes silently breaks atomic
resumability.

The CLI calls `adapter.close()` after each command. `runSeeds()` and `inspect()` do not;
programmatic callers own adapter lifetime.

## node-postgres

Install node-postgres if the project does not already have it:

```bash
npm i pg
npm i -D @types/pg
```

```ts
// src/db/index.mts
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
```

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

Inside a transactional seed, `db` is a checked-out `PoolClient`-shaped queryable. With
`transaction: false`, it is the Pool.

The CLI closes the Pool through `pool.end()`. Programmatic calls leave it open.

## Drizzle

sidder is Postgres-only. The Drizzle adapter is therefore for Drizzle instances backed
by Postgres. The verified integration is `drizzle-orm/node-postgres`:

```ts
// src/db/index.mts
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const db = drizzle(pool);
```

```ts
// sidder.config.mts
import { defineConfig } from 'sidder';
import { drizzleAdapter } from 'sidder/adapters/drizzle';
import { db } from './src/db/index.mts';

export default defineConfig({
  adapter: drizzleAdapter(db),
  seeds: 'seeds/**/*.mts',
});
```

Seeds keep using the same query builders:

```ts
import { defineSeed } from 'sidder';
import type { db } from '../src/db/index.mts';
import { roles } from '../src/db/schema.mts';

export default defineSeed<typeof db>({
  async run({ db }) {
    await db.insert(roles).values({ name: 'admin' });
  },
});
```

Inside a transaction, the runtime `db` is Drizzle's transaction object. It has the query
builders but not every driver property of the root instance; in particular `$client` is
not available there even though a broad generic type may suggest it is.

The adapter closes `db.$client` when that client exposes `end()`. If a driver needs
different shutdown behavior, wrap or implement the adapter explicitly.

## Custom adapter

The following node-postgres-shaped implementation is complete:

```js
const scope = (queryable) => ({
  db: queryable,
  execute: async (sql, params) => (await queryable.query(sql, params)).rows,
});

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

  close: () => pool.end(),
};
```

Requirements:

- `execute` accepts PostgreSQL `$1` parameters and returns rows as plain objects.
- `transaction` commits on resolution and rolls back on rejection.
- The scope passed to `fn` executes journal SQL in that exact transaction.
- Use Postgres's default read-committed isolation. Higher isolation remains safe but a
  concurrent loser may receive a serialization error instead of a quiet skip.
- Do not implement `transaction` by opening one connection for `db` and another for
  `execute`.

The journal issues ordinary DDL/DML plus transaction-scoped advisory lock functions. See
[Journal and concurrency](journal.md) for the exact contract.
