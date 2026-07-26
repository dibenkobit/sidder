import {
  ArrowRight,
  Check,
  Database,
  GitBranch,
  GitFork,
  LockKeyhole,
  ScanSearch,
  SquareTerminal,
} from 'lucide-react';
import Link from 'next/link';

const features = [
  {
    icon: GitBranch,
    title: 'Ordered',
    description:
      'Declare what a seed depends on. sidder finds a deterministic order and shows it before running.',
  },
  {
    icon: Database,
    title: 'Resumable',
    description:
      'Every successful seed is journaled inside the same transaction as its database writes.',
  },
  {
    icon: ScanSearch,
    title: 'Transparent',
    description:
      'Config, environment, inferred names, order and every skipped seed are printed with their reason.',
  },
  {
    icon: LockKeyhole,
    title: 'Concurrency-safe',
    description:
      'Per-seed advisory locks keep two deploys from quietly applying the same seed twice.',
  },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      <section className="relative border-b">
        <div className="sidder-grid pointer-events-none absolute inset-0" />
        <div className="absolute inset-x-0 top-0 mx-auto h-80 max-w-3xl rounded-full bg-fd-primary/10 blur-3xl" />

        <div className="relative mx-auto grid w-full max-w-[1200px] gap-14 px-6 py-20 md:px-10 md:py-28 lg:grid-cols-[1fr_0.88fr] lg:items-center lg:py-36">
          <div>
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border bg-fd-card/80 px-3 py-1 text-sm text-fd-muted-foreground shadow-sm backdrop-blur">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              Postgres · Drizzle · node-postgres
            </div>

            <h1 className="max-w-3xl text-balance text-5xl font-semibold tracking-[-0.04em] md:text-7xl">
              Seeds deserve
              <span className="block text-fd-primary">a real runner.</span>
            </h1>

            <p className="mt-6 max-w-2xl text-pretty text-lg leading-8 text-fd-muted-foreground md:text-xl">
              Migrations got discovery, ordering and a journal fifteen years ago. sidder brings the
              same guarantees to database seeds — without inventing a new DSL.
            </p>

            <div className="mt-9 flex flex-wrap gap-3">
              <Link
                href="/docs/getting-started"
                className="inline-flex h-11 items-center gap-2 rounded-full bg-fd-primary px-5 font-medium text-fd-primary-foreground shadow-sm transition-opacity hover:opacity-90"
              >
                Get started
                <ArrowRight className="size-4" />
              </Link>
              <Link
                href="https://github.com/dibenkobit/sidder"
                className="inline-flex h-11 items-center gap-2 rounded-full border bg-fd-card px-5 font-medium transition-colors hover:bg-fd-accent"
              >
                <GitFork className="size-4" />
                GitHub
              </Link>
            </div>

            <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-fd-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <Check className="size-4 text-emerald-500" />
                zero runtime dependencies
              </span>
              <span className="inline-flex items-center gap-2">
                <Check className="size-4 text-emerald-500" />
                TypeScript-first
              </span>
              <span className="inline-flex items-center gap-2">
                <Check className="size-4 text-emerald-500" />
                Node 22.18+ and Bun
              </span>
            </div>
          </div>

          <div className="relative">
            <div className="absolute -inset-8 rounded-[3rem] bg-fd-primary/10 blur-3xl" />
            <div className="relative overflow-hidden rounded-2xl border bg-[#0b0d10] text-[13px] text-zinc-300 shadow-2xl shadow-black/20">
              <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3 text-zinc-500">
                <span className="size-2.5 rounded-full bg-red-400/80" />
                <span className="size-2.5 rounded-full bg-amber-400/80" />
                <span className="size-2.5 rounded-full bg-emerald-400/80" />
                <span className="ml-2 flex items-center gap-2">
                  <SquareTerminal className="size-3.5" />
                  sidder run
                </span>
              </div>
              <pre className="overflow-x-auto p-5 leading-7">
                <code>
                  <span className="text-zinc-100">sidder</span>
                  <span className="text-zinc-600"> · </span>
                  <span>sidder.config.mts</span>
                  <span className="text-zinc-600"> · </span>
                  <span>env development (NODE_ENV)</span>
                  {'\n\n'}
                  <span className="text-emerald-400"> ✓ </span>
                  roles
                  <span className="text-zinc-600"> 7ms</span>
                  {'\n'}
                  <span className="text-emerald-400"> ✓ </span>
                  territory
                  <span className="text-zinc-600"> 5ms</span>
                  {'\n'}
                  <span className="text-emerald-400"> ✓ </span>
                  demo
                  <span className="text-zinc-600"> 7ms</span>
                  {'\n'}
                  <span className="text-zinc-600"> · </span>
                  bulk-metrics
                  <span className="text-zinc-600"> already applied 2026-07-24</span>
                  {'\n'}
                  <span className="text-zinc-600"> · </span>
                  fake-users
                  <span className="text-zinc-600">
                    {' '}
                    development, staging only — running as production
                  </span>
                  {'\n\n'}
                  <span className="text-zinc-500"> 3 applied, 2 skipped in 52ms</span>
                </code>
              </pre>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1200px] px-6 py-20 md:px-10 md:py-28">
        <div className="max-w-2xl">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-fd-primary">
            Guessing is fine. Guessing quietly is not.
          </p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight md:text-5xl">
            Everything inferred is explained.
          </h2>
          <p className="mt-5 text-lg leading-8 text-fd-muted-foreground">
            sidder finds the config, discovers seeds, resolves the environment and computes the
            order. Then it names every inference before anything reaches your database.
          </p>
        </div>

        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border bg-fd-border md:grid-cols-2">
          {features.map(({ icon: Icon, title, description }) => (
            <article key={title} className="bg-fd-background p-7 md:p-9">
              <div className="mb-5 inline-flex size-10 items-center justify-center rounded-xl border bg-fd-card text-fd-primary shadow-sm">
                <Icon className="size-5" />
              </div>
              <h3 className="text-xl font-semibold">{title}</h3>
              <p className="mt-2 leading-7 text-fd-muted-foreground">{description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="border-y bg-fd-card/45">
        <div className="mx-auto grid w-full max-w-[1200px] gap-10 px-6 py-20 md:px-10 lg:grid-cols-[0.85fr_1.15fr] lg:items-center">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
              Three concepts to seed one table.
            </h2>
            <p className="mt-4 text-lg leading-8 text-fd-muted-foreground">
              A config, <code>defineSeed</code>, and the database handle you are handed. Everything
              else is optional and waits until you need it.
            </p>
            <Link
              href="/docs/concepts"
              className="mt-6 inline-flex items-center gap-2 font-medium text-fd-primary"
            >
              Explore the concepts
              <ArrowRight className="size-4" />
            </Link>
          </div>

          <div className="overflow-hidden rounded-2xl border bg-[#0b0d10] text-sm text-zinc-300 shadow-xl">
            <div className="border-b border-white/10 px-5 py-3 text-zinc-500">seeds/roles.mts</div>
            <pre className="overflow-x-auto p-5 leading-7">
              <code>{`import { defineSeed } from 'sidder';

export default defineSeed({
  async run({ db }) {
    await db.query(
      "insert into roles (name) values ('admin')",
    );
  },
});`}</code>
            </pre>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1200px] px-6 py-20 text-center md:px-10 md:py-28">
        <h2 className="text-3xl font-semibold tracking-tight md:text-5xl">
          Stop maintaining the seed script chain.
        </h2>
        <p className="mx-auto mt-5 max-w-2xl text-lg text-fd-muted-foreground">
          Install sidder, point it at the database handle you already have, and keep your seed code
          ordinary.
        </p>
        <Link
          href="/docs/getting-started"
          className="mt-8 inline-flex h-11 items-center gap-2 rounded-full bg-fd-primary px-5 font-medium text-fd-primary-foreground"
        >
          Read the quick start
          <ArrowRight className="size-4" />
        </Link>
      </section>
    </main>
  );
}
