import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: 'postgresql://sidder:sidder@localhost:55432/sidder',
});
