# RDS Desktop — Rev Data Seeder

An Electron desktop app that orchestrates cross-org Salesforce CPQ / sales data
migration: connect a source and a target org, scope an account graph, freeze a
plan, and deploy with automation suppression and restore. Built at LaunchDarkly
for seeding sandboxes with realistic CPQ data; published as-is for other
Salesforce teams with the same problem.

**The app lives in [`desktop/`](desktop/).** This repo root holds the changelog,
the CI workflow and a platform knowledge base.

## What it does

- **Deployments:** pick a source and a target org (authenticated in the `sf`
  CLI), choose the accounts and objects to copy, review a frozen plan, and run.
  The engine walks the object graph in dependency order, remaps every lookup,
  relinks the CPQ text fields that hold record ids, disables and restores
  target automation around the run, and reports every row it could not land
  with a reason.
- **Keyed or keyless.** With an External Id field on the target, reruns are
  idempotent upserts. Without one, the app keeps a local id map per target org.
- **Templates:** reusable data-seed and post-refresh templates (which flows and
  triggers to deactivate, which configuration rows to seed) that can run on
  their own or as stages before and after a deployment.
- **Read-only source, pinned production.** The source org is never written to,
  and a production org can be pinned so it can never become a target.

## Quick start

```bash
cd desktop
npm ci
npm run rebuild:electron   # native better-sqlite3 for the Electron ABI
npm run dev
```

## Verification lanes

| Command | Expected |
|---|---|
| `npm run scan:secrets` | clean |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm test` | pure-logic suites (about 1,700 tests) |
| `npm run rebuild:node && npm run test:store` | sqlite suites (about 160 tests) |

The two ABI lanes are mutually exclusive: run `rebuild:node` before
`test:store`, and `rebuild:electron` before `dev`. `npm run package:dmg`
forces an Electron rebuild, so `test:store` reports bogus failures until you
rebuild for node again.

## Packaging

`npm run package:dmg` produces an **arm64-only, ad-hoc-signed, un-notarized**
DMG in `desktop/release/`. It is for internal distribution: first open on
another Mac requires right-click → Open, and it will not run on Intel.

## Where to start reading

- [`desktop/README.md`](desktop/README.md) — stack, layout, how to build and test
- [`CHANGELOG.md`](CHANGELOG.md) — what each release changed and why
- [`desktop/docs/OAUTH_APP_RUNBOOK.md`](desktop/docs/OAUTH_APP_RUNBOOK.md) — setting up an OAuth External Client App

## Publishability

Every tracked file is meant to be safe to publish. The changelog and code
comments refer to the sandboxes the engine was proven on by neutral aliases
(`srcbox_*` for the source, `tgt_*` and `sb*` for targets), and record ids in
fixtures are synthetic. `npm run scan:secrets` checks credential shapes and the
org-specific identifiers on every commit.

## History

Extracted 2026-09-07 from an internal repository that also contained a now-frozen
Salesforce 2GP Apex implementation of the same engine. The pre-extraction history
is not public; this repository starts from the desktop app.
