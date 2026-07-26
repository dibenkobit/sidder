# sidder docs

This is a Next.js application generated with
[Create Fumadocs](https://github.com/fuma-nama/fumadocs).

Run development server:

```bash
bun run docs:dev
```

Run this command from the repository root, then open http://localhost:3000.

Content lives in `content/docs`. The production build, content type generation and Biome
checks run together with:

```bash
bun run docs:check
```

`NEXT_PUBLIC_SITE_URL` sets the canonical production origin. Vercel deployments use
`VERCEL_PROJECT_PRODUCTION_URL` automatically when the explicit value is absent.
