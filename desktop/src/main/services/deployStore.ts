/**
 * DeployStore — the SQLite facade behind `DeployIo.store` (E2.5, deployDesign
 * §1.1/§1.3). Exposes PRIMITIVE persistence operations only; transition
 * legality (single-writer status walk) is enforced by engine/deploy/
 * stateMachine.ts (E4E.1), which is the only caller allowed to change phases
 * once the orchestrator exists.
 *
 * Counters are never written — they are read back from the migration-005 SQL
 * views (v_run_object_counters / v_run_counters), which compute the frozen
 * Apex accumulation semantics from record_results (see the 005 migration
 * comment in store.ts for the oracle line cites).
 */
import type Database from 'better-sqlite3'
import type {
  FailedRecordInput,
  FrozenPlanRow,
  ObjectCounters,
  OrphanedLinkGroup,
  StrippedRefInput,
  PassKind,
  RecordResultInput,
  RunCounters,
  RunPhase,
  RunState
} from '../engine/deploy/types'
import { DEPLOYMENT_STATUS_BY_PHASE, TERMINAL_RUN_PHASES } from '../engine/deploy/types'
import type { AuditFinding, AuditKind } from '../engine/deploy/automationAudit'
import { RdsHandlerError } from '../errors'

/**
 * The ledger correlation id for a run (`run-<id>` today; a real UUID when the
 * target-org ledger lands). ONE definition — the deploy handler writes it,
 * the run-state reader queries by it.
 */
export function runUuidFor(runId: number): string {
  return `run-${runId}`
}

export class DeployStore {
  constructor(private db: Database.Database) {}

  // ── Frozen plans ────────────────────────────────────────────

  /** Persist a frozen plan as the next version for this deployment. */
  savePlan(deploymentId: number, planJson: string, planHash: string): FrozenPlanRow {
    const insert = this.db.prepare(
      `INSERT INTO plans (deployment_id, version, plan_json, plan_hash)
       VALUES (@deploymentId, COALESCE((SELECT MAX(version) FROM plans WHERE deployment_id = @deploymentId), 0) + 1,
               @planJson, @planHash)`
    )
    const tx = this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM deployments WHERE id = ?').get(deploymentId)) {
        throw new RdsHandlerError('NOT_FOUND', `Deployment ${deploymentId} not found`)
      }
      return Number(insert.run({ deploymentId, planJson, planHash }).lastInsertRowid)
    })
    const plan = this.getPlanById(tx())
    if (!plan) throw new RdsHandlerError('NOT_FOUND', 'savePlan failed to persist')
    return plan
  }

  getPlanById(planId: number): FrozenPlanRow | null {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as
      Record<string, unknown> | undefined
    return row ? this.rowToPlan(row) : null
  }

  getLatestPlan(deploymentId: number): FrozenPlanRow | null {
    const row = this.db
      .prepare('SELECT * FROM plans WHERE deployment_id = ? ORDER BY version DESC LIMIT 1')
      .get(deploymentId) as Record<string, unknown> | undefined
    return row ? this.rowToPlan(row) : null
  }

  private rowToPlan(r: Record<string, unknown>): FrozenPlanRow {
    return {
      id: Number(r.id),
      deploymentId: Number(r.deployment_id),
      version: Number(r.version),
      planJson: String(r.plan_json),
      planHash: String(r.plan_hash),
      createdAt: Number(r.created_at)
    }
  }

  // ── Runs ────────────────────────────────────────────────────

  /**
   * Create a run against a frozen plan (initial phase 'Frozen'). plan_hash is
   * denormalized onto the run so every record_results batch is audit-traceable
   * to the exact plan bytes via run_id alone.
   */
  createRun(deploymentId: number, planId: number): RunState {
    const plan = this.getPlanById(planId)
    if (!plan) throw new RdsHandlerError('NOT_FOUND', `Plan ${planId} not found`)
    if (plan.deploymentId !== deploymentId) {
      throw new RdsHandlerError(
        'INVALID_STATE',
        `Plan ${planId} belongs to deployment ${plan.deploymentId}, not ${deploymentId}`
      )
    }
    const info = this.db
      .prepare(`INSERT INTO deploy_runs (deployment_id, plan_id, plan_hash) VALUES (?, ?, ?)`)
      .run(deploymentId, planId, plan.planHash)
    const run = this.getRun(Number(info.lastInsertRowid))
    if (!run) throw new RdsHandlerError('NOT_FOUND', 'createRun failed to persist')
    return run
  }

  getRun(runId: number): RunState | null {
    const row = this.db.prepare('SELECT * FROM deploy_runs WHERE id = ?').get(runId) as
      Record<string, unknown> | undefined
    return row ? this.rowToRun(row) : null
  }

  /** Non-terminal runs, oldest first — the startup recovery sweep's input. */
  listActiveRuns(): RunState[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM deploy_runs WHERE phase NOT IN ('Completed','Failed','Cancelled') ORDER BY id`
      )
      .all() as Record<string, unknown>[]
    return rows.map((r) => this.rowToRun(r))
  }

  listRunsForDeployment(deploymentId: number): RunState[] {
    const rows = this.db
      .prepare('SELECT * FROM deploy_runs WHERE deployment_id = ? ORDER BY id')
      .all(deploymentId) as Record<string, unknown>[]
    return rows.map((r) => this.rowToRun(r))
  }

  /**
   * Set the run phase. started_at is stamped once, on the first transition out
   * of 'Frozen'; finished_at is stamped when the phase is terminal (and cleared
   * again if a Stalled run is later resumed — resuming re-opens the run).
   *
   * S46 D1: the parent `deployments.status` is MIRRORED in the same transaction
   * (deployDesign §1.3 — status tracks the run; the label vocabulary is
   * DEPLOYMENT_STATUS_BY_PHASE). Two statements, one transaction, so a crash
   * between them can never leave the row pair disagreeing. The Apex preserve
   * rule (AutomationToggleBatch start/finish never overwrote a Cancelled or
   * Stalled deployment with a working status, ATB:63-68) is kept: a
   * NON-terminal target phase does not overwrite 'Cancelled' / 'Stalled';
   * terminal phases and 'Stalled' itself always write. Consequence for the
   * future E2 resume slice: re-opening a Stalled run must clear the status
   * explicitly — the mirror alone will not move it off 'Stalled'.
   */
  setRunPhase(runId: number, phase: RunPhase): void {
    const now = Date.now()
    const terminal = TERMINAL_RUN_PHASES.has(phase)
    const status = DEPLOYMENT_STATUS_BY_PHASE[phase]
    const force = terminal || phase === 'Stalled'
    const runUpdate = this.db.prepare(
      `UPDATE deploy_runs SET
         phase = @phase,
         started_at = CASE WHEN started_at IS NULL AND @phase != 'Frozen' THEN @now ELSE started_at END,
         finished_at = CASE WHEN @terminal THEN @now ELSE NULL END
       WHERE id = @runId`
    )
    const statusMirror = this.db.prepare(
      `UPDATE deployments SET status = @status, updated_at = @now
       WHERE id = (SELECT deployment_id FROM deploy_runs WHERE id = @runId)
         AND (@force = 1 OR status NOT IN ('Cancelled', 'Stalled'))`
    )
    const tx = this.db.transaction(() => {
      const info = runUpdate.run({ runId, phase, now, terminal: terminal ? 1 : 0 })
      if (info.changes === 0) throw new RdsHandlerError('NOT_FOUND', `Run ${runId} not found`)
      statusMirror.run({ runId, status, now, force: force ? 1 : 0 })
    })
    tx()
  }

  /** Persist the (object, pass) resume point. Null clears it (between objects). */
  setResumePoint(runId: number, currentObject: string | null, currentPass: PassKind | null): void {
    const info = this.db
      .prepare('UPDATE deploy_runs SET current_object = ?, current_pass = ? WHERE id = ?')
      .run(currentObject, currentPass, runId)
    if (info.changes === 0) throw new RdsHandlerError('NOT_FOUND', `Run ${runId} not found`)
  }

  /**
   * Persist the target's legacy-CPQ-setting probe result at gate time (S47,
   * PLAN D2): the post-run reminder mirrors the LWC `!hasCpqTriggerSetting &&
   * any gated object` instead of hedging.
   */
  setRunCpqTriggerSetting(runId: number, hasCpqTriggerSetting: boolean): void {
    const info = this.db
      .prepare('UPDATE deploy_runs SET cpq_trigger_setting = ? WHERE id = ?')
      .run(hasCpqTriggerSetting ? 1 : 0, runId)
    if (info.changes === 0) throw new RdsHandlerError('NOT_FOUND', `Run ${runId} not found`)
  }

  /** null = never recorded (pre-006 row or a run that died before the gate wrote it). */
  runCpqTriggerSetting(runId: number): boolean | null {
    const row = this.db
      .prepare('SELECT cpq_trigger_setting AS v FROM deploy_runs WHERE id = ?')
      .get(runId) as { v: number | null } | undefined
    if (!row || row.v == null) return null
    return row.v === 1
  }

  requestCancel(runId: number): void {
    const info = this.db
      .prepare('UPDATE deploy_runs SET cancel_requested = 1 WHERE id = ?')
      .run(runId)
    if (info.changes === 0) throw new RdsHandlerError('NOT_FOUND', `Run ${runId} not found`)
  }

  /** Stamp the outcome the run entered teardown with (E4E.1 resume contract). */
  setTeardownOutcome(runId: number, outcome: 'completed' | 'cancelled' | 'failed'): void {
    const info = this.db
      .prepare('UPDATE deploy_runs SET teardown_outcome = ? WHERE id = ?')
      .run(outcome, runId)
    if (info.changes === 0) throw new RdsHandlerError('NOT_FOUND', `Run ${runId} not found`)
  }

  /** Finalize hook completed — a teardown resume skips straight to restore. */
  markFinalizeDone(runId: number): void {
    const info = this.db.prepare('UPDATE deploy_runs SET finalize_done = 1 WHERE id = ?').run(runId)
    if (info.changes === 0) throw new RdsHandlerError('NOT_FOUND', `Run ${runId} not found`)
  }

  isCancelRequested(runId: number): boolean {
    const row = this.db
      .prepare('SELECT cancel_requested FROM deploy_runs WHERE id = ?')
      .get(runId) as { cancel_requested: number } | undefined
    if (!row) throw new RdsHandlerError('NOT_FOUND', `Run ${runId} not found`)
    return row.cancel_requested === 1
  }

  private rowToRun(r: Record<string, unknown>): RunState {
    return {
      id: Number(r.id),
      deploymentId: Number(r.deployment_id),
      planId: Number(r.plan_id),
      planHash: String(r.plan_hash),
      phase: String(r.phase) as RunPhase,
      currentObject: r.current_object != null ? String(r.current_object) : null,
      currentPass: r.current_pass != null ? (String(r.current_pass) as PassKind) : null,
      cancelRequested: r.cancel_requested === 1,
      teardownOutcome:
        r.teardown_outcome != null
          ? (String(r.teardown_outcome) as RunState['teardownOutcome'])
          : null,
      finalizeDone: r.finalize_done === 1,
      startedAt: r.started_at != null ? Number(r.started_at) : null,
      finishedAt: r.finished_at != null ? Number(r.finished_at) : null,
      createdAt: Number(r.created_at)
    }
  }

  // ── Record results (the attempt log the counter views read) ─

  /** Batch-insert one transport batch's per-record outcomes (single transaction). */
  recordResults(runId: number, rows: RecordResultInput[]): void {
    if (rows.length === 0) return
    const stmt = this.db.prepare(
      `INSERT INTO record_results
         (run_id, deployment_object_id, object_api_name, source_id, target_id,
          pass, retry_pass, object_attempt, outcome, error_code, error_message)
       VALUES
         (@runId, NULL, @objectApiName, @sourceId, @targetId,
          @pass, @retryPass, @objectAttempt, @outcome, @errorCode, @errorMessage)`
    )
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        stmt.run({
          runId,
          objectApiName: r.objectApiName,
          sourceId: r.sourceId,
          targetId: r.targetId ?? null,
          pass: r.pass,
          retryPass: r.retryPass,
          objectAttempt: r.objectAttempt,
          outcome: r.outcome,
          errorCode: r.errorCode ?? null,
          errorMessage: r.errorMessage ?? null
        })
      }
    })
    tx()
  }

  // ── Failure relation (classification + retry bookkeeping) ───

  recordFailures(runId: number, rows: FailedRecordInput[]): void {
    if (rows.length === 0) return
    const stmt = this.db.prepare(
      `INSERT INTO failed_records
         (run_id, object_api_name, pass, retry_pass, object_attempt, source_id,
          ext_id, error_code, error_message, fields_json, classification)
       VALUES
         (@runId, @objectApiName, @pass, @retryPass, @objectAttempt, @sourceId,
          @extId, @errorCode, @errorMessage, @fieldsJson, @classification)`
    )
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        stmt.run({
          runId,
          objectApiName: r.objectApiName,
          pass: r.pass,
          retryPass: r.retryPass,
          objectAttempt: r.objectAttempt,
          sourceId: r.sourceId,
          extId: r.extId ?? null,
          errorCode: r.errorCode ?? null,
          errorMessage: r.errorMessage ?? null,
          fieldsJson: r.fieldsJson ?? null,
          classification: r.classification ?? null
        })
      }
    })
    tx()
  }

  /**
   * The failure relation for one (run, object, retryPass, objectAttempt) —
   * the retry-transition input. objectAttempt is EXPLICIT (E2.5 review
   * finding): without it, stale failures from an aborted earlier attempt leak
   * into the retry input — Apex zeroed Retry_Source_Ids on whole-object retry
   * entry (DDQ L125-126), so only the current attempt's failures may feed
   * retries.
   */
  listFailures(
    runId: number,
    objectApiName: string,
    retryPass: number,
    objectAttempt: number
  ): { sourceId: string; classification: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT source_id, classification FROM failed_records
         WHERE run_id = ? AND object_api_name = ? AND pass = 1
           AND retry_pass = ? AND object_attempt = ?
         ORDER BY id`
      )
      .all(runId, objectApiName, retryPass, objectAttempt) as {
      source_id: string
      classification: string | null
    }[]
    return rows.map((r) => ({ sourceId: r.source_id, classification: r.classification }))
  }

  /** Latest whole-object attempt recorded for (run, object), first-pass family. -1 = no rows yet. */
  maxObjectAttempt(runId: number, objectApiName: string): number {
    const row = this.db
      .prepare(
        `SELECT MAX(object_attempt) AS m FROM record_results
         WHERE run_id = ? AND object_api_name = ? AND pass = 1`
      )
      .get(runId, objectApiName) as { m: number | null }
    return row.m ?? -1
  }

  /** Highest targeted-retry pass recorded for (run, object) at the given attempt. 0 = fresh only. */
  maxRetryPass(runId: number, objectApiName: string, objectAttempt: number): number {
    const row = this.db
      .prepare(
        `SELECT MAX(retry_pass) AS m FROM record_results
         WHERE run_id = ? AND object_api_name = ? AND pass = 1 AND object_attempt = ?`
      )
      .get(runId, objectApiName, objectAttempt) as { m: number | null }
    return row.m ?? 0
  }

  /** COUNT of failed_records at exact (retryPass, objectAttempt) — the progress-gate input. */
  failureCountAt(
    runId: number,
    objectApiName: string,
    retryPass: number,
    objectAttempt: number
  ): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM failed_records
         WHERE run_id = ? AND object_api_name = ? AND pass = 1
           AND retry_pass = ? AND object_attempt = ?`
      )
      .get(runId, objectApiName, retryPass, objectAttempt) as { n: number }
    return row.n
  }

  /** Drop an object's queued retries (whole-object retry entry — Apex nulls Retry_Pending_Ids). */
  clearRetryQueue(runId: number, objectApiName: string): void {
    this.db
      .prepare('DELETE FROM retry_queue WHERE run_id = ? AND object_api_name = ?')
      .run(runId, objectApiName)
  }

  // ── Retry queue (Apex Retry_Pending_Ids drained in 150-Id chunks) ─

  /** Idempotent enqueue (re-enqueueing an id keeps one row, latest attempt). */
  enqueueRetries(runId: number, objectApiName: string, sourceIds: string[], attempt: number): void {
    if (sourceIds.length === 0) return
    const stmt = this.db.prepare(
      `INSERT INTO retry_queue (run_id, object_api_name, source_id, attempt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (run_id, object_api_name, source_id) DO UPDATE SET attempt = excluded.attempt`
    )
    const tx = this.db.transaction(() => {
      for (const id of sourceIds) stmt.run(runId, objectApiName, id, attempt)
    })
    tx()
  }

  /**
   * Pull-and-delete the next chunk in insertion order (the Apex 150-Id chunk
   * drain). Returns [] when the queue for this object is empty.
   */
  dequeueRetryChunk(runId: number, objectApiName: string, limit: number): string[] {
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id, source_id FROM retry_queue
           WHERE run_id = ? AND object_api_name = ? ORDER BY id LIMIT ?`
        )
        .all(runId, objectApiName, limit) as { id: number; source_id: string }[]
      const del = this.db.prepare('DELETE FROM retry_queue WHERE id = ?')
      for (const r of rows) del.run(r.id)
      return rows.map((r) => r.source_id)
    })
    return tx()
  }

  retryQueueDepth(runId: number, objectApiName?: string): number {
    const row = (
      objectApiName === undefined
        ? this.db.prepare('SELECT COUNT(*) AS n FROM retry_queue WHERE run_id = ?').get(runId)
        : this.db
            .prepare(
              'SELECT COUNT(*) AS n FROM retry_queue WHERE run_id = ? AND object_api_name = ?'
            )
            .get(runId, objectApiName)
    ) as { n: number }
    return row.n
  }

  // ── Counters (computed — the migration-005 views) ───────────

  /** Per-object counter sextet, plan-order-agnostic (caller sorts by plan). */
  /**
   * The classifier's failed set per object — the exact mirror of the Apex
   * Persistent_Failed_Source_Ids__c snapshot (DDQ L2244-2263): per object, the
   * failed_records rows at the LATEST object_attempt's LATEST retry_pass.
   * That reproduces the per-hop OVERWRITE (Persistent = the current pass's
   * accumulator, L1997-2003): a record absent from a retry pass's failures —
   * healed, transform-skipped, or DELETED ON SOURCE mid-run — drops out, so a
   * later FK line pointing at it classifies ROOT exactly like the frozen Apex
   * (E4E.3 review: a current-truth reading kept deleted-source parents
   * 'failed' forever and cascade-classified what Apex called root). An
   * abandoned drain that recorded nothing leaves the previous pass's set in
   * place — also Apex (the transition never wrote Persistent; only batch DML
   * did). Residual documented gap: a FULLY-healed retry pass nulled the Apex
   * Persistent while this query falls back to the previous pass's rows — an
   * FK error against a healed (= now present on target) parent record can't
   * occur, so the shapes differ only for OLI transform-skips nothing FKs to.
   */
  currentFailures(runId: number): { objectApiName: string; sourceId: string }[] {
    const rows = this.db
      .prepare(
        `SELECT fr.object_api_name, fr.source_id
         FROM failed_records fr
         WHERE fr.run_id = @run AND fr.pass = 1
           AND fr.object_attempt = (
             SELECT MAX(f2.object_attempt) FROM failed_records f2
             WHERE f2.run_id = @run AND f2.pass = 1
               AND f2.object_api_name = fr.object_api_name)
           AND fr.retry_pass = (
             SELECT MAX(f3.retry_pass) FROM failed_records f3
             WHERE f3.run_id = @run AND f3.pass = 1
               AND f3.object_api_name = fr.object_api_name
               AND f3.object_attempt = fr.object_attempt)
         ORDER BY fr.object_api_name, fr.source_id`
      )
      .all({ run: runId }) as Record<string, unknown>[]
    return rows.map((r) => ({
      objectApiName: String(r.object_api_name),
      sourceId: String(r.source_id)
    }))
  }

  /**
   * The run's own materialized first-pass scope for one object (E4E.4):
   * DISTINCT source ids of the retry_pass-0 rows at the LATEST object_attempt
   * — exactly the records the fresh page walk queried (one row per source
   * record by the E4E.2 row-writing contract), insertion order. The second
   * pass scopes its source query to these ids instead of re-deriving the
   * filter (deployDesign E4E.4).
   */
  queriedSourceIds(runId: number, objectApiName: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT r.source_id AS sid
         FROM record_results r
         JOIN v_run_object_attempt la
           ON la.run_id = r.run_id AND la.object_api_name = r.object_api_name
         WHERE r.run_id = ? AND r.object_api_name = ? AND r.pass = 1
           AND r.retry_pass = 0 AND r.object_attempt = la.latest_attempt
         GROUP BY r.source_id
         ORDER BY MIN(r.id)`
      )
      .all(runId, objectApiName) as { sid: string }[]
    return rows.map((r) => r.sid)
  }

  /**
   * Source ids whose CURRENT outcome is success — latest row per record at the
   * latest attempt (v_run_record_current), so a record that failed at retry
   * pass 0 and healed at pass 2 counts, and one that regressed does not. The
   * junction parent scope (E4E.5) = reverse() of these — the run-scoped
   * replacement for the Apex org-wide target ExtId scan.
   */
  deployedSourceIds(runId: number, objectApiName: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT source_id AS sid FROM v_run_record_current
         WHERE run_id = ? AND object_api_name = ? AND outcome = 'success'
         ORDER BY id`
      )
      .all(runId, objectApiName) as { sid: string }[]
    return rows.map((r) => r.sid)
  }

  // ── Stripped references (S50 A5) — observability only ─────────

  /** Batch-insert the run's dropped NILLABLE lookups (single transaction). */
  recordStrippedRefs(runId: number, rows: StrippedRefInput[]): void {
    if (rows.length === 0) return
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO stripped_refs
         (run_id, object_api_name, source_id, field_name, relationship_name,
          ref_object, parent_ext_id, parent_source_id, pass, retry_pass,
          object_attempt, created_at)
       VALUES
         (@runId, @objectApiName, @sourceId, @fieldName, @relationshipName,
          @refObject, @parentExtId, @parentSourceId, @pass, @retryPass,
          @objectAttempt, @createdAt)`
    )
    const createdAt = Date.now()
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        stmt.run({
          runId,
          objectApiName: r.objectApiName,
          sourceId: r.sourceId,
          fieldName: r.fieldName,
          relationshipName: r.relationshipName,
          refObject: r.refObject,
          parentExtId: r.parentExtId,
          parentSourceId: r.parentSourceId,
          pass: r.pass,
          retryPass: r.retryPass,
          objectAttempt: r.objectAttempt,
          createdAt
        })
      }
    })
    tx()
  }

  /**
   * S50 (A5): the orphan roll-up. Counts DISTINCT source records per
   * (object, field) whose lookup was dropped, and — via `v_run_record_current`
   * on the parent object — how many of those parents nonetheless landed in
   * this run. That split is the actionable part: a parent that DID land means
   * "re-run and the link resolves", a parent that never landed means "widen
   * the scope or accept the gap".
   */
  orphanedLinkSummary(runId: number): OrphanedLinkGroup[] {
    const rows = this.db
      .prepare(
        `SELECT sr.object_api_name AS obj,
                sr.field_name      AS fld,
                sr.ref_object      AS ref,
                COUNT(DISTINCT sr.source_id) AS n,
                COUNT(DISTINCT CASE WHEN cur.source_id IS NOT NULL
                                    THEN sr.source_id END) AS landed
         FROM stripped_refs sr
         LEFT JOIN v_run_record_current cur
           ON cur.run_id = sr.run_id
          AND cur.object_api_name = sr.ref_object
          AND cur.outcome = 'success'
          AND cur.source_id = sr.parent_source_id
         WHERE sr.run_id = ?
         GROUP BY sr.object_api_name, sr.field_name, sr.ref_object
         ORDER BY n DESC, obj, fld`
      )
      .all(runId) as { obj: string; fld: string; ref: string; n: number; landed: number }[]
    return rows.map((r) => ({
      objectApiName: String(r.obj),
      fieldName: String(r.fld),
      refObject: String(r.ref),
      count: Number(r.n),
      parentLandedCount: Number(r.landed)
    }))
  }

  /**
   * S49 (BUG-1 pt3). Reads `v_run_record_current` so a record healed by a later
   * retry stops counting as skipped, exactly like every other counter.
   */
  skipReasonCounts(runId: number): Array<{ reason: string; count: number }> {
    const rows = this.db
      .prepare(
        `SELECT
           CASE
             WHEN instr(error_message, ' ') > 0
               THEN substr(error_message, 1, instr(error_message, ' ') - 1)
             ELSE error_message
           END AS reason,
           COUNT(*) AS n
         FROM v_run_record_current
         WHERE run_id = ? AND outcome = 'skipped' AND error_message IS NOT NULL
         GROUP BY reason
         ORDER BY n DESC, reason`
      )
      .all(runId) as { reason: string; n: number }[]
    return rows.map((r) => ({ reason: String(r.reason), count: Number(r.n) }))
  }

  objectCounters(runId: number): ObjectCounters[] {
    const rows = this.db
      .prepare('SELECT * FROM v_run_object_counters WHERE run_id = ? ORDER BY object_api_name')
      .all(runId) as Record<string, unknown>[]
    return rows.map((r) => ({
      runId: Number(r.run_id),
      objectApiName: String(r.object_api_name),
      recordsQueried: Number(r.records_queried),
      recordsDeployed: Number(r.records_deployed),
      recordsFailed: Number(r.records_failed),
      recordsFailedRoot: Number(r.records_failed_root),
      recordsFailedCascade: Number(r.records_failed_cascade),
      recordsSkipped: Number(r.records_skipped)
    }))
  }

  /** Run-level rollup (recomputeDeploymentCounters SUM semantics). Zeroes when no results yet. */
  runCounters(runId: number): RunCounters {
    const row = this.db.prepare('SELECT * FROM v_run_counters WHERE run_id = ?').get(runId) as
      Record<string, unknown> | undefined
    if (!row) {
      return {
        runId,
        recordsQueried: 0,
        recordsDeployed: 0,
        recordsFailed: 0,
        recordsFailedRoot: 0,
        recordsFailedCascade: 0,
        recordsSkipped: 0
      }
    }
    return {
      runId: Number(row.run_id),
      recordsQueried: Number(row.records_queried),
      recordsDeployed: Number(row.records_deployed),
      recordsFailed: Number(row.records_failed),
      recordsFailedRoot: Number(row.records_failed_root),
      recordsFailedCascade: Number(row.records_failed_cascade),
      recordsSkipped: Number(row.records_skipped)
    }
  }

  // ── S53 (item 1): run audit findings — observability only ───────────

  /** Persist audit findings for a run (single transaction). Empty input is a no-op. */
  recordAuditFindings(runId: number, rows: ReadonlyArray<AuditFinding>): void {
    if (rows.length === 0) return
    const stmt = this.db.prepare(
      `INSERT INTO run_audit_findings
         (run_id, kind, object_api_name, ref_object, ref_field, row_count, sample_ids, created_at)
       VALUES (@runId, @kind, @objectApiName, @refObject, @refField, @count, @sampleIds, @createdAt)`
    )
    const createdAt = Date.now()
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        stmt.run({
          runId,
          kind: r.kind,
          objectApiName: r.objectApiName,
          refObject: r.refObject,
          refField: r.refField,
          count: r.count,
          sampleIds: JSON.stringify(r.sampleIds ?? []),
          createdAt
        })
      }
    })
    tx()
  }

  /** The run's audit findings, insertion order. */
  auditFindings(runId: number): AuditFinding[] {
    const rows = this.db
      .prepare(
        `SELECT kind, object_api_name, ref_object, ref_field, row_count, sample_ids
         FROM run_audit_findings WHERE run_id = ? ORDER BY id`
      )
      .all(runId) as Record<string, unknown>[]
    return rows.map((r) => {
      let sampleIds: string[] = []
      try {
        const parsed = JSON.parse(String(r.sample_ids ?? '[]')) as unknown
        if (Array.isArray(parsed)) sampleIds = parsed.map((x) => String(x))
      } catch {
        /* a malformed sample list is not worth failing the read */
      }
      return {
        kind: String(r.kind) as AuditKind,
        objectApiName: String(r.object_api_name),
        refObject: r.ref_object == null ? null : String(r.ref_object),
        refField: r.ref_field == null ? null : String(r.ref_field),
        count: Number(r.row_count),
        sampleIds
      }
    })
  }

  /** Stamp the post-run audit as complete; `note` explains a skip / partial audit (null = clean). */
  markAuditComplete(runId: number, note: string | null): void {
    const info = this.db
      .prepare('UPDATE deploy_runs SET audit_completed_at = ?, audit_note = ? WHERE id = ?')
      .run(Date.now(), note, runId)
    if (info.changes === 0) throw new RdsHandlerError('NOT_FOUND', `Run ${runId} not found`)
  }

  /** The run's audit stamp; completedAt null = the post-run audit never ran. */
  auditStatus(runId: number): { completedAt: number | null; note: string | null } {
    const row = this.db
      .prepare('SELECT audit_completed_at AS at, audit_note AS note FROM deploy_runs WHERE id = ?')
      .get(runId) as { at: number | null; note: string | null } | undefined
    if (!row) throw new RdsHandlerError('NOT_FOUND', `Run ${runId} not found`)
    return { completedAt: row.at == null ? null : Number(row.at), note: row.note ?? null }
  }

  // ── E4A.6 automation ledger mirror (engine/automation/hooks.ts seam) ──
  // The D4 write-ahead record: rows inserted BEFORE any toggle callout, in one
  // synchronous transaction (fail-loud — a throw here aborts the run before
  // automation is touched). The target-org RDS_Restore_Ledger__c write-ahead
  // (connector-package v-next) will layer behind the same seam.

  /** Insert write-ahead rows; returns row ids in input order. THROWS on failure. */
  ledgerWriteAhead(
    deploymentId: number,
    runUuid: string,
    rows: {
      itemType: string
      itemId: string | null
      itemName: string
      restoreVersionNumber: number | null
      detail: string | null
    }[]
  ): number[] {
    const target = this.db
      .prepare('SELECT target_connection_id FROM deployments WHERE id = ?')
      .get(deploymentId) as { target_connection_id: string | null } | undefined
    if (!target) throw new RdsHandlerError('NOT_FOUND', `Deployment ${deploymentId} not found`)
    const insert = this.db.prepare(
      `INSERT INTO automation_ledger_mirror
         (deployment_id, target_org_id, item_type, item_name, item_id,
          run_uuid, restore_version_number, detail, restore_confirmed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
    const tx = this.db.transaction((): number[] => {
      const ids: number[] = []
      for (const row of rows) {
        ids.push(
          Number(
            insert.run(
              deploymentId,
              target.target_connection_id ?? '',
              row.itemType,
              row.itemName,
              row.itemId,
              runUuid,
              row.restoreVersionNumber,
              row.detail
            ).lastInsertRowid
          )
        )
      }
      return ids
    })
    return tx()
  }

  /** Stamp disabled_at on attempted/confirmed toggles (bookkeeping, not gating). */
  ledgerMarkDisabled(rowIds: number[]): void {
    if (rowIds.length === 0) return
    const stmt = this.db.prepare(
      `UPDATE automation_ledger_mirror SET disabled_at = unixepoch('now') * 1000 WHERE id = ?`
    )
    const tx = this.db.transaction(() => {
      for (const id of rowIds) stmt.run(id)
    })
    tx()
  }

  /** Rows for the run still awaiting a confirmed restore (the restore work list). */
  ledgerUnconfirmed(runUuid: string): {
    id: number
    itemType: string
    itemId: string | null
    itemName: string
    restoreVersionNumber: number | null
    detail: string | null
    disabledAt: number | null
  }[] {
    const rows = this.db
      .prepare(
        `SELECT id, item_type, item_id, item_name, restore_version_number, detail, disabled_at
         FROM automation_ledger_mirror
         WHERE run_uuid = ? AND restore_confirmed = 0
         ORDER BY id`
      )
      .all(runUuid) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: Number(r.id),
      itemType: String(r.item_type),
      itemId: r.item_id == null ? null : String(r.item_id),
      itemName: String(r.item_name),
      restoreVersionNumber:
        r.restore_version_number == null ? null : Number(r.restore_version_number),
      detail: r.detail == null ? null : String(r.detail),
      disabledAt: r.disabled_at == null ? null : Number(r.disabled_at)
    }))
  }

  /** Per-item restore confirmation stamps (deployDesign §4.1). */
  ledgerConfirmRestored(rowIds: number[]): void {
    if (rowIds.length === 0) return
    const stmt = this.db.prepare(
      'UPDATE automation_ledger_mirror SET restore_confirmed = 1 WHERE id = ?'
    )
    const tx = this.db.transaction(() => {
      for (const id of rowIds) stmt.run(id)
    })
    tx()
  }

  /** ALL unconfirmed rows regardless of run — the E4E.6 launch-recovery scan. */
  ledgerUnconfirmedAll(): { runUuid: string | null; deploymentId: number; count: number }[] {
    const rows = this.db
      .prepare(
        `SELECT run_uuid, deployment_id, COUNT(*) AS n
         FROM automation_ledger_mirror
         WHERE restore_confirmed = 0
         GROUP BY run_uuid, deployment_id`
      )
      .all() as Record<string, unknown>[]
    return rows.map((r) => ({
      runUuid: r.run_uuid == null ? null : String(r.run_uuid),
      deploymentId: Number(r.deployment_id),
      count: Number(r.n)
    }))
  }

  // NOTE (S46 E1): `deployedTargetIds` was removed. The first-pass upsert
  // path never records target_id (collections.ts discards success ids — only
  // the junction path writes it), so scoping Contract activation by target Id
  // was a structural no-op. Activation now scopes by this run's ExtIds derived
  // from `deployedSourceIds` (deployDesign §4.3(2) prescribes ExtId scoping).
}
