# RDS Desktop

Off-platform (Electron/macOS) orchestrator for the Rev Data Seeder — cross-org CPQ/sales data
migration without Apex governor limits. See the root [README.md](../README.md) for what the tool
does and [CHANGELOG.md](../CHANGELOG.md) for how it has evolved.

## Stack

Electron + electron-vite + TypeScript + React · `@jsforce/jsforce-node` (API pinned **v66.0**) ·
better-sqlite3 (WAL) · vitest

## Ground rules (enforced in code, not just docs)

- **Source orgs are read-only.** The transport layer (`src/main/services/salesforce.ts`) refuses any
  write unless the connection role is exactly `target`.
- **LaunchDarkly production (00D41000000UvVn) is permanently read-only** — pinned at the store layer
  AND re-checked at the write gate; it can never be assigned the `target` role.
- Auth today is **CLI-delegated** (orgs you've authenticated in `sf`; tokens minted on demand via
  `sf org display`, held in memory only). The ECA (PKCE + JWT Bearer) path is Epic 1.4/1.5.

## Commands

```bash
npm install               # deps (better-sqlite3 prebuilt for system Node)
npm run smoke             # live smoke vs ldseed: CLI auth → store → guardrail → describes → SOQL
npm test                  # vitest (pure-logic engine tests; no native deps)
npm run typecheck
npm run rebuild:electron  # switch better-sqlite3 to Electron ABI (required before `npm run dev`)
npm run dev               # launch the app (electron-vite dev)
npm run rebuild:node      # switch better-sqlite3 back for smoke/tests under system Node
```

The better-sqlite3 ABI dance (Electron vs system Node) is the standard native-module tradeoff —
`rebuild:electron` before running the app, `rebuild:node` before `npm run smoke`. Vitest suites are
pure-logic only and unaffected. **Note:** `npm run package`/`package:dmg` also rebuild better-sqlite3
for Electron in-place — run `rebuild:node` afterwards if you need smoke/parity.

## Packaging (A1/E7.1 — internal, ad-hoc signed)

```bash
npm run package           # app bundle only → release/mac-arm64/RDS Desktop.app (fast; for testing)
npm run package:dmg       # + DMG installer → release/
```

`scripts/afterPack.cjs` flips Electron fuses (RunAsNode/NODE_OPTIONS/--inspect OFF, asar-only +
asar-integrity ON) and re-signs the bundle inside-out, **ad-hoc with the hardened runtime**
(`--options runtime` plus `build/entitlements.mac.plist`). Decision 2026-07-23: no Apple Developer
account / no notarization — internal 5-user tool. On another Mac the first open is **right-click →
Open** (Gatekeeper); OAuth connections may need re-auth after app updates because the ad-hoc signing
identity isn't stable across builds. Bundle id: `com.launchdarkly.rds-desktop`.

**Apple Silicon only.** Builds are arm64-only (`electron-builder.yml`); Rosetta cannot run an
arm64 build on an Intel Mac. All target laptops are Apple Silicon; revisit universal builds only if
that changes.

## Layout

```
src/shared/       types + IPC contract (dependency-free)
src/main/         Electron main: window, IPC
  services/       sfcli (CLI auth bridge) · salesforce (guarded client) · store (SQLite) · describe
  engine/         Apex ports (pure logic): objectPolicy · dependencyResolver · junctionDetector
src/preload/      contextBridge → window.rds
src/renderer/     React UI (connections page; wizard comes with Epics 3–5)
scripts/          smoke-ldseed.ts (live verification)
test/             vitest suites
```

## Porting notes

Engine ports are **fidelity ports** of the Apex classes (`force-app/main/default/classes/…`) with the
Apex test fixtures translated to vitest — behavior parity first, redesign later. Deviations are
documented in each file's header.
