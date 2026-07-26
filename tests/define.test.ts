import { describe, expect, test } from 'bun:test';
import type { PgQueryable } from '../src/adapters/pg.ts';
import { defineSeed } from '../src/define.ts';

describe('defineSeed', () => {
  test('keeps an explicitly typed adapter handle available to seed code', async () => {
    let queryText = '';
    const seed = defineSeed<PgQueryable>({
      async run({ db }) {
        await db.query('select $1::text', ['typed']);
      },
    });
    const db: PgQueryable = {
      query: async (text) => {
        queryText = text;
        return { rows: [] };
      },
    };

    await seed.run({ db, env: 'test', name: 'typed-seed' });

    expect(queryText).toBe('select $1::text');
  });
});
