import { defineSeed } from 'sidder';
import type { PgQueryable } from 'sidder/adapters/pg';

export default defineSeed<PgQueryable>({
  name: 'roles',

  async run({ db }) {
    await db.query(
      `insert into roles (name)
       select unnest($1::text[])
       on conflict (name) do nothing`,
      [['admin', 'member']],
    );
  },
});
