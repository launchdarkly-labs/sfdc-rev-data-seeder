# RDS Desktop — Rev Data Seeder

An Electron desktop app that orchestrates cross-org Salesforce CPQ/sales data
migration: connect a source and a target org, scope an account graph, freeze a
plan, and deploy with automation suppression and restore.

**The app lives in [`desktop/`](desktop/).** This repo root holds only project
documentation and the session handoff.

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
| `npm run typecheck` | clean |
| `npm test` | 1,317 pure-logic tests |
| `npm run rebuild:node && npm run test:store` | 115 sqlite tests |
| `npm run lint` | one known `WizardShell.tsx` `react-hooks/refs` error |

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
- [`desktop/docs/OAUTH_APP_RUNBOOK.md`](desktop/docs/OAUTH_APP_RUNBOOK.md) — setting up the OAuth External Client App

## History

Extracted 2026-09-07 from an internal repository that also contained a now-frozen
Salesforce 2GP Apex implementation of the same engine. The pre-extraction history
is not public; this repository starts from the desktop app.
