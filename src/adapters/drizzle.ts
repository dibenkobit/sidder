import { type SQL, sql } from 'drizzle-orm';
import type { Adapter, Row, Scope } from '../types.ts';

/**
 * Adapter for Drizzle, on any of its drivers.
 *
 * Inside a transactional seed, the `db` handed to `run()` is Drizzle's transaction
 * object rather than the database itself. It carries the same query builders, so seed
 * code does not notice; if a seed opens its own `db.transaction()` inside, Drizzle
 * turns that into a savepoint and it keeps working.
 */

export interface DrizzleLike {
  execute(query: SQL): Promise<unknown>;
  transaction<T>(fn: (tx: DrizzleLike) => Promise<T>): Promise<T>;
}

export function drizzleAdapter<TDb extends DrizzleLike>(db: TDb): Adapter<TDb> {
  return {
    root: scopeFor(db),
    transaction: <T>(fn: (scope: Scope<TDb>) => Promise<T>) =>
      // Drizzle's transaction object is not literally TDb — it has the query builders
      // but not the driver handle. Seeds use the builders, so this is the same cast
      // every Drizzle codebase already makes when it types a helper as `db | tx`.
      db.transaction((tx) => fn(scopeFor(tx as TDb))),
    close: async () => {
      const client = (db as { $client?: { end?: () => Promise<void> } }).$client;
      await client?.end?.();
    },
  };
}

function scopeFor<TDb extends DrizzleLike>(executor: TDb): Scope<TDb> {
  return {
    db: executor,
    execute: async (query, params = []) => toRows(await executor.execute(bind(query, params))),
  };
}

/**
 * Turns `('... values ($1, $2)', [a, b])` into a parameterised Drizzle SQL object.
 *
 * siddy only ever calls `execute` with its own three journal statements, so this sees
 * a fixed set of inputs — but it binds rather than interpolates anyway, because the
 * seed names that flow through it come from your filenames.
 */
function bind(query: string, params: readonly unknown[]): SQL {
  const parts = query.split(/\$(\d+)/g);
  return sql.join(
    parts.map((part, index) =>
      // split() with one capture group alternates: literal, placeholder digits, literal…
      index % 2 === 0 ? sql.raw(part) : sql`${params[Number(part) - 1]}`,
    ),
  );
}

/** node-postgres returns `{ rows }`, postgres.js returns the array itself. */
function toRows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (typeof result === 'object' && result !== null && 'rows' in result) {
    const { rows } = result as { rows?: Row[] };
    return rows ?? [];
  }
  return [];
}
