/**
 * S47 — the deploy attempt's main-side glue over the REAL sqlite Store
 * (review F3: D1/D2/D3 decision logic had no tests):
 *   closeOutAttempt · bridgeCancel · runFailureMessage/stalledMessage ·
 *   Store.reconcileOnStartup · currentAttemptRun / buildDeployRunState.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Store } from '../../src/main/services/store'
import { JobManager, JobCancelledError } from '../../src/main/jobs'
import {
  bridgeCancel,
  closeOutAttempt,
  runFailureMessage,
  stalledMessage
} from '../../src/main/services/deployAttempt'
import { buildDeployRunState, currentAttemptRun } from '../../src/main/services/deployRunState'
import { PlanFreezeError } from '../../src/main/engine/deploy/planFreeze'
import {
  INTERRUPTED_BEFORE_RUN_MESSAGE,
  STALLED_TEARDOWN_MESSAGE
} from '../../src/shared/recoveryCopy'

let store: Store
let jobs: JobManager

beforeEach(() => {
  store = new Store(':memory:')
  jobs = new JobManager(() => {})
  store.upsertConnections([
    {
      alias: 'src',
      username: 's@x.io',
      orgId: '00Dsrc00000000',
      instanceUrl: 'https://src.my.salesforce.com',
      connectedStatus: 'Connected',
      isSandbox: true
    },
    {
      alias: 'tgt',
      username: 't@x.io',
      orgId: '00Dtgt00000000',
      instanceUrl: 'https://tgt.my.salesforce.com',
      connectedStatus: 'Connected',
      isSandbox: true
    }
  ])
})
afterEach(() => store.close())

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function newDeployment(): number {
  return store.createDeployment({
    name: 'gpr test',
    sourceConnectionId: 'src',
    targetConnectionId: 'tgt'
  })
}

const PLAN_JSON = JSON.stringify({
  objects: [
    {
      objectName: 'Account',
      sortOrder: 0,
      isJunction: false,
      recordCount: 1,
      requiresTriggerBypass: false
    },
    {
      objectName: 'SBQQ__Quote__c',
      sortOrder: 1,
      isJunction: false,
      recordCount: 3,
      requiresTriggerBypass: true
    }
  ],
  totalRecords: 4
})

/** A run row for an attempt, linked like the ipc handler does it. */
function attemptWithRun(deploymentId: number): number {
  store.markDeployStarted(deploymentId)
  const plan = store.deploy.savePlan(deploymentId, PLAN_JSON, `h-${Date.now()}-${Math.random()}`)
  const run = store.deploy.createRun(deploymentId, plan.id)
  store.setCurrentRun(deploymentId, run.id)
  return run.id
}

const status = (id: number): string => store.getDeploymentHeader(id)!.status
const error = (id: number): string | null => store.getDeploymentHeader(id)!.errorMessage

describe('closeOutAttempt (D1)', () => {
  it('(i) PlanFreezeError BEFORE a run → Failed + the FULL multi-line text; no run row', () => {
    const id = newDeployment()
    store.markDeployStarted(id)
    const err = new PlanFreezeError([
      'Account: deferred field Gone__c no longer exists on the source object (stale plan) — re-run analysis before deploying',
      'Contact: deferred field Name is not a reference field on the current source describe (stale plan) — re-run analysis before deploying'
    ])
    closeOutAttempt(store, id, null, err)
    expect(status(id)).toBe('Failed')
    expect(error(id)).toBe(err.message)
    expect(error(id)!.length).toBeGreaterThan(255)
    expect(store.deploy.listRunsForDeployment(id)).toHaveLength(0)
  })

  it('(ii) JobCancelledError BEFORE a run → Cancelled, no error text', () => {
    const id = newDeployment()
    store.markDeployStarted(id)
    closeOutAttempt(store, id, null, new JobCancelledError())
    expect(status(id)).toBe('Cancelled')
    expect(error(id)).toBeNull()
  })

  it('(iii) throw AFTER a run that mirrored Stalled → status stays Stalled, reason recorded', () => {
    const id = newDeployment()
    const runId = attemptWithRun(id)
    store.deploy.setRunPhase(runId, 'Deploying')
    store.deploy.setRunPhase(runId, 'Stalled')
    closeOutAttempt(
      store,
      id,
      runId,
      new Error(STALLED_TEARDOWN_MESSAGE + '\nTeardown error: soap down')
    )
    expect(status(id)).toBe('Stalled')
    expect(error(id)).toContain('Teardown error: soap down')
  })

  it('(v) a run still Frozen when the job throws (nothing on the target touched) is closed Failed — not a phantom live run', () => {
    const id = newDeployment()
    const runId = attemptWithRun(id)
    closeOutAttempt(store, id, runId, new Error('hooks construction blew up'))
    expect(store.deploy.getRun(runId)!.phase).toBe('Failed')
    expect(status(id)).toBe('Failed')
    expect(error(id)).toBe('hooks construction blew up')
    // and a cancel in the same window closes it Cancelled
    const id2 = newDeployment()
    const run2 = attemptWithRun(id2)
    closeOutAttempt(store, id2, run2, new JobCancelledError())
    expect(store.deploy.getRun(run2)!.phase).toBe('Cancelled')
    expect(status(id2)).toBe('Cancelled')
    expect(error(id2)).toBeNull()
  })

  it('post-run cancel (orchestrator already mirrored Cancelled) leaves status + error untouched', () => {
    const id = newDeployment()
    const runId = attemptWithRun(id)
    store.deploy.setRunPhase(runId, 'Deploying')
    store.deploy.setRunPhase(runId, 'Cancelled')
    closeOutAttempt(store, id, runId, new JobCancelledError())
    expect(status(id)).toBe('Cancelled')
    expect(error(id)).toBeNull()
  })
})

describe('bridgeCancel (D3)', () => {
  it('(iv) a RUNNING deploy job → job token set AND deploy_runs.cancel_requested = 1; a finished job → unchanged', async () => {
    const id = newDeployment()
    const runId = attemptWithRun(id)
    let release: (() => void) | null = null
    const jobId = jobs.start(
      'deploy',
      'Deploy data',
      () => new Promise<void>((r) => (release = r)),
      {
        deploymentId: String(id)
      }
    )
    const map = new Map<string, number>([[jobId, runId]])
    bridgeCancel(store, jobs, map, jobId)
    expect(store.deploy.isCancelRequested(runId)).toBe(true)
    release!()
    await flush()

    const id2 = newDeployment()
    const run2 = attemptWithRun(id2)
    const done = jobs.start('deploy', 'Deploy data', async () => undefined, {
      deploymentId: String(id2)
    })
    await flush()
    bridgeCancel(store, jobs, new Map([[done, run2]]), done)
    expect(store.deploy.isCancelRequested(run2)).toBe(false) // finished job: no persisted cancel
  })

  it('an unknown run id never throws (deployment deleted mid-run)', async () => {
    let release: (() => void) | null = null
    const jobId = jobs.start('deploy', 'Deploy data', () => new Promise<void>((r) => (release = r)))
    expect(() => bridgeCancel(store, jobs, new Map([[jobId, 4242]]), jobId)).not.toThrow()
    release!()
    await flush()
  })
})

describe('terminal texts carry the last Error-level engine line (F2)', () => {
  it('runFailureMessage + stalledMessage', () => {
    const tripwire =
      'CPQ triggers are ACTIVE on the target — SBQQ.SubscriptionAfter rejected the batch. Check "Triggers Disabled" and re-run.'
    expect(runFailureMessage(3, tripwire)).toBe(
      `Deployment failed — 3 record(s) failed; per-record failures are recorded in the app database (failed_records / record_results) until the run-log pane ships (5C.1).\n${tripwire}`
    )
    expect(runFailureMessage(0, null)).not.toContain('\n')
    expect(runFailureMessage(0, null)).not.toContain('see the run log')
    expect(stalledMessage('Teardown error: x')).toBe(
      `${STALLED_TEARDOWN_MESSAGE}\nTeardown error: x`
    )
    expect(stalledMessage(null)).toBe(STALLED_TEARDOWN_MESSAGE)
  })
})

describe('Store.reconcileOnStartup (review F1 — the desktop watchdog)', () => {
  it('a busy status with NO live run → Failed + the interruption note, current_run_id cleared, re-deployable', () => {
    const id = newDeployment()
    store.markDeployStarted(id) // died during connect/gates/freeze
    const swept = store.reconcileOnStartup()
    expect(swept).toEqual({ stalledRuns: 0, interruptedAttempts: 1 })
    expect(status(id)).toBe('Failed')
    expect(error(id)).toBe(INTERRUPTED_BEFORE_RUN_MESSAGE)
    expect(store.getCurrentRunId(id)).toBeNull()
  })

  it('a NON-terminal run (app died mid-run) → parked Stalled; its deployment mirrors Stalled and is NOT closed Failed', () => {
    const id = newDeployment()
    const runId = attemptWithRun(id)
    store.deploy.setRunPhase(runId, 'Deploying')
    const swept = store.reconcileOnStartup()
    expect(swept).toEqual({ stalledRuns: 1, interruptedAttempts: 0 })
    expect(store.deploy.getRun(runId)!.phase).toBe('Stalled')
    expect(status(id)).toBe('Stalled')
    expect(store.getCurrentRunId(id)).toBe(runId) // linkage kept for the detail page
  })

  it('terminal rows and an already-Stalled run are untouched; the sweep is idempotent', () => {
    const done = newDeployment()
    const r1 = attemptWithRun(done)
    store.deploy.setRunPhase(r1, 'Deploying')
    store.deploy.setRunPhase(r1, 'Completed')
    const stalled = newDeployment()
    const r2 = attemptWithRun(stalled)
    store.deploy.setRunPhase(r2, 'Stalled')
    const failedPre = newDeployment()
    store.markDeployStarted(failedPre)
    store.markDeployFailedBeforeRun(failedPre, 'refused')
    expect(store.reconcileOnStartup()).toEqual({ stalledRuns: 0, interruptedAttempts: 0 })
    expect(status(done)).toBe('Completed')
    expect(status(stalled)).toBe('Stalled')
    expect(error(failedPre)).toBe('refused')
    expect(store.reconcileOnStartup()).toEqual({ stalledRuns: 0, interruptedAttempts: 0 })
  })
})

describe('currentAttemptRun / buildDeployRunState attribution (review F3)', () => {
  it('a second attempt refused at freeze AFTER a Completed run → run:null (pre-run shape), status Failed, no CPQ reminder', () => {
    const id = newDeployment()
    const r1 = attemptWithRun(id)
    store.deploy.setRunCpqTriggerSetting(r1, false)
    store.deploy.setRunPhase(r1, 'Deploying')
    store.deploy.setRunPhase(r1, 'Completed')
    // attempt 2: job start clears the linkage, freeze refuses
    store.markDeployStarted(id)
    closeOutAttempt(store, id, null, new PlanFreezeError(['Account: deferred field X …']))
    const s = buildDeployRunState(store, jobs, id)
    expect(s.deployment.status).toBe('Failed')
    expect(s.run).toBeNull()
    expect(s.counters).toBeNull()
    expect(s.cpqReminder).toBe(false)
    expect(s.deployment.errorMessage).toContain('Plan freeze refused')
  })

  it('while attempt 2 is in connect/gates/freeze (status Deploying, linkage cleared) the Completed run is NOT shown as current', () => {
    const id = newDeployment()
    const r1 = attemptWithRun(id)
    store.deploy.setRunPhase(r1, 'Deploying')
    store.deploy.setRunPhase(r1, 'Completed')
    store.markDeployStarted(id)
    expect(currentAttemptRun(store, id, status(id))).toBeNull()
    // …and once attempt 2 creates its run, THAT run is current
    const plan = store.deploy.savePlan(id, PLAN_JSON, 'h2')
    const r2 = store.deploy.createRun(id, plan.id)
    store.setCurrentRun(id, r2.id)
    expect(currentAttemptRun(store, id, status(id))!.id).toBe(r2.id)
    expect(buildDeployRunState(store, jobs, id).run!.id).toBe(r2.id)
  })

  it('legacy rows (no linkage): the newest run counts only while the status mirrors its phase', () => {
    const id = newDeployment()
    const plan = store.deploy.savePlan(id, PLAN_JSON, 'h-legacy')
    const run = store.deploy.createRun(id, plan.id) // no setCurrentRun — pre-006 shape
    store.deploy.setRunPhase(run.id, 'Deploying')
    store.deploy.setRunPhase(run.id, 'Failed')
    expect(currentAttemptRun(store, id, 'Failed')!.id).toBe(run.id)
    expect(currentAttemptRun(store, id, 'Planned')).toBeNull() // re-analysed afterwards
  })

  it('CPQ reminder = finished ∧ gated objects ∧ NOT hasCpqTriggerSetting (LWC parity); null probe counts as manual', () => {
    const manual = newDeployment()
    const r1 = attemptWithRun(manual)
    store.deploy.setRunCpqTriggerSetting(r1, false)
    store.deploy.setRunPhase(r1, 'Deploying')
    store.deploy.setRunPhase(r1, 'Completed')
    expect(buildDeployRunState(store, jobs, manual).cpqReminder).toBe(true)

    const legacySetting = newDeployment()
    const r2 = attemptWithRun(legacySetting)
    store.deploy.setRunCpqTriggerSetting(r2, true) // the app toggled SBQQ__TriggerDisabled__c itself
    store.deploy.setRunPhase(r2, 'Deploying')
    store.deploy.setRunPhase(r2, 'Completed')
    expect(buildDeployRunState(store, jobs, legacySetting).cpqReminder).toBe(false)

    const running = newDeployment()
    const r3 = attemptWithRun(running)
    store.deploy.setRunCpqTriggerSetting(r3, false)
    store.deploy.setRunPhase(r3, 'Deploying')
    expect(buildDeployRunState(store, jobs, running).cpqReminder).toBe(false) // not finished

    const noProbe = newDeployment()
    const r4 = attemptWithRun(noProbe)
    store.deploy.setRunPhase(r4, 'Deploying')
    store.deploy.setRunPhase(r4, 'Failed')
    expect(store.deploy.runCpqTriggerSetting(r4)).toBeNull()
    expect(buildDeployRunState(store, jobs, noProbe).cpqReminder).toBe(true)
  })

  it('objects + counters come from the current run’s frozen plan; restoreUnconfirmed counts that run’s ledger', () => {
    const id = newDeployment()
    const runId = attemptWithRun(id)
    store.deploy.setRunPhase(runId, 'Deploying')
    store.deploy.recordResults(runId, [
      {
        objectApiName: 'Account',
        sourceId: '001S1',
        targetId: null,
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'success',
        errorCode: null,
        errorMessage: null
      },
      {
        objectApiName: 'SBQQ__Quote__c',
        sourceId: 'a0S1',
        targetId: null,
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'failed',
        errorCode: 'X',
        errorMessage: 'nope'
      }
    ])
    store.deploy.ledgerWriteAhead(id, `run-${runId}`, [
      {
        itemType: 'ValidationRule',
        itemId: '03d1',
        itemName: 'VR',
        restoreVersionNumber: null,
        detail: null
      }
    ])
    store.deploy.setRunPhase(runId, 'Failed')
    const s = buildDeployRunState(store, jobs, id)
    expect(s.objects.map((o) => o.objectName)).toEqual(['Account', 'SBQQ__Quote__c'])
    expect(s.objects[1]!.recordsFailed).toBe(1)
    expect(s.counters).toEqual({
      recordsQueried: 2,
      recordsDeployed: 1,
      recordsFailed: 1,
      recordsSkipped: 0
    })
    expect(s.totalRecords).toBe(4)
    expect(s.restoreUnconfirmed).toBe(1)
    expect(s.run!.phase).toBe('Failed')
  })

  it('unknown deployment throws NOT_FOUND; the session’s latest deploy job is attached', async () => {
    expect(() => buildDeployRunState(store, jobs, 999)).toThrow(/not found/i)
    const id = newDeployment()
    jobs.start('deploy', 'Deploy data', async () => undefined, { deploymentId: String(id) })
    await flush()
    expect(buildDeployRunState(store, jobs, id).job?.kind).toBe('deploy')
  })
})
