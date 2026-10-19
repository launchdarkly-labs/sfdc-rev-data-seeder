/**
 * User-facing recovery copy (S46 E2 — text slice). Shared by main (the job's
 * terminal error message) and the renderer (deployment detail banners) so the
 * two can never disagree about what the operator must do.
 *
 * WHY THIS EXISTS: until the ledger-keyed recovery slice (PLAN E2 / E4E.6)
 * ships, a run that parks Stalled — or a run the app was closed on — leaves
 * the TARGET org's automation disabled with no button to put it back. The
 * previous copy promised "Relaunching the app offers recovery"; nothing backed
 * that promise. This text says what is actually true and what to do.
 *
 * The app's SQLite ledger (`automation_ledger_mirror`) records exactly which
 * items were disabled and, for flows, which version was active — that is the
 * authoritative list to work from until the Tools page renders it.
 */

export const STALLED_TEARDOWN_MESSAGE =
  'Deployment teardown did not complete — target-org automation may still be disabled. ' +
  'Automatic recovery is not built yet: restore it manually in Setup (steps on the deployment ' +
  'page) and do not deploy into this org again until that is done.'

export const STRANDED_RUN_MESSAGE =
  'This run has no deploy job in the current app session (the app was closed or crashed while ' +
  'it was running). Its target-org automation may still be disabled. Automatic recovery is not ' +
  'built yet — restore it manually in Setup using the steps below.'

/**
 * Manual restore steps, in the order the app itself would restore. Each line
 * is one Setup action; the list renders as an ordered list in the UI and is
 * joined with newlines for log/error text.
 */
export const MANUAL_RESTORE_STEPS: readonly string[] = [
  'Validation rules — Setup → Object Manager → (each in-scope object) → Validation Rules: re-activate every rule the run deactivated.',
  'Flows — Setup → Flows: for each flow the run deactivated, activate the version that was active before the run (the app ledger recorded that version).',
  'Apex triggers — Setup → Apex Triggers: any trigger whose body begins with the RDS_BYPASS marker comment has been wrapped; restore its original body from source control (or unwrap the marker) and deploy it.',
  'Duplicate rules — Setup → Duplicate Rules: re-activate any rule the run deactivated (only if "Disable duplicate rules" was on).',
  'Workflow rules — Setup → Workflow Rules: re-activate any rule the run deactivated.',
  'Legacy CPQ setting — Setup → Custom Settings → "Trigger Disabled" (SBQQ__TriggerDisabled__c): if the run checked the org default, uncheck it.',
  'Connector guard — RDS_Deployment_Control__c (connector-package orgs only): set Disable CPQ Triggers and Deployment In Progress back to false.',
  'CPQ package "Triggers Disabled" — Installed Packages → Salesforce CPQ → Configure → Additional Settings: uncheck it if you checked it for this run, then run Execute Scripts if the org reports post-install steps incomplete.'
]

/**
 * Startup reconciliation (S47 review F1): a deployment left 'Deploying' with
 * NO run row means the app died during connect / gates / freeze — nothing on
 * the target was touched. Persisted as the Failed reason so the operator can
 * simply deploy again.
 */
export const INTERRUPTED_BEFORE_RUN_MESSAGE =
  'Interrupted before the run started (the app was closed during connect / gates / plan freeze). ' +
  'Nothing was changed on the target org — deploy again from the Plan step.'

/** Where per-record failures live until the run-log pane ships (5C.1). */
export const RUN_LOG_POINTER =
  'per-record failures are recorded in the app database (failed_records / record_results) until the run-log pane ships (5C.1).'

/** What a Stalled deployment can do next (until the E2 recovery slice). */
export const STALLED_NEXT_STEP =
  'This deployment cannot be re-deployed until the recovery slice ships. After restoring the target’s automation manually, create a NEW deployment for the next attempt.'

/** The post-run CPQ reminder (mirrors the How To page's CPQ section). */
export const CPQ_UNCHECK_REMINDER =
  'This run included CPQ objects. If you checked CPQ "Triggers Disabled" before deploying, uncheck it now ' +
  '(Setup → Installed Packages → Salesforce CPQ → Configure → Additional Settings) — it is org-wide, and ' +
  'CPQ calculation stays off for everyone until you do. Use Execute Scripts on the same page if the org ' +
  'reports its post-install steps as incomplete.'

/**
 * S53 (item 3) — the wording the plan freeze uses when an object's own upsert
 * key is unusable on the target (missing / not External ID / FLS-hidden). Lives
 * here so the renderer can recognise the class and link to the Readiness step
 * (the renderer cannot import engine modules — TS6307).
 */
export const EXT_ID_REFUSAL_MARKER = 'has no usable Data_Deployment_External_Id__c'

/**
 * S53 (item 1) — what to do about rows the TARGET's own automation created
 * during a run. Shared by the job log line and the deployment-page banner.
 */
export const AUTOMATION_BORN_GUIDANCE =
  'These rows carry no RDS key, so a re-run will neither update nor remove them — they are the ' +
  '“two of every product” shape. Before the next run into this org, confirm CPQ “Triggers ' +
  'Disabled” is checked (Installed Packages → Salesforce CPQ → Configure → Additional Settings) ' +
  'and review the automation the run left enabled; delete the listed rows by hand if they are ' +
  'duplicates.'

/** S53 (item 1) — the pre-run finding: unkeyed rows already under RDS-keyed parents. */
export const PRE_RUN_UNKEYED_GUIDANCE =
  'They were created by target automation during an earlier run, or by hand. This run updates ' +
  'keyed rows only and cannot remove or de-duplicate them.'
