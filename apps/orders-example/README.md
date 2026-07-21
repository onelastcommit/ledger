# orders-example

A worked example of consuming `@1percentlabs/ledger` from an application: an
order lifecycle of `placed → paid → shipped`, with cancellation allowed until it
ships.

It demonstrates the four things you will actually write:

| File | Shows |
| --- | --- |
| `src/ledger.ts` | Wiring the pool, entity definition and inline projection once, at startup. |
| `src/orders.service.ts` | Appending with `expectedSeq` and retrying on `VersionConflictError`. |
| `src/main.ts` | The read model committing atomically, the audit trail, hash verification, a rejected illegal transition, and a subscription used for fan-out. |

This app is a member of the workspace, so `pnpm -r typecheck` compiles it
against the library on every CI run — it cannot drift out of date.

## Running it

```bash
docker run -d --rm --name ledger-example \
  -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=orders \
  -p 5432:5432 postgres:16

pnpm --filter orders-example start
```

Expected output:

```
state        { state: 'shipped', seq: 3 }
read model   { status: 'OrderShipped', updated_seq: 3 }
audit trail
   seq 1  OrderPlaced    by user customer-42         at 2026-07-21T07:04:16.047Z
   seq 2  OrderPaid      by service payments-worker  at 2026-07-21T07:04:16.051Z
   seq 3  OrderShipped   by service warehouse        at 2026-07-21T07:04:16.053Z
tamper check { valid: true }
re-ship      InvalidTransitionError -> true
subscriber   notified for 1 shipment(s): [ 'order:1784617456046' ]
```

Requires `DATABASE_URL`; defaults are read from the environment.
