# sidder docs

This is a Next.js application generated with
[Create Fumadocs](https://github.com/fuma-nama/fumadocs).

Run development server:

```bash
bun run docs:dev
```

Run this command from the repository root, then open http://localhost:43921.

`43921` is the local default for both `dev` and `start`. It is deliberately outside the
ports commonly used by framework development servers.

Content lives in `content/docs`. The production build, content type generation and Biome
checks run together with:

```bash
bun run docs:check
```

`NEXT_PUBLIC_SITE_URL` sets the canonical production origin. Vercel deployments use
`VERCEL_PROJECT_PRODUCTION_URL` automatically when the explicit value is absent.

For Vercel, import this repository and set the project's Root Directory to `apps/docs`.
Vercel detects Next.js and runs the production build itself; the local `43921` port is
not part of the deployment.
