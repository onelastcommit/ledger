---
name: add-migration
description: Add a database migration to the ledger package. Use when changing the Postgres schema — adding or altering a table, column, index or constraint used by @1percentlabs/ledger. Covers the registration step that is easy to miss and the append-only constraints on ledger_events.
---

# Adding a migration

Migrations are plain SQL files applied once each, in filename order, inside a
single transaction guarded by an advisory lock. `migrate()` is idempotent and is
expected to run on every process boot.

## Steps

1. **Create the file** at `packages/ledger/src/migrations/NNN_short_name.sql`,
   where `NNN` is the next zero-padded number. Look at the existing files first
   to continue the sequence.

2. **Register it** in `packages/ledger/src/migration-loader.ts`:

   ```ts
   export const MIGRATION_NAMES = ['001_init.sql', 'NNN_short_name.sql'] as const;
   ```

   This is the step people forget. A file that is not listed is never applied,
   and nothing warns you — the tests just fail confusingly later.

3. **Write idempotent DDL.** Use `CREATE TABLE IF NOT EXISTS`,
   `CREATE INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`. Migrations are
   recorded in `ledger_migrations` so they run once, but idempotent DDL keeps
   things recoverable if a run is interrupted.

4. **No comments in the SQL**, matching the rest of the codebase. The sole
   exception is the existing append-only contract block in `001_init.sql`.

5. **If you touched `ledger_events` or `ledger_streams`**, update
   `packages/ledger/src/repositories/columns.ts`. Column names are declared
   there once and the SELECT list, INSERT list and row types all derive from it.
   Adding a column to the map without handling it in `toStoredEvent` is a
   compile error, which is the intent.

6. **If you changed what `ledger_streams` caches**, update
   `MaintenanceService.rebuildStream` to compute the same values. Otherwise a
   rebuild silently disagrees with what appends write.

7. **Add an integration test.** `packages/ledger/test/integration/` — the
   harness truncates between tests, so add any new table to the `TRUNCATE` in
   `harness.ts`.

## Constraints

`ledger_events` is append-only. No migration may add an `UPDATE` or `DELETE`
path against it, and no library code may issue one. The only exceptions in the
repository are deliberate corruption tests.

Adding a column to `ledger_events` changes the bind-parameter arithmetic —
`MAX_EVENTS_PER_STATEMENT` in `event.repository.ts` recalculates automatically,
but the assertion in `resilience.test.ts` pins the current value and will need
updating.

## Verify

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test
```

Confirm the migration is idempotent by running the integration suite twice
against the same database — `migrate()` is called by every harness.
