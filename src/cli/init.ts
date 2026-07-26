import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { style } from './format.ts';

/**
 * Writes a starting `sowme.config.ts`.
 *
 * It looks at your package.json to pick a template, and then says which one it picked
 * and why. Guessing saves you a trip to the README; guessing silently would leave you
 * wondering why the file mentions Drizzle.
 */

type Flavour = 'drizzle' | 'pg';

export function runInit(cwd: string, force: boolean): { path: string; message: string } {
  const path = resolve(cwd, 'sowme.config.ts');

  if (existsSync(path) && !force) {
    return {
      path,
      message: `${style.yellow('sowme.config.ts already exists')} — pass --force to overwrite it.`,
    };
  }

  const { flavour, evidence } = detectFlavour(cwd);
  writeFileSync(path, TEMPLATES[flavour], 'utf8');

  return {
    path,
    message: [
      `${style.green('wrote')} sowme.config.ts ${style.dim(`(${flavour} — ${evidence})`)}`,
      '',
      'Next, edit the import so it points at the database instance you already have,',
      'then write a seed:',
      '',
      style.dim('  // seeds/roles.ts'),
      style.dim("  import { defineSeed } from 'sowme';"),
      style.dim(''),
      style.dim('  export default defineSeed({'),
      style.dim('    async run({ db }) {'),
      style.dim('      // your existing seeding code, unchanged'),
      style.dim('    },'),
      style.dim('  });'),
      '',
      `Then ${style.bold('sowme status')} to see what it would do.`,
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
  drizzle: `import { defineConfig } from 'sowme';
import { drizzleAdapter } from 'sowme/adapters/drizzle';

// Point this at the Drizzle instance you already have.
import { db } from './src/db/index.ts';

export default defineConfig({
  adapter: drizzleAdapter(db),

  // Where your seeds live. Paths are relative to this file.
  seeds: 'seeds/**/*.ts',
});
`,

  pg: `import { defineConfig } from 'sowme';
import { pgAdapter } from 'sowme/adapters/pg';

// Point this at the Pool you already have.
import { pool } from './src/db/index.ts';

export default defineConfig({
  adapter: pgAdapter(pool),

  // Where your seeds live. Paths are relative to this file.
  seeds: 'seeds/**/*.ts',
});
`,
};
