# Runtimes

sidder imports config and seed source files in the CLI process. The runtime that launches
sidder must therefore understand every file those modules import.

The supported Node engine is 22.18 or newer. Bun is also tested as a development runtime.

## Choose a path

| Project | Command | TypeScript behavior |
|---|---|---|
| Erasable TypeScript, explicit relative paths | `npx sidder run` | Node native type stripping |
| TypeScript using `tsconfig` paths or transform-only syntax | loader command below | `tsx` |
| Bun project | `bun run --bun sidder run` | Bun native TypeScript |
| JavaScript seeds | `npx sidder run` | Ordinary Node ESM/CJS rules |

## Node native TypeScript

Node 22.18 enables type stripping by default. It removes erasable type syntax; it does
not run the TypeScript compiler and does not read `tsconfig.json`.

Use:

```bash
npx sidder status
npx sidder run
```

Native Node does not support:

- `tsconfig` `paths`;
- JSX/TSX;
- syntax that requires JavaScript generation, such as enums, parameter properties and
  some namespaces;
- extensionless relative imports.

Relative imports must name their real file:

```ts
import { db } from './src/db/index.mts';
```

not:

```ts
import { db } from './src/db';
```

### `.mts` versus `.ts`

`.mts` is always an ES module. `.ts` follows the same module selection rules as `.js`:
ESM imports require the nearest `package.json` to contain `"type": "module"`.

That is why `sidder init` generates `sidder.config.mts` and `seeds/**/*.mts`. It works
without changing the host project's module mode.

Node documents the full behavior in
[Modules: TypeScript](https://nodejs.org/api/typescript.html).

## Node with `tsx`

Use a loader when the project relies on its TypeScript toolchain rather than native type
stripping:

```bash
npm i -D tsx
node --import=tsx ./node_modules/sidder/dist/cli/main.js status
node --import=tsx ./node_modules/sidder/dist/cli/main.js run
```

For repeated use, put the exact command in package scripts:

```json
{
  "scripts": {
    "seed": "node --import=tsx ./node_modules/sidder/dist/cli/main.js run",
    "seed:status": "node --import=tsx ./node_modules/sidder/dist/cli/main.js status"
  }
}
```

Then:

```bash
npm run seed:status
npm run seed
```

The `dist/cli/main.js` path is the same published file declared by sidder's `bin` field
and is supported for loader invocation.

## Bun

Install and run the published package:

```bash
bun add -d sidder
bun run --bun sidder init
bun run --bun sidder status
bun run --bun sidder run
```

`bun run` resolves the local executable. `--bun` overrides sidder's Node shebang so Bun
loads the user's TypeScript and honors `tsconfig` paths.

Do not use the old GitHub-install workaround. Published npm tarballs already contain
`dist/`; no consumer build is needed.

## Common runtime failures

### ESM parsed as CommonJS

```text
Cannot use import statement outside a module
```

Rename config and seed files to `.mts`, add `"type": "module"` for `.ts`, or use a
loader/Bun. sidder reports this as `ModuleFormatError`, separately from broken syntax.

### Unsupported TypeScript syntax

Node native type stripping cannot transform the syntax. Use `tsx` or Bun, or rewrite it
to erasable syntax.

### Alias does not resolve

Node does not read `tsconfig` paths. Use a relative path with its extension, `tsx`, Bun,
or Node package `imports` aliases beginning with `#`.

### Package import does not resolve

Dependencies are resolved from the user's importing file. Install the package in the
project that owns the config/seeds, not inside sidder.
