import type { Adapter, Row, Scope } from '../types.ts';

/**
 * Adapter for node-postgres.
 *
 * It imports nothing from `pg` — the two interfaces below are the entire shape it
 * needs, so anything pool-like satisfies it. This is also the shortest illustration
 * of what an adapter is: `query` for the journal, BEGIN/COMMIT for the transaction,
 * and that is the file.
 */

export interface PgQueryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }>;
}

export interface PgClient extends PgQueryable {
  release(): void;
}

export interface PgPool extends PgQueryable {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

export function pgAdapter(pool: PgPool): Adapter<PgQueryable> {
  return {
    root: scopeFor(pool),

    async transaction<T>(fn: (scope: Scope<PgQueryable>) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn(scopeFor(client));
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => {
          // The original error is what the caller needs to see. A rollback that also
          // fails means the connection is gone, which release() below deals with.
        });
        throw error;
      } finally {
        client.release();
      }
    },

    close: () => pool.end(),
  };
}

function scopeFor(queryable: PgQueryable): Scope<PgQueryable> {
  return {
    db: queryable,
    execute: async (sql, params) => (await queryable.query(sql, params)).rows,
  };
}
