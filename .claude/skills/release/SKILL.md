---
name: release
description: Cut a release of @onelastcommit/ledger to npm. Use when publishing a new version, bumping the version number, or preparing release notes. Covers the tag-and-version contract the CI workflow enforces.
---

# Releasing

Publishing is driven by a `v*` tag. `.github/workflows/release.yml` runs the
full suite, checks the tag matches `package.json`, then publishes with npm
provenance.

## Before you start

Publishing to npm is **irreversible** — a published version cannot be reused,
and unpublishing is restricted after 72 hours. Confirm with the user before
tagging. Never publish unprompted.

## Authentication

The package publishes under the `@onelastcommit` scope. Three routes, in order of
preference:

1. **Trusted publishing (OIDC).** Authorise the repository and workflow on the
   package's npm settings page; CI then publishes with no stored secret and gets
   provenance automatically. Configured per-package, so it can only be set up
   after the first publish.
2. **Granular access token** at
   `https://www.npmjs.com/settings/<user>/tokens/granular-access-tokens/new`,
   scoped to `@onelastcommit` with read/write on both packages and the
   organisation. Store as the `NPM_TOKEN` repository secret. This is what
   satisfies npm's 2FA requirement for automated publishing; classic Automation
   tokens also work but are being phased out.
3. **Local publish with an OTP** — `pnpm publish --otp=<code>`. Fine for a first
   release, but `publishConfig.provenance` is `true` and **provenance only works
   from CI**, so a local publish needs `--no-provenance` and produces no
   attestation.

### Reading the failures

npm returns the same `403` — "Two-factor authentication or granular access token
with bypass 2fa enabled is required" — for several distinct causes, so it proves
less than it appears to. It fires _before_ scope membership is checked, so it
does not confirm the scope exists.

Check in this order:

1. `npm profile get` — if `two-factor auth: disabled`, that is the cause.
   npm requires either 2FA on the account or a granular token created with 2FA
   bypass explicitly enabled. Neither a plain login session nor a granular token
   without that setting can publish.
2. `npm org ls <org>` — confirms the organisation exists and lists members.
   A genuine scope problem surfaces here, not in the publish error.
3. Token scope. A token generated _before_ an organisation existed cannot have
   been granted permission on it, because the scope was not yet offered in the
   picker. Regenerate after creating the org.

### The first publish is a special case

Trusted publishing is configured on a package's settings page, so it cannot be
set up before that package exists. The first release therefore has to go out via
2FA-and-OTP or a bypass-enabled token; only afterwards can OIDC take over.

pnpm attempts OIDC automatically and logs
`Skipped OIDC: ERR_PNPM_AUTH_TOKEN_EXCHANGE ... 404` when no trusted publisher is
configured, then falls back to `NODE_AUTH_TOKEN`. That warning is expected until
trusted publishing is set up, and is not itself the failure.

If the credential is missing, stop and say so rather than working around it.

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
   tar -tzf /tmp/onelastcommit-ledger-<version>.tgz
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
