# Changelog

## 0.4.1 — unreleased

### Appearance
- **Accent is now LaunchDarkly blue.** The amber accent (`#f29d38`) is replaced by the blue from the LD brand palette
  (`#405BFF`), in a two-tone treatment: fills (primary buttons, the brand tile, the app icon) use the brand blue with
  white labels; text, borders, badges and tints use a lightened blue on the dark theme (`#7a8dff`, 6.3:1) and a darker one
  on the light theme (`#1a3aff`, 6.2:1), because the brand blue alone is only 3.7:1 as text on graphite. Neutrals, type,
  the mark and the warning amber are unchanged — the app borrows one brand colour without becoming an LD product.
- `npm run icon` regenerates `build/icon.png` + `build/icon.icns` from `build/icon.svg` with Electron's own renderer
  (macOS `sips` + `iconutil` for the iconset); the 0.4.0 icon had been produced by hand.
- Token test now also checks the accent as TEXT (≥ 4.5:1 on the page and on panels) in both themes.

### Housekeeping
- **Secret scan covers untracked files.** `npm run scan:secrets` now reads `git ls-files` plus `git ls-files --others
  --exclude-standard`, so a new file is scanned before it is ever staged (0.4.0 added 33 files that only the pre-commit
  `--staged` run ever checked). Gitignored paths are still never read. `--staged` is unchanged.

## 0.4.0 — 2026-10-19 (S64–S67: polish pass — platform, design tokens, first-run UX, branding, measured performance)

### Platform (P0)
- **Electron 37 → 44** (37 had been end-of-life since 2026-01-15). Minimum macOS is now 13 (Ventura).
- **Universal macOS build** (arm64 + x64) so Intel Macs can run the public DMG.
- Dependency refresh: react-router-dom, @jsforce/jsforce-node and the in-range transitives; dev toolchain to vitest 5,
  electron-vite 6 and @electron/rebuild 4, clearing every critical `npm audit` finding. `.github/dependabot.yml` added.
- `engines.node >= 22` + `.nvmrc`; renderer CSP adds `object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.

### Design tokens + accessibility floor (P1)
- **Token layer.** `:root` now declares every colour, tint (via `color-mix`), type size, radius, shadow and z-index the
  stylesheet uses; hard-coded values were replaced throughout. A `[data-theme="light"]` block redefines the colour tokens
  only (opt-in; no automatic switch yet).
- **Links and native controls** follow the dark scheme (`color-scheme: dark`, `a { color }`): deployment names, Details /
  Open plan and in-text links were browser-default blue on near-black (2.0:1).
- **Keyboard focus** is visible app-wide (`:focus-visible` ring; no `outline: none` left). Primary and danger buttons use
  darker fills so their labels pass AA; nothing renders below 12px.
- **Type scale:** body 13px / 1.45; `h2` 15px, `h3` 13px (section headings were the browser's 24px); How To uses a `.prose`
  measure at 14px / 1.6.
- **CSS hygiene:** rules for the 17 classes that had none (`banner info` no longer renders red; `p.error` is red; the
  OAuth/CLI pills are tinted), the S49 selection pill renamed `.sel-pill` so it stops restyling the status `.pill`,
  dead `.chip` / `.sidebar button` rules removed, generic aliases `.table` / `.select` / `.input-sm` / `.check` added,
  inline styles moved into classes. Wide tables scroll inside `.table-wrap` instead of clipping. Window minimum 1024×680.
- **New tests:** `cssClasses.test.ts` (every className in the renderer has a selector — the five-time gotcha now has an
  automated check; also guards color-scheme, the focus ring and the 12px floor) and `tokens.test.ts` (WCAG contrast of the
  declared tokens in both themes; no stray hex outside the token blocks).

### First-run and safety fixes (P2)
- **Re-run guard.** On a Completed / Failed / Cancelled deployment the Plan step says what deploying again does (keyed:
  rows already on the target are updated in place; keyless: anything the id map does not know lands again), the button
  reads **Re-run deploy**, and a confirmation is asked first. Before, a finished deployment showed a live "Deploy" button
  with no sign it would re-run.
- **First run.** Home shows a three-step getting-started checklist while there are no orgs and no deployments; New
  Deployment with no connected org points at Connections instead of two empty selects; `/welcome` is a real page; the
  old `/extids`, `/history` and `/tools` stubs redirect Home; Not found links back.
- **Salesforce CLI missing** is reported as guidance (install link, `sf org login web -a <alias>`, Refresh) instead of
  `spawn sf ENOENT` — a new `CLI_MISSING` error code.
- **Wizard order and labels.** Stages (formerly the "Templates" step) moves after Fields; one shared `STEP_LABELS`
  table drives the step nav, the "Next: …" buttons and the How To list; the header shows "Step N of M" and a
  breadcrumb back to Deployments (and to the monitor once the deployment has run). The wizard's saved
  objects / mappings / fields selections are now called **presets**, so "Templates" means the two runnable kinds.
- **Templates › Rename** works: a modal with a text field replaces `window.prompt`, which Electron does not implement.
- **Deployment page copy** no longer names database tables; failed rows can be exported as JSON
  (**Export failure list**) through a save dialog.
- **Analysis** can be cancelled where it runs, and its bar is indeterminate until the engine reports a total.
- **Connections** gets a filter (alias / username), a "Hide unassigned" toggle and a count; a failed Verify shows its
  full reason in an expandable row.
- Tests: `p2FirstRun.test.tsx` (re-run guard, breadcrumb and step count, no-orgs banner, CLI-missing banner, filter,
  rename modal, welcome checklist).

### Consistency, copy and feedback (P3)
- **Navigation:** Deployments (lit on every `/deployments/*` page), Templates, Connections, How To. "New deployment" is
  the Deployments page's primary button. The sidebar footer is a plain "Idle" when nothing runs and a "N jobs running"
  button with a popover (title, phase, Cancel) when something does.
- **Deployments page** (was Home): one activity list with a kind badge (Deployment / Template run / Analysis), one status
  vocabulary in Title Case (`shared/labels.ts`), one primary action per status (Continue · Review plan · Monitor · View
  report) and a "…" menu for the rest; a running job attaches to its deployment card; long errors collapse to one line
  with Show more.
- **Plan step pre-flight card** replaces six stacked banners: one row per gate (automation scan · CPQ "Triggers Disabled"
  confirmation · objects that will fail · readiness · relink · stages), each with a state glyph and expandable detail;
  the automation table is collapsed under its row.
- **Shared components:** `EmptyState`, `Loading` (spinner + label, used on Orgs, Objects, Mappings, Fields with
  "n / N" counters), `CancelJobButton` (visible helper text, used on the monitor and template reports); one `.table`
  base replaces four duplicate table styles; bare `<select>` / `<input>` elements match the app's inputs.
- **Copy pass:** "External Id" everywhere, API names only once in `<code>`; engine phases shown as words ("Restoring
  automation"); junction / keyless / confirmation terms carry a one-line glossary tooltip and a legend per page; KPIs
  reordered and titled; report columns get units; long cautions are a one-sentence lead with "Learn more"; roadmap ids
  removed from the UI; "Production orgs are pinned read-only" instead of a company name.
- **Feedback:** toasts have a close button, errors announce as alerts, at most three show at once; Readiness provisioning
  ticks per object; the monitor lists the pre-run phases before the first engine event, highlights the current object with
  a per-row progress bar and an "updated Ns ago" stamp; the template run log auto-scrolls (pause on hover), says it shows
  the last 400 lines, and can filter to errors and warnings; disabled Next buttons say why in visible text.
- **Templates page rows:** Run (or Rename for presets) plus a "…" menu instead of six buttons; Last run shows a status
  badge and a relative time.
- **Accessibility:** sortable headers are buttons; the modal traps and returns focus and is labelled by its heading;
  decorative glyphs are hidden from screen readers; the filter row's remove button is outside its label; SeedBuilder
  tabs are a complete tab pattern with arrow keys; reasons that lived only in `title` are visible text.
- Tests: `p3Components`, `p3NavShell`, `p3HomeActivity`, `p3PlanPreflight` plus updates across the step and page suites
  (1,800 pure · 160 sqlite).

### Branding (P4)
- **Look:** true graphite neutrals with one warm amber accent for the brand and primary actions (dark text on it, ≈ 9:1);
  warnings move to a cooler yellow in an outlined style so the accent never reads as a warning; cards lift by shadow
  instead of border. Inter (UI) and JetBrains Mono (API names) are bundled as Latin woff2 files; the base size is 14px
  on a 1.25 scale.
- **Mark and icon:** an amber tile with a seed-into-arrow mark in the sidebar with the version, in the window title, and as
  the app icon (`build/icon.icns`); a small inline SVG icon set for the nav and the pre-flight states. "by LaunchDarkly
  Labs · MIT" in the sidebar footer.
- **Light theme + Settings page.** Settings (new nav item) offers Match the system / Dark / Light, persisted through a
  new allow-listed `settingsGet` / `settingsSet` IPC pair (`pref.theme`), applied before first paint; the page also states
  the version, where the data lives, and how org sign-ins work.
- Fixed three tokens that referenced themselves since P1 (`--backdrop`, `--shadow-modal`, `--font-mono`), which had
  disabled the modal backdrop and the monospace font; the token test now rejects self-references.
- Tests: `p4Theme.test.tsx` (theme resolution and persistence, Settings page, icon accessibility).

### Performance — measured first, then the safe wins (P5)
- **Run timings are now persisted** (migration 014). Every phase transition of a run — the pre-run connect / gates /
  freeze / audit steps as well as the engine's own phases — is stamped in a `run_phases` table, and the peak working
  set per Electron process over the run is written to the run row when the job ends. Until now the only durable
  timestamps were a run's start and finish and each record's attempt time; restore, finalize, audit and relink
  durations disappeared with the job and no memory number survived anywhere. The Deployment page shows the
  breakdown as a per-phase duration strip, with the peak-memory line beneath it. Engine throughput changes
  (parallel automation toggles, scoped PricebookEntry prefetch, write pipelining) are deferred to 0.4.1 so they can
  be judged against these numbers from a live run instead of reconstructed from attempt-time gaps.
- **One describe per object per run.** The plan freeze, every object context (including each 150-id retry chunk),
  the second pass and the text-Id relink each re-described both orgs — roughly 65 describes of 230–280 KB per
  11-object run. They now share one memo for the life of the attempt (a failed describe is retried, never pinned);
  the job log ends with `Describes this run: N fetched from the orgs, M served from the run cache.`
- **Counter reads are run-scoped.** The counter views' `WHERE run_id = ?` could not enter their materialised CTEs, so
  every read scanned every run ever written (50–90 ms per call on a 47k-row store, growing with history, twice per
  monitor refresh). The reads now carry the run id inside the CTEs: 68 → 23 ms for the largest run, 31 → 3 ms for a
  small one, and flat (133 → 1 ms) on a store four times larger. Rows are identical to the views, which stay as the
  oracle. The one missing index found by EXPLAIN (`automation_ledger_mirror(run_uuid, restore_confirmed)`) was added.
- **Smaller job events.** The first-pass strategy line carried the full dropped-field list (up to 32 KB) as detail on
  every 2,000-record page; it is capped at 2,000 characters (the full list is in the frozen plan). The renderer's job
  store no longer rebuilds its state on `log` events, so pages subscribed to a running job stop re-rendering once
  per log line; the deployment cards, mapping rows and seed-report rows are memoised.
- **One refresh path on the monitor pages.** The Deployment page and the template run report each refreshed their
  persisted snapshot from two independent timers with no in-flight guard, so reads overlapped on the main thread and
  a slow earlier response could overwrite a newer one. Both now go through one guarded path: at most one read in
  flight plus one trailing read, responses applied in order, a stale response dropped; the event-driven refresh stays
  the fast path and the 3 s poll the floor while a job runs. The run report's live log appends in place and renders
  once per burst of lines instead of once per line.
- **Wizard describes are fetched once.** Scope, Mappings and Fields each re-pulled every object's describe from both
  orgs on entry (N=11 ≈ 22 round-trips of 200–280 KB per step). One cache per open wizard now serves all three steps
  (24 → 6 describes on a three-object Scope → Mappings → Fields → Scope walk; a failed describe is retried, never
  pinned). The Fields step describes all objects in parallel while keeping its per-object progress count, and its
  per-field exclusion checks use a set per object instead of scanning the exclusion list for every field (the
  "Exclude all" case on a 500-field object was a quarter-million comparisons per keystroke). Draft saves from the
  wizard are debounced to half a second, flushed at once when you change step or leave the wizard.

### Compatibility and first-run docs (P6)
- **README prerequisites and install.** The root README now states what a first-time user needs before anything
  else: Apple Silicon or Intel (the DMG is universal), macOS 13+, Salesforce CLI `sf` 2.136+ with
  `sf org login web -a <alias>`, the macOS 15/26 **Open Anyway** steps (the right-click → Open bypass no longer
  exists), where the SQLite database lives (`~/Library/Application Support/rds-desktop/rds-desktop.db`), what keyed
  mode creates on a target (the External Id field + the `RDS_Deployment_Access` permission set, both permanent), the
  CPQ *Triggers Disabled* step that is the operator's to do, and that OAuth sign-in needs your own External Client
  App. Contributor notes cover npm ≥ 11.19 (`npm install-scripts approve electron esbuild better-sqlite3`) and the
  Node/Electron ABI dance. `desktop/README.md` gains a **Releasing** checklist (lanes → local DMG proven live →
  bundle checks → tag → what the Release page must say → second-Mac Open Anyway walk). The OAuth runbook is
  genericised: create the ECA in a home org of your own, distribute it or not, hand the key to the build via
  `.env.local`. The Settings page now names the real data folder (it said `RDS Desktop/`; the folder is the package
  name `rds-desktop/`).
- **One API version.** The nine `v66.0` literals in the engine (REST root, Tooling root, Tooling query / sobject
  prefixes, the UI-API picklist endpoint, a Tooling `ApiVersion` fallback) now derive from `shared/apiVersion.ts`
  (`API_VERSION`, `DATA_API_PATH`, `TOOLING_API_PATH`, …); `services/salesforce.ts` re-exports the constant. The
  version is shown on Settings › About and in the How To. `test/apiVersion.test.ts` fails the build if a literal
  version path or bare version string reappears under `src/` (comments excluded).
- **Production pin as a runtime setting** (decision D6). The pin that makes an org read-only and never a target was
  a compiled constant, so another team's production org was unprotected until they rebuilt the app. It is now
  `settings.pref.prodOrgIdPrefix`, edited on the Connections page (**Production pin**: paste a 15- or 18-character
  Org Id, Save, Reset to default); the compiled `PROD_ORG_ID_PREFIX` stays as the default and remains allow-listed
  in the secret scanner. All three enforcement layers read the same resolver: the store's connection view (role
  forced to source) and `setRole` refusal, the transport's write gate (the minted org id is re-checked against the
  pin passed in at connect time), and the templates pre-flight blocker. A stored role survives underneath a pin and
  reappears when the pin moves; an invalid stored value falls back to the default rather than pinning nothing. Error
  and advisory text no longer names a company ("pinned production org"). Tests: `prodPin.test.ts`,
  `prodPin.store.test.ts`, six Connections UI cases.
- **Signing for either identity.** `scripts/afterPack.cjs` always flips the fuses, then ad-hoc signs inside-out
  **only when `CSC_LINK` is unset**; with a Developer ID certificate it stops and electron-builder signs and
  notarizes. The hardened runtime and `build/entitlements.mac.plist` are declared once in `electron-builder.yml`
  (`hardenedRuntime`, `entitlements`, `entitlementsInherit`; the hook reads the same path), with
  `minimumSystemVersion 13.0` and `notarize: false`; `electron-builder.release.yml` extends it and only sets
  `identity: Developer ID Application` + `notarize: true`. New `.github/workflows/release.yml` (tag `v*` or manual):
  the five lanes, a package-version-equals-tag check, ad-hoc or Developer ID packaging depending on whether the
  `CSC_LINK` secret exists, bundle verification (`codesign --verify`, entitlements, `lipo`, fuses, `spctl` when
  signed), and upload of the DMG + `SHA256SUMS.txt` to the GitHub Release. Not exercised in CI yet; the DMG rebuild
  after P6 is the lead's step.
- Tests: 1,860 pure · 175 sqlite (P6: +24 / +8).

### Validated live before tagging
- The installed universal DMG (asar `a6c1ad00`) ran one data-seed template into a fresh sandbox (39 objects, 4,778 rows,
  parity 0 mismatches, 43 automation items disabled and restored) and two one-account deployments from the source sandbox
  into two fresh sandboxes — keyless into one, keyed into the other (Readiness created the External Id field and the
  permission set). Both: 192 planned, 191 deployed, 0 failed, 1 skipped (an OpportunityTeamMember unique-constraint
  collision, a known platform artefact); 41 text-Ids relinked, 0 unresolved, 0 dangling on the org; all automation
  restored. The S63 text-Id relink pass is live-proven in both modes with this release.
- First `run_phases` numbers (one account, 191 rows): plan freeze 9 s in both modes; disabling automation 107–159 s and
  restoring it 131–137 s; record writes 117 s keyless / 126 s keyed. The toggles are two thirds of the run; 0.4.1's
  throughput work starts there.
- **Not exercised:** a deployment with a template stage in front of it (the composed path from 0.3.1) and the
  `release.yml` workflow, which runs for the first time on this tag.

## 0.3.1 — 2026-10-18 (S62 + S63: the second live pass on two fresh sandboxes → fixes, templates as deployment stages, text-Id relink)

### Templates as stages of a New Deployment (U-2)
- **New wizard step "Templates"** (after Orgs): pick saved Data-seed / Post-refresh templates to run **before** the
  data lands and/or **after** it. Each stage is a real template run through the templates engine — its own run row,
  ledger and report — using the deployment's source and target. A post-refresh template's automation step and its
  embedded seeds (with group ticks) are selectable per stage; purge is not offered here (use the Templates tab).
- **One job, one lock.** The composed run is the deployment's `deploy` job: before-stages → the data run →
  after-stages. Every existing per-target-org gate (sibling deployments, template applies) sees it. A stage that ends
  blocked, failed or cancelled stops the sequence; later stages are recorded `skipped`. Rerun replays the sequence.
- **Stages strip on the Deployment page** (migration 012, `deploy_stages`): state, duration, note, and a link to each
  template stage's report. Template run history shows "via deployment #N".
- **One attestation covers every stage:** the Plan step's CPQ "Triggers Disabled" gate unions the data plan's gated
  objects with every ticked seed's; the runner re-checks the same flag per stage.

### Fixes from the live pass (S62-1 … S62-3)
- **Plan step: whole-object failures get their own block.** A warning that predicts every row of an object failing
  (`… will fail with REQUIRED_FIELD_MISSING`) now renders in a red block above Deploy with an explicit "Deploy anyway"
  tick; Deploy stays disabled until it is ticked. On tgt_b the CampaignMember warning sat among seven routine
  notices and was deployed past twice.
- **"Already on target" is now a counter, not a disguise.** A keyless re-run's already-mapped rows (reported as
  successes without a write), a junction row the dedupe found, and a Contract already Activated carry the
  `ALREADY_ON_TARGET` tag; the counter views expose `records_already_on_target` (deployed/skipped unchanged) and the
  Deployment page shows "N already on target". Run 32's "11 deployed → 0 deployed / 14 skipped" now reads as what it was.
- **Keyless second pass compares before it PATCHes.** Rows whose every deferred value already matches the target are
  not sent (counted as current, logged as "already current, not sent"); a read failure sends every row as before.
  Run 32 had re-PATCHed 17 Opportunities + 4 Contracts with identical values, bumping LastModifiedDate and firing
  target automation for no change.

### Text fields that hold record Ids are relinked after the load (S63, 2026-10-16)
- **New post-load pass.** The engine remapped a field only when the describe flagged it as a lookup. CPQ also stores
  record Ids in plain TEXT fields — `SBQQ__Subscription__c.SBQQ__RequiredById__c` / `SBQQ__RootId__c`,
  `SBQQ__QuoteLine__c.SBQQ__OriginalQuoteLineId__c`, `OpportunityLineItem.SBQQ__ParentID__c`, and the pricebook /
  quote-template / record-type / email-template Ids on Quote, Opportunity and Contract — and those landed holding
  SOURCE Ids (deployment 50 → sb1: 103 of 127 subscriptions pointed at the source org; bundle amendments walk that
  field). After the last second pass and before contract activation, the run now rewrites EXACTLY the fields listed in
  `shared/fieldPolicy.ts TEXT_ID_FIELDS`: in-run fields resolve through the RDS key (keyed) or the id map (keyless);
  catalog fields resolve by Name / DeveloperName on the target. It compares before every PATCH, so a target already
  holding the right Ids gets no write. **Unresolved values are never nulled and never rewritten** — they stay as the
  source Id and every one is logged with a reason (parent outside scope, parent failed, no catalog row of that name,
  ambiguous name). Never a describe-wide "18-char text" heuristic: Opportunity carries NetSuite / GCLID / Consensus /
  Gearset id text that must not be touched.
- **Plan step notice** names the fields the run will relink and flags a scope gap (an in-run field whose parent
  object is not in the deployment) before the run starts.
- **Deployment page:** "relinked" and "unresolved Ids" KPIs plus a per-field table with a "why" drill-down listing the
  unresolved rows and their reasons. Ledger: `text_id_relinks` (migration 013); counters are untouched.

### Internal
- `rds:deploy.start` lifted into `ipc/deployRuns.ts: startDeployRun()` (pure move + the stage driver);
  `ipc/templateRuns.ts` split into prepare / execute so a stage and a standalone run share one path;
  `engine/deploy/stages.ts` holds the pure stop rule. Startup reconciliation also closes stages a dead session left.
- Tests: 1,714 pure · 160 sqlite (S63: +22 / +2). Withdrawn during the build: the "deploy.start ignores template jobs" lock-gap
  finding — the handler already consults the template-side lock (S59 §6.5).

## 0.3.0 — 2026-10-13 (S61, built 2026-10-12: the first live templates pass → one fix-and-feature build)

### Keyless deployments — the External Id field is now optional (U-5)
- **New Deployment → "Use an External Id field on the target" (default on).** Unticked, the deployment runs
  **keyless**: records are INSERTED and matched through this app's local source→target id map (the strategy the
  Data seed templates already use), no field is created on the target, and the Readiness step is skipped. The
  caution is shown on the New Deployment form, on the Plan step and in the deploy log: parents resolve through the
  map batch by batch (a little slower); re-running against the same target from THIS app skips rows it already
  mapped (and re-inserts rows that were deleted); another machine, a fresh app database or a refreshed target has no
  map and would insert duplicates; nothing on the target records which rows came from the seeder.
- **How it works (one mechanism, no engine fork):** the engine keeps stamping every payload with its computed
  External Id as a *virtual key*. The live transport strips it before the `POST /composite/sobjects/` insert and
  uses it only to attribute the positional results back — so the first pass, retry drain, second pass and failure
  classifier are unchanged. Nested `{ Rel: { ExtId } }` parent references become flat lookup Ids through the map
  (the parent-strip probe asks the map and checks the row still exists); the second pass PATCHes by the mapped Id
  and fails an unmapped row synthetically (`NOT_MAPPED`) rather than writing blind; the junction path dedupes on
  mapped TARGET ids and writes flat lookups; Contract activation selects by the run's mapped ids; the post-run
  automation audit counts the whole window and subtracts the rows the run inserted (no samples — they would be ours).
  Parents OUTSIDE the deployment stay locked to Skip (the map only knows what this app wrote).
- Store: `id_map` gains deploy rows (`deployment_id` set); lookups are per TARGET org, so an earlier deployment's
  rows are found by a later one. No new migration.

### Templates — fixes from the first live pass on a fresh sandbox (runs 1–10, tgt_a)
- **Fixed (U-9, bug):** "run again" on a report opened the form with the FIRST target in the list, not the run's.
  It now carries the run's target, source, steps and options (`?from=<runId>`); the attestation is never carried
  and the purge alias is retyped; a preset target that is no longer a Target connection leaves the pick empty and
  says so instead of falling through to another org.
- **Fixed (U-12):** purge counted 126 `sbaa__ApprovalCondition__c` deletes refused by the Advanced Approvals package
  trigger ("Condition Index Number … does not exist") as problems although the parent rules' master-detail cascade
  removed every one of them. Children are still deleted first (CPQ refuses to delete a quote template while it has
  line columns, so skipping a child is never safe); a refusal is held and forgiven only when a re-count after the
  parents are purged shows the rows gone, and the report says so. The leftover check still guards.
- **Fixed (U-11):** the seed's own preflight (copied-object match, existing rows, stale id map) now runs BEFORE the
  target's automation is touched — a blocked apply no longer toggles 43 rules off and on.
- **Fixed (U-6):** dangling lookups left by a KNOWN (expected) relink failure are reported as expected, not as a
  second problem.
- **Fixed (U-7):** "Next: Resume" is no longer suggested when every seed-side problem is non-retryable
  (cross-reference, validation, skips); the report says to fix the data or record an expected failure.
- **Changed (U-8):** a new run state **partial** — every step ran to the end but some rows or items had unexpected
  problems (badge shows the count). **failed** now means the run did not finish. A partial run's job ends `done`.
- **New (U-1):** a clean (or partial) dry run of the current revision, run this session, offers **Apply with these
  settings** on its report — same target, source, steps and options, one confirm.
- **UX (U-4):** Source is listed before Target on the run form and the run history.
- **UX (U-3 / U-10):** the External IDs, History, Tools and Settings nav items (M1 stubs) are hidden until they have content.
- **Fixed:** the run form of a Post-refresh template never showed the CPQ "Triggers Disabled" attestation for the seed templates it embeds, so Apply was always blocked by preflight. The gated-object list is now resolved in main (`TemplateSummary.cpqGatedObjects`) with the runner's own policy and follows the seeds ticked on the form (found on the first live pass, 2026-10-12).

### Templates (new left-nav tab)

- **Two composable template types for getting a refreshed sandbox ready.** A **Data seed**
  template copies configuration rows (price rules, product rules, quote templates, approval
  rules, custom config objects) from a source org into a sandbox in dependency order,
  remapping lookups through a source→target Id map — an insert with remapping, not the
  wizard's External-Id upsert. Per tier: a WHERE fragment, a batch size (1–200, default 200),
  deferred fields with placeholders, prune-under-parent, parent scope, and an attachments
  handler. A **Post-refresh** template sets flows and triggers to a wanted state (deactivate,
  activate, comment out, restore body), optionally patches settings (prefix or set), then runs
  the seed templates it names. Both are built in a builder against a "read from" org (source
  orgs by default), stored locally, and exported/imported as self-contained JSON files.
- **Dry run → Apply.** Apply unlocks only after a dry run of the same template revision on the
  same target, in this session, ended without blockers. The form and the Apply confirm both
  carry the caveat verbatim: a dry run cannot see managed-package validation or trigger
  errors. Apply refuses a target whose stored role is not Target or whose live Organization
  row is not a sandbox, a source that is not role Source, the same org twice, a running
  deploy or template job against the org, and a target already holding rows in the seed
  objects (purge first, by typing the alias, or resume the last apply).
- **Desired-state automation.** An item already in the wanted state is left alone, never
  reversed. Deactivating a trigger sets its Status via a MetadataContainer, then a Metadata
  API deploy, then falls back to commenting the body out with the template's own sentinel
  (the deploy's orphan sweep never touches it); the report says which mechanism took. Every
  post-refresh change is recorded locally with the state it found; a safety check re-reads
  the org after Apply.
- **Seed-time protection.** The target's own unmanaged validation rules, record-triggered
  flows and triggers on the seeded objects are disabled for the seed and restored afterwards
  (also on failure or cancel); until every item is confirmed restored, the org is locked for
  deploys and template applies, and the run page offers Restore target automation. The CPQ
  "Triggers Disabled" attestation is required when a seeded object needs the package bypass.
- **The writer's retry ladder and the batch-size report.** Transient errors retry in smaller
  batches (size → 50 → 10); the bulk-only trigger error class gets one single-record retry.
  The report names every object whose rows saved only on that retry and offers "set
  batchSize 1 → Apply to template". Expected failures declared on the template are listed
  with their reason instead of counting as unexpected.
- **Resume and verify.** The id map is persisted after every tier, so a cancelled or crashed
  apply resumes from where it stopped (a map that disagrees with the target is refused).
  Verify compares counts, probes dangling lookups on relinked objects, and checks second-pass
  values record by record.
- Migration 011 adds `template_runs`, `template_run_problems`,
  `template_automation_changes`, `templates.description` and `id_map.template_run_id`.

### Wizard follow-ups from Session 57

- **Scope advisor noise.** Parents reached only through a field whose namespace is excluded
  on the Fields step are no longer advice; cards sort required → keyed on target → optional;
  optional parents reached only through managed-package fields collapse to one
  "N enrichment lookups will be left blank" line.
- **Objects templates that carry an object the platform allows no custom fields on**
  (CampaignMemberStatus) drop it on apply, say so, and offer one click to save the template
  back without it.
- **Mappings "Suggest" banner** now says what the probe checked — users and record types
  share Ids across these orgs — instead of claiming all records do.

- **CI is green for the first time.** Every `desktop-ci` run since the first commit failed at the
  lint step on one `react-hooks/refs` error in `WizardShell.tsx` (a latest-value ref written during
  render), so typecheck and both test lanes never ran on CI. The active step is now resolved before
  the early returns and the ref is synced in an effect. No behaviour change; 1,461 + 142 tests pass.

## v0.2.7 — 2026-09-18

Six items from the first live runs against a fresh sb1 (sb1-915-git) and the
v0.2.6 click-through on sb3_912 — Session 57. The deploy engine's write path is
unchanged; the mapping POLICY and the wizard learned to say, before the run,
what the run was going to prove the hard way.

### Deploy policy

- **A parent outside the deployment that the target already holds is resolved
  by its RDS key instead of being skipped.** Run 24 put 228 CampaignMembers
  into sb1 with Campaign out of scope: `CampaignId` was locked to Skip, every
  row failed `REQUIRED_FIELD_MISSING`, and the Campaign had been deployed by the
  run before it, key and all. The engine could already write such a reference
  (it writes the parent's External Id and probes the target for it, failing
  loud); only the policy refused, because it looked at the selected objects
  alone. It now also asks the target: an out-of-scope parent whose object
  carries the key field is unlocked (External ID / Skip), and defaults to
  External ID when the target holds keyed rows of it. The Mappings row, the
  Fields step's "skipped by mapping" lock and the frozen plan all make the same
  one policy call, so what you see is what deploys. A missing parent still
  blanks a nillable link or fails a required one, exactly as before.
  Template apply keeps such entries instead of dropping them as "parent not in
  this deployment". Read-only probe: one Tooling query per org (cached a few
  minutes) plus one `LIMIT 1` per candidate object.

### Wizard

- **The Scope step says which parents are missing, before the run.** For every
  reference from an in-scope object to an object outside the scope, a card:
  the consequence (a required reference fails every row; an optional one is
  left blank), a humble "You should probably add Campaign", a one-click add
  with a ready-made semi-join filter when the child has a plain filter (SOQL
  cannot nest semi-joins; the card says so when it can't derive one), and — when
  the target already holds keyed rows — "leaving it out is fine".
- The "Parents outside this deployment" section starts collapsed with a count and a
  Show/Hide toggle — on a wide scope the list is long (Jack, during the live check).
- **A required reference that resolves to Skip is a warning on the Plan step
  and in the job log**, naming the object, the field and the fix. Analysis and
  freeze use the same helper.
- **"Next: readiness" is disabled when nothing can deploy** — every filter
  validated to zero records and no unfiltered object stands on its own (an
  unfiltered root would take every record in the source org, so that case stays
  open). Busy or invalid filters never block.
- **Readiness names objects that can never carry the key field.** Salesforce
  allows no custom fields on CampaignMemberStatus, so provisioning could never
  turn its row green and the L1 hard stop stayed shut with no explanation. The
  row now says so, offers "Deselect", the gate banner repeats it, provisioning
  skips it (and classifies the platform's own refusal for objects the registry
  does not know), and the object picker badges it at selection time.
- **"Suggest exclusions" keeps SBQQ/sbaa only when a CPQ object is in scope.**
  A Campaign deployment no longer carries the CPQ fields on Account.
- **"an Account"**, not "a Account", in the filter hint.

### Tests

- New: `scopeAdvisor`, `targetKeys`, `stepScope` suites; freeze, policy,
  Mappings, Fields, Readiness, provisioning and picker suites extended.

## v0.2.6 — 2026-09-13

Five small items from the second sb3 test pass, all at the UI and job-log
level; the deploy engine is unchanged from v0.2.5.

### Wizard

- **A filter that matches nothing is a warning, and an impossible Id is
  explained.** A valid WHERE clause that returns zero rows used to show a green
  check. On a root object that means the whole deployment is empty, because
  every child is scoped by its parent. It now shows amber: "0 records — nothing
  will deploy for Account, or for anything scoped under it." When the clause
  holds a literal record Id that cannot match, one more line says why: the Id's
  key prefix belongs to another object ("006… is an Opportunity Id — this
  filter is on Account"), or the record exists on the target org rather than
  the source ("… is a Account record on sb3_912 (the target). Filters run
  against the source, srcbox_911 — use the source Id."). Both cases happened on
  the same day of testing. Prefixes come from a fixed table for standard
  objects plus the org's global describe for custom and managed ones; the
  target probe is a single read-only query and only runs when a target is set.
- **Cancel says what it does.** Hovering the button explains that the run stops
  at the next batch boundary, restores automation and audits, that records
  already written stay, and why it is unavailable during the restore.

### Deploy job log

- **Automation discovery reports itself.** The job log now states what was
  found ("73 flows (record-triggered flows on the plan objects only), 93
  validation rules, 17 triggers, 0 duplicate rules") and, if the scoped flow
  query ever falls back to the org-wide sweep again, a warning with the
  target's error text. The wizard panel always showed that banner; the job log,
  which is what gets read after a run, never did, which is how the v0.2.5
  flow-query fix went unnoticed for twenty sessions.
- **Peak memory is logged at the end of every run.** One line per run: main,
  renderer and GPU process peaks, sampled every 30 seconds. A measurement, not
  a fix: the previous session ended with the operator's machine out of memory
  and no number to say whether the app was involved.

### Deployment page

- Removed a sentence left over from before the run monitor existed ("per-object
  status and the run log arrive with the full monitor").

## v0.2.5 — 2026-09-13

The two items logged during the first sb3 test pass, both built before the
second pass.

### Deploy engine

- **Automation discovery now scopes flows correctly; before this, every run
  disabled every active flow in the target org.** The scoped query selected
  `ActiveVersion.VersionNumber` from `FlowDefinitionView`, which has no such
  relationship (the view carries the active version's number as its own
  `VersionNumber` field). The query therefore failed on every org, the code
  swallowed the error and fell back, as designed, to the org-wide Tooling
  sweep, and the panel's fallback warning was the only trace. On sb3 that was
  223 flows disabled and restored where 73 record-triggered flows on the plan's
  objects were in scope; runs on projsb and sb1 did the same. Fixed by
  selecting the right field (verified read-only on sb3_912 and srcbox_911 against
  `FlowVersionView` and the Tooling `Flow` table: the number is the active
  version's). The fallback, when it does happen, now names the target's error
  text in the panel instead of hiding it. Neither org has an active Process
  Builder process, so the record-triggered set is the complete set of flows
  fired by the load.

### Wizard

- **Readiness is a hard stop.** A non-junction object whose
  `Data_Deployment_External_Id__c` is missing, not flagged External Id, or
  hidden by field-level security, or that cannot be described on the target,
  renders red and closes the wizard: Next on the Readiness step, the step nav
  past it, Analyze on the Summary step and Deploy on the Plan step all read one
  predicate. The verdict is stored on the draft keyed by the scope, so a green
  for one set of objects does not carry over when an object is added, and a
  deployment saved before this version is treated as unchecked until its
  Readiness step is visited once. Copy is "You can't proceed", not "you can
  continue". The plan-freeze own-key gate from v0.2.3 stays as the last line.
  Reason: on a fresh target the old flow spent describes on both orgs, an
  analysis job and a full plan freeze before refusing (T0 on sb3).

## v0.2.4 — 2026-09-12

One fix found by the first test run on a fresh target.

### Deploy engine

- **A junction row whose second parent was never deployed is skipped, not failed,
  even when the run wrote no rows of that parent at all.** The S49 fix for this
  (cross-account contact roles) switched itself off whenever the run had written
  zero rows of the second parent, on the theory that the parent must already be
  on the target. Run 16 on sb3 disproved it: Contact was in scope with zero rows
  (the account has none), its one OpportunityContactRole pointed at a private
  contact, the check was disabled, and the row failed at the API with the exact
  error the fix exists to prevent. The junction path now asks the target: any
  second-parent Id the run did not write is probed by External Id, and a row is
  skipped as `referenced_parent_out_of_scope` only when its parent is neither
  written this run nor present on target. A parent that is on target from an
  earlier run still passes. No probe is issued when every parent was written
  this run.

## v0.2.3 — 2026-09-12

Detects the one duplicate shape the engine cannot prevent, stops a failed
account's children from deploying detached, locks the target org rather than
the deployment, refuses a plan whose upsert key is unusable, and stops asking
the CLI for the same token twice a second.

### Deploy engine

- **The run now audits the target for rows its own automation created.** Every
  record the engine writes carries the RDS key (`Data_Deployment_External_Id__c`),
  so a re-run updates in place — the local database proves it for the re-run tests
  on sb1 (the same 137 quote lines, 59 line items, 13 quotes and 24 opportunities
  landed on identical target ids across runs). What the engine never saw was what
  the target created on its own while the load ran: CPQ's quote→opportunity sync
  spawning line items, bundle triggers auto-adding option lines, contracting
  spawning subscriptions. Those rows have no key, so the upsert never matches
  them and a re-run neither updates nor removes them — "two of every product on
  the opportunity", with the run reporting Completed. After every run (any
  outcome) the app now counts rows created in the run window, by the deploying
  user, without the key, per plan object plus the known CPQ spawn objects, and
  reports them with sample ids in the job log and on the deployment page. A
  clean run says so. Before the run it also reports rows that already sit
  unkeyed under RDS-keyed parents from an earlier run. Read-only, fail-open,
  never changes the outcome. Verified against run 15 on projsb: 12 objects
  checked, nothing created by automation.
- **A record whose scope parent is not on target is withheld, not written
  detached** (the N>1 half of the S50 root gate, Jack's call: skip the subtree).
  The gate aborted only when the root deployed *zero* records; with twenty
  accounts, one failed account's children had their account lookup blanked
  (nillable) and deployed as orphans while the run said Completed. The lookup an
  object was *scoped by* (`Contact.AccountId`, `OpportunityLineItem.OpportunityId`,
  `SBQQ__QuoteLine__c.SBQQ__Quote__c`) is now never stripped: a record whose
  scope parent is missing is excluded from the upsert and recorded as **failed**
  with code `SCOPE_PARENT_NOT_ON_TARGET` — cascade when the parent failed in this
  run, root otherwise. Failed rather than skipped on purpose: the retry drain
  re-runs it, so a parent that heals in a later retry round relinks its whole
  subtree within the same run, and a run that ends with a dead account reports
  the subtree as failures instead of success. Every other lookup keeps the
  strip-and-deploy behaviour.
- **The run lock is per target org.** The three deploy-start gates — a running
  job, a live (or Stalled) run, an unconfirmed automation restore — were scoped
  to the deployment being started, so two deployments aimed at the same org
  passed all of them and could disable and restore each other's automation, and
  a stranded run of *another* deployment left the target's automation disabled
  while this one deployed over it. The gates now consider every deployment whose
  target connection is the same org (a superseded alias and its live sibling are
  one org) and name the offending deployment.
- **The plan freeze refuses an object whose own upsert key is unusable on the
  target.** Readiness only warned, and the freeze consulted the ExtId probe for
  reference mappings but never for the object's own key; a missing or FLS-hidden
  field produced a run in which 100% of that object's records failed with "does
  not match an External ID". The freeze now checks the target describe (what the
  connected user can actually see), says whether the field is missing, not
  flagged External ID, or hidden by field-level security, and the deployment page
  links the refusal to the Readiness step.

### Performance

- **CLI tokens are cached for ten minutes.** Every IPC call built a fresh
  connection, and a CLI mint is two child processes (`sf org display` plus, since
  CLI 2.150, `sf org auth show-access-token`). Measured before changing anything:
  0.9–1.2 s + 0.7 s per org, about 3.5 s of pure CLI time before the Orgs and
  Objects steps could make their first org request, and roughly one spawn a
  second during busy steps. A token minted within the last ten minutes is now
  served from memory; the 401 refresh path always re-mints and replaces the
  cached entry, so a rejected token still self-heals through the existing capped
  refresh loop. Measured after: second connect 0 ms.

### Validation

1,416 unit tests and 142 SQLite integration tests. Read-only live probes against
projsb: the audit's SOQL ran clean on run 15's real plan (twelve objects, one
platform artefact — the owner row Salesforce adds to an opportunity team — is
excluded by design), the freeze gate passed all ten of run 15's objects, and the
mint cache turned a 1.2 s second connect into 0 ms. The subtree rule is covered
by fixtures only; its first live proof needs a run in which one account fails.

## v0.2.2 — 2026-09-11

Roles that save themselves, honest connection lists, and a way to delete the
deployment that could never run.

### Deployments

- **Picking an org as source or target now saves that role.** Roles live on the
  connection, and nothing in the deployment flow ever wrote them: an org still
  `unassigned` could be picked as the target, carried through every wizard step,
  and refused at deploy start with "cannot be a deploy target (role 'unassigned')".
  Creating a deployment now assigns the never-assigned side(s) in the same
  transaction as the insert and says so in a toast. A row that already carries a
  role is never changed, so a demotion made on the Connections page still stands.
- **The Orgs step shows both connections' roles** and fixes an unassigned side with
  one click, so drafts created before this release (or after a demotion) no longer
  find out on the Plan step. The deploy-start refusal, when it still fires, says
  where to fix it, and the deployment page links to the Orgs step instead of
  suggesting a mappings fix.
- **Deployments can be deleted from the UI.** There was no delete anywhere. Draft,
  Planned and Stalled deployments can go, and so can a Failed or Cancelled one
  that never started a run — nothing ever touched the target. A deployment that
  ran keeps its results and stays.

### Connections

- **Stale aliases are recognised.** A renamed alias or a refreshed sandbox left the
  old row behind with a stale org id and a role that did not follow the org. On
  every refresh, a CLI row the CLI no longer lists is marked superseded by its
  live sibling (same username), takes on the live org id, and passes its role to
  the sibling if the sibling has none. A row whose auth is gone is marked
  "Not in CLI". Both are hidden from the new-deployment pickers, listed under
  "Stale connections", and removable once no deployment references them.
  Existing deployments that point at a superseded row keep working.

### Validation

1,375 unit tests and 131 SQLite integration tests. Run 15 (2026-09-11, 20 accounts,
srcbox → projsb) deployed **11,622 of 11,835 records with 3 failures**, all three a
zero-quantity source value the target refused, and restored automation 339/339. It was
also the first run to cross the 1,000-id materialization cap: four objects were over it,
and Contact deployed 4,060 of 4,060 through the fallback path with no failures — the
"validated to 4 accounts" limitation below is closed.

## v0.2.1 — 2026-09-11

Fixes a hang on the wizard's Orgs step caused by a Salesforce CLI update.

### Auth

- **The Orgs step no longer hangs at "Comparing schemas…" after a CLI update.**
  Salesforce CLI 2.150 (September 2026) redacts the access token in
  `sf org display --json` unless `SF_TEMP_SHOW_SECRETS=true` is set, and an app
  launched from Finder or the Dock never has that variable. The app handed the
  literal `[REDACTED]…` placeholder to jsforce, the org answered 401, jsforce asked
  for a refresh, the CLI returned the placeholder again, and jsforce retried — once
  a second, forever, with nothing reaching the UI. The token is now read through
  the CLI's replacement command, `sf org auth show-access-token`, whenever
  `org display` redacts it. Older CLIs are unaffected (one call, as before).
- **A token the org keeps rejecting now fails loudly.** jsforce retries after every
  refresh with no cap. The refresh hook now stops when a refresh hands back the
  same token the org just rejected, or after three refreshes inside a minute, and
  surfaces a session-expired error naming the connection so the re-authenticate
  prompt fires.

## v0.2.0 — 2026-09-07

First tagged release. Adds object templates, makes the deployment monitor honest
during the run's long tail, and gives bulk actions a visible outcome.

### Deployment monitor

- **The monitor no longer freezes during a run's tail.** Progress was emitted from
  exactly one place — the first-pass walk — so once the first pass ended, nothing
  invalidated the refetch key. The persisted view then froze for minutes at a time
  through the second pass and the automation restore, showing a stale phase and a
  stale "current object" while the run was somewhere else entirely.
- **Automation restore now reports progress.** Roughly 340 validation rules, flows
  and triggers used to be re-enabled behind a finished-looking "Deploy data" bar —
  the longest stretch of a run was invisible. Progress is stage-weighted to match
  the real shape of the work: validation rules, flows and triggers each go out as
  one composite call, while duplicate rules, the CPQ setting and workflow rules
  advance per item.
- **Cancel is withdrawn once teardown starts.** Cancelling mid-restore was the one
  action that could leave a target org with its automation disabled — the exact
  state the app later refuses to deploy over.
- The header no longer names a data object while tearing down.

### Wizard

- **Object templates.** Save, apply, rename and delete a selected-object set on the
  Objects step. Applying replaces the selection rather than merging into it, so a
  template can be used to deploy *less*, and entries no longer deployable in both
  orgs are dropped and named rather than silently selected. Applying a narrower
  template also drops the removed objects' filters.
- **Bulk actions have a visible outcome.** Results and failures used to share one
  unstyled line, so a real summary ("54 to Direct ID, 11 to Name Match") read as an
  unnoticed caption and a *failed* action could pass entirely unnoticed. Successes
  and failures are now distinguishable at a glance, and failures are announced to
  screen readers.
- **A spinner while bulk actions run**, and wizard navigation is disabled during
  them — previously you could navigate away mid-action and have your mappings
  rewritten from a step you had already left.

### Validation

1,340 unit tests and 115 SQLite integration tests. Exercised against two live
cross-org deployments totalling **3,364 records across 6 accounts with zero
failures**, planned-vs-queried counts matching exactly on every object, and
automation fully restored (340/340) on both runs.

### Install (please read — macOS will block this build)

This build is **ad-hoc signed and not notarized**, so Gatekeeper will refuse it on
first launch with a "damaged" or "unidentified developer" message. That is expected,
not a corrupt download. Either:

- right-click the app in `/Applications` and choose **Open**, then confirm; or
- run `xattr -dr com.apple.quarantine "/Applications/RDS Desktop.app"`

Notarizing properly requires an Apple Developer account and is not yet set up.

### Known limitations

- **Apple Silicon only** (arm64). There is no Intel build — it will not run on an
  Intel Mac.
- **The run lock is per-deployment, not per-target-org.** Two *different*
  deployments pointing at the same target org can run at once, and they will
  corrupt each other's automation restore while both report success. Run one
  deployment at a time against a given org.
- **Multi-account is validated to 4 accounts.** At roughly 5 accounts a parent's
  materialized id list crosses an internal 1,000-id cap and takes a fallback path
  that has never been exercised. Larger sets should be treated as untested.
- **A failed root record in a multi-account run does not abort the run.** The abort
  gate fires only when the root object deploys zero records, so if one account fails
  while others succeed, that account's child records deploy without their parent
  link. The orphan ledger records this, but the run still reports success.
- Skipped records are terminal and are never retried.
