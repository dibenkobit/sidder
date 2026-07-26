# Security policy

sidder executes project-owned TypeScript with database credentials and can write
arbitrary data. Treat a vulnerability that changes what code runs, where SQL executes or
which seed is recorded as security-sensitive.

## Supported versions

Before 1.0, security fixes target the latest published minor release. Upgrade to the
latest `0.x` before reporting that a fix is missing from an older line.

| Version | Security fixes |
|---|---|
| Latest published minor | Yes |
| Older `0.x` minors | No |
| Unreleased branches and forks | No |

## Report privately

Do not open a public issue for a suspected vulnerability.

Email [snetkov@exoform.ai](mailto:snetkov@exoform.ai) with the subject
`sidder security: <short summary>`. Include:

- affected sidder version and installation source;
- Node or Bun version, package manager and operating system;
- adapter and driver versions;
- a minimal reproduction or precise sequence of commands;
- expected and observed database effects;
- whether transactions committed, rolled back or remained open;
- impact and any known workaround;
- logs with credentials, connection strings and production data removed.

You should receive an acknowledgement within three business days. This is a
maintainer-run project without a response-time SLA, but the goal is to confirm severity
and a coordination plan within seven business days.

Please allow time for a fix and release before public disclosure. Credit is offered
unless you prefer to remain anonymous.

## In scope

Examples include:

- loading a different config or seed than the one reported;
- SQL injection through sidder-owned configuration or journal operations;
- applying a transactional seed without the documented rollback or lock guarantees;
- recording a journal row for work that did not commit;
- leaking database credentials or seed contents through normal CLI output;
- published-package or install-script behavior that executes unexpected code.

## Usually not a vulnerability

- arbitrary SQL intentionally written inside a seed;
- partial writes from a seed that declares `transaction: false`;
- duplicate simultaneous application of a non-transactional seed, which is a documented
  limitation;
- secrets explicitly printed by user seed code or a database driver;
- denial of service requiring trusted write access to the config or seed files;
- unsupported runtimes, drivers or old sidder releases.

When unsure, report privately. A maintainer can reclassify a bug without exposing it
prematurely.
