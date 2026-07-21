# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Current state

`@1percentlabs/ledger@0.1.1` is **published and live** on npm. Publishing goes
through **trusted publishing (OIDC)** — there is no `NPM_TOKEN` secret and there
should never be one again. Tag `vX.Y.Z` and the Release workflow does the rest.
174 tests (107 unit, 67 integration), CI green.

## What this is

`@1percentlabs/ledger` — a domain-agnostic, append-only event store on plain
PostgreSQL, with first-class provenance and per-entity state machines. It runs
in-process on the caller's `pg.Pool`, and the append joins the **caller's**
transaction so their read models commit atomically with the events.

It is a library. Not a server, not a framework, no message queues.

## House rules

These are non-negotiable and have been reiterated by the user:

- **No comments in the codebase.** None. Code should read on its own. The only
  exception is `src/migrations/001_init.sql`, whose append-only/REVOKE contract
  was explicitly required by the build spec. Do not add explanatory comments to
  TypeScript files — not even JSDoc. Put the explanation in the README instead.
- **British English** in all prose: comments, commit messages, PR descriptions,
  docs, README, user-facing copy. Code identifiers and third-party APIs keep
  their required spellings (`color`, `moduleResolution`, etc.).
- **Node 24.** `.nvmrc` pins 24, `engines` requires `>=24`, tsup targets
  `node24`, CI reads `node-version-file: .nvmrc`. Do not reintroduce Node 20/22.
- **Arrow functions only** (`func-style`). Class methods are fine; top-level
  `function` declarations are not.
- **No default exports** outside config files and `global-setup.ts`.
- **No enums.** Use string-literal unions or `as const` objects.
- **Conventional commits**, small and logical. Co-author trailer on every commit.
- **`pnpm lint` runs with `--max-warnings=0`.** Warnings fail the build.
- **Typed payloads are the headline API.** `payloadOf<T>()` on a transition,
  `defineEntity` infers the map, `ledger.entity(def)` gives a checked `append`.
  It is a phantom type that erases at runtime. Keep it that way — no runtime
  validation crept in, and that is deliberate.
- **Prettier owns formatting.** `.prettierrc.json` declares the style the code
  already used (single quotes, 100 columns). Never hand-format against it, and
  never argue with it in ESLint — `eslint-config-prettier` disables the
  overlapping rules. `pnpm format` fixes, `pnpm format:check` gates CI.

## Architecture

This is a pnpm workspace. The library is `packages/ledger/`; every `src/` path
below is relative to it. `apps/orders-example/` is the only other workspace.

```
packages/ledger/src/
  ledger.ts              composition root — wires repositories into services
  ledger.types.ts        Ledger, LedgerConfig, LedgerTransaction
  types.ts               public event envelope types
  entity.ts              ledger.entity(def) — the typed append handle
  entity.types.ts        EntityLedger, TypedEvent, EventsOf and friends
  errors.ts              LedgerError hierarchy
  migration-loader.ts    MUST stay at src root — see gotchas
  domain/                pure: fsm, hash, ulid. No database, no clock.
  repositories/          every SQL statement in the library
  services/              append, stream-reader, verification, projection,
                         subscription, notification-hub, migration, maintenance
  migrations/            001_init.sql, 002_subscription_failures.sql
```

Layering rule: **only `repositories/` writes SQL.** Services take collaborators
through the constructor and are wired once in `createLedger`. `domain/` is pure
and must stay that way — it is unit-testable without a database and that is the
point.

Types live in co-located `*.types.ts` files next to what they describe.

## Non-obvious things that will bite you

**`migration-loader.ts` must stay at `src/` root.** It resolves
`./migrations/${name}` against `import.meta.url`. tsup bundles everything into a
single `dist/index.js`, so at runtime `import.meta.url` is `dist/`. Only a module
that sits at the source root resolves correctly in _both_ dev (`src/migrations/`)
and bundled (`dist/migrations/`) layouts. Moving it into a subdirectory silently
breaks `migrate()` for installed consumers.

**Extensionless imports depend on `moduleResolution: "Bundler"`.** There is a
root `tsconfig.json` specifically so editors and tools discover a config that
says so. Under `NodeNext` every relative import fails to resolve, every symbol
becomes error-typed, and the editor lights up with hundreds of
`no-unsafe-assignment` errors. If that ever recurs, check that the root
`tsconfig.json` still exists and still says `Bundler` — the CLI can be green
while the editor is broken.

**`occurredAt` is normalised to millisecond ISO before hashing.** Postgres
returns `timestamptz` as a JS `Date`, which renders via `toISOString()`. If the
value were hashed as the caller typed it (`2024-01-01T00:00:00Z`), the read-back
form (`...T00:00:00.000Z`) would differ and `verifyStream` would report false
tampering on untouched rows. Do not remove `normaliseTimestamp`.

**Optimistic concurrency rests on `UNIQUE (stream_id, seq)`,** not on the
`SELECT` of the stream head. The read is an optimisation. Never replace the
constraint with locking. On a `23505` the transaction is already aborted, so the
true seq cannot be read — that is why `VersionConflictError.actualSeq` is
nullable.

**Appends over 5,957 events are chunked.** Postgres binds at most 65,535
parameters; the limit is derived in `event.repository.ts` as
`65535 / columns`. Do not hardcode it — if a column is added to
`ledger_events`, the constant recalculates itself.

**`ledger_streams` is a cache.** It is always derivable from the log. If you
change what it stores, update `MaintenanceService.rebuildStream` to match, or
rebuilds will silently produce different values from appends.

**`PayloadMarker<P>` is covariant, so the constraint must be
`TransitionDefinition<unknown>`, never `<never>`.** Using `<never>` silently
collapses every inferred payload to `never`, and vitest will not catch it because
vitest does not typecheck. The type tests are gated by `pnpm typecheck`, which
verifies each `@ts-expect-error` is genuinely needed — if you change the type
machinery, deliberately break one test and confirm tsc complains before trusting
a green run.

**`ledger.close()` stops every subscription it created**, then releases the hub.
Do not revert to closing only the hub: subscription loops kept polling forever.

**Advisory locks for `singleRunner` live on the NotificationHub's session.**
They release if that connection drops, which is intentional failover. Do not
move them to a per-subscription connection — that reintroduces the
connection-per-subscription problem the hub exists to solve.

## Testing

- `pnpm test:unit` — no database. Includes `append.service.test.ts`, which
  exercises the service against in-memory fakes in `test/unit/fakes.ts`. Prefer
  adding here first; it is instant.
- `pnpm test:integration` — real Postgres via testcontainers, falling back to
  `DATABASE_URL`, skipping gracefully with a clear message if neither exists.
- Integration tests `TRUNCATE` between tests, so `beforeEach(h.reset())` is
  mandatory and tests must not assume ambient data.
- The **only** `UPDATE`/`DELETE` against `ledger_events` anywhere in the repo are
  in corruption tests. Keep it that way; it is an acceptance criterion.

## Decisions already made — do not re-litigate

| Decision                                                | Why                                                                                                                                                                                                                              | Revisit when                                                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Raw SQL, no ORM                                         | Prisma owns the connection, which breaks the caller-owned-transaction guarantee the library exists to provide. It also cannot do `LISTEN`/`NOTIFY`.                                                                              | —                                                                                                     |
| **Kysely over Prisma if an abstraction is ever wanted** | Kysely can `.compile()` to `{ sql, parameters }` executed on _your_ client, so shared transactions survive. Evaluated and deferred: 5 tables, ~14 queries, and `repositories/columns.ts` already makes a rename a compile error. | The schema passes ~10 tables, or application code starts writing ad-hoc queries against these tables. |
| No zod                                                  | Payloads are deliberately opaque — that is what makes the library domain-agnostic. The only validation surface is entity definitions, already hand-checked at startup. Adding it costs the zero-dependency property.             | Consumers want to declare payload schemas per event type. That is a feature, not a refactor.          |
| No DI container (tsyringe et al.)                       | One composition root. `reflect-metadata` plus decorators to replace ~20 lines of explicit wiring in `createLedger`.                                                                                                              | Many composition roots, or runtime-swapped implementations.                                           |
| `singleRunner` defaults to **off**                      | Delivery is at-least-once, so handlers must be idempotent regardless; exclusivity is an optimisation that trades liveness for it. Defaulting it on would silently make consumers dormant during a listener blip.                 | —                                                                                                     |
| `deadLetterPolicy` defaults to `'skip'`                 | The event is never lost — it stays in `ledger_events` and the failure is recorded — so skipping is recoverable, whereas stopping blocks the consumer.                                                                            | —                                                                                                     |
| Runtime dependency: `pg` only                           | It is the library's headline property.                                                                                                                                                                                           | Only with the user's explicit agreement.                                                              |

## Workflows

```bash
nvm use && corepack enable && pnpm install
pnpm build         # ALWAYS FIRST. apps/orders-example resolves the library
                   # through its built types, so both lint and typecheck
                   # produce error-typed nonsense if dist/ is missing.
pnpm lint          # --max-warnings=0
pnpm typecheck
pnpm test          # unit, then integration
```

Integration tests need Docker, or `DATABASE_URL` pointing at a scratch database.

CI runs `lint`, `typecheck`, `test-unit` and `test-integration` as four
concurrent jobs, with shared setup in `.github/actions/setup` and Postgres only
in the integration job. The aggregate `ci` job is the one to require in branch
protection. `lint` and `typecheck` each run `pnpm build` first because
`apps/orders-example` resolves the library through its built types; the tests do
not, because they import from source.

Adding a migration and cutting a release each have a skill —
see `.claude/skills/`.

## Known gaps

- The `__payloads` phantom property is visible on the public `EntityDefinition`
  type. It works, but a branded unique symbol would be tidier. Note that
  `PayloadsOf` reads `__payloads` **structurally**, not through
  `D extends EntityDefinition<infer P>` — that form infers `P | undefined` off
  the optional property. If `__payloads` is ever rebranded, `PayloadsOf` is the
  thing that breaks, and it breaks silently into `never`.
- Typed reads on the entity facade are an **unchecked cast**, deliberately. The
  event type is enforced by the FSM at append time; the payload shape is not
  validated on the way out. `payloadVersion` is the trap — old rows type as the
  current shape. This was a considered trade (see README), not an oversight. Do
  not "fix" it by adding runtime validation; that costs the zero-dependency
  property. Reads via `ledger.readStream()` stay `StoredEvent<unknown>`.
- `apps/` holds only the example. The docs site remains a deliberate non-goal.
- No snapshotting, sagas, upcasting or multi-database support — all explicit
  non-goals from the original spec.
- `readAll` returns one batch bounded by `limit`; use `iterateAll` to walk the
  whole log without holding it in memory.
