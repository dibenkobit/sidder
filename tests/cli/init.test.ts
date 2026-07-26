import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/cli/init.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(packageJson?: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'sidder-init-'));
  dirs.push(dir);
  if (packageJson !== undefined) {
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(packageJson)}\n`);
  }
  return dir;
}

describe('runInit', () => {
  test('writes explicit ESM files that do not depend on package.json module mode', () => {
    const dir = project();

    const result = runInit(dir, false);
    const config = readFileSync(result.path, 'utf8');

    expect(result.path).toBe(join(dir, 'sidder.config.mts'));
    expect(config).toContain("from './src/db/index.mts'");
    expect(config).toContain("seeds: 'seeds/**/*.mts'");
    expect(result.message).toContain('seeds/roles.mts');
    expect(result.message).toContain('npx sidder status');
  });

  test('chooses Drizzle only when package.json provides evidence for it', () => {
    const dir = project({ dependencies: { 'drizzle-orm': '^1.0.0' } });

    const { path, message } = runInit(dir, false);
    const config = readFileSync(path, 'utf8');

    expect(config).toContain("from 'sidder/adapters/drizzle'");
    expect(message).toContain('drizzle-orm is in your package.json');
  });

  test('does not create a competing config when a supported one already exists', () => {
    const dir = project();
    const existing = join(dir, 'sidder.config.ts');
    writeFileSync(existing, 'export default existing;\n');

    const result = runInit(dir, false);

    expect(result.path).toBe(existing);
    expect(result.message).toContain('sidder.config.ts already exists');
    expect(readFileSync(existing, 'utf8')).toBe('export default existing;\n');
    expect(existsSync(join(dir, 'sidder.config.mts'))).toBe(false);
  });

  test('--force overwrites the config resolution would actually choose', () => {
    const dir = project();
    const existing = join(dir, 'sidder.config.ts');
    writeFileSync(existing, 'export default existing;\n');

    const result = runInit(dir, true);

    expect(result.path).toBe(existing);
    expect(readFileSync(existing, 'utf8')).toContain("from 'sidder/adapters/pg'");
  });
});
