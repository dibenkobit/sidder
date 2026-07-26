# Journal and concurrency

sidder records one row per applied seed:

```sql
create table sidder_journal (
  name        text        primary key,
  applied_at  timestamptz not null default now(),
  environment text        not null,
  duration_ms integer     not null
);
```

The table is deliberately ordinary. Query it in psql, monitor it, back it up and delete
a row manually if that is clearer than using `forget`.

## Why it is in the database

For transactional seeds, the seed's writes and journal row use the same `Scope` and
commit together:

```text
begin
  seed writes
  journal upsert
commit
```

If either step fails, both roll back. There is no durable half-applied or “in progress”
state to repair. The next run skips earlier committed seeds and resumes at the failed one.

`mode: 'always'` also writes a row; its timestamp means “last applied”.

## Command effects

| Operation | Creates missing journal | Reads | Writes rows |
|---|---:|---:|---:|
| `run` | yes | yes | after each applied seed |
| `run --dry-run` | no | if present | no |
| `status` / `inspect()` | yes | yes | no |
| `forget` | yes | no | deletes requested rows |
| `runSeeds(..., { journal: false })` | no | no | no |

`status` is safe from seed execution but is not database-read-only on first use because it
creates the journal table.

## Permissions

The database role used by the CLI needs:

- connection and schema usage;
- `CREATE` on the target schema if sidder may create the journal;
- `SELECT`, `INSERT`, `UPDATE` and `DELETE` on an existing journal;
- permission to call PostgreSQL advisory lock functions, normally available by default;
- whatever privileges the seed code itself needs.

For least privilege, create the journal in a migration and grant only table DML to the
runtime role. The columns must match the schema above; extra columns are tolerated when
their own defaults allow sidder's inserts.

A schema-qualified `journalTable` requires the schema to exist:

```ts
journalTable: 'internal.sidder_journal'
```

## Two runs at once

The initial plan is a forecast based on one journal read. It is not authority to write:
two runs can read an empty journal at the same time.

Before each transactional seed, sidder:

1. opens the seed transaction;
2. tries a transaction-scoped advisory lock keyed by journal table and seed name;
3. if another run owns it, emits `waiting` and blocks;
4. re-reads that seed's journal row under the lock;
5. skips if a once-mode row appeared, otherwise runs and records the seed.

The journal upsert cannot by itself prevent duplicate work; it would merely hide it after
both seeds ran. The lock and re-read prevent the second application.

Locks are per seed, not one connection for the whole run. Independent seeds in unrelated
runs do not block one another. A single sidder invocation still processes seeds
sequentially.

## Exceptions

### `transaction: false`

There is no transaction in which to hold an advisory transaction lock. sidder re-reads
the journal immediately before running, but two simultaneous arrivals can both apply the
seed. Failures may leave seed writes without a journal row.

### `mode: 'always'`

Both concurrent runs are supposed to apply it. They take the lock and serialize rather
than deduplicate.

## Orphans and renames

An orphan is a journal row with no discovered seed of the same name. The common cause is
renaming a file whose seed had no explicit `name`.

`status` reports orphans. Remove one with:

```bash
npx sidder forget old-name
```

Then decide whether the renamed seed should run as new work. There is no automatic rename
because sidder cannot know whether a missing name is a rename, removal or intentionally
retired seed.

## No reset

Deleting a journal row does not reverse database writes. sidder has no `down` or `reset`
contract because arbitrary seed code has no general inverse.
