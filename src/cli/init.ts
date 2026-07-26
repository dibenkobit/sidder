import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { style } from './format.ts';

/**
 * Writes a starting `sidder.config.ts`.
 *
 * It looks at your package.json to pick a template, and then says which one it picked
 * and why. Guessing saves you a trip to the README; guessing silently would leave you
 * wondering why the file mentions Drizzle.
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
const PLACEHOLDER = './src/db/index.ts';

export function runInit(cwd: string, force: boolean): { path: string; message: string } {
  const path = resolve(cwd, 'sidder.config.ts');

  if (existsSync(path) && !force) {
    return {
      path,
      message: `${style.yellow('sidder.config.ts already exists')} — pass --force to overwrite it.`,
    };
  }

  const { flavour, evidence } = detectFlavour(cwd);
  writeFileSync(path, TEMPLATES[flavour], 'utf8');

  return {
    path,
    message: [
      `${style.green('wrote')} sidder.config.ts ${style.dim(`(${flavour} — ${evidence})`)}`,
      '',
      `Next, point the ${style.bold(PLACEHOLDER)} import at the database handle you already have.`,
      'That path is a placeholder, not somewhere sidder looked. Then write a seed:',
      '',
      style.dim('  // seeds/roles.ts'),
      style.dim("  import { defineSeed } from 'sidder';"),
      style.dim(''),
      style.dim('  export default defineSeed({'),
      style.dim('    async run({ db }) {'),
      style.dim('      // your existing seeding code, unchanged'),
      style.dim('    },'),
      style.dim('  });'),
      '',
      `Then ${style.bold('sidder status')} to see what it would do.`,
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
  seeds: 'seeds/**/*.ts',
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
  seeds: 'seeds/**/*.ts',
});
`,
};
