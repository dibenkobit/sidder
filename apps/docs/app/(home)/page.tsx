import Link from 'next/link';

const statusHeader =
  'sidder 0.1.0  ·  sidder.config.mts  ·  env development (default)  ·  journal sidder_journal';

function Cell({
  label,
  children,
  className = '',
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`register-cell ${className}`}>
      <span className="register-cell-label">{label}</span>
      {children}
    </div>
  );
}

export default function HomePage() {
  return (
    <main className="sidder-register">
      <header className="register-masthead">
        <div className="register-frame register-masthead-inner">
          <div className="register-title">
            <h1>sidder</h1>
            <p>A seed runner for Postgres.</p>
          </div>

          <p className="register-thesis">
            A folder of scripts says how to start. It cannot say what committed, what remains, or
            what the next run knows.
          </p>

          <div className="register-start">
            <code>npm i -D sidder</code>
            <div>
              <Link href="/docs/getting-started">Quick start →</Link>
              <Link href="https://github.com/dibenkobit/sidder">GitHub ↗</Link>
            </div>
          </div>
        </div>
      </header>

      <section aria-labelledby="before-writes">
        <div className="register-frame">
          <div className="register-section-heading">
            <h2 id="before-writes">Before any seed writes</h2>
            <p>
              Files establish the candidates and their order. Postgres establishes whether those
              candidates still need to run.
            </p>
          </div>

          <div className="register-column-head" aria-hidden="true">
            <span>evidence</span>
            <span>decision</span>
            <span>seed writes</span>
            <span>sidder_journal</span>
            <span>next run</span>
          </div>

          <div className="register-row register-row-files">
            <Cell label="Evidence">
              <code className="register-file">sidder.config.mts</code>
              <code className="register-file">seeds/roles.mts</code>
            </Cell>
            <Cell label="Decision">
              <p className="register-primary">roles</p>
              <p className="register-secondary">name: explicit</p>
              <p className="register-secondary">order: roles</p>
            </Cell>
            <Cell label="Seed writes">
              <p className="register-empty">not reached</p>
            </Cell>
            <Cell label="sidder_journal">
              <p className="register-empty">not consulted</p>
            </Cell>
            <Cell label="Next run">
              <p className="register-empty">forecast pending</p>
            </Cell>
          </div>

          <div className="register-threshold">
            <strong>Postgres journal state enters the decision here.</strong>
            <span>
              <code>status</code> creates the table if missing; <code>--dry-run</code> only reads it
              when present.
            </span>
          </div>

          <div className="register-provenance">
            <code>{statusHeader}</code>
          </div>

          <div className="register-row">
            <Cell label="Evidence">
              <code className="register-command">npx sidder status</code>
              <p className="register-secondary">inspects; never calls seed code</p>
            </Cell>
            <Cell label="Decision">
              <pre className="register-output register-output-compact">
                <span className="register-glyph-muted">✗</span> roles&nbsp; never run{'\n\n'}
                <span className="register-dim">order: roles</span>
              </pre>
            </Cell>
            <Cell label="Seed writes">
              <p className="register-empty">none</p>
            </Cell>
            <Cell label="sidder_journal">
              <pre className="register-table register-table-empty">{`name | applied_at | environment | duration_ms
-----+------------+-------------+------------
(0 rows)`}</pre>
            </Cell>
            <Cell label="Next run">
              <p className="register-primary">eligible</p>
            </Cell>
          </div>

          <div className="register-row">
            <Cell label="Evidence">
              <code className="register-command">npx sidder run --dry-run</code>
            </Cell>
            <Cell label="Decision">
              <pre className="register-output register-output-compact">
                <span className="register-glyph-ok">✓</span> roles&nbsp; would run{'\n\n'}
                <span className="register-dim">1 would apply, 0 skipped</span>
              </pre>
            </Cell>
            <Cell label="Seed writes">
              <p className="register-empty">none</p>
              <p className="register-secondary">by contract</p>
            </Cell>
            <Cell label="sidder_journal">
              <p className="register-empty">read, not written</p>
            </Cell>
            <Cell label="Next run">
              <p className="register-primary">eligible</p>
            </Cell>
          </div>
        </div>
      </section>

      <section aria-labelledby="inside-seed">
        <div className="register-frame">
          <div className="register-section-heading">
            <h2 id="inside-seed">Inside one seed</h2>
            <p>
              The printed plan is a forecast. The ruling happens under a per-seed lock, on the same
              checked-out Postgres client that receives the seed and journal writes.
            </p>
          </div>

          <div className="register-transaction-heading">
            <span>one client</span>
            <span>one seed transaction</span>
            <span>one commit boundary</span>
          </div>

          <div className="register-row register-row-transaction">
            <Cell label="Evidence">
              <code className="register-command">npx sidder run</code>
              <p className="register-secondary">node-postgres adapter</p>
            </Cell>
            <Cell label="Decision">
              <pre className="register-source">{`begin
pg_try_advisory_xact_lock(...)
select ... from sidder_journal
  where name = $1`}</pre>
              <p className="register-secondary">
                If the lock is held, sidder prints <code>waiting</code>, then re-reads.
              </p>
            </Cell>
            <Cell label="Seed writes">
              <pre className="register-source">{`insert into roles (name)
select unnest($1::text[])
on conflict (name) do nothing`}</pre>
              <p className="register-secondary">through the transaction&apos;s db handle</p>
            </Cell>
            <Cell label="sidder_journal">
              <pre className="register-source">{`insert into sidder_journal
  (name, applied_at,
   environment, duration_ms)
values (...)
on conflict (name) do update`}</pre>
              <p className="register-secondary">through that same transaction scope</p>
            </Cell>
            <Cell label="Next run">
              <p className="register-primary">commit</p>
              <p className="register-secondary">or every write in this row rolls back</p>
            </Cell>
          </div>

          <div className="register-proof-note">
            Nothing is journalled before the seed succeeds. Nothing from this seed commits without
            its journal row.
          </div>

          <div className="register-row register-row-applied">
            <Cell label="Evidence">
              <code className="register-command">npx sidder run</code>
              <p className="register-secondary">captured from examples/node-postgres</p>
            </Cell>
            <Cell label="Decision">
              <pre className="register-output register-output-compact">
                <span className="register-glyph-ok">✓</span> roles&nbsp; 7ms{'\n\n'}
                <span className="register-dim">1 applied, 0 skipped in 26ms</span>
              </pre>
            </Cell>
            <Cell label="Seed writes">
              <pre className="register-table">{`name
------
admin
member
(2 rows)`}</pre>
            </Cell>
            <Cell label="sidder_journal">
              <pre className="register-table">{`name  | environment | duration_ms
------+-------------+------------
roles | development | 5
(1 row)`}</pre>
              <p className="register-secondary">
                The row is timed before commit; the CLI line completes after it.
              </p>
            </Cell>
            <Cell label="Next run">
              <p className="register-primary">recorded</p>
              <p className="register-secondary">the row now changes the decision</p>
            </Cell>
          </div>
        </div>
      </section>

      <section aria-labelledby="next-run">
        <div className="register-frame">
          <div className="register-section-heading">
            <h2 id="next-run">The next invocation is an event, too</h2>
            <p>
              A successful no-op is not silence. The row that committed above is now the reason
              printed beside the seed.
            </p>
          </div>

          <div className="register-provenance">
            <code>{statusHeader}</code>
          </div>

          <div className="register-row register-row-repeat">
            <Cell label="Evidence">
              <code className="register-command">npx sidder run</code>
            </Cell>
            <Cell label="Decision">
              <pre className="register-output register-output-compact">
                <span className="register-glyph-muted">·</span> roles&nbsp; already applied
                2026-07-26{'\n\n'}
                <span className="register-dim">0 applied, 1 skipped in 20ms</span>
              </pre>
            </Cell>
            <Cell label="Seed writes">
              <p className="register-empty">none</p>
            </Cell>
            <Cell label="sidder_journal">
              <p className="register-primary">unchanged</p>
            </Cell>
            <Cell label="Next run">
              <p className="register-primary">skips again</p>
              <p className="register-secondary">
                until <code>--force</code> or <code>forget</code>
              </p>
            </Cell>
          </div>

          <div className="register-aside">
            <p>The seed you are editing is the one case where history gets in the way.</p>
            <code>npx sidder run --only roles --force</code>
            <span>run it anyway</span>
            <code>npx sidder forget roles</code>
            <span>drop its row</span>
          </div>
        </div>
      </section>

      <section aria-labelledby="failed-run">
        <div className="register-frame">
          <div className="register-section-heading">
            <h2 id="failed-run">A failed seed leaves a different record</h2>
            <p>
              With the default transaction, the application data and journal row both disappear. The
              error says that before it says anything about the stack.
            </p>
          </div>

          <div className="register-row register-row-failed">
            <Cell label="Evidence">
              <code className="register-command">npx sidder run</code>
              <p className="register-secondary">
                after <code>sidder forget roles</code>
              </p>
            </Cell>
            <Cell label="Decision">
              <p className="register-primary register-failed">
                <span>✗</span> roles failed
              </p>
              <p className="register-secondary">code 23505 · roles_pkey</p>
            </Cell>
            <Cell label="Seed writes">
              <p className="register-primary">rolled back</p>
              <p className="register-secondary">database as it was before this seed started</p>
            </Cell>
            <Cell label="sidder_journal">
              <pre className="register-table register-table-empty">{`name | applied_at | environment | duration_ms
-----+------------+-------------+------------
(0 rows)`}</pre>
            </Cell>
            <Cell label="Next run">
              <p className="register-primary">eligible</p>
              <p className="register-secondary">fix the seed, then run normally</p>
            </Cell>
          </div>

          <div className="register-error">
            <span>stderr</span>
            <pre>{`error roles failed
  rolled back — the database is as it was before this seed started

  duplicate key value violates unique constraint "roles_pkey"
  detail: Key (name)=(admin) already exists.
  table: roles
  constraint: roles_pkey
  code: 23505

  Run again with --trace for the stack.`}</pre>
          </div>
        </div>
      </section>

      <section aria-labelledby="authoring-surface">
        <div className="register-frame">
          <div className="register-section-heading">
            <h2 id="authoring-surface">The complete authoring surface</h2>
            <p>
              One config, <code>defineSeed</code>, and the database handle handed to{' '}
              <code>run</code>. Seed code remains ordinary TypeScript.
            </p>
          </div>

          <div className="register-files">
            <article>
              <h3>sidder.config.mts</h3>
              <pre>{`import { defineConfig } from 'sidder';
import { pgAdapter } from 'sidder/adapters/pg';
import { pool } from './src/db/index.mts';

export default defineConfig({
  adapter: pgAdapter(pool),
  seeds: 'seeds/**/*.mts',
});`}</pre>
            </article>

            <article>
              <h3>seeds/roles.mts</h3>
              <pre>{`import { defineSeed } from 'sidder';
import type { PgQueryable } from 'sidder/adapters/pg';

export default defineSeed<PgQueryable>({
  name: 'roles',

  async run({ db }) {
    await db.query(
      \`insert into roles (name)
       select unnest($1::text[])
       on conflict (name) do nothing\`,
      [['admin', 'member']],
    );
  },
});`}</pre>
            </article>
          </div>
        </div>
      </section>

      <footer className="register-footer">
        <div className="register-frame register-footer-inner">
          <div>
            <strong>sidder</strong>
            <span>A seed runner for Postgres.</span>
          </div>
          <nav aria-label="Footer">
            <Link href="/docs/getting-started">Quick start</Link>
            <Link href="/docs/guides/running">Running seeds</Link>
            <Link href="/docs/guides/journal">Journal</Link>
            <Link href="/docs/reference/cli">CLI</Link>
            <Link href="https://github.com/dibenkobit/sidder">GitHub ↗</Link>
          </nav>
          <span>MIT</span>
        </div>
      </footer>
    </main>
  );
}
