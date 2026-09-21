/**
 * Deploy-engine shared vocabulary (E2.5 slice — run state, record outcomes,
 * counters). E4E.1 extends this file with the orchestrator/state-machine types
 * (DeployPlan walk state, DeployIo, DeployEvent).
 *
 * Pure types only — nothing here may import jsforce or better-sqlite3
 * (engine/ purity rule); the SQLite binding lives in services/deployStore.ts.
 */
import type { DescribeField } from './transform/fieldFilter'

/**
 * Run phases — deployDesign.md §1.3 state machine:
 *   Frozen → DisablingAutomation → Deploying → Retrying → SecondPass
 *          → Finalizing → RestoringAutomation → Completed | Failed | Cancelled
 * 'Stalled' is the recovered-at-startup parking state (non-terminal, resumable).
 * A run row is created AT plan freeze, so 'Frozen' is the initial phase; the
 * wizard's pre-freeze 'Draft' lives on deployments.status, not here.
 */
export const RUN_PHASES = [
  'Frozen',
  'DisablingAutomation',
  'Deploying',
  'Retrying',
  'SecondPass',
  'Finalizing',
  'RestoringAutomation',
  'Completed',
  'Failed',
  'Cancelled',
  'Stalled'
] as const
export type RunPhase = (typeof RUN_PHASES)[number]

export const TERMINAL_RUN_PHASES: ReadonlySet<RunPhase> = new Set([
  'Completed',
  'Failed',
  'Cancelled'
])

/**
 * The `deployments.status` label each run phase mirrors (S46 D1 — deployDesign
 * §1.3 requires status to track the run; the vocabulary is the frozen Apex
 * Deployment__c.Status__c labels: 'Deploying' DDS:70, 'Retrying' DDQ:2992,
 * 'Disabling Automation' / 'Restoring Automation' from AutomationToggleBatch,
 * terminal words verbatim, 'Stalled' from the watchdog). Frozen / SecondPass /
 * Finalizing collapse onto 'Deploying' exactly as the Apex single status did.
 */
export const DEPLOYMENT_STATUS_BY_PHASE: Readonly<Record<RunPhase, string>> = {
  Frozen: 'Deploying',
  DisablingAutomation: 'Disabling Automation',
  Deploying: 'Deploying',
  Retrying: 'Retrying',
  SecondPass: 'Deploying',
  Finalizing: 'Deploying',
  RestoringAutomation: 'Restoring Automation',
  Completed: 'Completed',
  Failed: 'Failed',
  Cancelled: 'Cancelled',
  Stalled: 'Stalled'
}

/**
 * Pass routing at the (object, pass) resume granularity. 'retry' is the
 * targeted-retry drain of a first-pass object (retry_queue input); its record
 * rows still land in the first-pass family (record_results.pass = 1).
 */
export type PassKind = 'first' | 'retry' | 'second' | 'junction'

/**
 * Per-record outcome. The Apex vocabulary had no explicit 'retried' state —
 * a retried record simply gets a NEW row at a higher retry_pass; the counter
 * views read the LATEST row per record as the current truth (mirrors the
 * "current truth, not the historical attempt log" contract documented on
 * DataDeploymentService.recomputeDeploymentCounters, DDS L1220-1227).
 */
export type RecordOutcome = 'success' | 'failed' | 'skipped'

/** classifyFailures buckets (DDQ L2214-2296). Root + Cascade ≡ Failed. */
export type FailureClassification = 'root' | 'cascade'

/** A frozen plan version (plans table row). plan_json is the immutable DeployPlan. */
export interface FrozenPlanRow {
  id: number
  deploymentId: number
  version: number
  planJson: string
  planHash: string
  createdAt: number
}

/** A deploy run (deploy_runs row). Resume point granularity = (object, pass). */
export interface RunState {
  id: number
  deploymentId: number
  planId: number
  planHash: string
  phase: RunPhase
  currentObject: string | null
  currentPass: PassKind | null
  cancelRequested: boolean
  /**
   * Persisted at TEARDOWN ENTRY (E4E.1 review fix): the outcome the run was
   * heading to when it entered Finalizing. Non-null ⇒ the walk is over — a
   * resume (from any phase, including Stalled parks) must re-enter teardown
   * with THIS outcome, never the walk: a cancelled/tripwired run crashed
   * mid-teardown must not resurrect as 'completed' (which would activate
   * contracts for a cancelled deploy), and a run parked during restore must
   * not replay deploy passes against a guard-disarmed target.
   */
  teardownOutcome: RunOutcome | null
  /** Finalize hook completed (contracts + guard disarm) — resume skips straight to restore. */
  finalizeDone: boolean
  startedAt: number | null
  finishedAt: number | null
  createdAt: number
}

/**
 * One record attempt row (record_results). Keys that make the counter views
 * reproduce the Apex accumulation semantics by construction:
 *  - pass: 1 = first-pass family (fresh + targeted retries + junction),
 *          2 = deferred-field second pass. Views count ONLY pass 1 — the Apex
 *          second pass never touches counters (executeSecondPassV2 logs only;
 *          "second pass never erases first-pass failure counts").
 *  - retryPass: 0 = fresh page walk, 1..5 = targeted retry passes. Queried/
 *    Skipped are retryPass-0-only (DDQ L1989-1996 first-pass-only rule).
 *  - objectAttempt: bounded whole-object retry (DDQ L119-139 zeroes all six
 *    counters and re-runs from batch 0) — views count ONLY the latest attempt,
 *    so earlier attempts' rows drop out exactly like the Apex reset.
 */
export interface RecordResultInput {
  objectApiName: string
  sourceId: string
  targetId?: string | null
  pass: 1 | 2
  retryPass: number
  objectAttempt: number
  outcome: RecordOutcome
  errorCode?: string | null
  errorMessage?: string | null
}

/**
 * One failure-relation row (failed_records) — replaces Retry_Source_Ids__c /
 * Retry_Pending_Ids__c / Persistent_Failed_Source_Ids__c. Keyed per
 * (run, object, pass, retryPass, objectAttempt, sourceId) so "appendMode"
 * bookkeeping (FINDINGS #15/#16) is a non-concept. classification defaults to
 * 'root' in the views when absent (Apex classifyFailures default bucket).
 */
/** One nillable lookup dropped because its parent was not on target (S50 A5). */
export interface StrippedRefInput {
  objectApiName: string
  sourceId: string
  fieldName: string
  relationshipName: string
  refObject: string
  parentExtId: string
  /** `reverse(parentExtId)` — the parent's SOURCE id, for joining to results. */
  parentSourceId: string
  pass: 1 | 2
  retryPass: number
  objectAttempt: number
}

/** Reporting roll-up for the terminal summary (S50 A5). */
export interface OrphanedLinkGroup {
  objectApiName: string
  fieldName: string
  refObject: string
  count: number
  /** How many of those parents DID land later in the run — re-running relinks them. */
  parentLandedCount: number
}

export interface FailedRecordInput {
  objectApiName: string
  pass: 1 | 2
  retryPass: number
  objectAttempt: number
  sourceId: string
  extId?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  fieldsJson?: string | null
  classification?: FailureClassification | null
}

/** v_run_object_counters row — the Deployment_Object__c counter sextet. */
export interface ObjectCounters {
  runId: number
  objectApiName: string
  recordsQueried: number
  recordsDeployed: number
  recordsFailed: number
  recordsFailedRoot: number
  recordsFailedCascade: number
  recordsSkipped: number
}

/** v_run_counters row — recomputeDeploymentCounters SUM semantics (DDS L1228-1263). */
export interface RunCounters {
  runId: number
  recordsQueried: number
  recordsDeployed: number
  recordsFailed: number
  recordsFailedRoot: number
  recordsFailedCascade: number
  recordsSkipped: number
}

// ───────────────────── E4E.1 — orchestration vocabulary ─────────────────────

/**
 * Whole-object re-runs after a thrown exception / failed source query
 * (DDQ L16: `MAX_OBJECT_RETRIES = 2`). Counter reset happens structurally:
 * each re-run increments object_attempt and the views count only the latest.
 */
export const MAX_OBJECT_RETRIES = 2

/** Targeted-retry ceiling per object (DDQ L2942: `MAX_RETRIES = 5`). */
export const MAX_TARGETED_RETRIES = 5

/** Retry-queue drain chunk (Apex Retry_Pending_Ids 150-Id chunks). */
export const RETRY_CHUNK_SIZE = 150

/**
 * X.1 contract: DeployEvent ⊂ JobEvent — the engine emits {kind, data}; the
 * main-process JobManager stamps jobId/ts and owns the single bus.
 */
export interface DeployEvent {
  kind: 'progress' | 'log' | 'phase' | 'done' | 'error' | 'cancelled'
  data: Record<string, unknown>
}

/**
 * The store surface the ENGINE needs (structural subset of services/
 * deployStore.DeployStore — engine/ never imports the sqlite-typed class).
 */
export interface DeployRunStore {
  getRun(runId: number): RunState | null
  getPlanById(planId: number): FrozenPlanRow | null
  setRunPhase(runId: number, phase: RunPhase): void
  setResumePoint(runId: number, currentObject: string | null, currentPass: PassKind | null): void
  setTeardownOutcome(runId: number, outcome: RunOutcome): void
  markFinalizeDone(runId: number): void
  isCancelRequested(runId: number): boolean
  recordResults(runId: number, rows: RecordResultInput[]): void
  recordFailures(runId: number, rows: FailedRecordInput[]): void
  listFailures(
    runId: number,
    objectApiName: string,
    retryPass: number,
    objectAttempt: number
  ): { sourceId: string; classification: string | null }[]
  enqueueRetries(runId: number, objectApiName: string, sourceIds: string[], attempt: number): void
  dequeueRetryChunk(runId: number, objectApiName: string, limit: number): string[]
  retryQueueDepth(runId: number, objectApiName?: string): number
  clearRetryQueue(runId: number, objectApiName: string): void
  /** The classifier's failed set (E4E.3): per object, failed_records at the
   *  LATEST (object_attempt, retry_pass) — the exact Apex
   *  Persistent_Failed_Source_Ids per-hop-overwrite mirror (DDQ L1997-2003).
   *  Records absent from the latest pass (healed / skipped / deleted on
   *  source) drop out, like the Apex accumulator. */
  currentFailures(runId: number): { objectApiName: string; sourceId: string }[]
  /** The run's own materialized first-pass scope for one object (E4E.4):
   *  DISTINCT source ids of the retry_pass-0 rows at the LATEST object_attempt
   *  — every record the fresh page walk queried (success + failed + skipped),
   *  insertion order. Replaces the Apex second pass's per-object filter
   *  re-derivation/re-materialization (DDQ L570-590) per deployDesign E4E.4
   *  ("scope Ids from the run's own materialized scope in SQLite"). */
  queriedSourceIds(runId: number, objectApiName: string): string[]
  /** Source ids whose CURRENT outcome is 'success' (latest row per record at
   *  the latest attempt) — "the parents THIS RUN wrote" (E4E.5): reversing
   *  these yields the junction parent scope, replacing the Apex org-wide
   *  target ExtId scan (getDeployedParentSourceIds, DDQ L1024-1068 — the
   *  class-9 full-table walk deployDesign E4E.5 kills). */
  deployedSourceIds(runId: number, objectApiName: string): string[]
  /**
   * S49 (BUG-1 pt3): current-truth skip counts for the run, grouped by the
   * REASON's leading token. Skips are recorded on `record_results` with the
   * reason in `error_message`, often with a per-record detail in parentheses
   * (`unique_constraint_collision (OpportunityId+UserId already claimed by …)`),
   * so the group key is everything before the first space.
   */
  /**
   * S50 (A5): record NILLABLE lookups that `stripMissingParentRefs` dropped, so
   * the orphans they create can be enumerated instead of inferred. Required
   * lookups are NOT recorded — those fail loudly and the retry drain heals
   * them. Observability only; nothing reads this to gate a deploy.
   */
  recordStrippedRefs(runId: number, rows: StrippedRefInput[]): void
  /** S50 (A5): the run's stripped nillable lookups, grouped for reporting. */
  orphanedLinkSummary(runId: number): OrphanedLinkGroup[]
  skipReasonCounts(runId: number): Array<{ reason: string; count: number }>
  objectCounters(runId: number): ObjectCounters[]
  runCounters(runId: number): RunCounters
  /** -1 when the object has no first-pass rows yet. */
  maxObjectAttempt(runId: number, objectApiName: string): number
  maxRetryPass(runId: number, objectApiName: string, objectAttempt: number): number
  failureCountAt(
    runId: number,
    objectApiName: string,
    retryPass: number,
    objectAttempt: number
  ): number
}

/**
 * ONE raw composite/sobjects POST batch (≤200 records), per-record results by
 * INDEX (E4E.5). The junction path needs raw results because the frozen Apex
 * `executeJunctionDeploy` did its OWN batching, error rendering ('CODE: message'
 * from errors[0] — NOT the upsert legacy string), tripwire, and counting inline
 * (DDQ L943-993) — the E4T.1 client's rendered strings would break byte parity,
 * and its flattened typedErrors can't attribute failures back to source rows.
 */
export type RawInsertBatchResult =
  | {
      ok: true
      /** results[k] corresponds to the submitted batch's records[k]. */
      results: Array<{
        success: boolean
        /** Target id when the platform returned one (success rows). */
        id: string | null
        errors: Array<{ statusCode: string | null; message: string | null; fields: string[] }>
      }>
    }
  | { ok: false; errorMessage: string | null }

/**
 * Per-batch transport result — the engine-side mirror of the collections
 * client's CollectionsResult (structurally identical; services/transport/
 * collections.ts returns it directly).
 */
export interface UpsertBatchResult {
  successCount: number
  failureCount: number
  /** Rendered legacy strings, byte-exact with Apex (golden-compared). */
  errorDetails: string[]
  failedExternalIds: string[]
  typedErrors: { extId: string; statusCode: string; message: string; fields: string[] }[]
  /**
   * S49 (BUG-1): per-record TARGET ids for the records that succeeded, keyed by
   * the ExtId that was submitted. The API returns these on every success and the
   * engine used to throw them away, which is why `record_results.target_id` was
   * NULL for all 942 rows of run 2 — and therefore why two source
   * OpportunityTeamMembers collapsing onto ONE target row (owner substitution →
   * unique (OpportunityId, UserId) index) was invisible: 27 in, 25 written,
   * counters still reporting 27 deployed and 0 failed.
   */
  successIds?: Array<{ extId: string; id: string }>
}

/**
 * One SOURCE query-response page (E4E.2). The Apex "batch" IS the REST query
 * page (DDQ processed one page per queueable hop; queryMore pages continue the
 * SAME batch numbering, DDQ L2043-2044) — preserving real page boundaries here
 * keeps batch numbers, per-batch log lines, and append semantics byte-aligned
 * with the oracle. `totalSize` is the response envelope's total (the strategy
 * log's record count, DDQ L1769/L1784-1786), identical on every page.
 */
export interface QueryPage {
  records: Array<Record<string, unknown>>
  totalSize: number | null
}

/**
 * The I/O seam the deploy engine runs over (deployDesign §1.1) — the sibling
 * of AnalysisIo. E4E.1 consumes store/emit/now/sleep; the transport-facing
 * members are bound in services/deployIo.ts and consumed by the pass
 * implementations (E4E.2–E4E.5).
 */
export interface DeployIo {
  /**
   * FULL field describe of `objectName` on the source/target org (Apex
   * SchemaService.describeRemoteObjectFields, DDQ L1324-1327 — re-described at
   * deploy time; the frozen plan stores field NAMES, the live describe supplies
   * the metadata the transform needs). Includes `relationshipName` and
   * `picklistValues` — the shared describe cache's FieldInfo lacks both, so the
   * deployIo binding maps the raw describe itself.
   */
  describeSource(objectName: string): Promise<DescribeField[]>
  describeTarget(objectName: string): Promise<DescribeField[]>
  /** Page-boundary-preserving source query walk (see QueryPage). */
  querySourcePages(soql: string): AsyncIterable<QueryPage>
  /** Connected/integration user Id on the TARGET org (DataSeederController.
   *  getOrgUserId — the `setToMe` / inactive-owner substitution user). */
  getTargetUserId(): Promise<string | null>
  querySource(soql: string): AsyncIterable<Record<string, unknown>>
  queryTarget(soql: string): AsyncIterable<Record<string, unknown>>
  /**
   * S49 (BUG-9): one raw GET against the TARGET org's REST API. Added for the
   * UI-API record-type picklist endpoint, which is the only source of
   * record-type-scoped and dependent-picklist truth (describe has neither).
   * Read-only by construction; rejections propagate to a fail-open caller.
   */
  restGetTarget(path: string): Promise<unknown>
  upsertBatch(
    objectName: string,
    records: Array<Record<string, unknown>>,
    opts: { updateOnly: boolean; batchSize: number | null }
  ): Promise<UpsertBatchResult>
  /**
   * ONE raw composite POST (junction path — the caller owns 200-batching,
   * error rendering, and the tripwire, like the Apex inline loop). The binding
   * applies the duplicate-rule bypass header (DDQ L958-961). An HTTP/transport
   * failure resolves { ok: false } — never throws (Apex counted the batch
   * failed and CONTINUED, L962-966).
   */
  insertCompositeBatch(
    objectName: string,
    records: Array<Record<string, unknown>>
  ): Promise<RawInsertBatchResult>
  store: DeployRunStore
  emit(event: DeployEvent): void
  now(): Date
  sleep(ms: number): Promise<void>
}

/**
 * A frozen-plan object as the orchestrator walks it. Kept structural (not
 * importing planFreeze's FrozenObjectPlan wholesale) so scripted test plans
 * stay small; planFreeze output satisfies it.
 */
export interface WalkObject {
  objectName: string
  sortOrder: number
  hasCircularReference: boolean
  isJunction: boolean
  /** Scoped source count from the frozen plan — the Apex Source_Record_Count
   *  fallback when whole-object exhaustion left no recorded rows (DDQ L144-149). */
  recordCount: number
}

/** Context handed to a pass executor for one (object, pass, attempt). */
export interface ObjectPassContext {
  runId: number
  object: WalkObject
  passKind: PassKind
  /** Whole-object attempt (0-based); rows must be recorded with it. */
  objectAttempt: number
  /** Targeted-retry pass number (0 for fresh passes; ≥1 for retry drains). */
  retryPass: number
  io: DeployIo
}

/**
 * The pass-execution seam. E4E.1 orchestrates ORDER and retry/cancel/resume
 * semantics; E4E.2–E4E.5 implement the real batch loops behind this interface
 * (tests inject scripted executors). Executors THROW to signal object-level
 * catastrophic failure (bounded whole-object retry); a thrown error named
 * 'CpqTriggersActiveError' fails the whole run (tripwire — no retry, no
 * chaining, straight to teardown).
 */
export interface PassExecutors {
  firstPass(ctx: ObjectPassContext): Promise<void>
  /** Drains ctx.io.store retry queue for the object in 150-Id chunks. */
  retryPass(ctx: ObjectPassContext): Promise<void>
  secondPass(ctx: ObjectPassContext): Promise<void>
  junctionPass(ctx: ObjectPassContext): Promise<void>
  /** Automation disable (E4A) — optional until that epic lands. */
  disableAutomation?(runId: number, io: DeployIo): Promise<void>
  /** Finalize: contract activation (SKIPPED on cancel) → CPQ-guard disarm. */
  finalize?(runId: number, io: DeployIo, reason: RunOutcome): Promise<void>
  /** Automation restore (E4A). */
  restoreAutomation?(runId: number, io: DeployIo, reason: RunOutcome): Promise<void>
}

/** Why the run is heading to teardown. */
export type RunOutcome = 'completed' | 'cancelled' | 'failed'
