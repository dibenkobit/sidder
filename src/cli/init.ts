import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { CONFIG_FILENAMES } from '../resolve/config.ts';
import { style } from './format.ts';

/**
 * Writes a starting `sidder.config.mts`.
 *
 * It looks at your package.json to pick a template, and then says which one it picked
 * and why. Guessing saves you a trip to the README; guessing silently would leave you
 * wondering why the file mentions Drizzle.
 *
 * `.mts` is not a guess. Node decides what `.ts` means from the nearest package.json,
 * so the ESM imports in a generated `.ts` config fail in an otherwise ordinary CommonJS
 * project. `.mts` states its module format in its name and works the same way with Node,
 * Bun, and a TypeScript loader.
 */

type Flavour = 'drizzle' | 'pg';

/**
 * The one line in the generated config that is a guess rather than a default.
 *
 * sidder does not go looking for your database module: a path found by scanning is right
 * often enough to be trusted and wrong often enough to send you chasing an undefined
 * `pool` instead of a missing file, which is the worse of the two failures. So it writes
 * a placeholder that says so in the file, says so again in the message, and leaves
 * `ModuleResolutionError` to say it a third time if you run before editing it.
 */
const PLACEHOLDER = './src/db/index.mts';
const DEFAULT_CONFIG_FILE = 'sidder.config.mts';

export function runInit(cwd: string, force: boolean): { path: string; message: string } {
  const existing = CONFIG_FILENAMES.map((name) => resolve(cwd, name)).find(existsSync);
  const path = existing ?? resolve(cwd, DEFAULT_CONFIG_FILE);
  const filename = basename(path);

  if (existing !== undefined && !force) {
    return {
      path,
      message: `${style.yellow(`${filename} already exists`)} — pass --force to overwrite it.`,
    };
  }

  const { flavour, evidence } = detectFlavour(cwd);
  writeFileSync(path, TEMPLATES[flavour], 'utf8');

  return {
    path,
    message: [
      `${style.green('wrote')} ${filename} ${style.dim(`(${flavour} — ${evidence})`)}`,
      '',
      `Next, point the ${style.bold(PLACEHOLDER)} import at the database handle you already have.`,
      'That path is a placeholder, not somewhere sidder looked. Then write a seed:',
      '',
      ...SEED_EXAMPLES[flavour].map((line) => style.dim(`  ${line}`)),
      '',
      `Then ${style.bold('npx sidder status')} to see what it would do.`,
      style.dim('For pnpm, Yarn, and Bun, see the package-manager commands in the README.'),
    ].join('\n'),
  };
}

function detectFlavour(cwd: string): { flavour: Flavour; evidence: string } {
  const packageJsonPath = resolve(cwd, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return { flavour: 'pg', evidence: 'no package.json here, defaulting to node-postgres' };
  }

  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };

  if ('drizzle-orm' in dependencies) {
    return { flavour: 'drizzle', evidence: 'drizzle-orm is in your package.json' };
  }
  return { flavour: 'pg', evidence: 'no drizzle-orm found, defaulting to node-postgres' };
}

const TEMPLATES: Record<Flavour, string> = {
  drizzle: `import { defineConfig } from 'sidder';
import { drizzleAdapter } from 'sidder/adapters/drizzle';

// Placeholder: point this at the Drizzle instance you already have. Keep the file
// extension — sidder imports this file with your runtime, and Node's resolver needs it.
import { db } from '${PLACEHOLDER}';

export default defineConfig({
  adapter: drizzleAdapter(db),

  // Where your seeds live. Paths are relative to this file.
  seeds: 'seeds/**/*.mts',
});
`,

  pg: `import { defineConfig } from 'sidder';
import { pgAdapter } from 'sidder/adapters/pg';

// Placeholder: point this at the Pool you already have. Keep the file extension —
// sidder imports this file with your runtime, and Node's resolver needs it.
import { pool } from '${PLACEHOLDER}';

export default defineConfig({
  adapter: pgAdapter(pool),

  // Where your seeds live. Paths are relative to this file.
  seeds: 'seeds/**/*.mts',
});
`,
};

const SEED_EXAMPLES: Record<Flavour, string[]> = {
  pg: [
    '// seeds/roles.mts',
    "import { defineSeed } from 'sidder';",
    "import type { PgQueryable } from 'sidder/adapters/pg';",
    '',
    'export default defineSeed<PgQueryable>({',
    '  async run({ db }) {',
    '    // db is a Pool or the transaction-scoped PoolClient',
    '  },',
    '});',
  ],
  drizzle: [
    '// seeds/roles.mts',
    "import { defineSeed } from 'sidder';",
    "import type { db } from '../src/db/index.mts'; // use your real database module",
    '',
    'export default defineSeed<typeof db>({',
    '  async run({ db }) {',
    '    // db has your Drizzle query builders',
    '  },',
    '});',
  ],
};
