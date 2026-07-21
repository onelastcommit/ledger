# Changelog

All notable changes to `@1percentlabs/ledger` are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — with
the caveat that while on 0.x, minor versions may contain breaking changes.

## [Unreleased]

### Added

- Catch-up subscriptions retry failed handlers with exponential backoff and full
  jitter, then dead-letter to `ledger_subscription_failures` and move on. Set
  `deadLetterPolicy: 'stop'` to halt at the offending event instead. Previously a
  handler that always threw blocked its subscription forever.
- `singleRunner: true` takes a Postgres advisory lock so only one runner per
  subscription name is active, with automatic handover when the holder stops.
  Off by default; duplicates are already expected under at-least-once delivery.
- `ledger.close()` releases the shared notification listener.
- `readStream` accepts `afterSeq` and `limit`, and `verifyStream` walks the chain
  in batches, so neither loads an entire stream into memory.
- `ledger.rebuildStream()` and `ledger.rebuildAllStreams()` recompute the
  `ledger_streams` cache by replaying the log, reporting which rows disagreed.
  The cache was always described as derivable; now it is actually recoverable.
- `ledger.iterateAll()` and `ledger.iterateStream()` are async generators yielding
  batches, so the whole log can be walked without holding it in memory.
- `subscription.status()` reports `position`, `headPosition`, `lag`, `active` and
  `deadLettered`. `lag` is an exact count of pending events rather than position
  arithmetic, so it stays accurate when stream types interleave.
- `apps/orders-example`, a worked order-lifecycle app typechecked against the
  library on every CI run.
- Migration `002_subscription_failures.sql`.

### Changed

- **Renamed to `@1percentlabs/ledger`.** The GitHub remote is unchanged.
- Added `repository`, `homepage`, `bugs` and `publishConfig` metadata, required
  before a first publish and for provenance attestation.

- All subscriptions now share a single `LISTEN` connection, which reconnects with
  backoff on failure. Previously each subscription held a pooled client for its
  own listener, so N subscriptions permanently consumed N connections.
- Appends larger than one statement can bind are chunked automatically within the
  same transaction. Batches over 5,957 events previously failed with an opaque
  driver error on Postgres's 65,535 bind-parameter limit.
- Column names are declared once and the row types derived from them, so a rename
  is a compile error rather than a silent mismatch.
- Node 24 is now the minimum supported version, matching `.nvmrc` and CI.

## [0.1.0] — unreleased

Initial implementation: append-only event log with provenance, per-entity state
machines validated inside the append transaction, per-stream hash chaining,
inline projections and catch-up subscriptions.
