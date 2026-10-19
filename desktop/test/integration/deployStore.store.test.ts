/**
 * E2.5 — deploy-run-state migration (005) + DeployStore facade + counter views.
 *
 * The counter views are asserted against the FROZEN APEX ACCUMULATION
 * SEMANTICS on a scripted multi-pass fixture (the E2.5 acceptance criterion):
 *   - Records_Queried / Records_Skipped are FIRST-PASS-ONLY (DDQ L1989-1996)
 *   - targeted-retry counter zeroing: Failed/Root/Cascade reflect the LAST
 *     retry pass, Deployed accumulates across passes (DDQ L2968-2987 + L1969-1985)
 *   - whole-object retry resets ALL六 counters and re-runs from batch 0
 *     (DDQ L119-139) — only the latest object_attempt counts
 *   - the second pass NEVER touches counters (executeSecondPassV2 logs only;
 *     prep explicitly does not reset Records_Failed, DDQ L3025-3034)
 *   - Root + Cascade ≡ Failed, with 'root' the default bucket (DDQ L2214-2296)
 *   - run rollup = SUM over objects (recomputeDeploymentCounters, DDS L1228-1263)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Store, MIGRATIONS } from '../../src/main/services/store'
import { RUN_SCOPED_SQL } from '../../src/main/services/deployStore'
import type { FailureClassification, RecordOutcome } from '../../src/main/engine/deploy/types'

let store: Store

beforeEach(() => {
  store = new Store(':memory:')
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

function newDeployment(): number {
  return store.createDeployment({
    name: 'Acme',
    sourceConnectionId: 'src',
    targetConnectionId: 'tgt'
  })
}

function newRun(): { deploymentId: number; runId: number } {
  const deploymentId = newDeployment()
  const plan = store.deploy.savePlan(deploymentId, '{"objects":[]}', 'hash-1')
  const run = store.deploy.createRun(deploymentId, plan.id)
  return { deploymentId, runId: run.id }
}

/**
 * Record one transport batch: outcomes keyed by source id. Failed records also
 * land in failed_records with the given classification (null = writer omitted
 * it — the view must default the bucket to 'root').
 */
function recordBatch(
  runId: number,
  objectApiName: string,
  opts: { pass?: 1 | 2; retryPass?: number; objectAttempt?: number },
  outcomes: Record<string, RecordOutcome | ['failed', FailureClassification | null]>
): void {
  const pass = opts.pass ?? 1
  const retryPass = opts.retryPass ?? 0
  const objectAttempt = opts.objectAttempt ?? 0
  const rows = Object.entries(outcomes).map(([sourceId, o]) => ({
    objectApiName,
    sourceId,
    pass,
    retryPass,
    objectAttempt,
    outcome: Array.isArray(o) ? ('failed' as const) : o
  }))
  store.deploy.recordResults(runId, rows)
  const failures = Object.entries(outcomes)
    .filter(([, o]) => Array.isArray(o) && o[1] !== null)
    .map(([sourceId, o]) => ({
      objectApiName,
      pass,
      retryPass,
      objectAttempt,
      sourceId,
      classification: (o as ['failed', FailureClassification])[1]
    }))
  store.deploy.recordFailures(runId, failures)
}

function counters(runId: number, objectApiName: string) {
  const c = store.deploy.objectCounters(runId).find((o) => o.objectApiName === objectApiName)
  expect(c, `expected counters for ${objectApiName}`).toBeDefined()
  return c!
}

describe('DeployStore — counter views vs the Apex accumulation oracle (E2.5 AC)', () => {
  it('scripted multi-pass fixture: fresh → targeted retry → second pass', () => {
    const { runId } = newRun()

    // ── Fresh first pass (2 pages of the same pass — pagination APPENDs) ──
    recordBatch(
      runId,
      'Account',
      {},
      {
        a01: 'success',
        a02: 'success',
        a03: 'success',
        a04: ['failed', 'root'],
        a05: ['failed', 'root'],
        a06: 'skipped'
      }
    )
    recordBatch(
      runId,
      'Account',
      {},
      {
        a07: 'success',
        a08: 'success',
        a09: 'success',
        a10: ['failed', 'cascade']
      }
    )

    let c = counters(runId, 'Account')
    expect(c.recordsQueried).toBe(10)
    expect(c.recordsDeployed).toBe(6)
    expect(c.recordsFailed).toBe(3)
    expect(c.recordsFailedRoot).toBe(2)
    expect(c.recordsFailedCascade).toBe(1)
    expect(c.recordsSkipped).toBe(1)
    // Root + Cascade ≡ Failed
    expect(c.recordsFailedRoot + c.recordsFailedCascade).toBe(c.recordsFailed)

    // ── Targeted retry pass 1: the 3 failed re-run, 2 heal, 1 persists ──
    // Apex zeroes Failed/Root/Cascade at retry entry and re-accumulates
    // (DDQ L2968-2987); Deployed keeps accumulating; Queried/Skipped frozen.
    recordBatch(
      runId,
      'Account',
      { retryPass: 1 },
      {
        a04: 'success',
        a05: 'success',
        a10: ['failed', 'root']
      }
    )

    c = counters(runId, 'Account')
    expect(c.recordsQueried).toBe(10) // first-pass-only — retry never re-counts
    expect(c.recordsSkipped).toBe(1) // first-pass-only
    expect(c.recordsDeployed).toBe(8) // 6 + 2 healed
    expect(c.recordsFailed).toBe(1) // retry zeroing: last pass's failures only
    expect(c.recordsFailedRoot).toBe(1)
    expect(c.recordsFailedCascade).toBe(0)
    expect(c.recordsFailedRoot + c.recordsFailedCascade).toBe(c.recordsFailed)

    // ── Second pass (deferred fields): counters must be COMPLETELY inert ──
    recordBatch(
      runId,
      'Account',
      { pass: 2 },
      {
        a01: 'success',
        a02: 'success',
        a03: ['failed', 'root'],
        a07: ['failed', null],
        a08: 'success'
      }
    )

    const after = counters(runId, 'Account')
    expect(after).toEqual(c) // second-pass preservation — nothing moved
  })

  it('a record transform-skipped DURING a retry pass counts NOWHERE (first-pass-only Skipped — review fix)', () => {
    const { runId } = newRun()
    // Fresh pass: x1 fails, x2 succeeds, x3 is skipped.
    recordBatch(
      runId,
      'OpportunityLineItem',
      {},
      {
        x1: ['failed', 'root'],
        x2: 'success',
        x3: 'skipped'
      }
    )
    // Targeted retry: target state drifted (PBE deactivated) → the gate SKIPS x1.
    recordBatch(runId, 'OpportunityLineItem', { retryPass: 1 }, { x1: 'skipped' })

    // Apex oracle (DDQ L1989-1996 + L2980): Queried=3, Deployed=1, Failed=0,
    // Skipped=1 — x1 vanishes from every counter.
    const c = counters(runId, 'OpportunityLineItem')
    expect(c.recordsQueried).toBe(3)
    expect(c.recordsDeployed).toBe(1)
    expect(c.recordsFailed).toBe(0)
    expect(c.recordsFailedRoot).toBe(0)
    expect(c.recordsFailedCascade).toBe(0)
    expect(c.recordsSkipped).toBe(1) // only the fresh-pass skip
  })

  it('whole-object retry: only the latest object_attempt counts (full counter reset)', () => {
    const { runId } = newRun()

    // Attempt 0 dies mid-object: 4 failures, 1 success.
    recordBatch(
      runId,
      'Contact',
      { objectAttempt: 0 },
      {
        c1: 'success',
        c2: ['failed', 'root'],
        c3: ['failed', 'root'],
        c4: ['failed', 'cascade'],
        c5: ['failed', 'root']
      }
    )
    // Whole-object retry (attempt 1) re-runs from batch 0 and all heal.
    recordBatch(
      runId,
      'Contact',
      { objectAttempt: 1 },
      {
        c1: 'success',
        c2: 'success',
        c3: 'success',
        c4: 'success',
        c5: 'success'
      }
    )

    const c = counters(runId, 'Contact')
    expect(c.recordsQueried).toBe(5)
    expect(c.recordsDeployed).toBe(5)
    expect(c.recordsFailed).toBe(0) // attempt-0 failures erased, like the Apex zeroing
    expect(c.recordsFailedRoot).toBe(0)
    expect(c.recordsFailedCascade).toBe(0)
    expect(c.recordsSkipped).toBe(0)
  })

  it('a failed row with no failed_records classification defaults to root (classifyFailures default)', () => {
    const { runId } = newRun()
    recordBatch(
      runId,
      'Order',
      {},
      {
        o1: ['failed', null], // recorded in record_results only
        o2: 'success'
      }
    )
    const c = counters(runId, 'Order')
    expect(c.recordsFailed).toBe(1)
    expect(c.recordsFailedRoot).toBe(1)
    expect(c.recordsFailedCascade).toBe(0)
  })

  it('junction single-pass shape: queried/deployed/failed/skipped from one pass', () => {
    const { runId } = newRun()
    // E4E.5 records OCR rows as pass-1/retry-0 — dedupe-skips + FK-skips are 'skipped'.
    recordBatch(
      runId,
      'OpportunityContactRole',
      {},
      {
        j1: 'success',
        j2: 'success',
        j3: 'skipped',
        j4: 'skipped',
        j5: ['failed', null]
      }
    )
    const c = counters(runId, 'OpportunityContactRole')
    expect(c.recordsQueried).toBe(5)
    expect(c.recordsDeployed).toBe(2)
    expect(c.recordsSkipped).toBe(2)
    expect(c.recordsFailed).toBe(1)
    expect(c.recordsFailedRoot).toBe(1) // junction failures bucket as root
  })

  it('run rollup SUMs across objects and is isolated per run', () => {
    const { deploymentId, runId } = newRun()
    recordBatch(runId, 'Account', {}, { a1: 'success', a2: ['failed', 'root'] })
    recordBatch(runId, 'Contact', {}, { c1: 'success', c2: 'success', c3: 'skipped' })

    const total = store.deploy.runCounters(runId)
    expect(total).toEqual({
      runId,
      recordsQueried: 5,
      recordsDeployed: 3,
      recordsFailed: 1,
      recordsFailedRoot: 1,
      recordsFailedCascade: 0,
      recordsSkipped: 1,
      recordsAlreadyOnTarget: 0
    })

    // A second run over the SAME deployment + object names starts at zero.
    const plan2 = store.deploy.savePlan(deploymentId, '{"objects":[]}', 'hash-2')
    const run2 = store.deploy.createRun(deploymentId, plan2.id)
    recordBatch(run2.id, 'Account', {}, { a1: 'success' })
    expect(store.deploy.runCounters(run2.id).recordsDeployed).toBe(1)
    expect(store.deploy.runCounters(runId).recordsDeployed).toBe(3) // untouched

    // No results at all → explicit zeroes, not a missing row.
    const plan3 = store.deploy.savePlan(deploymentId, '{"objects":[]}', 'hash-3')
    const run3 = store.deploy.createRun(deploymentId, plan3.id)
    expect(store.deploy.runCounters(run3.id).recordsQueried).toBe(0)
  })
})

describe('DeployStore — orphaned-link ledger (S50 A5)', () => {
  /**
   * Run 9 (2026-09-07): the root Account failed and 249
   * Contacts + 18 Opportunities + 5 Quotes deployed with a null account FK
   * while the run reported Completed. Required lookups cascade loudly and heal
   * on retry; NILLABLE ones deploy detached and nothing re-links them, because
   * the second pass only revisits DEFERRED fields.
   */
  const strip = (
    sourceId: string,
    parentSourceId: string,
    over: Partial<{ objectApiName: string; fieldName: string; refObject: string }> = {}
  ): Parameters<typeof store.deploy.recordStrippedRefs>[1][number] => ({
    objectApiName: over.objectApiName ?? 'Contact',
    sourceId,
    fieldName: over.fieldName ?? 'AccountId',
    relationshipName: 'Account',
    refObject: over.refObject ?? 'Account',
    parentExtId: parentSourceId.split('').reverse().join(''),
    parentSourceId,
    pass: 1,
    retryPass: 0,
    objectAttempt: 0
  })

  it('groups by object+field and counts DISTINCT orphaned records', () => {
    const { runId } = newRun()
    store.deploy.recordStrippedRefs(runId, [
      strip('003a', '001dead'),
      strip('003b', '001dead'),
      strip('006a', '001dead', { objectApiName: 'Opportunity' })
    ])
    const groups = store.deploy.orphanedLinkSummary(runId)
    expect(groups).toEqual([
      {
        objectApiName: 'Contact',
        fieldName: 'AccountId',
        refObject: 'Account',
        count: 2,
        parentLandedCount: 0
      },
      {
        objectApiName: 'Opportunity',
        fieldName: 'AccountId',
        refObject: 'Account',
        count: 1,
        parentLandedCount: 0
      }
    ])
  })

  it('splits out parents that DID land — the actionable half', () => {
    // A parent that landed later means "re-run and the link resolves"; one
    // that never landed means "widen the scope".
    const { runId } = newRun()
    recordBatch(runId, 'Account', {}, { '001landed': 'success' })
    store.deploy.recordStrippedRefs(runId, [
      strip('003a', '001landed'),
      strip('003b', '001dead')
    ])
    const [g] = store.deploy.orphanedLinkSummary(runId)
    expect(g).toMatchObject({ count: 2, parentLandedCount: 1 })
  })

  it('is idempotent — a whole-object rerun does not double-count', () => {
    const { runId } = newRun()
    store.deploy.recordStrippedRefs(runId, [strip('003a', '001dead')])
    store.deploy.recordStrippedRefs(runId, [strip('003a', '001dead')])
    expect(store.deploy.orphanedLinkSummary(runId)[0]).toMatchObject({ count: 1 })
  })

  it('returns [] for a run with no stripped refs', () => {
    const { runId } = newRun()
    expect(store.deploy.orphanedLinkSummary(runId)).toEqual([])
  })
})

describe('DeployStore — counter-view query plan (S50 A2 regression guard)', () => {
  /**
   * MEASURED before migration 007, at 8,008 failed_records / 24,024
   * record_results: `objectCounters` took 326,782 ms — five and a half MINUTES
   * for one call — because `v_run_record_current` drove from `record_results`
   * and re-scanned an un-materialized co-routine once per row. After 007 the
   * same call is 25 ms.
   *
   * Timing assertions are flaky, so this pins the SHAPE instead. Both planner
   * directives in migration 007 are load-bearing and each one disappearing
   * from the plan reintroduces the quadratic blow-up:
   *   - CROSS JOIN forces `latest` to drive, so `rr` is reached by rowid;
   *     without it SQLite reorders and picks record_results as outer (measured
   *     71s -> 53s, i.e. still quadratic).
   *   - AS MATERIALIZED stops each CTE being re-run per outer row.
   */
  it('reaches record_results by INTEGER PRIMARY KEY, not by re-scanning a co-routine', () => {
    const { runId } = newRun()
    recordBatch(runId, 'Account', {}, { a01: 'success', a02: ['failed', 'root'] })

    const db = (store as unknown as { db: import('better-sqlite3').Database }).db
    const plan = (
      db
        .prepare('EXPLAIN QUERY PLAN SELECT * FROM v_run_object_counters WHERE run_id = ?')
        .all(runId) as { detail: string }[]
    ).map((r) => r.detail)

    expect(plan.some((d) => d.includes('SEARCH rr USING INTEGER PRIMARY KEY'))).toBe(true)
    // The pre-007 shape: record_results as the outer table of the latest-row join.
    expect(plan.some((d) => d.includes('SEARCH rr USING INDEX idx_record_results_run'))).toBe(false)
  })

  /**
   * S64 P5 (5.3). MEASURED on the 2026-10-19 DB copy (47,591 record_results
   * over 34 runs): the view's outer `run_id = ?` cannot enter its MATERIALIZED
   * CTE, so `la` scanned the whole index (`run_id>?`) — 50–68 ms for the
   * largest run, 31 ms for a 209-row run, growing with every run ever written
   * (170 / 133 ms on a 5× copy). With the predicate inside: 23 ms / 3 ms, and
   * 18 ms / 1 ms on the 5× copy. This pins the SHAPE: the scoped `la` seeks
   * by `run_id=?`, and the 007 directives survive in the scoped query.
   */
  it('the run-scoped counter query seeks la by run_id=? and keeps the 007 drive order', () => {
    const { runId } = newRun()
    recordBatch(runId, 'Account', {}, { a01: 'success', a02: ['failed', 'root'] })

    const db = (store as unknown as { db: import('better-sqlite3').Database }).db
    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${RUN_SCOPED_SQL.objectCounters}`).all({ runId }) as {
        detail: string
      }[]
    ).map((r) => r.detail)

    expect(plan.some((d) => d.includes('SEARCH rr USING INTEGER PRIMARY KEY'))).toBe(true)
    expect(plan.some((d) => /MATERIALIZE la/.test(d))).toBe(true)
    // The whole point: no `run_id>?` range scan over every run's rows anywhere in the plan.
    expect(plan.some((d) => d.includes('run_id>?'))).toBe(false)
    expect(plan.filter((d) => d.includes('idx_record_results_latest (run_id=?')).length).toBeGreaterThan(0)
  })

  it('keeps both migration-007 indexes', () => {
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(names).toContain('idx_record_results_latest')
    expect(names).toContain('idx_failed_records_latest')
  })
})

describe('DeployStore — skipReasonCounts (S49 BUG-1 pt3)', () => {
  it('groups skips by the leading reason token, stripping per-record detail', () => {
    const { runId } = newRun()
    store.deploy.recordResults(runId, [
      // The three S49 skip classes, in the shapes the engine actually writes.
      {
        objectApiName: 'OpportunityTeamMember',
        sourceId: 'otm1',
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'skipped',
        errorMessage: 'unique_constraint_collision (OpportunityId+UserId already claimed by 005A)'
      },
      {
        objectApiName: 'OpportunityTeamMember',
        sourceId: 'otm2',
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'skipped',
        errorMessage: 'unique_constraint_collision (OpportunityId+UserId already claimed by 005B)'
      },
      {
        objectApiName: 'OpportunityLineItem',
        sourceId: 'oli1',
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'skipped',
        errorMessage: 'pbe_missing_on_target'
      },
      {
        objectApiName: 'Account',
        sourceId: 'a1',
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'success'
      }
    ])

    expect(store.deploy.skipReasonCounts(runId)).toEqual([
      { reason: 'unique_constraint_collision', count: 2 },
      { reason: 'pbe_missing_on_target', count: 1 }
    ])
  })

  it('drops a skip that a later retry pass HEALED (current-truth, like every counter)', () => {
    const { runId } = newRun()
    store.deploy.recordResults(runId, [
      {
        objectApiName: 'OpportunityLineItem',
        sourceId: 'oli1',
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'skipped',
        errorMessage: 'pbe_missing_on_target'
      }
    ])
    expect(store.deploy.skipReasonCounts(runId)).toHaveLength(1)

    store.deploy.recordResults(runId, [
      {
        objectApiName: 'OpportunityLineItem',
        sourceId: 'oli1',
        pass: 1,
        retryPass: 1,
        objectAttempt: 0,
        outcome: 'success'
      }
    ])
    expect(store.deploy.skipReasonCounts(runId)).toEqual([])
  })

  it('returns [] for a run with no skips', () => {
    const { runId } = newRun()
    expect(store.deploy.skipReasonCounts(runId)).toEqual([])
  })
})

describe('DeployStore — frozen plans', () => {
  it('savePlan assigns sequential versions per deployment; getLatestPlan reads the newest', () => {
    const deploymentId = newDeployment()
    const v1 = store.deploy.savePlan(deploymentId, '{"v":1}', 'h1')
    const v2 = store.deploy.savePlan(deploymentId, '{"v":2}', 'h2')
    expect(v1.version).toBe(1)
    expect(v2.version).toBe(2)
    expect(store.deploy.getLatestPlan(deploymentId)!.planHash).toBe('h2')
    // Versions are per-deployment, not global.
    const other = newDeployment()
    expect(store.deploy.savePlan(other, '{"v":1}', 'hx').version).toBe(1)
  })

  it('savePlan on an unknown deployment throws NOT_FOUND', () => {
    expect(() => store.deploy.savePlan(999, '{}', 'h')).toThrow(/not found/i)
  })
})

describe('DeployStore — run lifecycle', () => {
  it('createRun denormalizes plan_hash and starts Frozen with no timestamps', () => {
    const { runId } = newRun()
    const run = store.deploy.getRun(runId)!
    expect(run.phase).toBe('Frozen')
    expect(run.planHash).toBe('hash-1')
    expect(run.startedAt).toBeNull()
    expect(run.finishedAt).toBeNull()
    expect(run.cancelRequested).toBe(false)
  })

  it('createRun rejects a plan belonging to a different deployment', () => {
    const { deploymentId } = newRun()
    const otherDep = newDeployment()
    const otherPlan = store.deploy.savePlan(otherDep, '{}', 'h-other')
    expect(() => store.deploy.createRun(deploymentId, otherPlan.id)).toThrow(/belongs to/i)
    expect(() => store.deploy.createRun(deploymentId, 9999)).toThrow(/not found/i)
  })

  it('phase walk stamps started_at once and finished_at on terminal phases only', () => {
    const { runId } = newRun()
    store.deploy.setRunPhase(runId, 'DisablingAutomation')
    const started = store.deploy.getRun(runId)!.startedAt
    expect(started).not.toBeNull()

    store.deploy.setRunPhase(runId, 'Deploying')
    expect(store.deploy.getRun(runId)!.startedAt).toBe(started) // stamped once
    expect(store.deploy.getRun(runId)!.finishedAt).toBeNull()

    store.deploy.setRunPhase(runId, 'Completed')
    const done = store.deploy.getRun(runId)!
    expect(done.finishedAt).not.toBeNull()

    // A Stalled re-open (recovery) clears finished_at — the run is live again.
    store.deploy.setRunPhase(runId, 'Stalled')
    expect(store.deploy.getRun(runId)!.finishedAt).toBeNull()
  })

  it('resume point round-trips and clears', () => {
    const { runId } = newRun()
    store.deploy.setResumePoint(runId, 'Account', 'first')
    let run = store.deploy.getRun(runId)!
    expect(run.currentObject).toBe('Account')
    expect(run.currentPass).toBe('first')
    store.deploy.setResumePoint(runId, null, null)
    run = store.deploy.getRun(runId)!
    expect(run.currentObject).toBeNull()
    expect(run.currentPass).toBeNull()
  })

  it('cancel flag round-trips', () => {
    const { runId } = newRun()
    expect(store.deploy.isCancelRequested(runId)).toBe(false)
    store.deploy.requestCancel(runId)
    expect(store.deploy.isCancelRequested(runId)).toBe(true)
  })

  it('teardown marker round-trips: outcome + finalize_done (resume contract)', () => {
    const { runId } = newRun()
    let run = store.deploy.getRun(runId)!
    expect(run.teardownOutcome).toBeNull()
    expect(run.finalizeDone).toBe(false)
    store.deploy.setTeardownOutcome(runId, 'cancelled')
    store.deploy.markFinalizeDone(runId)
    run = store.deploy.getRun(runId)!
    expect(run.teardownOutcome).toBe('cancelled')
    expect(run.finalizeDone).toBe(true)
    expect(() => store.deploy.setTeardownOutcome(999, 'failed')).toThrow(/not found/i)
    expect(() => store.deploy.markFinalizeDone(999)).toThrow(/not found/i)
  })

  it('listActiveRuns excludes terminal phases (recovery-sweep input)', () => {
    const { runId } = newRun()
    const second = newRun()
    store.deploy.setRunPhase(runId, 'Completed')
    store.deploy.setRunPhase(second.runId, 'Stalled') // non-terminal — must surface
    const active = store.deploy.listActiveRuns().map((r) => r.id)
    expect(active).not.toContain(runId)
    expect(active).toContain(second.runId)
  })

  it('unknown run ids throw NOT_FOUND on every mutator', () => {
    expect(() => store.deploy.setRunPhase(999, 'Deploying')).toThrow(/not found/i)
    expect(() => store.deploy.setResumePoint(999, null, null)).toThrow(/not found/i)
    expect(() => store.deploy.requestCancel(999)).toThrow(/not found/i)
    expect(() => store.deploy.isCancelRequested(999)).toThrow(/not found/i)
  })
})

describe('DeployStore — failure relation + retry queue', () => {
  it('failed_records dedupes on the full attempt key (appendMode is a non-concept)', () => {
    const { runId } = newRun()
    store.deploy.recordFailures(runId, [
      { objectApiName: 'Account', pass: 1, retryPass: 0, objectAttempt: 0, sourceId: 'a1' }
    ])
    expect(() =>
      store.deploy.recordFailures(runId, [
        { objectApiName: 'Account', pass: 1, retryPass: 0, objectAttempt: 0, sourceId: 'a1' }
      ])
    ).toThrow(/UNIQUE/i)
    // Same record at the NEXT retry pass is a new row, not a violation.
    store.deploy.recordFailures(runId, [
      { objectApiName: 'Account', pass: 1, retryPass: 1, objectAttempt: 0, sourceId: 'a1' }
    ])
    expect(store.deploy.listFailures(runId, 'Account', 1, 0)).toEqual([
      { sourceId: 'a1', classification: null }
    ])
  })

  it('listFailures is scoped to one object_attempt — stale aborted-attempt failures never leak (review fix)', () => {
    const { runId } = newRun()
    // Attempt 0 fails b1..b3, object then throws → whole-object retry.
    recordBatch(
      runId,
      'Contact',
      { objectAttempt: 0 },
      {
        b1: ['failed', 'root'],
        b2: ['failed', 'root'],
        b3: ['failed', 'root']
      }
    )
    // Attempt 1 re-runs from batch 0: only b3 fails.
    recordBatch(
      runId,
      'Contact',
      { objectAttempt: 1 },
      {
        b1: 'success',
        b2: 'success',
        b3: ['failed', 'root']
      }
    )
    // The Apex retry input is [b3] — attempt-0 rows must NOT pollute it.
    expect(store.deploy.listFailures(runId, 'Contact', 0, 1)).toEqual([
      { sourceId: 'b3', classification: 'root' }
    ])
    expect(store.deploy.listFailures(runId, 'Contact', 0, 0).map((f) => f.sourceId)).toEqual([
      'b1',
      'b2',
      'b3'
    ])
  })

  it('resume-derivation helpers: maxObjectAttempt / maxRetryPass / failureCountAt', () => {
    const { runId } = newRun()
    expect(store.deploy.maxObjectAttempt(runId, 'Account')).toBe(-1) // nothing yet
    recordBatch(runId, 'Account', {}, { a1: ['failed', 'root'], a2: ['failed', 'root'] })
    recordBatch(runId, 'Account', { retryPass: 1 }, { a1: ['failed', 'root'], a2: 'success' })
    recordBatch(runId, 'Account', { objectAttempt: 1 }, { a1: 'success' })
    expect(store.deploy.maxObjectAttempt(runId, 'Account')).toBe(1)
    expect(store.deploy.maxRetryPass(runId, 'Account', 0)).toBe(1)
    expect(store.deploy.maxRetryPass(runId, 'Account', 1)).toBe(0)
    expect(store.deploy.failureCountAt(runId, 'Account', 0, 0)).toBe(2)
    expect(store.deploy.failureCountAt(runId, 'Account', 1, 0)).toBe(1)
    expect(store.deploy.failureCountAt(runId, 'Account', 0, 1)).toBe(0)
  })

  it('clearRetryQueue drops one object queue only (whole-object retry entry)', () => {
    const { runId } = newRun()
    store.deploy.enqueueRetries(runId, 'Account', ['a1', 'a2'], 1)
    store.deploy.enqueueRetries(runId, 'Contact', ['c1'], 1)
    store.deploy.clearRetryQueue(runId, 'Account')
    expect(store.deploy.retryQueueDepth(runId, 'Account')).toBe(0)
    expect(store.deploy.retryQueueDepth(runId, 'Contact')).toBe(1)
  })

  it('retry queue drains in insertion order in bounded chunks (Apex 150-Id drain)', () => {
    const { runId } = newRun()
    const ids = Array.from({ length: 340 }, (_, i) => `id${String(i).padStart(3, '0')}`)
    store.deploy.enqueueRetries(runId, 'Account', ids, 1)
    expect(store.deploy.retryQueueDepth(runId, 'Account')).toBe(340)

    const chunk1 = store.deploy.dequeueRetryChunk(runId, 'Account', 150)
    expect(chunk1).toEqual(ids.slice(0, 150))
    const chunk2 = store.deploy.dequeueRetryChunk(runId, 'Account', 150)
    expect(chunk2).toEqual(ids.slice(150, 300))
    const chunk3 = store.deploy.dequeueRetryChunk(runId, 'Account', 150)
    expect(chunk3).toEqual(ids.slice(300))
    expect(store.deploy.dequeueRetryChunk(runId, 'Account', 150)).toEqual([])
    expect(store.deploy.retryQueueDepth(runId)).toBe(0)
  })

  it('re-enqueueing an id is idempotent (single row, attempt updated)', () => {
    const { runId } = newRun()
    store.deploy.enqueueRetries(runId, 'Account', ['a1', 'a2'], 1)
    store.deploy.enqueueRetries(runId, 'Account', ['a2'], 2)
    expect(store.deploy.retryQueueDepth(runId, 'Account')).toBe(2)
  })
})

describe('Store — migration 005 over an existing 001–004 DB (E2.5 AC)', () => {
  it('upgrades in place: legacy record_results survive with object_api_name backfilled; views ignore them; FKs intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rds-mig5-'))
    const dbPath = join(dir, 'rds.db')
    try {
      // Build a pre-005 DB (001–004 applied) with a legacy record_results row.
      const raw = new Database(dbPath)
      raw.pragma('foreign_keys = ON')
      raw.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER)`)
      for (const m of MIGRATIONS) {
        if (m.id === '005-deploy-run-state') break
        raw.exec(m.sql)
        raw.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(m.id)
      }
      raw
        .prepare(
          `INSERT INTO connections (id, label, cli_alias, username, org_id) VALUES ('src','src','src','s@x.io','00Dsrc'), ('tgt','tgt','tgt','t@x.io','00Dtgt')`
        )
        .run()
      raw
        .prepare(
          `INSERT INTO deployments (name, source_connection_id, target_connection_id, status) VALUES ('Legacy','src','tgt','Completed')`
        )
        .run()
      const depId = Number((raw.prepare('SELECT id FROM deployments').get() as { id: number }).id)
      raw
        .prepare(
          `INSERT INTO deployment_objects (deployment_id, object_api_name, sort_order) VALUES (?, 'Account', 0)`
        )
        .run(depId)
      const objId = Number(
        (raw.prepare('SELECT id FROM deployment_objects').get() as { id: number }).id
      )
      raw
        .prepare(
          `INSERT INTO record_results (deployment_object_id, source_id, pass, outcome) VALUES (?, 'legacy1', 1, 'success')`
        )
        .run(objId)
      raw
        .prepare(
          `INSERT INTO automation_ledger_mirror (deployment_id, target_org_id, item_type, item_name) VALUES (?, '00Dtgt', 'Flow', 'MyFlow')`
        )
        .run(depId)
      raw.close()

      // Open Store → 005 applies (rebuild inside the FK-OFF dance).
      const upgraded = new Store(dbPath)
      // Legacy row survived, object name backfilled, run_id NULL.
      const dbCheck = new Database(dbPath, { readonly: true })
      const legacy = dbCheck
        .prepare('SELECT * FROM record_results WHERE source_id = ?')
        .get('legacy1') as Record<string, unknown>
      expect(legacy).toBeDefined()
      expect(legacy.object_api_name).toBe('Account')
      expect(legacy.run_id).toBeNull()
      expect(legacy.retry_pass).toBe(0)
      expect(legacy.outcome).toBe('success')
      // The counter views count RUN rows only — a NULL-run legacy row is invisible.
      expect(dbCheck.prepare('SELECT COUNT(*) AS n FROM v_run_object_counters').get()).toEqual({
        n: 0
      })
      // Widened ledger columns exist and are null for old rows.
      const ledger = dbCheck
        .prepare('SELECT run_uuid, restore_version_number FROM automation_ledger_mirror')
        .get() as Record<string, unknown>
      expect(ledger.run_uuid).toBeNull()
      expect(ledger.restore_version_number).toBeNull()
      expect(dbCheck.pragma('foreign_key_check') as unknown[]).toEqual([])
      dbCheck.close()

      // And the upgraded DB is fully usable for new-run traffic.
      const plan = upgraded.deploy.savePlan(depId, '{}', 'h')
      const run = upgraded.deploy.createRun(depId, plan.id)
      upgraded.deploy.recordResults(run.id, [
        {
          objectApiName: 'Account',
          sourceId: 'n1',
          pass: 1,
          retryPass: 0,
          objectAttempt: 0,
          outcome: 'success'
        }
      ])
      expect(upgraded.deploy.runCounters(run.id).recordsDeployed).toBe(1)
      upgraded.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('deleteDeployment cascades plans, runs, results, failures, and the retry queue', () => {
    const { deploymentId, runId } = newRun()
    recordBatch(runId, 'Account', {}, { a1: ['failed', 'root'] })
    store.deploy.enqueueRetries(runId, 'Account', ['a1'], 1)

    store.deleteDeployment(deploymentId)

    const dbCheck = (store as unknown as { db: Database.Database }).db
    for (const table of ['plans', 'deploy_runs', 'failed_records', 'retry_queue']) {
      expect(
        (dbCheck.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
        table
      ).toBe(0)
    }
    expect(
      (
        dbCheck
          .prepare('SELECT COUNT(*) AS n FROM record_results WHERE run_id IS NOT NULL')
          .get() as { n: number }
      ).n
    ).toBe(0)
  })
})

// ── S46 D1 — deployments.status mirrors the run phase (deployDesign §1.3) ────

describe('DeployStore.setRunPhase mirrors deployments.status (S46 D1)', () => {
  const statusOf = (deploymentId: number): string => store.loadDraft(deploymentId)!.status

  it('walks the Apex status vocabulary phase by phase, in the same transaction', () => {
    const { deploymentId, runId } = newRun()
    expect(statusOf(deploymentId)).toBe('Draft') // createRun does NOT mirror (job start does)
    const expectations: Array<[Parameters<typeof store.deploy.setRunPhase>[1], string]> = [
      ['DisablingAutomation', 'Disabling Automation'],
      ['Deploying', 'Deploying'],
      ['Retrying', 'Retrying'],
      ['Deploying', 'Deploying'],
      ['SecondPass', 'Deploying'],
      ['Finalizing', 'Deploying'],
      ['RestoringAutomation', 'Restoring Automation'],
      ['Completed', 'Completed']
    ]
    for (const [phase, status] of expectations) {
      store.deploy.setRunPhase(runId, phase)
      expect(statusOf(deploymentId)).toBe(status)
      expect(store.deploy.getRun(runId)!.phase).toBe(phase)
    }
  })

  it('Failed / Cancelled / Stalled mirror verbatim', () => {
    for (const phase of ['Failed', 'Cancelled', 'Stalled'] as const) {
      const { deploymentId, runId } = newRun()
      store.deploy.setRunPhase(runId, 'Deploying')
      store.deploy.setRunPhase(runId, phase)
      expect(statusOf(deploymentId)).toBe(phase)
    }
  })

  it('preserve rule (ATB:63-68): a NON-terminal phase never overwrites Cancelled or Stalled; terminal phases do', () => {
    const { deploymentId, runId } = newRun()
    store.deploy.setRunPhase(runId, 'Stalled')
    store.deploy.setRunPhase(runId, 'RestoringAutomation') // resume attempt
    expect(statusOf(deploymentId)).toBe('Stalled') // unchanged — E2 resume must clear it explicitly
    store.deploy.setRunPhase(runId, 'Completed')
    expect(statusOf(deploymentId)).toBe('Completed')

    const c = newRun()
    store.markDeployStarted(c.deploymentId)
    store.markDeployCancelledBeforeRun(c.deploymentId) // status Cancelled by the pre-run path
    store.deploy.setRunPhase(c.runId, 'Deploying')
    expect(statusOf(c.deploymentId)).toBe('Cancelled')
  })

  it('an unknown run still throws NOT_FOUND and writes nothing', () => {
    const { deploymentId } = newRun()
    expect(() => store.deploy.setRunPhase(999, 'Deploying')).toThrow(/not found/i)
    expect(statusOf(deploymentId)).toBe('Draft')
  })
})

describe("Store pre-run status writers (S46 D1 — outside a run's lifetime)", () => {
  it('markDeployStarted → Deploying + error cleared; markDeployFailedBeforeRun → Failed + FULL error (scoped to Deploying)', () => {
    const deploymentId = newDeployment()
    store.setDeployErrorMessage(deploymentId, 'stale error from last time')
    store.markDeployStarted(deploymentId)
    let h = store.getDeploymentHeader(deploymentId)!
    expect(h.status).toBe('Deploying')
    expect(h.errorMessage).toBeNull()

    const long = 'Plan freeze refused: ' + 'x'.repeat(2000) // > 255 — no truncation
    store.markDeployFailedBeforeRun(deploymentId, long)
    h = store.getDeploymentHeader(deploymentId)!
    expect(h.status).toBe('Failed')
    expect(h.errorMessage).toBe(long)

    // Scoped: a second call against a non-Deploying row is a no-op.
    store.markDeployFailedBeforeRun(deploymentId, 'should not land')
    expect(store.getDeploymentHeader(deploymentId)!.errorMessage).toBe(long)
    store.markDeployCancelledBeforeRun(deploymentId)
    expect(store.getDeploymentHeader(deploymentId)!.status).toBe('Failed')
  })

  it('markDeployCancelledBeforeRun → Cancelled with no error; setDeployErrorMessage never touches status', () => {
    const deploymentId = newDeployment()
    store.markDeployStarted(deploymentId)
    store.markDeployCancelledBeforeRun(deploymentId)
    expect(store.getDeploymentHeader(deploymentId)!.status).toBe('Cancelled')
    expect(store.getDeploymentHeader(deploymentId)!.errorMessage).toBeNull()
    store.setDeployErrorMessage(deploymentId, 'why')
    const h = store.getDeploymentHeader(deploymentId)!
    expect(h.status).toBe('Cancelled')
    expect(h.errorMessage).toBe('why')
  })

  it('markDeployStarted on an unknown deployment throws NOT_FOUND; getDeploymentHeader returns null', () => {
    expect(() => store.markDeployStarted(4242)).toThrow(/not found/i)
    expect(store.getDeploymentHeader(4242)).toBeNull()
  })

  it("a run's mirrored terminal status is NOT clobbered by the pre-run writers (the WHERE status = Deploying scope)", () => {
    const { deploymentId, runId } = newRun()
    store.markDeployStarted(deploymentId)
    store.deploy.setRunPhase(runId, 'Deploying')
    store.deploy.setRunPhase(runId, 'Stalled')
    store.markDeployFailedBeforeRun(deploymentId, 'late throw')
    expect(store.getDeploymentHeader(deploymentId)!.status).toBe('Stalled')
    store.setDeployErrorMessage(deploymentId, 'late throw')
    expect(store.getDeploymentHeader(deploymentId)!.errorMessage).toBe('late throw')
  })

  describe('S61 U-5 keyless — the id map (per TARGET org, any deployment)', () => {
    it('idMapPut / idMapLookup round-trip; a replace re-points; another target org is invisible', () => {
      const d1 = newDeployment()
      const d2 = newDeployment()
      store.deploy.idMapPut('00Dtgt00000000', d1, 'Account', [
        { sourceId: '001SRC000000000001', targetId: '001TGT000000000001' },
        { sourceId: '001SRC000000000002', targetId: '001TGT000000000002' }
      ])
      // A later deployment into the SAME target sees the earlier rows …
      const found = store.deploy.idMapLookup('00Dtgt00000000', 'Account', ['001SRC000000000001', '001SRC000000000002', '001SRC000000000009'])
      expect([...found]).toEqual([
        ['001SRC000000000001', '001TGT000000000001'],
        ['001SRC000000000002', '001TGT000000000002']
      ])
      // … another target org does not.
      expect(store.deploy.idMapLookup('00Dother0000000', 'Account', ['001SRC000000000001']).size).toBe(0)
      // A re-insert after a deleted row re-points the same source id.
      store.deploy.idMapPut('00Dtgt00000000', d2, 'Account', [{ sourceId: '001SRC000000000001', targetId: '001TGT00000000000X' }])
      expect(store.deploy.idMapLookup('00Dtgt00000000', 'Account', ['001SRC000000000001']).get('001SRC000000000001')).toBe('001TGT00000000000X')
      // Inserted counts are per deployment and bounded by time (the audit's "ours").
      expect(store.deploy.idMapInsertedCounts('00Dtgt00000000', d1, 0)).toEqual({ Account: 1 })
      expect(store.deploy.idMapInsertedCounts('00Dtgt00000000', d2, 0)).toEqual({ Account: 1 })
      expect(store.deploy.idMapInsertedCounts('00Dtgt00000000', d1, Date.now() + 60_000)).toEqual({})
    })

    it('createDeployment seeds the draft config with the keyless choice', () => {
      const keyless = store.createDeployment({ name: 'K', sourceConnectionId: 'src', targetConnectionId: 'tgt', useExternalIds: false })
      expect(store.loadDraft(keyless)!.config.useExternalIds).toBe(false)
      const keyed = store.createDeployment({ name: 'E', sourceConnectionId: 'src', targetConnectionId: 'tgt' })
      expect(store.loadDraft(keyed)!.config.useExternalIds).toBe(true)
    })
  })
})

describe('S62 — records_already_on_target (migration 012) + composed stages', () => {
  it('counts tagged success/skipped rows as already on target WITHOUT changing deployed/skipped', () => {
    const { runId } = newRun()
    store.deploy.recordResults(runId, [
      { objectApiName: 'Opportunity', sourceId: 'o1', pass: 1, retryPass: 0, objectAttempt: 0, outcome: 'success' },
      { objectApiName: 'Opportunity', sourceId: 'o2', pass: 1, retryPass: 0, objectAttempt: 0, outcome: 'success', errorCode: 'ALREADY_ON_TARGET' },
      { objectApiName: 'Opportunity', sourceId: 'o3', pass: 1, retryPass: 0, objectAttempt: 0, outcome: 'skipped', errorCode: 'ALREADY_ON_TARGET', errorMessage: 'already on target' },
      { objectApiName: 'Opportunity', sourceId: 'o4', pass: 1, retryPass: 0, objectAttempt: 0, outcome: 'skipped', errorMessage: 'missing FK' },
      // pass-2 rows never touch the counters, tagged or not
      { objectApiName: 'Opportunity', sourceId: 'o1', pass: 2, retryPass: 0, objectAttempt: 0, outcome: 'success', errorCode: 'ALREADY_ON_TARGET' }
    ])
    const c = counters(runId, 'Opportunity')
    expect(c.recordsDeployed).toBe(2)
    expect(c.recordsSkipped).toBe(2)
    expect(c.recordsAlreadyOnTarget).toBe(2)
    const rc = store.deploy.runCounters(runId)
    expect(rc.recordsDeployed).toBe(2)
    expect(rc.recordsAlreadyOnTarget).toBe(2)
    // A run with no rows yet reads zero, not undefined.
    const { runId: empty } = newRun()
    expect(store.deploy.runCounters(empty).recordsAlreadyOnTarget).toBe(0)
  })

  it('stages: created pending in order, linked to their runs, finished with a word; latestStages reads the newest attempt', () => {
    const { deploymentId, runId } = newRun()
    const rows = store.deploy.createStages(deploymentId, 'attempt-1', [
      { kind: 'template', label: 'LD dev sandbox', templateId: null },
      { kind: 'deploy', label: 'Data deployment', templateId: null },
      { kind: 'template', label: 'LD CPQ configuration', templateId: null }
    ])
    expect(rows.map((r) => [r.position, r.kind, r.state])).toEqual([
      [0, 'template', 'pending'],
      [1, 'deploy', 'pending'],
      [2, 'template', 'pending']
    ])
    store.deploy.stageStarted(rows[0]!.id)
    store.deploy.stageFinished(rows[0]!.id, 'clean')
    store.deploy.stageStarted(rows[1]!.id)
    store.deploy.stageLinkRun(rows[1]!.id, { deployRunId: runId })
    store.deploy.stageFinished(rows[1]!.id, 'failed', '3 records failed')
    store.deploy.stageFinished(rows[2]!.id, 'skipped', 'stage 2 ended failed')
    const after = store.deploy.latestStages(deploymentId)
    expect(after.map((r) => r.state)).toEqual(['clean', 'failed', 'skipped'])
    expect(after[1]!.deployRunId).toBe(runId)
    expect(after[1]!.note).toBe('3 records failed')
    expect(after[0]!.startedAt).not.toBeNull()
    expect(after[0]!.finishedAt).not.toBeNull()

    // A second attempt supersedes the first in latestStages.
    store.deploy.createStages(deploymentId, 'attempt-2', [{ kind: 'deploy', label: 'Data deployment', templateId: null }])
    expect(store.deploy.latestStages(deploymentId).map((r) => r.attemptId)).toEqual(['attempt-2'])
    // Startup reconciliation closes what a dead session left behind.
    expect(store.deploy.reconcileStagesOnStartup()).toBe(1)
    expect(store.deploy.latestStages(deploymentId)[0]!.state).toBe('skipped')
  })
})

describe('S63 — text_id_relinks ledger (migration 013)', () => {
  it('records per-(row, field) outcomes, overwrites on re-record, and rolls up per field with samples', () => {
    const { runId } = newRun()
    const row = (sourceId: string, fieldName: string, outcome: 'relinked' | 'already_current' | 'unresolved' | 'not_an_id' | 'failed', reason: string | null = null) => ({
      objectApiName: 'SBQQ__Subscription__c',
      sourceId,
      targetId: 'T' + sourceId,
      fieldName,
      refObject: 'SBQQ__Subscription__c',
      sourceValue: 'V' + sourceId,
      resolvedValue: outcome === 'relinked' || outcome === 'already_current' ? 'R' + sourceId : null,
      outcome,
      reason
    })
    store.deploy.recordTextIdRelinks(runId, [
      row('s1', 'SBQQ__RequiredById__c', 'relinked'),
      row('s2', 'SBQQ__RequiredById__c', 'relinked'),
      row('s3', 'SBQQ__RequiredById__c', 'unresolved', 'parent outside scope'),
      row('s4', 'SBQQ__RequiredById__c', 'not_an_id'),
      row('s1', 'SBQQ__RootId__c', 'already_current'),
      row('s5', 'SBQQ__RootId__c', 'failed', 'FIELD_INTEGRITY_EXCEPTION')
    ])
    // A resumed pass re-records s3 as relinked: the UNIQUE (run, object, row, field) row is replaced.
    store.deploy.recordTextIdRelinks(runId, [row('s3', 'SBQQ__RequiredById__c', 'relinked')])

    const sum = store.deploy.textIdRelinkSummary(runId)
    expect(sum).toHaveLength(2)
    expect(sum[0]).toMatchObject({ fieldName: 'SBQQ__RequiredById__c', relinked: 3, alreadyCurrent: 0, unresolved: 0, notAnId: 1, failed: 0, samples: [] })
    expect(sum[1]).toMatchObject({ fieldName: 'SBQQ__RootId__c', relinked: 0, alreadyCurrent: 1, unresolved: 0, failed: 1 })
    expect(sum[1]!.samples).toEqual([{ sourceId: 's5', sourceValue: 'Vs5', outcome: 'failed', reason: 'FIELD_INTEGRITY_EXCEPTION' }])
    // Another run sees nothing; the counter views are untouched (no record_results written).
    expect(store.deploy.textIdRelinkSummary(runId + 1)).toEqual([])
    expect(store.deploy.runCounters(runId).recordsDeployed).toBe(0)
  })

  it('migration 013 is registered after 012 and the table has the outcome CHECK', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('013-text-id-relinks')).toBe(ids.indexOf('012-composed-deployments') + 1)
    const { runId } = newRun()
    expect(() =>
      store.deploy.recordTextIdRelinks(runId, [
        { objectApiName: 'X', sourceId: 's', targetId: null, fieldName: 'f', refObject: 'X', sourceValue: 'v', resolvedValue: null, outcome: 'bogus' as 'failed', reason: null }
      ])
    ).toThrow(/CHECK constraint/)
  })
})

describe('DeployStore — run-scoped counters agree with the migration-012 views (S64 P5 5.3)', () => {
  it('objectCounters / runCounters / deployedSourceIds / skipReasonCounts match the view rows byte for byte, per run', () => {
    // Two runs with overlapping objects, multiple attempts and retry passes, so
    // the scoped CTEs have to isolate by run AND reproduce the latest-attempt rule.
    const a = newRun().runId
    const b = newRun().runId
    recordBatch(a, 'Account', {}, { a01: 'success', a02: ['failed', 'root'], a03: 'skipped' })
    recordBatch(a, 'Account', { retryPass: 1 }, { a02: 'success' })
    recordBatch(a, 'Contact', {}, { c01: ['failed', 'cascade'], c02: 'success' })
    recordBatch(a, 'Contact', { objectAttempt: 1 }, { c01: 'success', c02: 'success', c03: ['failed', null] })
    recordBatch(b, 'Account', {}, { a01: ['failed', 'root'], a09: 'success' })
    recordBatch(b, 'Account', { pass: 2 }, { a09: 'success' })
    store.deploy.recordResults(b, [
      { objectApiName: 'Contact', sourceId: 'c77', pass: 1, retryPass: 0, objectAttempt: 0, outcome: 'skipped', errorMessage: 'NO_PARENT c77 x' }
    ])

    const db = (store as unknown as { db: import('better-sqlite3').Database }).db
    for (const runId of [a, b]) {
      const viewObj = db
        .prepare('SELECT * FROM v_run_object_counters WHERE run_id = ? ORDER BY object_api_name')
        .all(runId)
      const scopedObj = db.prepare(RUN_SCOPED_SQL.objectCounters).all({ runId })
      expect(scopedObj).toEqual(viewObj)
      const viewRun = db.prepare('SELECT * FROM v_run_counters WHERE run_id = ?').get(runId)
      const scopedRun = db.prepare(RUN_SCOPED_SQL.runCounters).get({ runId })
      expect(scopedRun).toEqual(viewRun)
      for (const obj of ['Account', 'Contact']) {
        const viewIds = (
          db
            .prepare(
              `SELECT source_id AS sid FROM v_run_record_current
               WHERE run_id = ? AND object_api_name = ? AND outcome = 'success' ORDER BY id`
            )
            .all(runId, obj) as { sid: string }[]
        ).map((r) => r.sid)
        expect(store.deploy.deployedSourceIds(runId, obj)).toEqual(viewIds)
      }
      const viewSkips = db
        .prepare(
          `SELECT CASE WHEN instr(error_message, ' ') > 0 THEN substr(error_message, 1, instr(error_message, ' ') - 1)
                  ELSE error_message END AS reason, COUNT(*) AS n
           FROM v_run_record_current WHERE run_id = ? AND outcome = 'skipped' AND error_message IS NOT NULL
           GROUP BY reason ORDER BY n DESC, reason`
        )
        .all(runId) as { reason: string; n: number }[]
      expect(store.deploy.skipReasonCounts(runId)).toEqual(viewSkips.map((r) => ({ reason: r.reason, count: r.n })))
    }
    // And the facade's typed readers see the same numbers (a02 healed on retry; c01 healed on re-attempt).
    expect(counters(a, 'Account')).toMatchObject({ recordsDeployed: 2, recordsFailed: 0, recordsSkipped: 1 })
    expect(counters(a, 'Contact')).toMatchObject({ recordsQueried: 3, recordsDeployed: 2, recordsFailed: 1, recordsFailedRoot: 1 })
    expect(store.deploy.runCounters(b)).toMatchObject({ recordsDeployed: 1, recordsFailed: 1, recordsSkipped: 1 })
  })

  it('a run with no results reads as zeroes, not undefined', () => {
    const { runId } = newRun()
    expect(store.deploy.objectCounters(runId)).toEqual([])
    expect(store.deploy.runCounters(runId)).toMatchObject({ runId, recordsQueried: 0, recordsDeployed: 0 })
  })
})

describe('DeployStore — run phase timings + peak memory (migration 014, S64 P5 5.1)', () => {
  it('every setRunPhase stamps a run_phases row at the transition time, in order', () => {
    const { runId } = newRun()
    store.deploy.setRunPhase(runId, 'DisablingAutomation')
    store.deploy.setRunPhase(runId, 'Deploying')
    store.deploy.setRunPhase(runId, 'SecondPass')
    store.deploy.setRunPhase(runId, 'Finalizing')
    store.deploy.setRunPhase(runId, 'RestoringAutomation')
    store.deploy.setRunPhase(runId, 'Completed')
    const phases = store.deploy.runPhases(runId)
    expect(phases.map((p) => p.phase)).toEqual([
      'DisablingAutomation',
      'Deploying',
      'SecondPass',
      'Finalizing',
      'RestoringAutomation',
      'Completed'
    ])
    for (let i = 1; i < phases.length; i++) expect(phases[i]!.at).toBeGreaterThanOrEqual(phases[i - 1]!.at)
    // The terminal stamp equals finished_at — the strip's last segment ends exactly there.
    expect(phases[phases.length - 1]!.at).toBe(store.deploy.getRun(runId)!.finishedAt)
  })

  it('the handler’s pre-run phases are flushed with their ORIGINAL timestamps and sort before the engine’s', () => {
    const { runId } = newRun()
    const t0 = Date.now() - 5000
    // Buffered before the run existed (the handler’s stampPhase), flushed after createRun.
    store.deploy.stampRunPhases(runId, [
      { phase: 'Connecting', at: t0 },
      { phase: 'Gates', at: t0 + 1200 },
      { phase: 'Freezing plan', at: t0 + 2500 }
    ])
    store.deploy.stampRunPhases(runId, [{ phase: 'Auditing target', at: t0 + 4000 }])
    store.deploy.setRunPhase(runId, 'Deploying')
    expect(store.deploy.runPhases(runId).map((p) => p.phase)).toEqual([
      'Connecting',
      'Gates',
      'Freezing plan',
      'Auditing target',
      'Deploying'
    ])
    expect(store.deploy.runPhases(runId)[1]!.at).toBe(t0 + 1200)
    // An empty flush is a no-op, not an error.
    store.deploy.stampRunPhases(runId, [])
    expect(store.deploy.runPhases(runId)).toHaveLength(5)
  })

  it('peak memory round-trips as MB-per-label JSON; null until written; garbage reads as null', () => {
    const { runId } = newRun()
    expect(store.deploy.runPeakMemory(runId)).toBeNull()
    store.deploy.setRunPeakMemory(runId, { main: 412, renderer: 380, gpu: 91 })
    expect(store.deploy.runPeakMemory(runId)).toEqual({ main: 412, renderer: 380, gpu: 91 })
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db
    db.prepare('UPDATE deploy_runs SET peak_memory = ? WHERE id = ?').run('not json', runId)
    expect(store.deploy.runPeakMemory(runId)).toBeNull()
    db.prepare('UPDATE deploy_runs SET peak_memory = ? WHERE id = ?').run('{"main":"x","gpu":7}', runId)
    expect(store.deploy.runPeakMemory(runId)).toEqual({ gpu: 7 })
    expect(() => store.deploy.setRunPeakMemory(999999, { main: 1 })).toThrow(/not found/)
  })

  it('run_phases cascade with the run; the ledger (run_uuid, restore_confirmed) index exists and is used', () => {
    const { runId } = newRun()
    store.deploy.setRunPhase(runId, 'Deploying')
    store.deploy.setRunPhase(runId, 'Finalizing')
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db
    expect((db.prepare('SELECT COUNT(*) AS n FROM run_phases WHERE run_id = ?').get(runId) as { n: number }).n).toBe(2)
    // A deployment that ran keeps its history (canDeleteDeployment), so the cascade
    // is exercised at the FK itself: deleting the run row must take its stamps with it.
    db.prepare('DELETE FROM deploy_runs WHERE id = ?').run(runId)
    expect((db.prepare('SELECT COUNT(*) AS n FROM run_phases WHERE run_id = ?').get(runId) as { n: number }).n).toBe(0)

    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((r) => r.name)
    expect(names).toContain('idx_run_phases_run')
    expect(names).toContain('idx_ledger_run_restore')
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT id FROM automation_ledger_mirror WHERE run_uuid = ? AND restore_confirmed = 0 ORDER BY id`
        )
        .all('run-1') as { detail: string }[]
    ).map((r) => r.detail)
    expect(plan.some((d) => d.includes('idx_ledger_run_restore'))).toBe(true)
    expect(plan.some((d) => /^SCAN automation_ledger_mirror$/.test(d.trim()))).toBe(false)
  })
})
