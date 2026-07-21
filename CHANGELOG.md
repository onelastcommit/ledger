# Changelog

All notable changes to `@1percentlabs/ledger` are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — with
the caveat that while on 0.x, minor versions may contain breaking changes.

## [Unreleased]

Nothing yet.

## [0.1.3] — 2026-07-21

### Added

- `ledger.entity(...).readStream()` returns a discriminated union, so switching
  on `type` narrows `payload`. `StoredEventOf<Payloads>` is exported for naming
  it directly. Note that this is an assertion rather than a check: the event type
  is enforced by the state machine at append time, but nothing validates a stored
  payload against the declared shape, so rows written before a payload changed
  are typed as the new shape. Branch on `payloadVersion` where a shape has
  evolved. `ledger.readStream()` and the `tx` path are unchanged and still return
  `StoredEvent<unknown>`.

## [0.1.2] — 2026-07-21

### Added

- Four type helpers for reading types back out of an entity definition:
  `EventsOf<D>` (the discriminated union `append` accepts), `EventTypeOf<D>`
  (the event names), `PayloadOf<D, K>` (one event's payload) and `PayloadsOf<D>`
  (the whole map). Each accepts either the definition or the `ledger.entity()`
  handle. This replaces `Parameters<typeof orders.append>[1]['events'][number]`,
  which worked but read badly. Type-level only, no runtime change.

## [0.1.1] — 2026-07-21

### Added

- Event payloads can be typed. `payloadOf<T>()` marks a transition's payload type,
  `defineEntity` infers a payload map from it, and `ledger.entity(definition)`
  returns a facade whose `append` checks each event against it. A missing field,
  a wrong type, a payload from a different event, or an undeclared event name are
  now compile errors. Purely type-level: the marker erases at runtime and adds no
  dependency. Fully additive — events without a marker stay `unknown`, and
  `tx.append({ streamType, ... })` is unchanged.

### Fixed

- `ledger.close()` now stops every subscription it created. Previously it closed
  the shared listener but left subscription loops polling the database
  indefinitely, so forgetting to stop them individually leaked a query loop.

## [0.1.0] — 2026-07-21

First release. An append-only event log on plain PostgreSQL with first-class
provenance, per-entity state machines validated inside the append transaction,
per-stream hash chaining, inline projections and catch-up subscriptions.

### Core

- `createLedger({ pool, entities, projections })` runs in-process on a caller's
  `pg.Pool`. Appends join the caller's transaction, so read models commit
  atomically with the events that produced them.
- `expectedSeq` is mandatory on append, enforced by `UNIQUE (stream_id, seq)`
  rather than by locking, so optimistic concurrency holds regardless of
  isolation level or code path.
- State machines are validated at write time. An illegal transition is not
  reported after the fact; it cannot be persisted. Stream types with no
  definition behave as pure logs.
- Every event is hash-chained — `sha256(prevHash + canonical(event))` — making
  the log tamper-evident. `verifyStream` reports the first divergent seq.
- Provenance is structural: `actor` (who), `source` (whence), and `occurredAt`
  (business time) as distinct from `recordedAt` (audit time).

### Consumption

- Inline projections run inside the append transaction; a failure rolls the
  append back.
- Catch-up subscriptions hold a durable cursor in `ledger_subscriptions`, woken
  promptly by `LISTEN`/`NOTIFY` but correct on polling alone. At-least-once
  delivery, so handlers must be idempotent.
- Handlers retry with exponential backoff and full jitter, then dead-letter to
  `ledger_subscription_failures` and move on. `deadLetterPolicy: 'stop'` halts at
  the offending event instead. Nothing is lost either way — the event remains in
  the log and replays by rewinding the cursor.
- All subscriptions on a ledger share one `LISTEN` connection, which reconnects
  with backoff. Pool size need not scale with subscription count.
- `singleRunner: true` takes a Postgres advisory lock so only one runner per
  subscription name is active, with automatic handover. Off by default, since
  duplicates are already expected under at-least-once delivery.
- `subscription.status()` reports `position`, `headPosition`, `lag`, `active` and
  `deadLettered`. `lag` is an exact count of pending events rather than position
  arithmetic, so it stays accurate when stream types interleave.

### Reading and recovery

- `readStream` accepts `afterSeq` and `limit`; `verifyStream` walks the chain in
  batches. Neither loads an entire stream into memory.
- `iterateAll` and `iterateStream` are async generators yielding batches, for
  walking more than fits in memory.
- `rebuildStream` and `rebuildAllStreams` recompute the `ledger_streams` cache by
  replaying the log. The cache was always derivable in principle; these make it
  recoverable in practice.
- Appends larger than one statement can bind are chunked within the same
  transaction, so Postgres's 65,535 bind-parameter limit is not a cap on batch
  size.

### Notes

- Runtime dependencies: `pg` only. Node >= 24, PostgreSQL >= 14, ESM only.
- Published without provenance attestation; the first release predated trusted
  publishing being configurable for the package.
