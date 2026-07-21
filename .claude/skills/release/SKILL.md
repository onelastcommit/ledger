---
name: release
description: Cut a release of @ahmadalmezaal/ledger to npm. Use when publishing a new version, bumping the version number, or preparing release notes. Covers the tag-and-version contract the CI workflow enforces.
---

# Releasing

Publishing is driven by a `v*` tag. `.github/workflows/release.yml` runs the
full suite, checks the tag matches `package.json`, then publishes with npm
provenance.

## Before you start

Publishing to npm is **irreversible** — a published version cannot be reused,
and unpublishing is restricted after 72 hours. Confirm with the user before
tagging. Never publish unprompted.

Requires an `NPM_TOKEN` repository secret. If it is missing, stop and say so
rather than working around it.

## Steps

1. **Decide the version.** The package is `0.x`, so minor versions may contain
   breaking changes; say so plainly in the changelog rather than pretending
   otherwise. Breaking change on `0.x` → bump minor. Additive or fix → bump
   patch.

2. **Update `packages/ledger/package.json`** with the new version.

3. **Update `CHANGELOG.md`.** Move entries out of `[Unreleased]` into a section
   for the new version with today's date. Write in British English. Describe
   the user-visible effect and, for anything surprising, the reason — the
   existing entries set the tone.

4. **Verify locally.** All of it, not a subset:

   ```bash
   pnpm install && pnpm lint && pnpm build && pnpm typecheck && pnpm test
   ```

5. **Check what actually ships:**

   ```bash
   cd packages/ledger && pnpm pack --pack-destination /tmp
   tar -tzf /tmp/ahmadalmezaal-ledger-<version>.tgz
   ```

   `dist/migrations/*.sql` **must** be present. Without it `migrate()` fails for
   every installed consumer, and no test catches this because tests run from
   source.

6. **Commit, tag and push:**

   ```bash
   git commit -m "chore(release): v<version>"
   git tag v<version>
   git push origin main --tags
   ```

7. **Watch the workflow.** The version check fails the run if the tag and
   `package.json` disagree.

## Dry run

`workflow_dispatch` on the Release workflow packs and validates without
publishing. Use it to check the pipeline after changing it.

## After releasing

Verify the published artifact actually works, rather than trusting the green
tick — install it into a scratch directory and run something against a real
database. `apps/orders-example` is the ready-made subject.
