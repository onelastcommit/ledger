# @ahmadalmezaal/ledger

> **0.x — the API is not yet stable.** Minor versions may break things until 1.0.

An append-only event store for PostgreSQL with first-class **provenance** — every event records who caused it, when it happened, and where it came from — and optional **per-entity state machines** validated at write time. It runs in your process, on your `pg.Pool`, inside your transaction, so your read models commit atomically with the events that produced them.

It is a library, not a server: no broker, no daemon, no domain opinions. The event log itself is the durable queue.

- **Runtime dependencies:** `pg`, and nothing else.
- **Requires:** Node >= 22, PostgreSQL >= 14. ESM only.

## Install

```bash
pnpm add @ahmadalmezaal/ledger pg
```

## Quick start

An order lifecycle: `placed → paid → shipped`, with cancellation allowed until it ships.

```ts
import pg from 'pg';
import { createLedger, defineEntity, type Projection } from '@ahmadalmezaal/ledger';

const order = defineEntity({
  streamType: 'order',
  initial: 'placed',
  states: ['placed', 'paid', 'shipped', 'cancelled'],
  events: {
    OrderPlaced:    { from: [null],             to: 'placed' },
    OrderPaid:      { from: ['placed'],         to: 'paid' },
    OrderShipped:   { from: ['paid'],           to: 'shipped',   terminal: true },
    OrderCancelled: { from: ['placed', 'paid'], to: 'cancelled', terminal: true },
  },
});

const orderSummary: Projection = {
  name: 'order-summary',
  handles: ['OrderPlaced', 'OrderPaid', 'OrderShipped', 'OrderCancelled'],
  async apply(tx, event) {
    await tx.client.query(
      `INSERT INTO order_summary (order_id, status)
       VALUES ($1, $2)
       ON CONFLICT (order_id) DO UPDATE SET status = EXCLUDED.status`,
      [event.streamId, event.type],
    );
  },
};

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ledger = createLedger({ pool, entities: [order], projections: [orderSummary] });

await ledger.migrate();

await pool.query(
  'CREATE TABLE IF NOT EXISTS order_summary (order_id TEXT PRIMARY KEY, status TEXT NOT NULL)',
);

const orderId = 'order:1001';

await ledger.withTransaction(async (tx) => {
  await tx.append({
    streamId: orderId,
    streamType: 'order',
    expectedSeq: 0,
    events: [
      {
        type: 'OrderPlaced',
        payload: { total: 4999, currency: 'GBP' },
        actor: { kind: 'user', id: 'customer-42', role: 'buyer' },
        source: { channel: 'web-checkout' },
      },
    ],
  });
});

await ledger.withTransaction(async (tx) => {
  const { seq } = await tx.getState(orderId);
  await tx.append({
    streamId: orderId,
    streamType: 'order',
    expectedSeq: seq,
    events: [
      {
        type: 'OrderPaid',
        payload: { method: 'card' },
        actor: { kind: 'service', id: 'payments' },
      },
    ],
  });
});

console.log(await ledger.getState(orderId));      // { state: 'paid', seq: 2 }
console.log(await ledger.verifyStream(orderId));  // { valid: true }

// Shipping before payment is not merely discouraged — it cannot be persisted.
await ledger.withTransaction((tx) =>
  tx.append({
    streamId: 'order:1002',
    streamType: 'order',
    expectedSeq: 0,
    events: [
      { type: 'OrderShipped', payload: {}, actor: { kind: 'system' } },
    ],
  }),
); // throws InvalidTransitionError, rolls back
```

## API

### `createLedger(config)`

| Option | Type | Notes |
| --- | --- | --- |
| `pool` | `pg.Pool` | Required. The library never creates or closes it. |
| `entities` | `EntityDefinition[]` | Optional. Stream types absent here are pure logs. |
| `projections` | `Projection[]` | Optional. Run inside the append transaction. |
| `notifyChannel` | `string` | Optional. Defaults to `ledger_events`. |

### `ledger.migrate()`

Applies pending migrations, recording them in `ledger_migrations` under an advisory lock. Idempotent and safe to call from several processes at boot.

### `ledger.withTransaction(fn)`

Opens a transaction, hands you a `LedgerTransaction`, then commits — or rolls back if `fn` throws.

```ts
interface LedgerTransaction {
  client: pg.PoolClient;                                  // run whatever SQL you like
  append(params): Promise<StoredEvent[]>;
  readStream(streamId): Promise<StoredEvent[]>;
  getState(streamId): Promise<StreamState>;
}
```

### `ledger.append(client, params)`

For when you already own the transaction. `client` must be inside a `BEGIN`; rolling back on failure is yours to do.

```ts
await ledger.append(client, {
  streamId: 'order:1001',
  streamType: 'order',
  expectedSeq: 2,        // the last seq you saw; 0 for a new stream
  events: [ /* EventInput[] */ ],
});
```

`expectedSeq` is mandatory. A mismatch throws `VersionConflictError`. Multiple events in one call are atomic, receive consecutive seqs, and are validated against the state machine in array order.

### `ledger.readStream(streamId, options?)`

Every event in the stream, in `seq` order. Returns `[]` for an unknown stream. Pass `{ client }` to read inside an open transaction.

### `ledger.readAll(options?)`

Pages the global log by `globalPosition`.

```ts
await ledger.readAll({ afterGlobalPosition: 0, streamTypes: ['order'], limit: 500 });
```

### `ledger.getState(streamId, options?)`

`{ state, seq }`. `state` is `null` for stream types with no entity definition. Throws `StreamNotFoundError` if the stream does not exist.

### `ledger.verifyStream(streamId)`

Recomputes the hash chain from seq 1 and returns `{ valid: true }` or `{ valid: false, firstBadSeq }`.

### `ledger.subscribe(options)`

A durable catch-up consumer.

```ts
const subscription = ledger.subscribe({
  name: 'search-indexer',        // the cursor is stored under this name
  streamTypes: ['order'],
  batchSize: 100,
  pollIntervalMs: 1000,
  startPosition: 0,              // only used the first time this name is seen
  onEvent: async (event) => { /* must be idempotent */ },
  onError: (error) => logger.error(error),
});

await subscription.caughtUp();   // resolves once the backlog is drained
subscription.position();         // last committed cursor
await subscription.stop();
```

### Event shape

```ts
interface EventInput<P = unknown> {
  type: string;
  payload: P;                    // must be JSON-serialisable
  actor: Actor;                  // provenance: who
  source?: SourceRef;            // provenance: whence — opaque to the library
  occurredAt?: string;           // business time, ISO 8601; defaults to now
  payloadVersion?: number;       // opaque passthrough
}

type Actor =
  | { kind: 'user'; id: string; role?: string }
  | { kind: 'service'; id: string }
  | { kind: 'ai'; model: string; version?: string }
  | { kind: 'system' };
```

A `StoredEvent` adds `id` (ULID), `streamId`, `streamType`, `seq`, `globalPosition`, `recordedAt` and `hash`.

### Errors

All extend `LedgerError`: `VersionConflictError` (carries `expectedSeq`, `actualSeq`), `InvalidTransitionError` (carries `currentState`, `eventType`), `UnknownEventTypeError`, `StreamNotFoundError`, `HashChainBrokenError`, `InvalidEntityDefinitionError`, `ProjectionFailedError` (original error on `cause`).

## Schema

Three tables. `ledger_events` is the log; the other two are derivable from it.

| Table | Purpose |
| --- | --- |
| `ledger_events` | The append-only log. `UNIQUE (stream_id, seq)` enforces concurrency. |
| `ledger_streams` | Cache of each stream's `last_seq`, `state` and `last_hash`. |
| `ledger_subscriptions` | One durable cursor per subscriber name. |

## Design decisions

**The transaction belongs to the caller.** An event store that opens its own transaction forces you into two-phase thinking: write the event, then update the read model, then reconcile when the second half fails. Here the append joins *your* transaction, so your read models and your events commit or fail together. `withTransaction` is a convenience; `append(client, …)` is the honest interface.

**`occurredAt` vs `recordedAt`.** When something happened and when the database learned of it are different facts, and conflating them makes backfills and late-arriving data unanalysable. `occurredAt` is business time and is yours to set; `recordedAt` is audit time, set by the database. Only `occurredAt` is part of the hash.

**Optimistic concurrency, enforced by a constraint.** `expectedSeq` is mandatory rather than optional, because a default of "just append" is a race waiting to happen. The check is backed by `UNIQUE (stream_id, seq)`, not by `SELECT … FOR UPDATE`: a lock you forgot to take protects nothing, whereas a constraint holds regardless of isolation level or code path.

**State machines validated at write time.** Deriving state by folding events is standard; validating the fold *inside the append transaction* means an illegal transition is not something to detect later, it is something that cannot be stored. Stream types without a definition skip validation entirely — not everything is a state machine, and a pure audit log is a legitimate use.

**Hash chaining.** `hash = sha256(prevHash + canonical(event))` over the immutable fields. It does not prevent tampering — anyone with `UPDATE` can rewrite a row — but it makes tampering *evident*, and `verifyStream` names the first divergent seq. Canonicalisation sorts object keys recursively and refuses values JSON would silently corrupt (`NaN`, `Infinity`, `bigint`), because a hash that quietly changes meaning is worse than no hash.

**No queues.** An outbox table plus a relay plus a broker is three systems to keep consistent. The log is already durable, already ordered, and already has positions — so a subscriber is just a name and a cursor. If you need to fan out to SQS or Kafka, write a subscriber that does exactly that; it lives in your application, not in here.

**At-least-once delivery.** Cursors advance *after* a batch is handled, so a crash mid-batch replays it. Handlers must be idempotent — key writes on `event.id`, or use `ON CONFLICT DO NOTHING`. Exactly-once would mean committing the cursor in the same transaction as the side effect, which is impossible when the side effect is an HTTP call. `LISTEN`/`NOTIFY` only wakes the poller early; correctness never depends on a notification arriving.

**No event upcasting.** `payloadVersion` is stored and returned untouched, and that is the whole feature. Version your payloads by branching on it in your own code, or by writing a new event type. A framework for rewriting history on read is a large amount of machinery pointed at the one thing this library is built to make impossible.

## Notes and limits

- **Payloads must be JSON-serialisable.** They are stored as `jsonb` and canonicalised for hashing.
- **`globalPosition` is a `BIGSERIAL` read into a JavaScript number.** Exact below 2^53; beyond roughly nine quadrillion events you would need a `bigint`.
- **The events table is append-only.** Nothing in this library issues `UPDATE` or `DELETE` against it. To have the database enforce that, `REVOKE UPDATE, DELETE, TRUNCATE ON ledger_events` from your application role — see the comment at the top of `001_init.sql`.

## Internal structure

Layered, with all SQL confined to the repository tier.

```
src/
  ledger.ts            composition root — wires repositories into services
  domain/              pure logic: fsm, hash chaining, ulid (no database, no clock)
  repositories/        every SQL statement in the library lives here
  services/            append, stream reading, verification, projections, subscriptions, migrations
  *.types.ts           type declarations, co-located with what they describe
```

Services take their collaborators through the constructor, so each is testable
against a fake repository. Wiring happens once, in `createLedger`.

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test              # unit, then integration
pnpm test:unit         # no database needed
pnpm test:integration  # Docker (testcontainers), or DATABASE_URL
```

Integration tests provision `postgres:16-alpine` via testcontainers. Without Docker, set `DATABASE_URL` to point at a scratch database — it is `TRUNCATE`d between tests. With neither, they skip with an explanatory message rather than failing.

Use the Node version in `.nvmrc` (24 LTS) — `nvm use`. The package itself supports Node 22 and above.

## Licence

MIT
