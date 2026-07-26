import Link from 'next/link';

const guarantees = [
  {
    number: '01',
    label: 'ORDER',
    title: 'Dependencies, not filenames',
    description:
      'Declare dependsOn. sidder computes one deterministic order and shows it before execution.',
  },
  {
    number: '02',
    label: 'RESUME',
    title: 'A journal that commits with the work',
    description:
      'The seed writes and their journal row share a transaction. Half-applied is not a state.',
  },
  {
    number: '03',
    label: 'EXPLAIN',
    title: 'Every guess names its source',
    description:
      'Config, environment, seed names, order and skips arrive with provenance, not magic.',
  },
  {
    number: '04',
    label: 'LOCK',
    title: 'Concurrent runs re-check',
    description:
      'A per-seed advisory lock prevents two deploys from quietly applying the same work twice.',
  },
];

export default function HomePage() {
  return (
    <div className="sidder-home">
      <section className="sidder-hero">
        <div className="sidder-frame">
          <div className="sidder-hero-copy">
            <div className="sidder-overline">
              <span>POSTGRES SEED RUNNER</span>
              <span>MIT / v0.1.0</span>
            </div>

            <h1>
              Seed data.
              <span className="sidder-hero-tagline">With a paper trail.</span>
            </h1>

            <p className="sidder-hero-lede">
              sidder discovers seed files, orders them by real dependencies, and records every
              successful run in Postgres — in the same transaction as the writes.
            </p>

            <div className="sidder-hero-actions">
              <Link className="sidder-button sidder-button-primary" href="/docs/getting-started">
                Read the quick start
                <span aria-hidden="true">↗</span>
              </Link>
              <Link
                className="sidder-button"
                href="https://github.com/dibenkobit/sidder"
                rel="noreferrer"
                target="_blank"
              >
                View source
                <span aria-hidden="true">↗</span>
              </Link>
            </div>

            <div className="sidder-install">
              <span className="sidder-install-prompt" aria-hidden="true">
                $
              </span>
              <code>npm i -D sidder</code>
              <span className="sidder-install-note">zero runtime dependencies</span>
            </div>
          </div>

          <div className="sidder-runbook">
            <div className="sidder-runbook-head">
              <span>RUN MANIFEST / 0017</span>
              <span className="sidder-live">
                <i aria-hidden="true" />
                COMPLETE
              </span>
            </div>

            <dl className="sidder-resolution">
              <div>
                <dt>CONFIG</dt>
                <dd>sidder.config.mts</dd>
                <span>found from cwd</span>
              </div>
              <div>
                <dt>ENV</dt>
                <dd>development</dd>
                <span>NODE_ENV</span>
              </div>
              <div>
                <dt>JOURNAL</dt>
                <dd>sidder_journal</dd>
                <span>default</span>
              </div>
            </dl>

            <div className="sidder-seed-list">
              <div className="sidder-seed-row">
                <span className="sidder-seed-index">01</span>
                <span className="sidder-seed-path">
                  <i aria-hidden="true" />
                  roles
                </span>
                <span className="sidder-seed-dependency">—</span>
                <span className="sidder-seed-status">APPLIED</span>
                <span className="sidder-seed-time">7ms</span>
              </div>
              <div className="sidder-seed-row">
                <span className="sidder-seed-index">02</span>
                <span className="sidder-seed-path">
                  <i aria-hidden="true" />
                  territory
                </span>
                <span className="sidder-seed-dependency">roles</span>
                <span className="sidder-seed-status">APPLIED</span>
                <span className="sidder-seed-time">5ms</span>
              </div>
              <div className="sidder-seed-row">
                <span className="sidder-seed-index">03</span>
                <span className="sidder-seed-path">
                  <i aria-hidden="true" />
                  demo
                </span>
                <span className="sidder-seed-dependency">territory</span>
                <span className="sidder-seed-status">APPLIED</span>
                <span className="sidder-seed-time">7ms</span>
              </div>
              <div className="sidder-seed-row sidder-seed-row-muted">
                <span className="sidder-seed-index">04</span>
                <span className="sidder-seed-path">
                  <i aria-hidden="true" />
                  bulk-metrics
                </span>
                <span className="sidder-seed-dependency">demo</span>
                <span className="sidder-seed-status">SKIPPED</span>
                <span className="sidder-seed-time">once</span>
              </div>
            </div>

            <div className="sidder-runbook-foot">
              <span>3 applied / 1 skipped</span>
              <span>COMMITTED IN 52ms</span>
            </div>
          </div>
        </div>
      </section>

      <section className="sidder-problem">
        <div className="sidder-frame sidder-section-grid">
          <div className="sidder-section-label">
            <span>THE PROBLEM</span>
            <span>01 / 04</span>
          </div>
          <div className="sidder-problem-copy">
            <h2>
              A folder of scripts
              <br />
              is not a system.
            </h2>
            <div className="sidder-problem-notes">
              <p>
                Migrations have discovery, ordering, history and one entry point. Seeds still get an{' '}
                <code>&amp;&amp;</code> chain someone has to remember to maintain.
              </p>
              <p>
                sidder gives data changes the operational discipline schema changes have had for
                years. Seed code stays ordinary TypeScript.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="sidder-process">
        <div className="sidder-frame">
          <div className="sidder-section-label">
            <span>THE RUN</span>
            <span>02 / 04</span>
          </div>

          <div className="sidder-process-intro">
            <h2>From loose files to database history.</h2>
            <p>
              One command resolves the plan before it asks Postgres to do anything. Every stage
              leaves evidence.
            </p>
          </div>

          <ol className="sidder-process-list">
            <li>
              <span className="sidder-process-number">01</span>
              <h3>Discover</h3>
              <p>Find config and seed files by convention. Print where every value came from.</p>
              <code>{'seeds/**/*.mts'}</code>
            </li>
            <li>
              <span className="sidder-process-number">02</span>
              <h3>Order</h3>
              <p>Validate names and dependencies. Produce a deterministic topological order.</p>
              <code>roles → territory → demo</code>
            </li>
            <li>
              <span className="sidder-process-number">03</span>
              <h3>Commit</h3>
              <p>Lock, re-check, run, and journal each seed as one transactional unit.</p>
              <code>BEGIN → seed → journal → COMMIT</code>
            </li>
          </ol>
        </div>
      </section>

      <section className="sidder-code-section">
        <div className="sidder-frame">
          <div className="sidder-section-label">
            <span>THE SURFACE</span>
            <span>03 / 04</span>
          </div>

          <div className="sidder-code-grid">
            <div className="sidder-code-copy">
              <p className="sidder-code-kicker">THREE CONCEPTS. THAT&apos;S IT.</p>
              <h2>Keep the seed code boring.</h2>
              <p>
                A config, <code>defineSeed</code>, and the database handle you are handed. No
                factory DSL, hidden registry or special query API.
              </p>
              <Link href="/docs/concepts">
                See the complete model
                <span aria-hidden="true"> →</span>
              </Link>
            </div>

            <div className="sidder-editor">
              <div className="sidder-editor-tabs">
                <span className="sidder-editor-tab-active">seeds/roles.mts</span>
                <span className="sidder-editor-tab">sidder.config.mts</span>
              </div>
              <div className="sidder-code">
                <span className="sidder-line-number">1</span>
                <code>
                  <b>import</b> {'{'} defineSeed {'}'} <b>from</b> <em>&apos;sidder&apos;;</em>
                </code>
                <span className="sidder-line-number">2</span>
                <code />
                <span className="sidder-line-number">3</span>
                <code>
                  <b>export default</b> defineSeed({'{'}
                </code>
                <span className="sidder-line-number">4</span>
                <code>
                  {'  '}async run({'{'} db {'}'}) {'{'}
                </code>
                <span className="sidder-line-number">5</span>
                <code>{'    '}await db.query(</code>
                <span className="sidder-line-number">6</span>
                <code>
                  {'      '}
                  <em>&quot;insert into roles (name) values (&apos;admin&apos;)&quot;</em>,
                </code>
                <span className="sidder-line-number">7</span>
                <code>{'    '});</code>
                <span className="sidder-line-number">8</span>
                <code>
                  {'  '}
                  {'}'},
                </code>
                <span className="sidder-line-number">9</span>
                <code>{'}'});</code>
              </div>
              <div className="sidder-editor-status">
                <span>TypeScript</span>
                <span>ordinary database code</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="sidder-guarantees">
        <div className="sidder-frame">
          <div className="sidder-section-label">
            <span>THE GUARANTEES</span>
            <span>04 / 04</span>
          </div>

          <div className="sidder-guarantees-heading">
            <h2>Designed for the failure, not the demo.</h2>
            <p>
              The happy path is easy. sidder&apos;s contract is about what happens when a process
              races, crashes, skips or has to explain itself.
            </p>
          </div>

          <div className="sidder-guarantee-list">
            {guarantees.map((guarantee) => (
              <article key={guarantee.number}>
                <div className="sidder-guarantee-index">
                  <span>{guarantee.number}</span>
                  <span>{guarantee.label}</span>
                </div>
                <h3>{guarantee.title}</h3>
                <p>{guarantee.description}</p>
              </article>
            ))}
          </div>

          <div className="sidder-transaction">
            <div className="sidder-transaction-title">
              <span>TRANSACTION / seed:roles</span>
              <span>ATOMIC</span>
            </div>
            <div className="sidder-transaction-flow">
              <div>
                <span>01</span>
                <strong>LOCK</strong>
                <small>pg_advisory_xact_lock</small>
              </div>
              <i aria-hidden="true">→</i>
              <div>
                <span>02</span>
                <strong>SEED WRITES</strong>
                <small>your existing db handle</small>
              </div>
              <i aria-hidden="true">→</i>
              <div>
                <span>03</span>
                <strong>JOURNAL ROW</strong>
                <small>same transaction, same scope</small>
              </div>
              <i aria-hidden="true">→</i>
              <div className="sidder-transaction-commit">
                <span>04</span>
                <strong>COMMIT</strong>
                <small>or all of it rolls back</small>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="sidder-final">
        <div className="sidder-frame">
          <p className="sidder-final-kicker">NO MORE MYSTERY SEED SCRIPTS.</p>
          <h2>The next run should explain itself.</h2>
          <div className="sidder-final-actions">
            <Link className="sidder-button sidder-button-primary" href="/docs/getting-started">
              Run the quick start
              <span aria-hidden="true">↗</span>
            </Link>
            <div className="sidder-final-install">
              <span className="sidder-final-prompt" aria-hidden="true">
                $
              </span>
              <code>npm i -D sidder</code>
            </div>
          </div>
        </div>
      </section>

      <footer className="sidder-footer">
        <div className="sidder-frame">
          <div>
            <span>sidder</span>
            <p>A seed runner for Postgres.</p>
          </div>
          <nav aria-label="Footer">
            <Link href="/docs">Docs</Link>
            <Link href="/docs/reference/cli">CLI</Link>
            <Link href="/docs/reference/api">API</Link>
            <Link href="https://github.com/dibenkobit/sidder">GitHub</Link>
          </nav>
          <span className="sidder-footer-license">MIT / 2026</span>
        </div>
      </footer>
    </div>
  );
}
