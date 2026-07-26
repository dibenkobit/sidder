import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '../../src/cli/main.ts');

async function invoke(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn([processExec(), CLI, ...args], {
    cwd: join(import.meta.dir, '../..'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...globalThis.process.env, NO_COLOR: '1' },
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

function processExec(): string {
  return globalThis.process.execPath;
}

describe('CLI usage', () => {
  test('run --help shows only run options and copyable examples', async () => {
    const result = await invoke(['run', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('npx sidder run --only demo --force');
    expect(result.stdout).toContain('--dry-run');
    expect(result.stdout).not.toContain('--json');
  });

  test('help status is the long form of status --help', async () => {
    const long = await invoke(['help', 'status']);
    const flag = await invoke(['status', '--help']);

    expect(long.exitCode).toBe(0);
    expect(long.stdout).toBe(flag.stdout);
    expect(long.stdout).toContain('--json');
    expect(long.stdout).not.toContain('--force');
  });

  test('rejects a known flag on the wrong command instead of ignoring it', async () => {
    const result = await invoke(['run', '--json']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--json is not valid with `sidder run`');
    expect(result.stderr).toContain('npx sidder run --help');
  });

  test('rejects extra positional arguments instead of ignoring them', async () => {
    const result = await invoke(['status', 'demo']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('does not accept positional arguments');
    expect(result.stderr).toContain('npx sidder status --help');
  });

  test('answers an unknown option with the root help command', async () => {
    const result = await invoke(['run', '--wat']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown option '--wat'");
    expect(result.stderr).toContain('npx sidder --help');
  });

  test('does not ignore a command option when no command was given', async () => {
    const result = await invoke(['--json']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--json needs a command');
  });
});
