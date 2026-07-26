interface Queryable {
  query(sql: string): Promise<unknown>;
}

export default {
  name: 'package-smoke-roles',
  async run({ db }: { db: Queryable }) {
    await db.query('select 1');
  },
};
