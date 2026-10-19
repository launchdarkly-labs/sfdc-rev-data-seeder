# RDS Desktop — Rev Data Seeder

An Electron desktop app that orchestrates cross-org Salesforce CPQ / sales data
migration: connect a source and a target org, scope an account graph, freeze a
plan, and deploy with automation suppression and restore. Built at LaunchDarkly
for seeding sandboxes with realistic CPQ data; published as-is for other
Salesforce teams with the same problem.

**The app lives in [`desktop/`](desktop/).** This repo root holds the changelog
and the CI / release workflows.

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
  and a production org is pinned so it can never become a target.

## Prerequisites

| | Requirement |
|---|---|
| **Mac** | Apple Silicon or Intel — the DMG is a universal build. |
| **macOS** | 13 (Ventura) or newer. |
| **Salesforce CLI** | `sf` **2.136 or newer** on your `PATH` ([install](https://developer.salesforce.com/tools/salesforcecli)). The app lists the orgs you have signed in to with the CLI and mints access tokens through it; it never stores a password. Sign in to each org once with `sf org login web -a <alias>`. CLI 2.150+ redacts tokens in `sf org display`; the app reads them with `sf org auth show-access-token`, so keep the CLI current (`sf update`). |
| **Org access** | A user in each org with API access. On a **target**, keyed mode also needs permission to create a custom field and a permission set (see *What the app changes on a target*). |
| **Salesforce API** | Both orgs must support the API version the build uses (shown on the app's Settings page; `desktop/src/shared/apiVersion.ts`). Any org on the current or previous two releases does. |

OAuth sign-in (instead of the CLI) is optional and needs **your own External
Client App** — see [the OAuth runbook](desktop/docs/OAUTH_APP_RUNBOOK.md). The
public DMG ships with no OAuth client; CLI sign-in works out of the box.

## Install

1. Download `RDS Desktop-<version>-universal.dmg` from the
   [Releases](../../releases) page, open it, and drag **RDS Desktop** to
   Applications.
2. The DMG is signed ad-hoc and **not notarized**, so macOS blocks the first
   launch. On **macOS 15 and 26** the old right-click → Open bypass is gone;
   instead:
   1. Double-click the app once. Dismiss the "cannot be opened" dialog.
   2. Open **System Settings → Privacy & Security**, scroll to *Security*, and
      click **Open Anyway** next to the RDS Desktop message.
   3. Confirm with Touch ID / your password, then open the app again.
   This is needed once per installed build. (A notarized build, when the
   release is signed with a Developer ID, opens without this step.)
3. Open **Connections**, click **Refresh from sf CLI**, and assign one org
   *source* and one *target*. The **How To** page inside the app is the
   operator guide.

### Where the data lives

Everything the app knows — connections, deployments, run ledgers, the keyless
id maps and templates — is one SQLite file:

```
~/Library/Application Support/rds-desktop/rds-desktop.db
```

(plus its `-wal` / `-shm` journal files while the app is open). Copy or delete
that folder to back up or reset the app. Nothing is sent anywhere except the
orgs you connect; there is no telemetry.

### What the app changes on a target org

- **Keyed mode (default):** the Readiness step creates the custom field
  `Data_Deployment_External_Id__c` (Text 255, External Id) on every in-scope
  object and a permission set `RDS_Deployment_Access` that grants read/edit on
  those fields, assigned to the deploying user. Both **stay** on the target
  after the run. **Keyless mode** creates no metadata; records are matched
  through the local id map instead, with the limits the app states.
- **Automation** (unmanaged triggers, flows, workflow rules, validation rules,
  and the CPQ guard settings) is disabled for the run and restored afterwards;
  every item is written to the local ledger before it is touched.
- **Salesforce CPQ:** the package's **Triggers Disabled** checkbox (Setup →
  Installed Packages → Salesforce CPQ → Configure → Additional Settings) is a
  protected setting with no API. **You** tick it before a deployment that
  includes CPQ objects and untick it after; the Plan step asks you to confirm
  you did. The How To page explains why.

The full inventory is on the app's **How To** page, which travels with the
build.

## For contributors

```bash
cd desktop
npm ci
npm run rebuild:electron   # native better-sqlite3 for the Electron ABI
npm run dev
```

- **Node 22+** (`desktop/.nvmrc`). With **npm 11.19 or newer**, dependency
  install scripts are withheld until approved — after `npm ci`, Electron has no
  binary and esbuild / better-sqlite3 have no prebuilds. Run once:

  ```bash
  npm install-scripts approve electron esbuild better-sqlite3
  ```

  (or `node node_modules/electron/install.js` for Electron alone), then
  `npm ci` again.
- **Two native ABIs.** better-sqlite3 must be built for Electron to run the app
  and for Node to run the sqlite test lane: `npm run rebuild:electron` before
  `npm run dev` / `package`, `npm run rebuild:node` before `npm run test:store`.
  `npm run package:dmg` rebuilds for Electron in place, so rebuild for Node
  again before the store tests.

### Verification lanes

| Command | Expected |
|---|---|
| `npm run scan:secrets` | clean |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm test` | pure-logic suites (about 1,850 tests) |
| `npm run rebuild:node && npm run test:store` | sqlite suites (about 170 tests) |

### Packaging and releasing

`npm run package:dmg` produces a **universal (arm64 + x64), ad-hoc-signed,
un-notarized** DMG in `desktop/release/`. Fuses are flipped and the bundle is
signed with the hardened runtime by `desktop/scripts/afterPack.cjs`. With a
Developer ID certificate in `CSC_LINK`, the same hook flips the fuses only and
electron-builder signs and notarizes (`desktop/electron-builder.release.yml`);
`.github/workflows/release.yml` does either on a `v*` tag depending on whether
the signing secrets exist. The release checklist is in
[`desktop/README.md`](desktop/README.md#releasing).

## Where to start reading

- [`desktop/README.md`](desktop/README.md) — stack, layout, build, test, release
- [`CHANGELOG.md`](CHANGELOG.md) — what each release changed and why
- [`desktop/docs/OAUTH_APP_RUNBOOK.md`](desktop/docs/OAUTH_APP_RUNBOOK.md) — setting up your own OAuth External Client App

## Publishability

Every tracked file is meant to be safe to publish. The changelog and code
comments refer to the sandboxes the engine was proven on by neutral aliases
(`srcbox_*` for the source, `tgt_*` and `sb*` for targets), and record ids in
fixtures are synthetic. `npm run scan:secrets` checks credential shapes and the
org-specific identifiers on every commit. The one real identifier in the tree is
the default production pin (an Org Id prefix) — it is the read-only guard, not a
secret, and the Connections page lets you replace it with your own.

## History

Extracted 2026-09-07 from an internal repository that also contained a now-frozen
Salesforce 2GP Apex implementation of the same engine. The pre-extraction history
is not public; this repository starts from the desktop app.
