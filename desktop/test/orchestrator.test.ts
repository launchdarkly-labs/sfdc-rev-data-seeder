/**
 * E4E.1 — orchestrator: scripted plan walks must produce the EXACT Apex pass
 * ordering (first passes → targeted retries → global second pass → teardown),
 * crash-simulated resume restarts at (object, pass) from batch 0 (next
 * attempt), cancel between batches reaches teardown, whole-object retry is
 * bounded at MAX 2 with fresh attempt coordinates, and the CPQ tripwire fails
 * the whole run straight to teardown. Oracle cites live in orchestrator.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  runDeployment,
  deriveRootObjectName,
  rootProducedNothing
} from '../src/main/engine/deploy/orchestrator'
import type {
  DeployEvent,
  DeployIo,
  DeployRunStore,
  FailedRecordInput,
  ObjectCounters,
  ObjectPassContext,
  OrphanedLinkGroup,
  PassExecutors,
  PassKind,
  RecordResultInput,
  RunPhase,
  RunState,
  WalkObject
} from '../src/main/engine/deploy/types'

// ── Scripted in-memory store (the orchestrator's read model) ──────────────

interface ObjectScript {
  /** failures[attempt][retryPass] = failed source ids (the failure relation). */
  failures: Record<number, Record<number, string[]>>
  maxAttempt: number
  maxRetryPassByAttempt: Record<number, number>
}

class FakeStore implements DeployRunStore {
  phase: RunPhase = 'Frozen'
  currentObject: string | null = null
  currentPass: PassKind | null = null
  cancel = false
  teardownOutcome: 'completed' | 'cancelled' | 'failed' | null = null
  finalizeDone = false
  readonly phaseLog: RunPhase[] = []
  readonly resumeLog: Array<[string | null, PassKind | null]> = []
  readonly enqueued: Array<{ object: string; ids: string[]; attempt: number }> = []
  readonly cleared: string[] = []
  private readonly objects = new Map<string, ObjectScript>()

  constructor(private readonly planObjects: WalkObject[]) {}

  private script(object: string): ObjectScript {
    let s = this.objects.get(object)
    if (s == null) {
      s = { failures: {}, maxAttempt: -1, maxRetryPassByAttempt: {} }
      this.objects.set(object, s)
    }
    return s
  }

  /** Test hook: record a pass outcome (what a real executor's writes produce). */
  /** S50 (A1): lets a test express "queried N, deployed 0" — the fake otherwise
   *  hardcodes both to 0, so the root gate could never be exercised here. */
  readonly countersOverride = new Map<string, { queried: number; deployed: number }>()
  setCounters(object: string, queried: number, deployed: number): void {
    this.countersOverride.set(object, { queried, deployed })
  }

  recordPass(object: string, attempt: number, retryPass: number, failedIds: string[]): void {
    const s = this.script(object)
    s.maxAttempt = Math.max(s.maxAttempt, attempt)
    s.maxRetryPassByAttempt[attempt] = Math.max(s.maxRetryPassByAttempt[attempt] ?? 0, retryPass)
    ;(s.failures[attempt] ??= {})[retryPass] = failedIds
  }

  getRun(runId: number): RunState {
    return {
      id: runId,
      deploymentId: 1,
      planId: 7,
      planHash: 'h',
      phase: this.phase,
      currentObject: this.currentObject,
      currentPass: this.currentPass,
      cancelRequested: this.cancel,
      teardownOutcome: this.teardownOutcome,
      finalizeDone: this.finalizeDone,
      startedAt: null,
      finishedAt: null,
      createdAt: 0
    }
  }

  setTeardownOutcome(_runId: number, outcome: 'completed' | 'cancelled' | 'failed'): void {
    this.teardownOutcome = outcome
  }

  markFinalizeDone(): void {
    this.finalizeDone = true
  }

  getPlanById(planId: number): ReturnType<DeployRunStore['getPlanById']> {
    return {
      id: planId,
      deploymentId: 1,
      version: 1,
      planJson: JSON.stringify({ objects: this.planObjects }),
      planHash: 'h',
      createdAt: 0
    }
  }

  setRunPhase(_runId: number, phase: RunPhase): void {
    this.phase = phase
    this.phaseLog.push(phase)
  }

  setResumePoint(_runId: number, obj: string | null, pass: PassKind | null): void {
    this.currentObject = obj
    this.currentPass = pass
    this.resumeLog.push([obj, pass])
  }

  isCancelRequested(): boolean {
    return this.cancel
  }

  recordResults(_runId: number, _rows: RecordResultInput[]): void {}
  recordFailures(_runId: number, _rows: FailedRecordInput[]): void {}
  queriedSourceIds(): string[] {
    return []
  }
  skipReasonCounts(): Array<{ reason: string; count: number }> {
    return []
  }
  /** S50 (A5): observability ledger — settable so the summary can be asserted. */
  orphanGroups: OrphanedLinkGroup[] = []
  recordStrippedRefs(): void {}
  orphanedLinkSummary(): OrphanedLinkGroup[] {
    return this.orphanGroups
  }
  deployedSourceIds(): string[] {
    return []
  }

  listFailures(
    _runId: number,
    object: string,
    retryPass: number,
    objectAttempt: number
  ): { sourceId: string; classification: string | null }[] {
    const ids = this.script(object).failures[objectAttempt]?.[retryPass] ?? []
    return ids.map((sourceId) => ({ sourceId, classification: null }))
  }

  enqueueRetries(_runId: number, object: string, ids: string[], attempt: number): void {
    this.enqueued.push({ object, ids, attempt })
  }

  dequeueRetryChunk(): string[] {
    return []
  }

  retryQueueDepth(): number {
    return 0
  }

  clearRetryQueue(_runId: number, object: string): void {
    this.cleared.push(object)
  }

  objectCounters(runId: number): ObjectCounters[] {
    const out: ObjectCounters[] = []
    for (const [name, s] of this.objects) {
      if (s.maxAttempt < 0) continue
      const k = s.maxRetryPassByAttempt[s.maxAttempt] ?? 0
      const failed = s.failures[s.maxAttempt]?.[k]?.length ?? 0
      const ov = this.countersOverride.get(name)
      out.push({
        runId,
        objectApiName: name,
        recordsQueried: ov?.queried ?? 0,
        recordsDeployed: ov?.deployed ?? 0,
        recordsFailed: failed,
        recordsFailedRoot: failed,
        recordsFailedCascade: 0,
        recordsSkipped: 0
      })
    }
    return out
  }

  runCounters(runId: number): ReturnType<DeployRunStore['runCounters']> {
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

  maxObjectAttempt(_runId: number, object: string): number {
    return this.script(object).maxAttempt
  }

  maxRetryPass(_runId: number, object: string, objectAttempt: number): number {
    return this.script(object).maxRetryPassByAttempt[objectAttempt] ?? 0
  }

  failureCountAt(_runId: number, object: string, retryPass: number, objectAttempt: number): number {
    return this.script(object).failures[objectAttempt]?.[retryPass]?.length ?? 0
  }

  currentFailures(): { objectApiName: string; sourceId: string }[] {
    return [] // classifier input — unused by the orchestrator (E4E.3 executors read it)
  }
}

// ── Harness ────────────────────────────────────────────────────────────────

function walkObj(objectName: string, sortOrder: number, over: Partial<WalkObject> = {}): WalkObject {
  return {
    objectName,
    sortOrder,
    hasCircularReference: false,
    isJunction: false,
    recordCount: 10,
    ...over
  }
}

interface Call {
  kind: string
  object?: string
  attempt?: number
  retryPass?: number
}

function harness(
  objects: WalkObject[],
  script: Partial<Record<string, (ctx: ObjectPassContext, store: FakeStore) => void>> = {}
): {
  store: FakeStore
  io: DeployIo
  passes: PassExecutors
  calls: Call[]
  logs: string[]
} {
  const store = new FakeStore(objects)
  const calls: Call[] = []
  const logs: string[] = []
  const io: DeployIo = {
    describeSource: () => Promise.reject(new Error('not used in E4E.1 tests')),
    describeTarget: () => Promise.reject(new Error('not used in E4E.1 tests')),
    querySourcePages: () => (async function* () {})(),
    getTargetUserId: () => Promise.resolve(null),
    querySource: () => (async function* () {})(),
    queryTarget: () => (async function* () {})(),
    // S49 (BUG-9): unused by these fakes; rejecting keeps the record-type
    // picklist prefetch on its fail-open path.
    restGetTarget: (): Promise<unknown> => Promise.reject(new Error('not used')),
    upsertBatch: () => Promise.reject(new Error('not used in E4E.1 tests')),
    insertCompositeBatch: () => Promise.reject(new Error('junction raw seam (E4E.5) — not used here')),
    store,
    emit: (e: DeployEvent) => {
      if (e.kind === 'log') logs.push(String(e.data.message))
    },
    now: () => new Date(0),
    sleep: () => Promise.resolve()
  }
  const record = (kind: string) => async (ctx: ObjectPassContext) => {
    calls.push({
      kind,
      object: ctx.object.objectName,
      attempt: ctx.objectAttempt,
      retryPass: ctx.retryPass
    })
    const fn = script[`${kind}:${ctx.object.objectName}`]
    if (fn) {
      fn(ctx, store)
    } else if (kind === 'first' || kind === 'junction') {
      // Default: clean pass, no failures.
      store.recordPass(ctx.object.objectName, ctx.objectAttempt, ctx.retryPass, [])
    }
  }
  const passes: PassExecutors = {
    firstPass: record('first'),
    retryPass: record('retry'),
    secondPass: record('second'),
    junctionPass: record('junction'),
    finalize: async (_runId, _io, reason) => {
      calls.push({ kind: `finalize:${reason}` })
    },
    restoreAutomation: async (_runId, _io, reason) => {
      calls.push({ kind: `restore:${reason}` })
    }
  }
  return { store, io, passes, calls, logs }
}

const seq = (calls: Call[]): string[] =>
  calls.map((c) => (c.object ? `${c.kind}:${c.object}` : c.kind))

// ── Tests ──────────────────────────────────────────────────────────────────

describe('orchestrator — Apex pass ordering (E4E.1 AC)', () => {
  it('walks Sort_Order with junction routing, then teardown', async () => {
    const { io, passes, calls, store, logs } = harness([
      walkObj('Account', 1),
      walkObj('OpportunityContactRole', 2, { isJunction: true }),
      walkObj('Contact', 3)
    ])
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('completed')
    expect(seq(calls)).toEqual([
      'first:Account',
      'junction:OpportunityContactRole',
      'first:Contact',
      'finalize:completed',
      'restore:completed'
    ])
    expect(store.phaseLog).toEqual(['Deploying', 'Finalizing', 'RestoringAutomation', 'Completed'])
    expect(logs).toContain('Deployment completed successfully.')
  })

  it('runs DisablingAutomation first when the hook is provided', async () => {
    const { io, passes, store, calls } = harness([walkObj('Account', 1)])
    passes.disableAutomation = async () => {
      calls.push({ kind: 'disable' })
    }
    await runDeployment(1, io, passes)
    expect(seq(calls)[0]).toBe('disable')
    expect(store.phaseLog[0]).toBe('DisablingAutomation')
  })

  it('targeted retries run AFTER all first passes, progress-gated, then give up without progress', async () => {
    const { io, passes, calls, store, logs } = harness(
      [walkObj('Account', 1), walkObj('Contact', 2)],
      {
        // Account fails 3 fresh → heals to 1 on retry 1 → stuck at 1 on retry 2.
        'first:Account': (ctx, s) =>
          s.recordPass('Account', ctx.objectAttempt, 0, ['a1', 'a2', 'a3']),
        'retry:Account': (ctx, s) =>
          s.recordPass('Account', ctx.objectAttempt, ctx.retryPass, ['a1'])
      }
    )
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('completed')
    // Retry starts only after Contact's first pass (Apex: retries after all first passes).
    expect(seq(calls)).toEqual([
      'first:Account',
      'first:Contact',
      'retry:Account', // retry 1: 3 → 1 (progress)
      'retry:Account', // retry 2: 1 → 1 (no progress → stop)
      'finalize:completed',
      'restore:completed'
    ])
    expect(calls[2]).toMatchObject({ retryPass: 1, attempt: 0 })
    expect(calls[3]).toMatchObject({ retryPass: 2, attempt: 0 })
    // The failure set drained each round is the FULL previous-pass set.
    expect(store.enqueued).toEqual([
      { object: 'Account', ids: ['a1', 'a2', 'a3'], attempt: 1 },
      { object: 'Account', ids: ['a1'], attempt: 2 }
    ])
    expect(logs).toContain(
      'Retrying 1 object(s) on failed records only: Account (retry 1, 3 failed)'
    )
    expect(logs).toContain(
      'Deployment completed with 1 persistent failures: Account (1 after 2 retries)'
    )
    expect(store.phaseLog).toContain('Retrying')
  })

  it('stops retrying at MAX 5 targeted passes even with steady progress', async () => {
    const { io, passes, calls } = harness([walkObj('Account', 1)], {
      'first:Account': (ctx, s) =>
        s.recordPass('Account', ctx.objectAttempt, 0, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']),
      'retry:Account': (ctx, s) =>
        // Strictly decreasing: 6, 5, 4, 3, 2 failures at passes 1..5.
        s.recordPass(
          'Account',
          ctx.objectAttempt,
          ctx.retryPass,
          Array.from({ length: 7 - ctx.retryPass }, (_, i) => `a${i + 1}`)
        )
    })
    await runDeployment(1, io, passes)
    const retries = calls.filter((c) => c.kind === 'retry')
    expect(retries).toHaveLength(5)
    expect(retries.at(-1)).toMatchObject({ retryPass: 5 })
  })

  it('junction objects never enter targeted retry', async () => {
    const { io, passes, calls } = harness(
      [walkObj('OpportunityContactRole', 1, { isJunction: true })],
      {
        'junction:OpportunityContactRole': (ctx, s) =>
          s.recordPass('OpportunityContactRole', ctx.objectAttempt, 0, ['j1', 'j2'])
      }
    )
    await runDeployment(1, io, passes)
    expect(calls.filter((c) => c.kind === 'retry')).toHaveLength(0)
  })

  it('global second pass runs after retries, in order, for circular-ref objects only', async () => {
    const { io, passes, calls, logs } = harness(
      [
        walkObj('Account', 1, { hasCircularReference: true }),
        walkObj('Contact', 2),
        walkObj('SBQQ__Quote__c', 3, { hasCircularReference: true })
      ],
      {
        'first:Contact': (ctx, s) => s.recordPass('Contact', ctx.objectAttempt, 0, ['c1']),
        'retry:Contact': (ctx, s) => s.recordPass('Contact', ctx.objectAttempt, ctx.retryPass, [])
      }
    )
    await runDeployment(1, io, passes)
    expect(seq(calls)).toEqual([
      'first:Account',
      'first:Contact',
      'first:SBQQ__Quote__c',
      'retry:Contact',
      'second:Account',
      'second:SBQQ__Quote__c',
      'finalize:completed',
      'restore:completed'
    ])
    expect(logs).toContain(
      'Starting second pass on 2 object(s) (deferred references): Account, SBQQ__Quote__c'
    )
  })
})

describe('orchestrator — bounded whole-object retry (DDQ L104-160)', () => {
  it('retries a throwing object twice with fresh attempts, then succeeds', async () => {
    let throws = 2
    const { io, passes, calls, logs, store } = harness([walkObj('Account', 1)], {
      'first:Account': (ctx, s) => {
        if (throws-- > 0) {
          // Simulate partial rows written before the crash.
          s.recordPass('Account', ctx.objectAttempt, 0, [])
          throw new Error('source query died')
        }
        s.recordPass('Account', ctx.objectAttempt, 0, [])
      }
    })
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('completed')
    const firsts = calls.filter((c) => c.kind === 'first')
    expect(firsts.map((c) => c.attempt)).toEqual([0, 1, 2]) // fresh coordinates each rerun
    expect(store.cleared).toEqual(['Account', 'Account']) // queue cleared on each catch
    expect(
      logs.some((l) =>
        l.startsWith(
          'Deployment errored for Account: source query died [Error] — retrying whole object (attempt 1 of 2)'
        )
      )
    ).toBe(true)
  })

  it('exhausts at MAX 2, marks the object failed, and the walk continues', async () => {
    const { io, passes, calls, logs } = harness(
      [
      // S50 (A1): a passive root at sortOrder 0. These cases are about GENERIC
      // exhaustion semantics, which still hold for non-root objects; the root
      // gate is covered separately below.
      walkObj('Root__c', 0),
        walkObj('Account', 1),
        walkObj('Contact', 2)
      ],
      {
        'first:Account': () => {
          throw new Error('permanent explosion')
        }
      }
    )
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('completed') // rest of the plan still runs (Apex parity)
    expect(calls.filter((c) => c.kind === 'first' && c.object === 'Account')).toHaveLength(3)
    expect(seq(calls)).toContain('first:Contact')
    expect(
      logs.some((l) =>
        l.startsWith('Deployment failed for Account after 2 whole-object retries:')
      )
    ).toBe(true)
  })

  it('a failed object is excluded from the second pass', async () => {
    const { io, passes, calls } = harness(
      [walkObj('Account', 1, { hasCircularReference: true }), walkObj('Contact', 2)],
      {
        'first:Account': () => {
          throw new Error('boom')
        }
      }
    )
    await runDeployment(1, io, passes)
    expect(calls.filter((c) => c.kind === 'second')).toHaveLength(0)
  })
})

describe('orchestrator — tripwire + cancel (§1.4)', () => {
  it('CpqTriggersActiveError fails the WHOLE run: no retry, no chaining, straight to teardown', async () => {
    const { io, passes, calls, store } = harness([walkObj('Account', 1), walkObj('Contact', 2)], {
      'first:Account': () => {
        const e = new Error('SBQQ.QuoteTrigger fired')
        e.name = 'CpqTriggersActiveError'
        throw e
      }
    })
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('failed')
    expect(seq(calls)).toEqual(['first:Account', 'finalize:failed', 'restore:failed'])
    expect(store.phaseLog.at(-1)).toBe('Failed')
    expect(calls.filter((c) => c.kind === 'first' && c.object === 'Account')).toHaveLength(1)
  })

  it('cancel between objects reaches teardown as cancelled (restore still runs)', async () => {
    const { io, passes, calls, store } = harness([walkObj('Account', 1), walkObj('Contact', 2)], {
      'first:Account': (_ctx, s) => {
        s.cancel = true // user clicked Cancel while Account was loading
      }
    })
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('cancelled')
    expect(seq(calls)).toEqual(['first:Account', 'finalize:cancelled', 'restore:cancelled'])
    expect(store.phaseLog.at(-1)).toBe('Cancelled')
  })

  it('cancel during the LAST object (no later walk boundary) still tears down as cancelled', async () => {
    // Pins the run()-level pre-teardown checkCancel (E4E.2): the E4E.2
    // executor returns cleanly on a between-batches cancel, so a cancel set
    // during the final object's batches has no later per-object boundary —
    // without the pre-teardown check the run would finalize as COMPLETED and
    // activate contracts for a cancelled deploy.
    const { io, passes, calls, store } = harness([walkObj('Account', 1), walkObj('Contact', 2)], {
      'first:Contact': (_ctx, s) => {
        s.cancel = true // cancel arrives while the final object's batches run
      }
    })
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('cancelled')
    expect(seq(calls)).toEqual([
      'first:Account',
      'first:Contact',
      'finalize:cancelled',
      'restore:cancelled'
    ])
    expect(store.phaseLog.at(-1)).toBe('Cancelled')
  })

  it('a restore failure parks the run STALLED (recoverable), never terminal-Failed with automation down', async () => {
    const { io, passes, store } = harness([walkObj('Account', 1)])
    let restoreAttempts = 0
    passes.restoreAutomation = async () => {
      restoreAttempts++
      if (restoreAttempts === 1) throw new Error('restore callout died')
    }
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('failed')
    expect(store.phaseLog.at(-1)).toBe('Stalled') // recoverable — NOT locked terminal
    expect(store.teardownOutcome).toBe('completed') // original outcome kept for the retry
    expect(store.finalizeDone).toBe(true)

    // Resume: goes straight back into teardown, restore succeeds, run completes.
    const resumed = await runDeployment(1, io, passes)
    expect(resumed).toBe('completed')
    expect(restoreAttempts).toBe(2)
    expect(store.phaseLog.at(-1)).toBe('Completed')
  })
})

describe('orchestrator — retry budget is consumed at selection time (review fix, DDQ L2976-2983)', () => {
  it('a retry drain that records NOTHING terminates after one more selection (no infinite loop)', async () => {
    // Source records deleted mid-run: the drain dequeues but the re-query
    // returns 0 rows, so nothing is recorded. Apex gives up on the second
    // selection (current >= previous snapshot); so must we.
    const { io, passes, calls } = harness([walkObj('Account', 1)], {
      'first:Account': (ctx, s) => s.recordPass('Account', ctx.objectAttempt, 0, ['a1', 'a2']),
      'retry:Account': () => {
        /* drains the queue, records nothing */
      }
    })
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('completed')
    expect(calls.filter((c) => c.kind === 'retry')).toHaveLength(1) // selected once, then give-up
  })

  it('a deterministically-throwing drain + reproducing rerun stops after ONE cycle (Apex memory across attempts)', async () => {
    const { io, passes, calls } = harness([walkObj('Account', 1)], {
      'first:Account': (ctx, s) => s.recordPass('Account', ctx.objectAttempt, 0, ['a1', 'a2']),
      'retry:Account': () => {
        throw new Error('retry-shaped query 500s')
      }
    })
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('completed')
    // One retry selection → throw → whole-object rerun reproduces the same 2
    // failures → next selection: current(2) >= previous(2) → give up.
    expect(calls.filter((c) => c.kind === 'retry')).toHaveLength(1)
    const firsts = calls.filter((c) => c.kind === 'first')
    expect(firsts.length).toBeLessThanOrEqual(2) // initial + at most one rerun
  })

  it('an exhausted object with recorded failures still gets its targeted retry (Apex has no Status filter)', async () => {
    let firstCalls = 0
    const { io, passes, calls } = harness([walkObj('Root__c', 0), walkObj('Account', 1)], {
      'first:Account': (ctx, s) => {
        firstCalls++
        // Every attempt records the same addressable failure, then dies.
        s.recordPass('Account', ctx.objectAttempt, 0, ['a1'])
        throw new Error('pagination died')
      },
      'retry:Account': (ctx, s) => s.recordPass('Account', ctx.objectAttempt, ctx.retryPass, [])
    })
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('completed')
    expect(firstCalls).toBe(3) // exhausted (initial + 2 bounded retries)
    // The recorded failure is still drained afterwards and heals.
    expect(calls.filter((c) => c.kind === 'retry')).toHaveLength(1)
  })
})

describe('orchestrator — resume (crash-simulated, E4E.1 AC)', () => {
  it('Deploying + currentObject resumes AT that object with the next attempt (from batch 0)', async () => {
    const { io, passes, calls, store } = harness([
      walkObj('Account', 1),
      walkObj('Contact', 2),
      walkObj('Opportunity', 3)
    ])
    // Simulate the pre-crash state: Account completed, Contact crashed mid-object.
    store.phase = 'Deploying'
    store.currentObject = 'Contact'
    store.currentPass = 'first'
    store.recordPass('Account', 0, 0, [])
    store.recordPass('Contact', 0, 0, []) // partial rows from the interrupted attempt
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('completed')
    expect(seq(calls)).toEqual([
      'first:Contact',
      'first:Opportunity',
      'finalize:completed',
      'restore:completed'
    ])
    // Contact re-runs from batch 0 at attempt 1 (crash consumed a retry slot).
    expect(calls[0]).toMatchObject({ object: 'Contact', attempt: 1 })
    expect(calls[1]).toMatchObject({ object: 'Opportunity', attempt: 0 })
  })

  it('a crash mid-retry-drain re-runs the whole object fresh, then re-evaluates retries', async () => {
    const { io, passes, calls, store } = harness([walkObj('Account', 1)], {
      'first:Account': (ctx, s) => s.recordPass('Account', ctx.objectAttempt, 0, [])
    })
    store.phase = 'Retrying'
    store.currentObject = 'Account'
    store.currentPass = 'retry'
    store.recordPass('Account', 0, 0, ['a1', 'a2'])
    store.recordPass('Account', 0, 1, ['a1']) // the interrupted drain's partial rows
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('completed')
    expect(store.cleared[0]).toBe('Account') // stale queue dropped first
    // Fresh first pass at attempt 1 (scripted clean) → no candidates → done.
    expect(seq(calls)).toEqual(['first:Account', 'finalize:completed', 'restore:completed'])
    expect(calls[0]).toMatchObject({ attempt: 1 })
  })

  it('SecondPass + currentObject resumes the second-pass walk at that object', async () => {
    const { io, passes, calls, store } = harness([
      walkObj('Account', 1, { hasCircularReference: true }),
      walkObj('Contact', 2, { hasCircularReference: true }),
      walkObj('Opportunity', 3, { hasCircularReference: true })
    ])
    store.phase = 'SecondPass'
    store.currentObject = 'Contact'
    store.currentPass = 'second'
    for (const o of ['Account', 'Contact', 'Opportunity']) store.recordPass(o, 0, 0, [])
    await runDeployment(1, io, passes)
    expect(seq(calls)).toEqual([
      'second:Contact',
      'second:Opportunity',
      'finalize:completed',
      'restore:completed'
    ])
    // Second pass appends to the CURRENT attempt — never bumps it.
    expect(calls[0]).toMatchObject({ attempt: 0 })
  })

  it('Finalizing resumes straight into teardown (hooks only, no passes)', async () => {
    const { io, passes, calls, store } = harness([walkObj('Account', 1)])
    store.phase = 'Finalizing'
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('completed')
    expect(seq(calls)).toEqual(['finalize:completed', 'restore:completed'])
  })

  it('Stalled resumes via its parked resume point', async () => {
    const { io, passes, calls, store } = harness([
      walkObj('Account', 1),
      walkObj('Contact', 2)
    ])
    store.phase = 'Stalled'
    store.currentObject = 'Contact'
    store.currentPass = 'first'
    store.recordPass('Account', 0, 0, [])
    await runDeployment(1, io, passes)
    expect(seq(calls)).toEqual([
      'first:Contact',
      'finalize:completed',
      'restore:completed'
    ])
  })

  it('refuses to run a terminal run', async () => {
    const { io, passes, store } = harness([walkObj('Account', 1)])
    store.phase = 'Completed'
    await expect(runDeployment(1, io, passes)).rejects.toThrow(/already terminal/)
  })

  it('resume from RestoringAutomation re-runs RESTORE (not finalize) and completes (review fix)', async () => {
    // Crash while E4A restore was running: finalize already completed.
    const { io, passes, calls, store } = harness([walkObj('Account', 1)])
    store.phase = 'RestoringAutomation'
    store.teardownOutcome = 'completed'
    store.finalizeDone = true
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('completed')
    expect(seq(calls)).toEqual(['restore:completed']) // no finalize re-run, no walk
    expect(store.phaseLog.at(-1)).toBe('Completed')
  })

  it('a cancelled run crashed mid-teardown resumes as CANCELLED — never resurrects completed (review fix)', async () => {
    const { io, passes, calls, store } = harness([walkObj('Account', 1)])
    store.phase = 'Finalizing'
    store.cancel = true
    store.teardownOutcome = 'cancelled' // stamped when teardown('cancelled') entered
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('cancelled')
    // finalize re-runs (it had NOT completed) with the ORIGINAL reason — the
    // 'skip contract activation on cancel' contract holds across the crash.
    expect(seq(calls)).toEqual(['finalize:cancelled', 'restore:cancelled'])
    expect(store.phaseLog.at(-1)).toBe('Cancelled')
  })

  it('a run parked Stalled DURING teardown resumes into teardown, not the stale walk resume point (review fix)', async () => {
    const { io, passes, calls, store } = harness([
      walkObj('Account', 1, { hasCircularReference: true })
    ])
    store.phase = 'Stalled'
    store.currentObject = 'Account' // stale (object, pass) stamp from the walk
    store.currentPass = 'second'
    store.teardownOutcome = 'completed'
    store.finalizeDone = true
    store.recordPass('Account', 0, 0, [])
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('completed')
    // NO second-pass replay against a guard-disarmed target; restore only.
    expect(seq(calls)).toEqual(['restore:completed'])
  })

  it('resume from a crash mid-DisablingAutomation re-runs the disable hook (review fix)', async () => {
    const { io, passes, calls, store } = harness([walkObj('Account', 1)])
    passes.disableAutomation = async () => {
      calls.push({ kind: 'disable' })
    }
    store.phase = 'DisablingAutomation'
    await runDeployment(1, io, passes)
    expect(seq(calls)[0]).toBe('disable') // interrupted disable completes first
    expect(seq(calls)).toContain('first:Account')
  })
})

describe('orchestrator — exhaustion is visible in the terminal summary (review fix, DDQ L144-149)', () => {
  it('an object that exhausted with NO recorded rows still reports persistent failures', async () => {
    const { io, passes, logs } = harness(
      [walkObj('Root__c', 0), walkObj('Account', 1, { recordCount: 42 })],
      {
        'first:Account': () => {
          throw new Error('source query dead') // never records a row
        }
      }
    )
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('completed') // Apex parity: run completes, object failed
    expect(logs).not.toContain('Deployment completed successfully.')
    expect(
      logs.some((l) =>
        l.includes('Deployment completed with 42 persistent failures: Account (42 after 0 retries)')
      )
    ).toBe(true)
  })

  it('falls back to 1 when the frozen plan has no record count', async () => {
    const { io, passes, logs } = harness([walkObj('Account', 1, { recordCount: 0 })], {
      'first:Account': () => {
        throw new Error('boom')
      }
    })
    await runDeployment(1, io, passes)
    expect(logs.some((l) => l.includes('Account (1 after 0 retries)'))).toBe(true)
  })
})

/**
 * S50 (A1) — root-failure abort.
 *
 * Run 9 (express scripts, 2026-09-07): the root Account failed on a restricted
 * picklist. Only `Contract.AccountId` is REQUIRED so only Contracts cascaded;
 * every other child lookup is nillable, so parentStrip dropped the link and the
 * rows deployed anyway — 249 Contacts / 18 Opportunities / 5 Quotes landed with
 * NO account, and the run reported `Completed`.
 *
 * The false-positive cases matter as much as the positive one: an over-eager
 * gate turns healthy runs into failures, and an EMPTY scope is legal.
 */
describe('orchestrator — root-failure abort (S50 A1)', () => {
  it('derives the root as the lowest-sortOrder raw-scoped object', () => {
    expect(
      deriveRootObjectName([
        { objectName: 'Contact', scope: { kind: 'parentIn' } },
        { objectName: 'Account', scope: { kind: 'raw' } }
      ])
    ).toBe('Account')
  })

  it('falls back to the first object when no scope survives (older frozen plans)', () => {
    expect(deriveRootObjectName([{ objectName: 'Account' }, { objectName: 'Contact' }])).toBe(
      'Account'
    )
  })

  describe('rootProducedNothing', () => {
    it('ABORTS when the root was queried and nothing landed (the run-9 shape)', () => {
      expect(rootProducedNothing({ recordsQueried: 1, recordsDeployed: 0 }, 1, false)).toBe(true)
    })

    it('does NOT abort when the root deployed', () => {
      expect(rootProducedNothing({ recordsQueried: 1, recordsDeployed: 1 }, 1, false)).toBe(false)
    })

    it('ABORTS when the root exhausted its retries and recorded nothing', () => {
      expect(rootProducedNothing(undefined, 42, true)).toBe(true)
    })

    it('does NOT abort on missing counters alone — that is not evidence of harm', () => {
      // Every scripted caller that does not track counters would otherwise
      // abort a perfectly healthy run.
      expect(rootProducedNothing(undefined, 42, false)).toBe(false)
    })

    it('does NOT abort on a legitimately EMPTY scope', () => {
      expect(rootProducedNothing({ recordsQueried: 0, recordsDeployed: 0 }, 0, false)).toBe(false)
    })
  })

  it('stops the walk and fails the run when the root deploys nothing', async () => {
    const { io, passes, calls, logs } = harness(
      [walkObj('Account', 1), walkObj('Contact', 2), walkObj('Opportunity', 3)],
      {
        // Root is queried but every record fails — exactly run 9.
        'first:Account': (_ctx, s) => {
          s.recordPass('Account', 0, 0, ['a1'])
          s.setCounters('Account', 1, 0)
        }
      }
    )
    const outcome = await runDeployment(1, io, passes)

    expect(outcome).toBe('failed')
    // The whole point: the children were NEVER written.
    expect(seq(calls)).not.toContain('first:Contact')
    expect(seq(calls)).not.toContain('first:Opportunity')
    expect(logs.some((l) => l.includes('Root object Account deployed no records'))).toBe(true)
  })

  it('lets a healthy root through and deploys the rest of the plan', async () => {
    const { io, passes, calls } = harness([walkObj('Account', 1), walkObj('Contact', 2)], {
      'first:Account': (_ctx, s) => {
        s.recordPass('Account', 0, 0, [])
        s.setCounters('Account', 1, 1)
      }
    })
    const outcome = await runDeployment(1, io, passes)
    expect(outcome).toBe('completed')
    expect(seq(calls)).toContain('first:Contact')
  })
})
