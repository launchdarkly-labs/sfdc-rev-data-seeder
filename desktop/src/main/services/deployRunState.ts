/**
 * S46 D2 — `rds:deploy.runState`: ONE read that assembles everything the
 * deployment detail page renders from the persisted rows (deployments header
 * incl. the full error text, the CURRENT attempt's deploy_runs row, counter
 * views, the plan-ordered objects) plus this session's latest deploy JobSummary.
 *
 * This is the single place that maps engine rows (RunState / RunCounters /
 * ObjectCounters / FrozenObjectPlan) onto the RENDERER-SAFE mirror types in
 * shared/types.ts — the renderer tsconfig cannot import engine types.
 *
 * WHICH RUN (S47 review F3): the current attempt's run is `deployments.
 * current_run_id` (migration 006) — cleared at job start, set after createRun.
 * NULL means this attempt has no run (in connect/gates/freeze, or it failed /
 * was cancelled there), even when OLDER runs exist: a fix-and-redeploy must
 * not be rendered as the previous run's outcome. Legacy rows (runs but no
 * linkage) attribute the newest run only when the deployment status still
 * mirrors that run's own phase word — a mismatch proves a later attempt.
 *
 * Read-only: no org I/O, no writes. Cheap enough to re-read on every job event.
 */
import type {
  DeployCountersView,
  DeployObjectStateView,
  DeployRunPhaseView,
  DeployRunStateView,
  JobSummary
} from '../../shared/types'
import { isDeployFinished } from '../../shared/wizard'
import type { JobManager } from '../jobs'
import { RdsHandlerError } from '../errors'
import type { FrozenObjectPlan } from '../engine/deploy/planFreeze'
import type { RunState } from '../engine/deploy/types'
import { DEPLOYMENT_STATUS_BY_PHASE } from '../engine/deploy/types'
import type { Store } from './store'
import { runUuidFor } from './deployStore'

const ZERO: DeployCountersView = {
  recordsQueried: 0,
  recordsDeployed: 0,
  recordsFailed: 0,
  recordsSkipped: 0
}

/** Newest 'deploy' job for the deployment this app session (undefined-safe). */
function latestDeployJob(jobs: JobManager, deploymentId: number): JobSummary | null {
  const key = String(deploymentId)
  let latest: JobSummary | null = null
  for (const j of jobs.list()) {
    if (j.kind === 'deploy' && j.deploymentId === key) latest = j
  }
  return latest
}

/** The CURRENT attempt's run (see header), or null. */
export function currentAttemptRun(
  store: Store,
  deploymentId: number,
  deploymentStatus: string
): RunState | null {
  const runs = store.deploy.listRunsForDeployment(deploymentId)
  if (runs.length === 0) return null
  const linked = store.getCurrentRunId(deploymentId)
  if (linked != null) return runs.find((r) => r.id === linked) ?? null
  // Legacy fallback (pre-006 rows): the newest run is this attempt only if
  // the status still mirrors its phase; a Deploying/Failed/Cancelled/Planned
  // status over a Completed run proves a later attempt closed out pre-run.
  const latest = runs[runs.length - 1]!
  return DEPLOYMENT_STATUS_BY_PHASE[latest.phase] === deploymentStatus ? latest : null
}

export function buildDeployRunState(
  store: Store,
  jobs: JobManager,
  deploymentId: number
): DeployRunStateView {
  const deployment = store.getDeploymentHeader(deploymentId)
  if (!deployment) throw new RdsHandlerError('NOT_FOUND', `Deployment ${deploymentId} not found`)
  const job = latestDeployJob(jobs, deploymentId)
  const finished = isDeployFinished(deployment.status)
  const run = currentAttemptRun(store, deploymentId, deployment.status)

  if (run == null) {
    // No run for THIS attempt: never frozen (Draft/Planned), in connect/gates/
    // freeze right now, or it failed / was cancelled there (status Failed or
    // Cancelled, error_message set, nothing on the target touched). Objects +
    // totals come from the ANALYSIS plan. No CPQ reminder: no run happened,
    // so there is nothing to undo between fix-and-redeploy attempts (F7).
    const plan = store.getPlan(deploymentId)
    const objects: DeployObjectStateView[] = (plan?.objects ?? []).map((o) => ({
      objectName: o.objectName,
      sortOrder: o.sortOrder,
      isJunction: o.isJunction,
      recordCount: o.recordCount,
      ...ZERO
    }))
    return {
      deployment,
      run: null,
      counters: null,
      objects,
      totalRecords: plan?.totalRecords ?? 0,
      cpqReminder: false,
      restoreUnconfirmed: 0,
      audit: null,
      job
    }
  }

  // A run exists for this attempt: objects come from ITS frozen plan (the
  // authoritative walk order), counters from the migration-005 views.
  const planRow = store.deploy.getPlanById(run.planId)
  const frozen = planRow
    ? (JSON.parse(planRow.planJson) as { objects: FrozenObjectPlan[]; totalRecords: number })
    : null
  const perObject = new Map(
    store.deploy.objectCounters(run.id).map((c) => [c.objectApiName, c] as const)
  )
  const frozenObjects = [...(frozen?.objects ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)
  const objects: DeployObjectStateView[] = frozenObjects.map((o) => {
    const c = perObject.get(o.objectName)
    return {
      objectName: o.objectName,
      sortOrder: o.sortOrder,
      isJunction: o.isJunction,
      recordCount: o.recordCount,
      recordsQueried: c?.recordsQueried ?? 0,
      recordsDeployed: c?.recordsDeployed ?? 0,
      recordsFailed: c?.recordsFailed ?? 0,
      recordsSkipped: c?.recordsSkipped ?? 0
    }
  })
  const rc = store.deploy.runCounters(run.id)
  const counters: DeployCountersView = {
    recordsQueried: rc.recordsQueried,
    recordsDeployed: rc.recordsDeployed,
    recordsFailed: rc.recordsFailed,
    recordsSkipped: rc.recordsSkipped
  }

  // Post-run CPQ reminder = the LWC predicate (deploymentWizard.js:2108-2113):
  // gated objects in the run AND the target lacked the legacy setting the app
  // could toggle itself (so the OPERATOR checked the package checkbox). A run
  // that died before the gate recorded the probe (null) is treated as
  // "manual" — the safe direction: an extra reminder, never a missing one.
  const hasCpqTriggerSetting = store.deploy.runCpqTriggerSetting(run.id) === true
  const anyGated = frozenObjects.some((o) => o.requiresTriggerBypass)

  return {
    deployment,
    run: {
      id: run.id,
      phase: run.phase as DeployRunPhaseView,
      currentObject: run.currentObject,
      currentPass: run.currentPass,
      cancelRequested: run.cancelRequested,
      teardownOutcome: run.teardownOutcome,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt
    },
    counters,
    objects,
    totalRecords: frozen?.totalRecords ?? objects.reduce((s, o) => s + o.recordCount, 0),
    cpqReminder: finished && anyGated && !hasCpqTriggerSetting,
    restoreUnconfirmed: store.deploy.ledgerUnconfirmed(runUuidFor(run.id)).length,
    // S53 (item 1): the run's automation audit — pre-run residue + post-run
    // automation-born rows, and whether the post-run audit completed at all.
    audit: {
      ...store.deploy.auditStatus(run.id),
      findings: store.deploy.auditFindings(run.id)
    },
    job
  }
}
