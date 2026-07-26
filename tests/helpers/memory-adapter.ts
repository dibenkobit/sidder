import type { Adapter, JournalEntry, Row, Scope } from '../../src/types.ts';

/**
 * An adapter that keeps everything in memory, so the runner can be tested without a
 * database.
 *
 * It models the one property the runner actually depends on: a transaction that either
 * commits both the seed's writes and its journal row, or neither. Staged state is a
 * copy that replaces the committed state on success and is thrown away on failure —
 * which is what a real ROLLBACK does, expressed in twenty lines.
 *
 * It recognises sowme's four journal statements rather than parsing SQL. That is a
 * deliberate limit: these tests prove the runner's decisions, and the SQL itself is
 * proved against a real Postgres in postgres.test.ts.
 */

export interface MemoryState {
  journal: Map<string, JournalEntry>;
  /** Whatever seeds chose to write, in order. Tests assert on this. */
  writes: string[];
}

export interface MemoryDb {
  write(value: string): void;
}

export interface MemoryAdapter {
  adapter: Adapter<MemoryDb>;
  /** The committed state. Reads here never see an in-flight transaction. */
  committed: MemoryState;
  /** Every SQL statement the journal issued, for tests that care about it. */
  statements: string[];
  closed: boolean;
}

export function createMemoryAdapter(): MemoryAdapter {
  const committed: MemoryState = { journal: new Map(), writes: [] };
  const statements: string[] = [];
  const handle: MemoryAdapter = {
    committed,
    statements,
    closed: false,
    adapter: undefined as unknown as Adapter<MemoryDb>,
  };

  const scopeFor = (state: MemoryState): Scope<MemoryDb> => ({
    db: { write: (value) => state.writes.push(value) },
    execute: async (sql, params = []) => {
      statements.push(sql.trim().split('\n')[0]!.trim());
      return applyJournalStatement(state, sql, params);
    },
  });

  handle.adapter = {
    root: scopeFor(committed),

    async transaction<T>(fn: (scope: Scope<MemoryDb>) => Promise<T>): Promise<T> {
      const staged: MemoryState = {
        journal: new Map(committed.journal),
        writes: [...committed.writes],
      };

      const result = await fn(scopeFor(staged));

      // Reached only when fn resolved. A throw propagates and `staged` is discarded,
      // which is the whole point.
      committed.journal = staged.journal;
      committed.writes = staged.writes;
      return result;
    },

    close: async () => {
      handle.closed = true;
    },
  };

  return handle;
}

function applyJournalStatement(state: MemoryState, sql: string, params: readonly unknown[]): Row[] {
  const statement = sql.trim().toLowerCase();

  if (statement.startsWith('create table')) return [];

  if (statement.startsWith('select')) {
    return [...state.journal.values()].map((entry) => ({
      name: entry.name,
      applied_at: entry.appliedAt,
      environment: entry.environment,
      duration_ms: entry.durationMs,
    }));
  }

  if (statement.startsWith('insert into')) {
    const [name, environment, durationMs] = params as [string, string, number];
    state.journal.set(name, { name, environment, durationMs, appliedAt: new Date() });
    return [];
  }

  if (statement.startsWith('delete from')) {
    // `returning name`, modelled: only the names that were actually there come back.
    return (params as string[])
      .filter((name) => state.journal.delete(name))
      .map((name) => ({
        name,
      }));
  }

  throw new Error(`memory adapter received a statement it does not model: ${sql}`);
}
