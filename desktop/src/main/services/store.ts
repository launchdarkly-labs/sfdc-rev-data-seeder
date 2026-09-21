/**
 * SQLite state store — replaces every org-side state blob the Apex app
 * fought (131KB Disabled_Automation__c / Retry_Pending_Ids__c truncation,
 * 32K Scoped_Filter__c, Deployment_Plan__c overflow).
 *
 * better-sqlite3 is synchronous by design — fine in the Electron main
 * process for our row volumes; WAL mode keeps the UI responsive.
 *
 * Migrations: append-only list, applied inside a transaction, recorded in
 * schema_migrations. NEVER edit an applied migration — add a new one.
 */
import Database from 'better-sqlite3'
import type {
  DeploymentHeader,
  DeploymentSummary,
  DraftDetail,
  OrgConnection,
  OrgRole,
  PlanView,
  Template,
  TemplateKind
} from '../../shared/types'
import { PROD_ORG_ID_PREFIX } from '../../shared/types'
import type { DraftCreateResult, RoleAssignment } from '../../shared/types'
import { rolesToAssign } from '../../shared/roles'
import type { WizardConfig, WizardStep } from '../../shared/wizard'
import { canDeleteDeployment, emptyWizardConfig } from '../../shared/wizard'
import { INTERRUPTED_BEFORE_RUN_MESSAGE } from '../../shared/recoveryCopy'
import { transition } from '../engine/deploy/stateMachine'
import type { AnalysisResult } from '../engine/analysis'
import type { DeploymentObjectRow } from '../planMapping'
import { plannedObjectToRow, plannedObjectToView, rowToPlannedObject } from '../planMapping'
import { RdsHandlerError } from '../errors'
import { DeployStore } from './deployStore'
import type { OAuthTokenStore, StoredTokenRow } from './tokenVault'

/** Exported for the integration test to build a pre-migration DB state. */
export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001-initial',
    sql: `
      CREATE TABLE connections (
        alias           TEXT PRIMARY KEY,
        username        TEXT NOT NULL,
        org_id          TEXT NOT NULL DEFAULT '',
        instance_url    TEXT NOT NULL DEFAULT '',
        role            TEXT NOT NULL DEFAULT 'unassigned' CHECK (role IN ('source','target','unassigned')),
        auth_kind       TEXT NOT NULL DEFAULT 'cli' CHECK (auth_kind IN ('cli','eca')),
        cli_status      TEXT NOT NULL DEFAULT 'Unknown',
        is_sandbox      INTEGER,
        last_verified_at INTEGER,
        created_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );

      CREATE TABLE deployments (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        source_alias    TEXT NOT NULL REFERENCES connections(alias),
        target_alias    TEXT NOT NULL REFERENCES connections(alias),
        status          TEXT NOT NULL DEFAULT 'Draft',
        error_message   TEXT,
        created_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        updated_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );

      CREATE TABLE deployment_objects (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        deployment_id   INTEGER NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
        object_api_name TEXT NOT NULL,
        sort_order      INTEGER,
        status          TEXT NOT NULL DEFAULT 'Pending',
        filter_clause   TEXT,
        scoped_filter   TEXT,            -- no 32K ceiling here
        scoped_record_count INTEGER,
        api_strategy    TEXT,            -- 'REST' | 'Bulk'
        gating_tier     TEXT,
        has_circular_refs INTEGER NOT NULL DEFAULT 0,
        deferred_fields TEXT,            -- JSON array
        is_junction     INTEGER NOT NULL DEFAULT 0,
        junction_parents TEXT,           -- JSON
        error_message   TEXT,
        UNIQUE (deployment_id, object_api_name)
      );

      CREATE TABLE record_results (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        deployment_object_id INTEGER NOT NULL REFERENCES deployment_objects(id) ON DELETE CASCADE,
        source_id       TEXT NOT NULL,
        target_id       TEXT,
        pass            INTEGER NOT NULL DEFAULT 1,  -- 1 = first pass, 2 = deferred-field pass
        outcome         TEXT NOT NULL,               -- 'success' | 'failed' | 'skipped' | 'retried'
        error_code      TEXT,
        error_message   TEXT,                        -- FULL error text, no 255-char truncation
        attempted_at    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );
      CREATE INDEX idx_record_results_object ON record_results(deployment_object_id, outcome);

      -- VEID-style source→target Id map, keyed per TARGET org so a second
      -- machine/install can rebuild matching (avoids Prodly's per-control-org
      -- duplicate risk; complements — not replaces — the computed-ExtId upsert).
      CREATE TABLE id_map (
        target_org_id   TEXT NOT NULL,
        object_api_name TEXT NOT NULL,
        source_id       TEXT NOT NULL,
        target_id       TEXT NOT NULL,
        deployment_id   INTEGER,
        mapped_at       INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        PRIMARY KEY (target_org_id, source_id)
      );
      CREATE INDEX idx_id_map_object ON id_map(target_org_id, object_api_name);

      -- Local mirror of automation disable/restore state. The authoritative
      -- write-ahead ledger STAYS on the target org (survives a dead laptop);
      -- this mirror drives the UI and reconciliation.
      CREATE TABLE automation_ledger_mirror (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        deployment_id   INTEGER NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
        target_org_id   TEXT NOT NULL,
        item_type       TEXT NOT NULL,   -- Flow | ValidationRule | ApexTrigger | DuplicateRule | ...
        item_name       TEXT NOT NULL,
        item_id         TEXT,
        disabled_at     INTEGER,
        restore_confirmed INTEGER NOT NULL DEFAULT 0,
        detail          TEXT
      );

      CREATE TABLE describe_cache (
        org_id          TEXT NOT NULL,
        object_api_name TEXT NOT NULL,   -- '' = global describe
        payload         TEXT NOT NULL,   -- JSON
        fetched_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        PRIMARY KEY (org_id, object_api_name)
      );

      CREATE TABLE settings (
        key             TEXT PRIMARY KEY,
        value           TEXT NOT NULL
      );
    `
  },
  {
    // 002 — analysis-plan persistence (2.2) + wizard draft model (5A.5).
    // Sequence note (S31): the plan originally pinned 002=auth; the wizard/
    // analysis data layer landed first, so it takes 002 and auth/deploy shift
    // to 003/004 (authoring order == application order for the append-only
    // runner). deployment_objects/deployments already exist (001); this only
    // adds columns.
    id: '002-plan-and-drafts',
    sql: `
      ALTER TABLE deployments ADD COLUMN wizard_step TEXT;
      ALTER TABLE deployments ADD COLUMN draft_config TEXT;             -- WizardConfig JSON
      ALTER TABLE deployments ADD COLUMN warnings TEXT;                 -- JSON array
      ALTER TABLE deployments ADD COLUMN auto_injected_junctions TEXT;  -- JSON array
      ALTER TABLE deployments ADD COLUMN analyzed_at INTEGER;
      ALTER TABLE deployment_objects ADD COLUMN scoped_filter_display TEXT;
      ALTER TABLE deployment_objects ADD COLUMN plan_json TEXT;         -- full PlannedObject
    `
  },
  {
    // 003 — auth dual-mode (A2). Re-key connections from alias-PK to a stable
    // TEXT id (CLI rows: id = old alias, a verbatim key so the deployments FK
    // re-point is a plain column copy; OAuth rows get a UUID in A4). Adds the
    // OAuth columns + oauth_tokens table; renames auth_kind 'eca' → 'oauth'.
    // Rebuilding these FK-referenced tables needs foreign_keys OFF (see migrate()
    // — a PRAGMA no-op inside a transaction), and preserves deployments.id
    // verbatim so deployment_objects / automation_ledger_mirror FKs survive.
    id: '003-auth-dual-mode',
    sql: `
      CREATE TABLE connections_new (
        id               TEXT PRIMARY KEY,
        label            TEXT NOT NULL,
        cli_alias        TEXT UNIQUE,
        username         TEXT NOT NULL,
        org_id           TEXT NOT NULL DEFAULT '',
        instance_url     TEXT NOT NULL DEFAULT '',
        login_url        TEXT,
        role             TEXT NOT NULL DEFAULT 'unassigned' CHECK (role IN ('source','target','unassigned')),
        auth_kind        TEXT NOT NULL DEFAULT 'cli' CHECK (auth_kind IN ('cli','oauth')),
        oauth_client_id  TEXT,
        oauth_client_kind TEXT CHECK (oauth_client_kind IN ('connectedApp','externalClientApp')),
        status           TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Expired','Error','Unauthenticated')),
        cli_status       TEXT NOT NULL DEFAULT 'Unknown',
        is_sandbox       INTEGER,
        is_scratch       INTEGER,
        last_verified_at INTEGER,
        last_tested_at   INTEGER,
        created_at       INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );
      INSERT INTO connections_new
        (id, label, cli_alias, username, org_id, instance_url, role, auth_kind, status,
         cli_status, is_sandbox, last_verified_at, created_at)
        SELECT alias, alias, alias, username, org_id, instance_url, role,
               CASE WHEN auth_kind = 'eca' THEN 'oauth' ELSE auth_kind END,
               'Active', cli_status, is_sandbox, last_verified_at, created_at
        FROM connections;
      DROP TABLE connections;
      ALTER TABLE connections_new RENAME TO connections;

      CREATE TABLE deployments_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        source_connection_id TEXT NOT NULL REFERENCES connections(id),
        target_connection_id TEXT NOT NULL REFERENCES connections(id),
        status          TEXT NOT NULL DEFAULT 'Draft',
        error_message   TEXT,
        wizard_step     TEXT,
        draft_config    TEXT,
        warnings        TEXT,
        auto_injected_junctions TEXT,
        analyzed_at     INTEGER,
        created_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        updated_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );
      INSERT INTO deployments_new
        (id, name, source_connection_id, target_connection_id, status, error_message,
         wizard_step, draft_config, warnings, auto_injected_junctions, analyzed_at,
         created_at, updated_at)
        SELECT id, name, source_alias, target_alias, status, error_message,
               wizard_step, draft_config, warnings, auto_injected_junctions, analyzed_at,
               created_at, updated_at
        FROM deployments;
      DROP TABLE deployments;
      ALTER TABLE deployments_new RENAME TO deployments;

      CREATE TABLE oauth_tokens (
        connection_id    TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
        access_token_ct  BLOB,
        refresh_token_ct BLOB,
        instance_url     TEXT,
        issued_at        INTEGER,
        refreshed_at     INTEGER
      );
    `
  },
  {
    // 004 — reusable wizard templates (5B.5). One row per saved template, keyed by
    // (kind, name): kind 'mappings' holds a WizardConfig['mappings'] JSON payload;
    // 'objects'/'fields' are reserved for later steps. Pure additive table — no FK
    // rebuild, so it passes foreign_key_check without the OFF/ON dance.
    id: '004-templates',
    sql: `
      CREATE TABLE templates (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        kind        TEXT NOT NULL,
        name        TEXT NOT NULL,
        payload     TEXT NOT NULL,   -- JSON; shape depends on kind
        created_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        updated_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        UNIQUE (kind, name)
      );
    `
  },
  {
    // 005 — deploy run state (E2.5, deployDesign.md §1.3; the doc's "migration
    // 002" label predates the S31 renumbering — 002/003/004 were taken by the
    // wizard data layer, auth, and templates).
    //
    // plans          — frozen DeployPlan JSON + content hash, versioned per
    //                  deployment. The orchestrator reads ONLY a frozen plan;
    //                  wizard edits after freeze require a re-freeze (new
    //                  version, new hash).
    // deploy_runs    — one row per deploy execution. Resume-point granularity
    //                  is (current_object, current_pass): resuming re-runs the
    //                  interrupted object's pass from batch 0 (ExtId upsert
    //                  idempotency makes that safe — same contract as the Apex
    //                  whole-object retry).
    // failed_records — relational replacement for Retry_Source_Ids__c /
    //                  Retry_Pending_Ids__c / Persistent_Failed_Source_Ids__c.
    //                  Keyed by (run, object, pass, retry_pass, object_attempt,
    //                  source_id) — Apex "appendMode" bookkeeping and the
    //                  FINDINGS #15/#16 miscount family are impossible by
    //                  construction.
    // retry_queue    — the targeted-retry input queue (Apex Retry_Pending_Ids
    //                  drained in 150-Id chunks; insertion order preserved).
    //
    // record_results is REBUILT (FK-referenced → needs the foreign_keys OFF
    // dance migrate() already performs) to add the run-scoped counting keys:
    //   run_id / object_api_name / retry_pass / object_attempt.
    // deployment_object_id becomes NULLABLE: engine rows link to the run (and
    // survive a re-analysis, which deletes+recreates deployment_objects);
    // legacy rows keep their old CASCADE linkage.
    //
    // COUNTERS ARE COMPUTED, NOT ACCUMULATED — SQL views reproduce the frozen
    // Apex semantics (the oracle, with line cites):
    //   v_run_object_attempt  latest whole-object attempt per (run, object):
    //                         the bounded whole-object retry zeroes all six
    //                         counters and re-runs from batch 0 (DDQ L119-139)
    //                         → views count ONLY the latest attempt.
    //   v_run_record_current  the LATEST row (MAX id) per source record within
    //                         that attempt, first-pass family only — the
    //                         "current truth, not the historical attempt log"
    //                         contract (DDS L1220-1227). Reproduces:
    //                         fresh-page RESET vs retry/pagination APPEND
    //                         (DDQ L1951-1996) and targeted-retry counter
    //                         zeroing (DDQ L2968-2987) — a record retried at
    //                         retry_pass N counts by its N-pass outcome only.
    //   v_run_object_queried  Records_Queried/Skipped are FIRST-PASS-ONLY
    //                         (retryInputIds == null gate, DDQ L1989-1996):
    //                         queried = ALL retry_pass-0 rows of the latest
    //                         attempt (recordCount + batchSkipCount per page).
    //   v_run_object_counters the Deployment_Object__c sextet. Root+Cascade ≡
    //                         Failed by construction: a failed row's bucket
    //                         comes from failed_records.classification,
    //                         defaulting to 'root' (classifyFailures' default
    //                         bucket, DDQ L2214-2296). pass=2 rows are invisible
    //                         to every view — the Apex second pass never
    //                         touches counters (executeSecondPassV2 logs only;
    //                         second-pass prep explicitly does NOT reset
    //                         Records_Failed, DDQ L3025-3034).
    //   v_run_counters        recomputeDeploymentCounters SUM rollup
    //                         (DDS L1228-1263; Total_Records comes from the
    //                         frozen plan, not from results).
    id: '005-deploy-run-state',
    sql: `
      CREATE TABLE plans (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        deployment_id INTEGER NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
        version       INTEGER NOT NULL,
        plan_json     TEXT NOT NULL,
        plan_hash     TEXT NOT NULL,
        created_at    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        UNIQUE (deployment_id, version)
      );

      CREATE TABLE deploy_runs (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        deployment_id    INTEGER NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
        plan_id          INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        plan_hash        TEXT NOT NULL,
        phase            TEXT NOT NULL DEFAULT 'Frozen',
        current_object   TEXT,
        current_pass     TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        -- Stamped at teardown ENTRY; non-null means the walk is over and any
        -- resume must re-enter teardown with THIS outcome (a cancelled run
        -- crashed mid-teardown must never resurrect as completed).
        teardown_outcome TEXT CHECK (teardown_outcome IN ('completed','cancelled','failed')),
        finalize_done    INTEGER NOT NULL DEFAULT 0,
        started_at       INTEGER,
        finished_at      INTEGER,
        created_at       INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );
      CREATE INDEX idx_deploy_runs_deployment ON deploy_runs(deployment_id);

      CREATE TABLE failed_records (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id          INTEGER NOT NULL REFERENCES deploy_runs(id) ON DELETE CASCADE,
        object_api_name TEXT NOT NULL,
        pass            INTEGER NOT NULL DEFAULT 1,
        retry_pass      INTEGER NOT NULL DEFAULT 0,
        object_attempt  INTEGER NOT NULL DEFAULT 0,
        source_id       TEXT NOT NULL,
        ext_id          TEXT,
        error_code      TEXT,
        error_message   TEXT,             -- FULL error text, no 255-char truncation
        fields_json     TEXT,             -- JSON array of offending field names
        classification  TEXT CHECK (classification IN ('root','cascade')),
        created_at      INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        UNIQUE (run_id, object_api_name, pass, retry_pass, object_attempt, source_id)
      );

      CREATE TABLE retry_queue (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id          INTEGER NOT NULL REFERENCES deploy_runs(id) ON DELETE CASCADE,
        object_api_name TEXT NOT NULL,
        source_id       TEXT NOT NULL,
        attempt         INTEGER NOT NULL DEFAULT 0,
        UNIQUE (run_id, object_api_name, source_id)
      );

      ALTER TABLE automation_ledger_mirror ADD COLUMN run_uuid TEXT;
      ALTER TABLE automation_ledger_mirror ADD COLUMN restore_version_number INTEGER;

      CREATE TABLE record_results_new (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id               INTEGER REFERENCES deploy_runs(id) ON DELETE CASCADE,
        deployment_object_id INTEGER REFERENCES deployment_objects(id) ON DELETE CASCADE,
        object_api_name      TEXT NOT NULL DEFAULT '',
        source_id            TEXT NOT NULL,
        target_id            TEXT,
        pass                 INTEGER NOT NULL DEFAULT 1,  -- 1 = first-pass family, 2 = deferred second pass
        retry_pass           INTEGER NOT NULL DEFAULT 0,  -- 0 = fresh page walk, 1..5 = targeted retries
        object_attempt       INTEGER NOT NULL DEFAULT 0,  -- bounded whole-object retry counter
        outcome              TEXT NOT NULL,               -- 'success' | 'failed' | 'skipped'
        error_code           TEXT,
        error_message        TEXT,                        -- FULL error text, no 255-char truncation
        attempted_at         INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      );
      INSERT INTO record_results_new
        (id, run_id, deployment_object_id, object_api_name, source_id, target_id,
         pass, outcome, error_code, error_message, attempted_at)
        SELECT rr.id, NULL, rr.deployment_object_id, COALESCE(o.object_api_name, ''),
               rr.source_id, rr.target_id, rr.pass, rr.outcome, rr.error_code,
               rr.error_message, rr.attempted_at
        FROM record_results rr
        LEFT JOIN deployment_objects o ON o.id = rr.deployment_object_id;
      DROP TABLE record_results;
      ALTER TABLE record_results_new RENAME TO record_results;
      CREATE INDEX idx_record_results_object ON record_results(deployment_object_id, outcome);
      CREATE INDEX idx_record_results_run ON record_results(run_id, object_api_name, pass, source_id);

      CREATE VIEW v_run_object_attempt AS
        SELECT run_id, object_api_name, MAX(object_attempt) AS latest_attempt
        FROM record_results
        WHERE run_id IS NOT NULL AND pass = 1
        GROUP BY run_id, object_api_name;

      CREATE VIEW v_run_record_current AS
        SELECT rr.*
        FROM record_results rr
        JOIN (
          SELECT r.run_id, r.object_api_name, r.source_id, MAX(r.id) AS max_id
          FROM record_results r
          JOIN v_run_object_attempt la
            ON la.run_id = r.run_id AND la.object_api_name = r.object_api_name
          WHERE r.pass = 1 AND r.object_attempt = la.latest_attempt
          GROUP BY r.run_id, r.object_api_name, r.source_id
        ) latest ON latest.max_id = rr.id;

      CREATE VIEW v_run_object_queried AS
        SELECT r.run_id, r.object_api_name, COUNT(*) AS records_queried
        FROM record_results r
        JOIN v_run_object_attempt la
          ON la.run_id = r.run_id AND la.object_api_name = r.object_api_name
        WHERE r.pass = 1 AND r.retry_pass = 0 AND r.object_attempt = la.latest_attempt
        GROUP BY r.run_id, r.object_api_name;

      CREATE VIEW v_run_object_counters AS
        SELECT
          cur.run_id,
          cur.object_api_name,
          COALESCE(MAX(q.records_queried), 0)                       AS records_queried,
          SUM(CASE WHEN cur.outcome = 'success' THEN 1 ELSE 0 END)  AS records_deployed,
          SUM(CASE WHEN cur.outcome = 'failed'  THEN 1 ELSE 0 END)  AS records_failed,
          SUM(CASE WHEN cur.outcome = 'failed'
                    AND COALESCE(fr.classification, 'root') = 'root'
                   THEN 1 ELSE 0 END)                               AS records_failed_root,
          SUM(CASE WHEN cur.outcome = 'failed'
                    AND fr.classification = 'cascade'
                   THEN 1 ELSE 0 END)                               AS records_failed_cascade,
          -- FIRST-PASS-ONLY like Queried (DDQ L1989-1996 gates BOTH on
          -- retryInputIds == null): a record transform-skipped during a
          -- targeted retry counts NOWHERE — its latest row is 'skipped' at
          -- retry_pass>0, so it leaves failed AND is excluded here, exactly
          -- like Apex (Failed zeroed at retry entry, skip never appended).
          -- (E2.5 review finding, empirically verified vs the oracle.)
          SUM(CASE WHEN cur.outcome = 'skipped' AND cur.retry_pass = 0
                   THEN 1 ELSE 0 END)                               AS records_skipped
        FROM v_run_record_current cur
        LEFT JOIN v_run_object_queried q
          ON q.run_id = cur.run_id AND q.object_api_name = cur.object_api_name
        LEFT JOIN failed_records fr
          ON fr.run_id = cur.run_id AND fr.object_api_name = cur.object_api_name
         AND fr.source_id = cur.source_id AND fr.pass = 1
         AND fr.retry_pass = cur.retry_pass AND fr.object_attempt = cur.object_attempt
        GROUP BY cur.run_id, cur.object_api_name;

      CREATE VIEW v_run_counters AS
        SELECT run_id,
               SUM(records_queried)        AS records_queried,
               SUM(records_deployed)       AS records_deployed,
               SUM(records_failed)         AS records_failed,
               SUM(records_failed_root)    AS records_failed_root,
               SUM(records_failed_cascade) AS records_failed_cascade,
               SUM(records_skipped)        AS records_skipped
        FROM v_run_object_counters
        GROUP BY run_id;
    `
  },
  {
    // 006 — attempt linkage (S47, review of Session A). Two nullable columns:
    // deployments.current_run_id — the deploy_runs row of the CURRENT attempt.
    //   Cleared at job start (markDeployStarted), set right after createRun.
    //   NULL while the attempt is in connect/gates/freeze or when it failed
    //   there, so the detail page can tell "this attempt has no run yet /
    //   never got one" from "the previous run" without guessing from the
    //   newest row (a fix-and-redeploy would otherwise show the old run).
    // deploy_runs.cpq_trigger_setting — the target's hasCpqTriggerSetting at
    //   gate time (1/0), so the post-run CPQ reminder mirrors the LWC's
    //   `!hasCpqTriggerSetting && any gated` (PLAN D2) instead of hedging.
    // (PLAN C1 reserved 006 for template provenance — that becomes 007.)
    id: '006-attempt-linkage',
    sql: `
      ALTER TABLE deployments ADD COLUMN current_run_id INTEGER;
      ALTER TABLE deploy_runs ADD COLUMN cpq_trigger_setting INTEGER;
    `
  },
  {
    // 007 — counter-view performance. NO semantic change: the counter columns
    // are the frozen-Apex accumulation oracle and stay byte-identical (pinned
    // by deployStore.store.test.ts). This is a JOIN-ORDER + INDEX fix.
    //
    // MEASURED (2026-09-07, S50): with 13,200 record_results / 4,400
    // failed_records — about a 20-account run — `objectCounters` took
    // **71 seconds**; at 8,008 failures it took **5 minutes 27 seconds** for a
    // single call. `countersFor` (orchestrator) calls it per object per retry
    // round, so 11 objects x 5 rounds is measured in HOURS. And it is not
    // merely slow: there is no worker/utilityProcess in src/main,
    // `runDeployment` is awaited on the main process, and better-sqlite3 is
    // synchronous — so the whole event loop, every ipcMain handler and the
    // cancel path stall. The run becomes unresponsive AND uncancellable.
    //
    // ROOT CAUSE, from EXPLAIN QUERY PLAN:
    //     CO-ROUTINE latest ... SEARCH rr USING INDEX ... / SCAN latest
    // `v_run_record_current` joined `record_results rr` to the un-materialized
    // `latest` co-routine as `latest.max_id = rr.id`, with rr as the OUTER
    // table. A co-routine cannot be indexed, so SQLite re-scanned the entire
    // grouped subquery once PER ROW of record_results — O(n^2), and each scan
    // re-derived v_run_object_attempt's GROUP BY over the whole table.
    //
    // FIX: drive from `latest` and look `rr` up by INTEGER PRIMARY KEY, which
    // is a single b-tree seek per group. Identical rows (inner join, same
    // predicate, still SELECT rr.*) — only the drive order changes. Plus one
    // covering index for the MAX(id)-per-source_id grouping and for
    // v_run_object_attempt, which share a column prefix.
    id: '007-counter-view-perf',
    sql: `
      DROP VIEW v_run_counters;
      DROP VIEW v_run_object_counters;
      DROP VIEW v_run_record_current;

      -- Simply reordering the FROM clause is NOT enough: SQLite reorders joins
      -- freely and still picked record_results as the outer table (measured:
      -- 71s -> 53s, still quadratic). Two explicit planner directives are
      -- required, and both are load-bearing:
      --   * AS MATERIALIZED  — forces each CTE to be computed ONCE into a temp
      --     b-tree instead of being re-run as a co-routine per outer row.
      --     (SQLite 3.35+; bundled build is 3.53.2.)
      --   * CROSS JOIN       — the documented way to pin join order in SQLite.
      --     'latest' must drive, so 'rr' is reached by INTEGER PRIMARY KEY.
      -- v_run_object_attempt is inlined as its own materialized CTE for the
      -- same reason; as a view reference it was re-derived inside the loop.
      CREATE VIEW v_run_record_current AS
        WITH la AS MATERIALIZED (
          SELECT run_id, object_api_name, MAX(object_attempt) AS latest_attempt
          FROM record_results
          WHERE run_id IS NOT NULL AND pass = 1
          GROUP BY run_id, object_api_name
        ),
        latest AS MATERIALIZED (
          SELECT r.run_id, r.object_api_name, r.source_id, MAX(r.id) AS max_id
          FROM record_results r
          JOIN la
            ON la.run_id = r.run_id AND la.object_api_name = r.object_api_name
          WHERE r.pass = 1 AND r.object_attempt = la.latest_attempt
          GROUP BY r.run_id, r.object_api_name, r.source_id
        )
        SELECT rr.*
        FROM latest
        CROSS JOIN record_results rr ON rr.id = latest.max_id;

      CREATE VIEW v_run_object_counters AS
        SELECT
          cur.run_id,
          cur.object_api_name,
          COALESCE(MAX(q.records_queried), 0)                       AS records_queried,
          SUM(CASE WHEN cur.outcome = 'success' THEN 1 ELSE 0 END)  AS records_deployed,
          SUM(CASE WHEN cur.outcome = 'failed'  THEN 1 ELSE 0 END)  AS records_failed,
          SUM(CASE WHEN cur.outcome = 'failed'
                    AND COALESCE(fr.classification, 'root') = 'root'
                   THEN 1 ELSE 0 END)                               AS records_failed_root,
          SUM(CASE WHEN cur.outcome = 'failed'
                    AND fr.classification = 'cascade'
                   THEN 1 ELSE 0 END)                               AS records_failed_cascade,
          SUM(CASE WHEN cur.outcome = 'skipped' AND cur.retry_pass = 0
                   THEN 1 ELSE 0 END)                               AS records_skipped
        FROM v_run_record_current cur
        LEFT JOIN v_run_object_queried q
          ON q.run_id = cur.run_id AND q.object_api_name = cur.object_api_name
        LEFT JOIN failed_records fr
          ON fr.run_id = cur.run_id AND fr.object_api_name = cur.object_api_name
         AND fr.source_id = cur.source_id AND fr.pass = 1
         AND fr.retry_pass = cur.retry_pass AND fr.object_attempt = cur.object_attempt
        GROUP BY cur.run_id, cur.object_api_name;

      CREATE VIEW v_run_counters AS
        SELECT run_id,
               SUM(records_queried)        AS records_queried,
               SUM(records_deployed)       AS records_deployed,
               SUM(records_failed)         AS records_failed,
               SUM(records_failed_root)    AS records_failed_root,
               SUM(records_failed_cascade) AS records_failed_cascade,
               SUM(records_skipped)        AS records_skipped
        FROM v_run_object_counters
        GROUP BY run_id;

      CREATE INDEX idx_record_results_latest
        ON record_results(run_id, object_api_name, pass, object_attempt, source_id, id);

      -- currentFailures' two correlated MAX() subqueries. The implicit UNIQUE
      -- index is (run_id, object_api_name, pass, retry_pass, object_attempt,
      -- source_id): retry_pass sits BETWEEN the equality columns and
      -- object_attempt, so the MAX(object_attempt) probe cannot seek and scans
      -- the whole (run, object, pass) slice. Reordering so both attempt and
      -- retry_pass are trailing, DESC, makes each MAX a seek-to-first.
      CREATE INDEX idx_failed_records_latest
        ON failed_records(run_id, pass, object_api_name, object_attempt DESC, retry_pass DESC);
    `
  },
  {
    // 008 — stripped-reference ledger (S50 A5). Observability ONLY; nothing
    // reads this to make a deploy decision.
    //
    // WHY: `stripMissingParentRefs` drops a lookup whose parent is not on
    // target so the row still deploys. For a REQUIRED lookup that surfaces as
    // a loud REQUIRED_FIELD_MISSING which the retry drain then heals. For a
    // NILLABLE one the row deploys with a null FK and NOTHING ever re-links it
    // — the second pass only revisits DEFERRED fields. That is a silent
    // orphan, and until now the only trace was one aggregated per-batch
    // Warning line.
    //
    // Live cost (run 9, express scripts, 2026-09-07): the root Account failed,
    // and 249 Contacts + 18 Opportunities + 5 Quotes landed on sb1_830 with no
    // account link while the run reported Completed. There was no way to
    // enumerate them afterwards without diffing the orgs by hand.
    //
    // Deliberately NOT a skip: an earlier design skipped these children, which
    // is a regression — a skipped record has records_failed = 0, is never
    // selected by retryRounds, and is permanently dropped, whereas today the
    // required case self-heals on retry.
    id: '008-stripped-refs',
    sql: `
      CREATE TABLE stripped_refs (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id            INTEGER NOT NULL REFERENCES deploy_runs(id) ON DELETE CASCADE,
        object_api_name   TEXT    NOT NULL,
        source_id         TEXT    NOT NULL,
        field_name        TEXT    NOT NULL,
        relationship_name TEXT    NOT NULL,
        ref_object        TEXT    NOT NULL,
        parent_ext_id     TEXT    NOT NULL,
        -- reverse(parent_ext_id), stored because SQL cannot reverse a string
        -- and the orphan roll-up joins it against record_results.source_id.
        parent_source_id  TEXT    NOT NULL,
        pass              INTEGER NOT NULL,
        retry_pass        INTEGER NOT NULL,
        object_attempt    INTEGER NOT NULL,
        created_at        INTEGER NOT NULL,
        UNIQUE (run_id, object_api_name, source_id, field_name, object_attempt, retry_pass)
      );
      CREATE INDEX idx_stripped_refs_run ON stripped_refs(run_id, ref_object);
    `
  },
  {
    // S52 F3 — connection supersession. Rows are keyed on the sf ALIAS, but one
    // sf username has exactly one auth; `sf org list` reports one alias per
    // username (the newest). An alias rename or a sandbox refresh therefore
    // inserted a sibling row and left the old one untouched forever — stale
    // org id, stale status, and a role that did not follow the org (S52:
    // darkb_829/source + darkb_911/unassigned; onesolve/target + one_solve).
    // `superseded_by` names the live sibling; pickers hide superseded rows,
    // deployments that reference them keep working (the alias still mints).
    id: '009-connection-supersession',
    sql: `
      ALTER TABLE connections ADD COLUMN superseded_by TEXT REFERENCES connections(id) ON DELETE SET NULL;
    `
  },
  {
    // S53 (item 1) — the automation-born-row audit. Observability ONLY;
    // nothing reads this to make a deploy decision.
    //
    // WHY: every record the engine writes carries the upsert key, so a re-run
    // updates in place. Rows the TARGET's own automation creates during a load
    // (CPQ quote→opp sync spawning OLIs, bundle triggers auto-adding option
    // quote lines, contracting spawning Contract/Subscription/Asset) carry NO
    // key, are invisible to the upsert forever, and surface to the user as
    // "two of every product on the opportunity" after a re-run (the re-run test
    // deployments on sb1_830, S49). The engine had no detection at all. Findings are
    // persisted per run so the deployment page can show them after the fact;
    // `deploy_runs.audit_*` distinguishes "audited, clean" from "not audited".
    id: '010-run-audit-findings',
    sql: `
      CREATE TABLE run_audit_findings (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id          INTEGER NOT NULL REFERENCES deploy_runs(id) ON DELETE CASCADE,
        kind            TEXT    NOT NULL,   -- 'automation_born' | 'pre_run_unkeyed'
        object_api_name TEXT    NOT NULL,
        ref_object      TEXT,               -- pre_run_unkeyed: the keyed parent object
        ref_field       TEXT,               -- pre_run_unkeyed: the lookup to it
        row_count       INTEGER NOT NULL,
        sample_ids      TEXT,               -- JSON array of target ids (≤5)
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_run_audit_findings_run ON run_audit_findings(run_id, kind);
      ALTER TABLE deploy_runs ADD COLUMN audit_completed_at INTEGER;
      ALTER TABLE deploy_runs ADD COLUMN audit_note TEXT;
    `
  }
]

export class Store implements OAuthTokenStore {
  private db: Database.Database
  /** Deploy-run state facade (E2.5) — the surface DeployIo.store binds to. */
  readonly deploy: DeployStore

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
    this.deploy = new DeployStore(this.db)
  }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
    )`)
    const applied = new Set(
      (this.db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map(
        (r) => r.id
      )
    )
    const pending = MIGRATIONS.filter((m) => !applied.has(m.id))
    if (pending.length === 0) return

    // Some migrations (003) rebuild FK-referenced tables (DROP+RENAME), which
    // requires foreign_keys OFF. PRAGMA foreign_keys is a NO-OP inside a
    // transaction, so it must be toggled around the whole batch. Each migration
    // still runs in its own transaction, and we assert foreign_key_check inside
    // it so a broken rebuild rolls back instead of leaving dangling FKs.
    this.db.pragma('foreign_keys = OFF')
    try {
      for (const m of pending) {
        const run = this.db.transaction(() => {
          this.db.exec(m.sql)
          this.db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(m.id)
          const violations = this.db.pragma('foreign_key_check') as unknown[]
          if (violations.length > 0) {
            throw new Error(
              `Migration ${m.id} left foreign-key violations: ${JSON.stringify(violations)}`
            )
          }
        })
        run()
      }
    } finally {
      this.db.pragma('foreign_keys = ON')
    }
  }

  // ── Connections ─────────────────────────────────────────────

  /**
   * Merges a fresh CLI enumeration into the registry. Existing rows keep
   * their assigned role; new orgs arrive 'unassigned'. Prod is pinned to
   * 'source' no matter what the stored row says.
   */
  upsertConnections(
    cliOrgs: {
      alias: string
      username: string
      orgId: string
      instanceUrl: string
      connectedStatus: string
      isSandbox: boolean | null
    }[]
  ): void {
    // CLI rows use id = cli_alias = label = the sf alias (a stable text key), so
    // deployment FKs that stored the alias re-point verbatim. ON CONFLICT keys on
    // cli_alias (== id for CLI rows), preserving an assigned role across refreshes.
    const stmt = this.db.prepare(`
      INSERT INTO connections
        (id, label, cli_alias, username, org_id, instance_url, cli_status, is_sandbox, auth_kind, status)
      VALUES
        (@alias, @alias, @alias, @username, @orgId, @instanceUrl, @connectedStatus, @isSandbox, 'cli', 'Active')
      ON CONFLICT(cli_alias) DO UPDATE SET
        username = excluded.username,
        org_id = excluded.org_id,
        instance_url = excluded.instance_url,
        cli_status = excluded.cli_status,
        is_sandbox = excluded.is_sandbox
    `)
    const tx = this.db.transaction(() => {
      for (const o of cliOrgs) {
        stmt.run({ ...o, isSandbox: o.isSandbox === null ? null : o.isSandbox ? 1 : 0 })
      }
      this.reconcileSupersededConnections(cliOrgs)
    })
    tx()
  }

  /** CLI-reported status for a row whose alias the CLI no longer knows at all. */
  static readonly CLI_STATUS_NOT_IN_CLI = 'Not in CLI'

  /**
   * S52 F3 — after an enumeration, classify every CLI row the CLI did NOT list:
   *   • another listed alias shares its username → SUPERSEDED by that row (same
   *     auth, new name / refreshed org). Copy the live org id + instance URL so
   *     the prod pin and labels stay truthful, and — Decision A, Jack 2026-09-11 —
   *     carry the old row's role onto the live row when the live row is still
   *     unassigned. The old row keeps its role: deployments may reference it.
   *   • no listed alias shares its username → 'Not in CLI' (sf org logout).
   * A row that is listed again is un-superseded. Runs inside upsertConnections'
   * transaction.
   */
  private reconcileSupersededConnections(
    cliOrgs: {
      alias: string
      username: string
      orgId: string
      instanceUrl: string
      connectedStatus: string
    }[]
  ): void {
    const listedAliases = new Set(cliOrgs.map((o) => o.alias))
    const liveByUsername = new Map(cliOrgs.map((o) => [o.username, o]))
    const rows = this.db
      .prepare(
        `SELECT id, cli_alias, username, role FROM connections WHERE auth_kind = 'cli' AND cli_alias IS NOT NULL`
      )
      .all() as { id: string; cli_alias: string; username: string; role: OrgRole }[]
    const unsupersede = this.db.prepare('UPDATE connections SET superseded_by = NULL WHERE id = ?')
    const supersede = this.db.prepare(
      `UPDATE connections SET superseded_by = @by, org_id = @orgId, instance_url = @instanceUrl,
         cli_status = @cliStatus WHERE id = @id`
    )
    const notInCli = this.db.prepare(
      'UPDATE connections SET superseded_by = NULL, cli_status = ? WHERE id = ?'
    )
    const carryRole = this.db.prepare(
      `UPDATE connections SET role = ? WHERE id = ? AND role = 'unassigned'`
    )
    for (const r of rows) {
      if (listedAliases.has(r.cli_alias)) {
        unsupersede.run(r.id)
        continue
      }
      const live = liveByUsername.get(r.username)
      if (live && live.alias !== r.id) {
        supersede.run({
          by: live.alias,
          orgId: live.orgId,
          instanceUrl: live.instanceUrl,
          cliStatus: live.connectedStatus,
          id: r.id
        })
        if (r.role !== 'unassigned' && !live.orgId.startsWith(PROD_ORG_ID_PREFIX)) {
          carryRole.run(r.role, live.alias)
        }
      } else {
        notInCli.run(Store.CLI_STATUS_NOT_IN_CLI, r.id)
      }
    }
  }

  private rowToConnection(r: Record<string, unknown>): OrgConnection {
    const orgId = String(r.org_id ?? '')
    const prodPinned = orgId.startsWith(PROD_ORG_ID_PREFIX)
    return {
      id: String(r.id),
      label: String(r.label ?? r.cli_alias ?? r.id),
      cliAlias: r.cli_alias != null ? String(r.cli_alias) : null,
      loginUrl: r.login_url != null ? String(r.login_url) : null,
      username: String(r.username),
      orgId,
      instanceUrl: String(r.instance_url ?? ''),
      role: prodPinned ? 'source' : (String(r.role) as OrgRole),
      authKind: r.auth_kind === 'oauth' ? 'oauth' : 'cli',
      status: String(r.status ?? 'Active') as OrgConnection['status'],
      cliStatus: String(r.cli_status ?? 'Unknown'),
      isSandbox: r.is_sandbox === null || r.is_sandbox === undefined ? null : r.is_sandbox === 1,
      lastVerifiedAt: (r.last_verified_at as number | null) ?? null,
      prodPinned,
      supersededBy: r.superseded_by != null ? String(r.superseded_by) : null
    }
  }

  listConnections(): OrgConnection[] {
    const rows = this.db
      .prepare('SELECT * FROM connections ORDER BY label, cli_alias')
      .all() as Record<string, unknown>[]
    return rows.map((r) => this.rowToConnection(r))
  }

  getConnection(connectionId: string): OrgConnection | undefined {
    const row = this.db.prepare('SELECT * FROM connections WHERE id = ?').get(connectionId) as
      Record<string, unknown> | undefined
    return row ? this.rowToConnection(row) : undefined
  }

  setRole(connectionId: string, role: OrgRole): void {
    const row = this.db.prepare('SELECT org_id FROM connections WHERE id = ?').get(connectionId) as
      { org_id: string } | undefined
    if (!row) throw new Error(`Unknown connection: ${connectionId}`)
    if (role === 'target' && row.org_id.startsWith(PROD_ORG_ID_PREFIX)) {
      throw new Error('LaunchDarkly production is permanently read-only and can never be a target.')
    }
    this.db.prepare('UPDATE connections SET role = ? WHERE id = ?').run(role, connectionId)
  }

  markVerified(connectionId: string, orgId: string): void {
    this.db
      .prepare('UPDATE connections SET last_verified_at = ?, org_id = ? WHERE id = ?')
      .run(Date.now(), orgId, connectionId)
  }

  /**
   * Create an OAuth-authenticated connection row. `id` is caller-generated (a
   * UUID) so the store stays crypto-free and tests are deterministic; tokens are
   * persisted separately via the TokenVault. Prod stays pinned read-only
   * downstream (rowToConnection forces role, setRole blocks target).
   */
  createOAuthConnection(input: {
    id: string
    label: string
    username: string
    orgId: string
    instanceUrl: string
    loginUrl: string
    oauthClientId: string | null
    oauthClientKind?: 'connectedApp' | 'externalClientApp'
    isSandbox: boolean | null
  }): OrgConnection {
    this.db
      .prepare(
        `INSERT INTO connections
           (id, label, cli_alias, username, org_id, instance_url, login_url,
            role, auth_kind, oauth_client_id, oauth_client_kind, status, cli_status, is_sandbox)
         VALUES
           (@id, @label, NULL, @username, @orgId, @instanceUrl, @loginUrl,
            'unassigned', 'oauth', @oauthClientId, @oauthClientKind, 'Active', 'OAuth', @isSandbox)`
      )
      .run({
        ...input,
        oauthClientKind: input.oauthClientKind ?? 'externalClientApp',
        isSandbox: input.isSandbox === null ? null : input.isSandbox ? 1 : 0
      })
    const row = this.getConnection(input.id)
    if (!row) throw new Error('createOAuthConnection failed to persist')
    return row
  }

  /** Mark a connection Active and (on re-auth) adopt a fresh org id / instance / username. */
  markConnectionActive(
    connectionId: string,
    patch?: { instanceUrl?: string; orgId?: string; username?: string }
  ): void {
    this.db
      .prepare(
        `UPDATE connections SET
           status = 'Active',
           instance_url = COALESCE(@instanceUrl, instance_url),
           org_id = COALESCE(@orgId, org_id),
           username = COALESCE(@username, username),
           last_verified_at = @now
         WHERE id = @id`
      )
      .run({
        id: connectionId,
        instanceUrl: patch?.instanceUrl ?? null,
        orgId: patch?.orgId ?? null,
        username: patch?.username ?? null,
        now: Date.now()
      })
  }

  setConnectionStatus(connectionId: string, status: OrgConnection['status']): void {
    this.db.prepare('UPDATE connections SET status = ? WHERE id = ?').run(status, connectionId)
  }

  /**
   * S53 (item 2) — the OTHER deployments that write into the same target org as
   * `deploymentId`. "Same org" is the connection's org id (which also unifies a
   * superseded alias and its live sibling — S52 F3); a row with a blank org id
   * (never verified OAuth) falls back to the same connection id. Input to the
   * per-target-org run lock (services/runLock.ts).
   */
  deploymentsSharingTarget(deploymentId: number): { id: number; name: string }[] {
    const me = this.db
      .prepare(
        `SELECT d.target_connection_id AS cid, COALESCE(c.org_id, '') AS org_id
         FROM deployments d LEFT JOIN connections c ON c.id = d.target_connection_id
         WHERE d.id = ?`
      )
      .get(deploymentId) as { cid: string; org_id: string } | undefined
    if (!me) return []
    const rows = this.db
      .prepare(
        `SELECT d.id, d.name
         FROM deployments d LEFT JOIN connections c ON c.id = d.target_connection_id
         WHERE d.id != @id
           AND (d.target_connection_id = @cid OR (@orgId != '' AND c.org_id = @orgId))
         ORDER BY d.id`
      )
      .all({ id: deploymentId, cid: me.cid, orgId: me.org_id }) as { id: number; name: string }[]
    return rows.map((r) => ({ id: Number(r.id), name: String(r.name) }))
  }

  /** True when a deployment still references this connection (blocks hard delete). */
  isConnectionReferenced(connectionId: string): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 FROM deployments WHERE source_connection_id = ? OR target_connection_id = ? LIMIT 1'
      )
      .get(connectionId, connectionId)
    return !!row
  }

  /**
   * Hard-delete a connection (its oauth_tokens row cascades via the A2 FK, and
   * we wipe upstream anyway). Throws if a deployment still references it.
   */
  deleteConnection(connectionId: string): void {
    if (this.isConnectionReferenced(connectionId)) {
      throw new Error(
        'This connection is used by a deployment — remove it from the deployment before disconnecting.'
      )
    }
    this.db.prepare('DELETE FROM connections WHERE id = ?').run(connectionId)
  }

  // ── Settings ────────────────────────────────────────────────

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined
    return row ? row.value : null
  }

  putSetting(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value)
  }

  // ── OAuth tokens (A3 TokenVault backing store; ciphertext BLOBs) ─────

  putOAuthTokens(input: {
    connectionId: string
    accessTokenCt: Buffer
    refreshTokenCt: Buffer | null
    instanceUrl: string
    issuedAt: number
  }): void {
    this.db
      .prepare(
        `INSERT INTO oauth_tokens
           (connection_id, access_token_ct, refresh_token_ct, instance_url, issued_at, refreshed_at)
         VALUES (@connectionId, @accessTokenCt, @refreshTokenCt, @instanceUrl, @issuedAt, NULL)
         ON CONFLICT(connection_id) DO UPDATE SET
           access_token_ct = excluded.access_token_ct,
           refresh_token_ct = excluded.refresh_token_ct,
           instance_url = excluded.instance_url,
           issued_at = excluded.issued_at,
           refreshed_at = NULL`
      )
      .run(input)
  }

  getOAuthTokenRow(connectionId: string): StoredTokenRow | null {
    const row = this.db
      .prepare(
        'SELECT access_token_ct, refresh_token_ct, instance_url, issued_at, refreshed_at FROM oauth_tokens WHERE connection_id = ?'
      )
      .get(connectionId) as
      | {
          access_token_ct: Buffer | null
          refresh_token_ct: Buffer | null
          instance_url: string | null
          issued_at: number | null
          refreshed_at: number | null
        }
      | undefined
    if (!row) return null
    return {
      accessTokenCt: row.access_token_ct ?? null,
      refreshTokenCt: row.refresh_token_ct ?? null,
      instanceUrl: row.instance_url ?? null,
      issuedAt: row.issued_at ?? null,
      refreshedAt: row.refreshed_at ?? null
    }
  }

  updateOAuthAccessCt(
    connectionId: string,
    accessTokenCt: Buffer,
    instanceUrl: string,
    refreshedAt: number
  ): void {
    this.db
      .prepare(
        'UPDATE oauth_tokens SET access_token_ct = ?, instance_url = ?, refreshed_at = ? WHERE connection_id = ?'
      )
      .run(accessTokenCt, instanceUrl, refreshedAt, connectionId)
  }

  wipeOAuthTokens(connectionId: string): void {
    this.db.prepare('DELETE FROM oauth_tokens WHERE connection_id = ?').run(connectionId)
  }

  // ── Describe cache ──────────────────────────────────────────

  getCachedDescribe(
    orgId: string,
    objectApiName: string
  ): { payload: string; fetchedAt: number } | null {
    const row = this.db
      .prepare(
        'SELECT payload, fetched_at FROM describe_cache WHERE org_id = ? AND object_api_name = ?'
      )
      .get(orgId, objectApiName) as { payload: string; fetched_at: number } | undefined
    return row ? { payload: row.payload, fetchedAt: row.fetched_at } : null
  }

  putCachedDescribe(orgId: string, objectApiName: string, payload: string): void {
    this.db
      .prepare(
        `
      INSERT INTO describe_cache (org_id, object_api_name, payload, fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(org_id, object_api_name) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
    `
      )
      .run(orgId, objectApiName, payload, Date.now())
  }

  // ── Deployments / drafts (5A.5) ─────────────────────────────

  createDeployment(input: {
    name: string
    sourceConnectionId: string
    targetConnectionId: string
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO deployments (name, source_connection_id, target_connection_id, status) VALUES (?, ?, ?, 'Draft')`
      )
      .run(input.name, input.sourceConnectionId, input.targetConnectionId)
    return Number(info.lastInsertRowid)
  }

  /**
   * S52 F1 — create the draft AND give the picked pair their roles, atomically.
   * Only an `unassigned` row is written (rolesToAssign); a row that already has
   * a role is never touched, and an unfixable pair (prod as target, a target
   * picked as source, same org twice) refuses BEFORE the row is inserted so a
   * failed create leaves no half-configured deployment behind.
   */
  createDeploymentAssigningRoles(input: {
    name: string
    sourceConnectionId: string
    targetConnectionId: string
  }): DraftCreateResult {
    const tx = this.db.transaction((): DraftCreateResult => {
      const assigned = this.applyRoleAssignment(input.sourceConnectionId, input.targetConnectionId)
      const id = this.createDeployment(input)
      return { id, assigned }
    })
    return tx()
  }

  /** S52 F2 — the same write for a deployment that already exists (old drafts). */
  assignDeploymentRoles(deploymentId: number): RoleAssignment {
    const row = this.db
      .prepare('SELECT source_connection_id, target_connection_id FROM deployments WHERE id = ?')
      .get(deploymentId) as
      { source_connection_id: string; target_connection_id: string } | undefined
    if (!row) throw new RdsHandlerError('NOT_FOUND', `Deployment ${deploymentId} not found`)
    const tx = this.db.transaction(() =>
      this.applyRoleAssignment(row.source_connection_id, row.target_connection_id)
    )
    return tx()
  }

  private applyRoleAssignment(
    sourceConnectionId: string,
    targetConnectionId: string
  ): RoleAssignment {
    const source = this.getConnection(sourceConnectionId)
    const target = this.getConnection(targetConnectionId)
    if (!source) throw new RdsHandlerError('NOT_FOUND', `Unknown connection: ${sourceConnectionId}`)
    if (!target) throw new RdsHandlerError('NOT_FOUND', `Unknown connection: ${targetConnectionId}`)
    const { assign, blocked } = rolesToAssign(source, target)
    if (blocked.length > 0) {
      throw new RdsHandlerError('INVALID_STATE', blocked.map((b) => b.reason).join(' '))
    }
    if (assign.source) this.setRole(source.id, 'source')
    if (assign.target) this.setRole(target.id, 'target')
    return assign
  }

  saveDraft(deploymentId: number, step: WizardStep, config: WizardConfig): void {
    const info = this.db
      .prepare(
        'UPDATE deployments SET wizard_step = ?, draft_config = ?, updated_at = ? WHERE id = ?'
      )
      .run(step, JSON.stringify(config), Date.now(), deploymentId)
    if (info.changes === 0) {
      throw new RdsHandlerError('NOT_FOUND', `Deployment ${deploymentId} not found`)
    }
  }

  loadDraft(deploymentId: number): DraftDetail | null {
    const row = this.db
      .prepare(
        `SELECT d.name, d.source_connection_id, d.target_connection_id, d.wizard_step,
                d.draft_config, d.status, sc.label AS source_label, tc.label AS target_label
         FROM deployments d
         LEFT JOIN connections sc ON sc.id = d.source_connection_id
         LEFT JOIN connections tc ON tc.id = d.target_connection_id
         WHERE d.id = ?`
      )
      .get(deploymentId) as
      | {
          name: string
          source_connection_id: string
          target_connection_id: string
          wizard_step: string | null
          draft_config: string | null
          status: string
          source_label: string | null
          target_label: string | null
        }
      | undefined
    if (!row) return null
    const config = row.draft_config
      ? (JSON.parse(row.draft_config) as WizardConfig)
      : emptyWizardConfig()
    return {
      name: row.name,
      sourceConnectionId: row.source_connection_id,
      targetConnectionId: row.target_connection_id,
      sourceLabel: row.source_label ?? row.source_connection_id,
      targetLabel: row.target_label ?? row.target_connection_id,
      step: (row.wizard_step as WizardStep | null) ?? 'orgs',
      config,
      status: row.status
    }
  }

  /**
   * Every deployment, newest first, for Home (+ History). S46 D3: the list is
   * no longer filtered to Draft/Planned/Stalled — once `deployments.status`
   * mirrors the run (D1), a running or finished deployment must stay visible
   * or its outcome is lost to the operator (the Apex home list showed only
   * resumable drafts because History was a separate tab; here one list carries
   * every mirrored status until 5D.2 lands).
   */
  listDrafts(): DeploymentSummary[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.name, d.source_connection_id, d.target_connection_id, d.status, d.error_message,
                d.wizard_step, d.analyzed_at, d.created_at, d.updated_at,
                sc.label AS source_label, tc.label AS target_label,
                (SELECT COUNT(*) FROM deployment_objects o WHERE o.deployment_id = d.id) AS total_objects,
                (SELECT COALESCE(SUM(o.scoped_record_count), 0) FROM deployment_objects o WHERE o.deployment_id = d.id) AS total_records,
                (SELECT COUNT(*) FROM deploy_runs r WHERE r.deployment_id = d.id) AS run_count
         FROM deployments d
         LEFT JOIN connections sc ON sc.id = d.source_connection_id
         LEFT JOIN connections tc ON tc.id = d.target_connection_id
         ORDER BY d.updated_at DESC`
      )
      .all() as Record<string, unknown>[]
    return rows.map((r) => this.toDeploymentSummary(r))
  }

  private toDeploymentSummary(r: Record<string, unknown>): DeploymentSummary {
    const analyzed = r.analyzed_at != null
    return {
      id: Number(r.id),
      name: String(r.name),
      sourceConnectionId: String(r.source_connection_id),
      targetConnectionId: String(r.target_connection_id),
      sourceLabel: String(r.source_label ?? r.source_connection_id),
      targetLabel: String(r.target_label ?? r.target_connection_id),
      status: String(r.status),
      errorMessage: r.error_message != null ? String(r.error_message) : null,
      wizardStep: (r.wizard_step as WizardStep | null) ?? null,
      totalObjects: analyzed ? Number(r.total_objects) : null,
      totalRecords: analyzed ? Number(r.total_records) : null,
      runCount: Number(r.run_count ?? 0),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at)
    }
  }

  // ── Deploy status writers OUTSIDE a run's lifetime (S46 D1) ────────────────
  // Single-writer contract (deployDesign §1.3): while a run exists, ONLY
  // DeployStore.setRunPhase (via stateMachine.transition) moves
  // deployments.status. The three writers below run when there is NO run for
  // the attempt yet — job start, and a gate/connect/freeze failure before
  // createRun — so the contract holds; each is scoped to the status it
  // expects to find, never blind.

  /** The deployment row header the monitor reads (includes the full error text). */
  getDeploymentHeader(deploymentId: number): DeploymentHeader | null {
    const row = this.db
      .prepare(
        `SELECT d.id, d.name, d.status, d.error_message, d.created_at, d.updated_at,
                d.source_connection_id, d.target_connection_id,
                sc.label AS source_label, tc.label AS target_label
         FROM deployments d
         LEFT JOIN connections sc ON sc.id = d.source_connection_id
         LEFT JOIN connections tc ON tc.id = d.target_connection_id
         WHERE d.id = ?`
      )
      .get(deploymentId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: Number(row.id),
      name: String(row.name),
      status: String(row.status),
      errorMessage: row.error_message != null ? String(row.error_message) : null,
      sourceLabel: String(row.source_label ?? row.source_connection_id),
      targetLabel: String(row.target_label ?? row.target_connection_id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }
  }

  /**
   * Job start (Apex DDS:70 flips Status to 'Deploying' before the first hop):
   * status → 'Deploying', previous error cleared. The "is a run still live?"
   * gate lives in the rds:deploy.start handler (it consults deploy_runs, the
   * source of truth — a busy STATUS with no live run is a crash artifact from
   * an attempt that died before createRun and must not lock the row forever).
   */
  markDeployStarted(deploymentId: number): void {
    const info = this.db
      .prepare(
        `UPDATE deployments SET status = 'Deploying', error_message = NULL, current_run_id = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(Date.now(), deploymentId)
    if (info.changes === 0) {
      throw new RdsHandlerError('NOT_FOUND', `Deployment ${deploymentId} not found`)
    }
  }

  /** Link the current attempt to its run row (right after createRun). */
  setCurrentRun(deploymentId: number, runId: number): void {
    const info = this.db
      .prepare('UPDATE deployments SET current_run_id = ? WHERE id = ?')
      .run(runId, deploymentId)
    if (info.changes === 0) {
      throw new RdsHandlerError('NOT_FOUND', `Deployment ${deploymentId} not found`)
    }
  }

  /** The current attempt's run id; null = no run yet / attempt died pre-run / legacy row. */
  getCurrentRunId(deploymentId: number): number | null {
    const row = this.db
      .prepare('SELECT current_run_id AS rid FROM deployments WHERE id = ?')
      .get(deploymentId) as { rid: number | null } | undefined
    return row?.rid ?? null
  }

  /**
   * Startup reconciliation (S47 review F1 — the desktop's answer to the Apex
   * RDS_Watchdog, deployDesign §6 "startup/interval recovery sweep"). At app
   * start no job can be running, so two shapes are provably dead:
   *  1. A NON-terminal run (the app died mid-run) → park it 'Stalled' via the
   *     state machine (legal from every non-terminal phase; the status mirror
   *     follows). Its target may still have automation disabled — the
   *     deployment page shows the manual restore steps; deploy.start refuses it.
   *  2. A busy `deployments.status` with NO live run (died during connect /
   *     gates / freeze, before createRun) → 'Failed' + INTERRUPTED_BEFORE_RUN_
   *     MESSAGE. Nothing on the target was touched; the row is re-deployable
   *     again instead of locked forever behind the busy-status guards.
   */
  reconcileOnStartup(): { stalledRuns: number; interruptedAttempts: number } {
    let stalledRuns = 0
    const sweep = this.db.transaction((): number => {
      for (const run of this.deploy.listActiveRuns()) {
        if (run.phase === 'Stalled') continue
        transition(this.deploy, run.id, 'Stalled')
        stalledRuns++
      }
      const info = this.db
        .prepare(
          `UPDATE deployments
             SET status = 'Failed', error_message = @msg, current_run_id = NULL, updated_at = @now
           WHERE status IN ('Deploying', 'Retrying', 'Disabling Automation', 'Restoring Automation')
             AND NOT EXISTS (
               SELECT 1 FROM deploy_runs r
               WHERE r.deployment_id = deployments.id
                 AND r.phase NOT IN ('Completed', 'Failed', 'Cancelled'))`
        )
        .run({ msg: INTERRUPTED_BEFORE_RUN_MESSAGE, now: Date.now() })
      return info.changes
    })
    const interruptedAttempts = sweep()
    return { stalledRuns, interruptedAttempts }
  }

  /**
   * A gate / connect / freeze failure BEFORE a run row exists (Apex
   * DDQ:175-181 wrote Status 'Failed' + Error_Message; no `.left(255)` here —
   * deployDesign §6 kills the truncation). Scoped to the 'Deploying' the job
   * start wrote: if a run exists its mirror owns the status and this is a no-op.
   */
  markDeployFailedBeforeRun(deploymentId: number, errorMessage: string): void {
    this.db
      .prepare(
        `UPDATE deployments SET status = 'Failed', error_message = ?, updated_at = ?
         WHERE id = ? AND status = 'Deploying'`
      )
      .run(errorMessage, Date.now(), deploymentId)
  }

  /** The job was cancelled before a run row existed (Apex DDS:219 'Cancelled'). */
  markDeployCancelledBeforeRun(deploymentId: number): void {
    this.db
      .prepare(
        `UPDATE deployments SET status = 'Cancelled', error_message = NULL, updated_at = ?
         WHERE id = ? AND status = 'Deploying'`
      )
      .run(Date.now(), deploymentId)
  }

  /**
   * Record the terminal error text for an attempt whose RUN owns the status
   * (the orchestrator already mirrored Failed / Stalled). Never touches status.
   */
  setDeployErrorMessage(deploymentId: number, errorMessage: string): void {
    this.db
      .prepare('UPDATE deployments SET error_message = ?, updated_at = ? WHERE id = ?')
      .run(errorMessage, Date.now(), deploymentId)
  }

  deleteDeployment(deploymentId: number): void {
    const dep = this.db.prepare('SELECT status FROM deployments WHERE id = ?').get(deploymentId) as
      { status: string } | undefined
    if (!dep) throw new RdsHandlerError('NOT_FOUND', `Deployment ${deploymentId} not found`)
    const unconfirmed = (
      this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM automation_ledger_mirror WHERE deployment_id = ? AND restore_confirmed = 0'
        )
        .get(deploymentId) as { n: number }
    ).n
    const runs = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM deploy_runs WHERE deployment_id = ?')
        .get(deploymentId) as { n: number }
    ).n
    const guard = canDeleteDeployment(dep.status, unconfirmed > 0, runs > 0)
    if (!guard.ok) throw new RdsHandlerError('INVALID_STATE', guard.reason ?? 'Cannot delete')
    // ON DELETE CASCADE clears deployment_objects / record_results / ledger mirror.
    this.db.prepare('DELETE FROM deployments WHERE id = ?').run(deploymentId)
  }

  // ── Reusable templates (5B.5) ───────────────────────────────

  private rowToTemplate(row: Record<string, unknown>): Template {
    return {
      id: Number(row.id),
      kind: String(row.kind) as TemplateKind,
      name: String(row.name),
      payload: JSON.parse(String(row.payload)) as unknown,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }
  }

  listTemplates(kind: TemplateKind): Template[] {
    const rows = this.db
      .prepare('SELECT * FROM templates WHERE kind = ? ORDER BY name COLLATE NOCASE')
      .all(kind) as Record<string, unknown>[]
    return rows.map((r) => this.rowToTemplate(r))
  }

  /** Create-or-overwrite by (kind, name); returns the saved row. */
  saveTemplate(kind: TemplateKind, name: string, payload: unknown): Template {
    const trimmed = name.trim()
    if (!trimmed) throw new RdsHandlerError('INVALID_STATE', 'Template name cannot be blank')
    this.db
      .prepare(
        `INSERT INTO templates (kind, name, payload) VALUES (?, ?, ?)
         ON CONFLICT(kind, name) DO UPDATE SET payload = excluded.payload, updated_at = unixepoch('now') * 1000`
      )
      .run(kind, trimmed, JSON.stringify(payload))
    const row = this.db
      .prepare('SELECT * FROM templates WHERE kind = ? AND name = ?')
      .get(kind, trimmed) as Record<string, unknown> | undefined
    if (!row) throw new RdsHandlerError('NOT_FOUND', 'saveTemplate failed to persist')
    return this.rowToTemplate(row)
  }

  renameTemplate(id: number, name: string): void {
    const trimmed = name.trim()
    if (!trimmed) throw new RdsHandlerError('INVALID_STATE', 'Template name cannot be blank')
    try {
      const info = this.db
        .prepare(`UPDATE templates SET name = ?, updated_at = unixepoch('now') * 1000 WHERE id = ?`)
        .run(trimmed, id)
      if (info.changes === 0) throw new RdsHandlerError('NOT_FOUND', `Template ${id} not found`)
    } catch (e) {
      if (e instanceof Error && /UNIQUE/i.test(e.message)) {
        throw new RdsHandlerError('INVALID_STATE', `A template named "${trimmed}" already exists`)
      }
      throw e
    }
  }

  deleteTemplate(id: number): void {
    const info = this.db.prepare('DELETE FROM templates WHERE id = ?').run(id)
    if (info.changes === 0) throw new RdsHandlerError('NOT_FOUND', `Template ${id} not found`)
  }

  // ── Analysis plan persistence (2.2) ─────────────────────────

  /** Replace a deployment's plan with a fresh analysis result (status → Planned). */
  saveAnalysis(deploymentId: number, result: AnalysisResult): void {
    const del = this.db.prepare('DELETE FROM deployment_objects WHERE deployment_id = ?')
    const ins = this.db.prepare(
      `INSERT INTO deployment_objects
        (deployment_id, object_api_name, sort_order, status, filter_clause, scoped_filter,
         scoped_filter_display, scoped_record_count, api_strategy, gating_tier, has_circular_refs,
         deferred_fields, is_junction, junction_parents, plan_json, error_message)
       VALUES
        (@deployment_id, @object_api_name, @sort_order, @status, @filter_clause, @scoped_filter,
         @scoped_filter_display, @scoped_record_count, @api_strategy, @gating_tier, @has_circular_refs,
         @deferred_fields, @is_junction, @junction_parents, @plan_json, @error_message)`
    )
    const upd = this.db.prepare(
      `UPDATE deployments SET status = 'Planned', analyzed_at = ?, warnings = ?,
         auto_injected_junctions = ?, updated_at = ? WHERE id = ?`
    )
    const tx = this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM deployments WHERE id = ?').get(deploymentId)) {
        throw new RdsHandlerError('NOT_FOUND', `Deployment ${deploymentId} not found`)
      }
      del.run(deploymentId)
      for (const p of result.objects) ins.run(plannedObjectToRow(deploymentId, p))
      const now = Date.now()
      upd.run(
        now,
        JSON.stringify(result.warnings),
        JSON.stringify(result.autoInjectedJunctions),
        now,
        deploymentId
      )
    })
    tx()
  }

  /**
   * Rewrite the plan's deploy order (5B.8 slot-refill reorder). `orderedNames`
   * MUST be a full permutation of the deployment's object names (the handler
   * computes it via `slotRefillReorder`, whose output always is one) — the
   * same invariant Apex's applyDeploymentPlan guarantees structurally, where
   * finalNames is always a permutation so every row gets a unique, contiguous
   * 0..n-1 Sort_Order. A partial or unknown-name list is REJECTED rather than
   * tolerated: silently skipping rows would let two objects share a
   * sort_order, recreating the ordering ambiguity the Session-16 fix (and the
   * future plan_json-reading deploy engine) exists to prevent.
   * `plan_json.sortOrder` is updated in the same transaction — it is the
   * authoritative copy (`getPlan` builds the renderer view from plan_json),
   * so a column-only update would leave a stale order behind.
   */
  reorderPlan(deploymentId: number, orderedNames: string[]): void {
    const rows = this.db
      .prepare(
        'SELECT id, object_api_name, plan_json FROM deployment_objects WHERE deployment_id = ?'
      )
      .all(deploymentId) as Array<{ id: number; object_api_name: string; plan_json: string | null }>
    if (rows.length === 0) {
      throw new RdsHandlerError(
        'INVALID_STATE',
        `Deployment ${deploymentId} has no plan to reorder`
      )
    }
    const orderByName = new Map<string, number>()
    orderedNames.forEach((name, i) => {
      if (!orderByName.has(name)) orderByName.set(name, i)
    })
    // Permutation guard: every row named exactly once, no unknown extras.
    if (orderByName.size !== rows.length || rows.some((r) => !orderByName.has(r.object_api_name))) {
      throw new RdsHandlerError(
        'INVALID_STATE',
        `reorderPlan requires the FULL object order for deployment ${deploymentId} ` +
          `(got ${orderByName.size} unique names for ${rows.length} plan objects)`
      )
    }
    const upd = this.db.prepare(
      'UPDATE deployment_objects SET sort_order = ?, plan_json = ? WHERE id = ?'
    )
    const touch = this.db.prepare('UPDATE deployments SET updated_at = ? WHERE id = ?')
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const newOrder = orderByName.get(row.object_api_name)
        if (newOrder === undefined) continue // unreachable after the guard; keeps TS narrow
        let planJson = row.plan_json
        if (planJson) {
          const planned = JSON.parse(planJson) as { sortOrder: number }
          planned.sortOrder = newOrder
          planJson = JSON.stringify(planned)
        }
        upd.run(newOrder, planJson, row.id)
      }
      touch.run(Date.now(), deploymentId)
    })
    tx()
  }

  /** The persisted plan for the renderer (null until analyzed). */
  /** The RAW analyzed PlannedObjects (plan_json, sort_order asc) — the 5B.9
   *  plan-freeze input; getPlan below is the renderer VIEW of the same rows. */
  getPlannedObjects(deploymentId: number): ReturnType<typeof rowToPlannedObject>[] {
    const rows = this.db
      .prepare('SELECT * FROM deployment_objects WHERE deployment_id = ? ORDER BY sort_order')
      .all(deploymentId) as DeploymentObjectRow[]
    return rows.map(rowToPlannedObject)
  }

  getPlan(deploymentId: number): PlanView | null {
    const dep = this.db
      .prepare(
        'SELECT warnings, auto_injected_junctions, analyzed_at FROM deployments WHERE id = ?'
      )
      .get(deploymentId) as
      | {
          warnings: string | null
          auto_injected_junctions: string | null
          analyzed_at: number | null
        }
      | undefined
    if (!dep || dep.analyzed_at == null) return null
    const rows = this.db
      .prepare('SELECT * FROM deployment_objects WHERE deployment_id = ? ORDER BY sort_order')
      .all(deploymentId) as DeploymentObjectRow[]
    const objects = rows.map((row) => plannedObjectToView(rowToPlannedObject(row)))
    return {
      deploymentId,
      objects,
      totalObjects: objects.length,
      totalRecords: objects.reduce((sum, o) => sum + o.recordCount, 0),
      autoInjectedJunctions: dep.auto_injected_junctions
        ? (JSON.parse(dep.auto_injected_junctions) as string[])
        : [],
      warnings: dep.warnings ? (JSON.parse(dep.warnings) as string[]) : []
    }
  }

  close(): void {
    this.db.close()
  }
}
