import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const DOCS_DIR = join(ROOT, 'docs');
const DOC_FILES = [
  ...['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'SUPPORT.md', 'CODE_OF_CONDUCT.md'].map(
    (file) => join(ROOT, file),
  ),
  join(ROOT, 'examples/node-postgres/README.md'),
  ...readdirSync(DOCS_DIR)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => join(DOCS_DIR, file)),
];

describe('documentation', () => {
  test('every local Markdown link reaches a file and heading', () => {
    for (const file of DOC_FILES) {
      const markdown = readFileSync(file, 'utf8');

      for (const target of markdown.matchAll(/(?<!!)\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const href = target[1];
        if (href === undefined || /^(?:https?:|mailto:)/.test(href)) continue;

        const [relativePath = '', fragment] = href.split('#', 2);
        const destination = relativePath === '' ? file : resolve(dirname(file), relativePath);

        if (!existsSync(destination)) {
          throw new Error(`${display(file)} links to missing ${href}`);
        }

        if (fragment !== undefined && fragment !== '') {
          const headings = headingIds(readFileSync(destination, 'utf8'));
          const decoded = decodeURIComponent(fragment);
          if (!headings.has(decoded)) {
            throw new Error(`${display(file)} links to missing heading ${href}`);
          }
        }
      }
    }
  });

  test('the documentation index includes every reference guide', () => {
    const index = readFileSync(join(DOCS_DIR, 'README.md'), 'utf8');
    const guides = readdirSync(DOCS_DIR)
      .filter((file) => file.endsWith('.md') && file !== 'README.md')
      .sort();

    for (const guide of guides) expect(index).toContain(`(${guide})`);
  });

  test('the README release example and install instructions stay current', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };

    expect(readme).toContain(`sidder ${packageJson.version}`);
    expect(readme).not.toContain('not on npm yet');
    expect(readme).not.toContain('github:dibenkobit/sidder');
    expect(readme).not.toContain('bunx sidder');
    expect(readme).not.toMatch(/^\$ sidder\b/m);
  });
});

function headingIds(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const ids = new Set<string>();

  for (const match of markdown.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const heading = match[1];
    if (heading === undefined) continue;

    const base = heading
      .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/`/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-');
    const duplicate = seen.get(base) ?? 0;
    seen.set(base, duplicate + 1);
    ids.add(duplicate === 0 ? base : `${base}-${duplicate}`);
  }

  return ids;
}

function display(file: string): string {
  return file.slice(ROOT.length + 1);
}
