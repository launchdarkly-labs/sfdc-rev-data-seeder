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
      recordsSkipped: 1
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
   * Run 9 (express scripts, 2026-09-07): the root Account failed and 249
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
})
