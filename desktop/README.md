# RDS Desktop

Off-platform (Electron/macOS) orchestrator for the Rev Data Seeder — cross-org Salesforce CPQ /
sales data migration without Apex governor limits. See the root [README.md](../README.md) for what
the tool does, the prerequisites and the install steps, and [CHANGELOG.md](../CHANGELOG.md) for
how it has evolved.

## Stack

Electron 44 + electron-vite + TypeScript + React · `@jsforce/jsforce-node` · better-sqlite3 (WAL) ·
vitest. One Salesforce API version for every call, declared in `src/shared/apiVersion.ts`
(`API_VERSION`) and shown on the app's Settings and How To pages; `test/apiVersion.test.ts` fails if
a literal version path reappears elsewhere.

## Ground rules (enforced in code, not just docs)

- **Source orgs are read-only.** The transport layer (`src/main/services/salesforce.ts`) refuses any
  write unless the connection role is exactly `target`.
- **A production org is pinned read-only.** The pin is a **runtime setting** edited on the
  Connections page (`src/shared/prodPin.ts`; stored as `settings.pref.prodOrgIdPrefix`); its default
  is the compiled `PROD_ORG_ID_PREFIX` in `src/shared/types.ts`. A connection whose Org Id starts
  with the pinned prefix reports its role as `source`, can never be assigned `target`, and the write
  gate re-checks the minted org id against the pin on every write. Paste your own production Org Id
  there — no rebuild needed.
- **Auth is CLI-delegated.** The app lists the orgs you have authenticated in `sf`, mints access
  tokens on demand, and holds them in memory only. No credentials are stored by the app. OAuth is
  optional and needs your own External Client App (`docs/OAUTH_APP_RUNBOOK.md`).

## Commands

```bash
npm ci                    # deps (better-sqlite3 prebuilt for system Node)
npm run smoke             # live smoke against a dev org (RDS_SMOKE_ALIAS): CLI auth → store → guardrail → describes → SOQL
npm test                  # vitest (pure-logic engine + UI suites; no native deps)
npm run test:store        # vitest sqlite suites (needs the Node ABI — see below)
npm run typecheck
npm run lint
npm run scan:secrets      # publishability scan (also runs as the pre-commit hook and first in CI)
npm run rebuild:electron  # switch better-sqlite3 to the Electron ABI (required before `npm run dev`)
npm run dev               # launch the app (electron-vite dev)
npm run rebuild:node      # switch better-sqlite3 back for smoke/tests under system Node
```

**npm ≥ 11.19** withholds dependency install scripts until you approve them: after a fresh `npm ci`
there is no Electron binary and no esbuild / better-sqlite3 prebuild. Run
`npm install-scripts approve electron esbuild better-sqlite3` once (or `node node_modules/electron/install.js`
for Electron alone), then `npm ci` again. Node 22+ (`.nvmrc`).

The better-sqlite3 ABI dance (Electron vs system Node) is the standard native-module tradeoff —
`rebuild:electron` before running the app, `rebuild:node` before `npm run smoke` or `test:store`.
The pure vitest suites are unaffected. **Note:** `npm run package` / `package:dmg` also rebuild
better-sqlite3 for Electron in-place — run `rebuild:node` afterwards if you need smoke or store tests.

## Packaging

```bash
npm run package           # app bundle only → release/mac-universal/RDS Desktop.app (fast; for testing)
npm run package:dmg       # + DMG installer → release/RDS Desktop-<version>-universal.dmg
```

Builds are **universal (arm64 + x64)** since 0.4.0 (`electron-builder.yml`); minimum macOS 13.
Bundle id: `com.launchdarkly.rds-desktop`.

`scripts/afterPack.cjs` flips Electron fuses (RunAsNode / NODE_OPTIONS / --inspect OFF, asar-only +
asar-integrity ON) for every build, then does one of two things:

| Identity | When | Who signs |
|---|---|---|
| **Ad-hoc** (default) | `CSC_LINK` unset; `mac.identity: null` | The hook re-signs the bundle inside-out with the hardened runtime and `build/entitlements.mac.plist` (read from `mac.entitlements`). Not notarized: first open on macOS 15/26 is System Settings → Privacy & Security → **Open Anyway** (the right-click → Open bypass is gone). |
| **Developer ID** | `CSC_LINK` + `CSC_KEY_PASSWORD` set; `--config electron-builder.release.yml` | The hook stops after the fuses. electron-builder signs every nested component with the same `hardenedRuntime` + entitlements and notarizes with `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`. |

`.github/workflows/release.yml` runs the lanes, builds whichever identity the repository secrets
allow, verifies the bundle (`codesign --verify`, entitlements, `lipo`, fuses) and uploads the DMG
plus `SHA256SUMS.txt` to the GitHub Release for the tag.

## Releasing

1. **Before tagging** — all lanes green (`scan:secrets`, `lint`, `typecheck`, `test`,
   `rebuild:node && test:store`); `package.json` version bumped; the CHANGELOG section dated;
   `npm run package:dmg` built locally and the result **installed over the previous build and run
   live** against a sandbox (the app's own validation vehicle — keyed and keyless paths, a template
   stage, cancel + restore). Record anything shipped unproven in the CHANGELOG.
2. **Bundle checks** on the local DMG: `codesign --verify --deep --strict` passes; `lipo -archs`
   shows `x86_64 arm64`; `npx @electron/fuses read --app "release/mac-universal/RDS Desktop.app"`
   shows RunAsNode / NodeOptions / NodeCliInspect off and OnlyLoadAppFromAsar / AsarIntegrity on;
   `shasum -a 256` of the DMG noted for the Release page.
3. **Tag and release** (`git tag vX.Y.Z && git push --tags`, `gh release create vX.Y.Z`). The
   workflow attaches the DMG; or upload the local DMG by hand and compare the hash.
4. **The Release page** carries, every time: the DMG name and SHA-256; **macOS 13+, Apple Silicon or
   Intel**; **Salesforce CLI `sf` 2.136+** and `sf org login web -a <alias>`; the **Open Anyway**
   steps (unless notarized); the one-line "what it changes on a target" (External Id field +
   permission set in keyed mode; automation disabled then restored; CPQ *Triggers Disabled* is
   yours to tick); where the database lives (`~/Library/Application Support/rds-desktop/`); and a
   link to the CHANGELOG section.
5. **After** — download the DMG from the Release on a second Mac and walk the Open Anyway path once;
   confirm the version on the app's Settings page; `npm run rebuild:node` locally so the store
   tests work again.

## Layout

```
src/shared/       types, field/mapping policy, API version, prod pin, IPC contract (dependency-free)
src/main/         Electron main: window, IPC
  services/       sfcli (CLI auth bridge) · salesforce (guarded client) · store (SQLite, migrations)
                  deployIo / deployStore (run ledger) · templateStore
  engine/         analysis, dependency resolution, junction detection
    deploy/       the deploy engine: first/second pass, retry, junction path, text-Id relink
    templates/    data-seed and post-refresh templates (seed planner, automation apply)
src/preload/      contextBridge → window.rds
src/renderer/     React UI: connections, the New Deployment wizard, Deployments, Templates, Settings
scripts/          smoke / parity scripts, secret scan, afterPack (fuses + signing)
test/             vitest suites (pure under test/, UI under test/ui/, sqlite under test/integration/)
build/            app icon, entitlements
```

## Publishability

Every tracked file must be safe to publish: no credentials, no customer names, no record ids or
usernames from a real org, no internal documents. `npm run scan:secrets` enforces the credential
shapes and the known org-specific identifiers; the pre-commit hook (`npm run hooks:install`) runs
it on staged files. Internal working documents live outside the tracked tree (see `.gitignore`).
The default production pin is the one deliberate real identifier (allow-listed in the scanner): it
is a read-only guard, not a secret, and a runtime setting replaces it.

## Porting notes

The engine began as a fidelity port of a now-frozen Apex implementation of the same seeder, with
its test fixtures translated to vitest. The Apex is advisory, not parity: where the two differ, the
divergence is documented in the file header of the TypeScript module.
