# RDS Desktop

Off-platform (Electron/macOS) orchestrator for the Rev Data Seeder — cross-org Salesforce CPQ /
sales data migration without Apex governor limits. See the root [README.md](../README.md) for what
the tool does and [CHANGELOG.md](../CHANGELOG.md) for how it has evolved.

## Stack

Electron + electron-vite + TypeScript + React · `@jsforce/jsforce-node` (API pinned **v66.0**) ·
better-sqlite3 (WAL) · vitest

## Ground rules (enforced in code, not just docs)

- **Source orgs are read-only.** The transport layer (`src/main/services/salesforce.ts`) refuses any
  write unless the connection role is exactly `target`.
- **A production org can be pinned permanently read-only** (`PROD_ORG_ID_PREFIX` in
  `src/shared/types.ts`). The pin is enforced at the store layer AND re-checked at the write gate;
  a pinned org can never be assigned the `target` role. Change the constant for your own org.
- **Auth is CLI-delegated.** The app lists the orgs you have authenticated in `sf`, mints access
  tokens on demand, and holds them in memory only. No credentials are stored by the app.

## Commands

```bash
npm install               # deps (better-sqlite3 prebuilt for system Node)
npm run smoke             # live smoke against a dev org (RDS_SMOKE_ALIAS): CLI auth → store → guardrail → describes → SOQL
npm test                  # vitest (pure-logic engine tests; no native deps)
npm run test:store        # vitest sqlite suites (needs the Node ABI — see below)
npm run typecheck
npm run lint
npm run scan:secrets      # publishability scan (also runs as the pre-commit hook and first in CI)
npm run rebuild:electron  # switch better-sqlite3 to the Electron ABI (required before `npm run dev`)
npm run dev               # launch the app (electron-vite dev)
npm run rebuild:node      # switch better-sqlite3 back for smoke/tests under system Node
```

The better-sqlite3 ABI dance (Electron vs system Node) is the standard native-module tradeoff —
`rebuild:electron` before running the app, `rebuild:node` before `npm run smoke` or `test:store`.
The pure vitest suites are unaffected. **Note:** `npm run package` / `package:dmg` also rebuild
better-sqlite3 for Electron in-place — run `rebuild:node` afterwards if you need smoke or store tests.

## Packaging (internal, ad-hoc signed)

```bash
npm run package           # app bundle only → release/mac-arm64/RDS Desktop.app (fast; for testing)
npm run package:dmg       # + DMG installer → release/
```

`scripts/afterPack.cjs` flips Electron fuses (RunAsNode / NODE_OPTIONS / --inspect OFF, asar-only +
asar-integrity ON) and re-signs the bundle inside-out, **ad-hoc with the hardened runtime**
(`--options runtime` plus `build/entitlements.mac.plist`). There is no Apple Developer account and
no notarization: this is an internal tool. On another Mac the first open is **right-click → Open**
(Gatekeeper). Bundle id: `com.launchdarkly.rds-desktop`.

**Apple Silicon only.** Builds are arm64-only (`electron-builder.yml`); Rosetta cannot run an
arm64 build on an Intel Mac.

## Layout

```
src/shared/       types, field/mapping policy, IPC contract (dependency-free)
src/main/         Electron main: window, IPC
  services/       sfcli (CLI auth bridge) · salesforce (guarded client) · store (SQLite, migrations)
                  deployIo / deployStore (run ledger) · templateStore
  engine/         analysis, dependency resolution, junction detection
    deploy/       the deploy engine: first/second pass, retry, junction path, text-Id relink
    templates/    data-seed and post-refresh templates (seed planner, automation apply)
src/preload/      contextBridge → window.rds
src/renderer/     React UI: connections, the New Deployment wizard, Deployments, Templates
scripts/          smoke / parity scripts, secret scan, afterPack signing
test/             vitest suites (pure under test/, sqlite under test/integration/)
```

## Publishability

Every tracked file must be safe to publish: no credentials, no customer names, no record ids or
usernames from a real org, no internal documents. `npm run scan:secrets` enforces the credential
shapes and the known org-specific identifiers; the pre-commit hook (`npm run hooks:install`) runs
it on staged files. Internal working documents live outside the tracked tree (see `.gitignore`).

## Porting notes

The engine began as a fidelity port of a now-frozen Apex implementation of the same seeder, with
its test fixtures translated to vitest. The Apex is advisory, not parity: where the two differ, the
divergence is documented in the file header of the TypeScript module.
