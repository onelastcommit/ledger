# ledger

> **0.x — the API is not yet stable.**

A pnpm workspace containing **[`@ahmadalmezaal/ledger`](packages/ledger)** — a domain-agnostic, append-only event store for PostgreSQL with first-class provenance and per-entity state machines.

Start with **[the package README](packages/ledger/README.md)** for the quick start, API reference and design decisions.

## Layout

```
packages/ledger/   the library
apps/              reserved for a docs site
```

## Development

```bash
corepack enable
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Integration tests need Docker (testcontainers provisions `postgres:16-alpine`) or a `DATABASE_URL` pointing at a scratch database. Without either, they skip with an explanatory message.

## Licence

MIT — see [LICENCE](LICENCE).
