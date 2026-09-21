/**
 * E4E.1 — the deploy orchestrator: the object loop / pass router
 * (deployDesign §1.1/§1.3/§1.4). Ports the queueable chain-walk semantics of
 * `DataDeploymentQueueable.chainNextObjectInternal` (DDQ L2903-3090) + the
 * whole-object bounded retry (DDQ L104-160) as ONE resumable async loop —
 * the cron/queueable hop machinery dies; the ORDER and retry/cancel semantics
 * survive exactly:
 *
 *   first passes (Sort_Order asc, junction objects via their own path)
 *     → targeted-retry rounds (progress-gated, MAX 5, full-failure-set drains)
 *     → global second pass (all first passes done first — deferred refs resolve)
 *     → teardown (finalize: contracts → guard disarm; then automation restore)
 *
 * Pass executors are INJECTED (PassExecutors): E4E.2-E4E.5 provide the real
 * batch loops; tests script them. The orchestrator owns ordering, resume,
 * bounded retry, cancel routing, phase transitions (via stateMachine), and
 * the Apex log-line texts.
 *
 * RESUME (deployDesign §1.3): granularity is (object, pass), re-run from batch
 * 0. The resume point is stamped at OBJECT ENTRY and left in place, so after a
 * crash `currentObject` names the interrupted object. Re-running it bumps
 * `objectAttempt` (fresh write coordinates — the counter views count only the
 * latest attempt, reproducing the Apex counter reset) and CONSUMES a bounded
 * whole-object-retry slot: a mid-object crash is treated exactly like the
 * thrown exception the Apex catch handled. A crash mid-RETRY-drain also
 * re-runs the whole object fresh (Apex whole-object retry nulled
 * Retry_Pending_Ids and re-ran from batch 0 — DDQ L125-132).
 *
 * TRIPWIRE (DDQ L104-110): an executor throw named 'CpqTriggersActiveError'
 * fails the WHOLE run — no per-object retry, no chaining — straight to
 * teardown (restore still runs; contract activation is the finalize hook's
 * call based on the outcome).
 *
 * Terminal events: the engine emits 'phase'/'log'/'progress' only; the
 * service-side job handler emits the terminal done/error/cancelled JobEvent
 * from the returned outcome (single source for terminal status).
 *
 * failed_records is a FIRST-PASS-FAMILY relation: second-pass executors must
 * NOT write it (Apex tracked second-pass failures in the activity log only —
 * DDQ L3025-3034); pass-2 rows in record_results are log/audit material.
 *
 * Pure over injected IO: no jsforce, no better-sqlite3, no clock, no timers.
 */
import type {
  DeployIo,
  ObjectCounters,
  PassExecutors,
  RunOutcome,
  RunState,
  WalkObject
} from './types'
import { MAX_OBJECT_RETRIES, MAX_TARGETED_RETRIES } from './types'
import { transition } from './stateMachine'

/** Internal control-flow signal: CPQ tripwire fired — fail the whole run. */
class TripwireSignal extends Error {
  constructor(readonly cause_: Error) {
    super(cause_.message)
    this.name = 'TripwireSignal'
  }
}

/** A cancel observed between objects/passes. */
class CancelSignal extends Error {
  constructor() {
    super('cancel requested')
    this.name = 'CancelSignal'
  }
}

export interface RunDeploymentOptions {
  /** Extra cancel source (UI AbortController); the store flag is always checked too. */
  signal?: { aborted: boolean }
}

function isTripwire(e: unknown): boolean {
  return e instanceof Error && e.name === 'CpqTriggersActiveError'
}

function errorDetail(e: unknown): string {
  if (e instanceof Error) return `${e.message} [${e.name}]`
  return String(e)
}

/**
 * S50 (A1) — which object is the run's ROOT?
 *
 * Scoping priority (`scoping.ts:284-291`) makes this unambiguous without any
 * new plan field: the object the user filtered directly gets `scope.kind ===
 * 'raw'` and is materialized for its children; every child is scoped
 * `parentIn` / `parentSubquery` off it. So the root is the lowest-`sortOrder`
 * raw-scoped object. Falls back to the first object when no scope survives
 * (older plans), which is the same thing in every plan we have.
 */
export function deriveRootObjectName(
  objects: ReadonlyArray<{ objectName: string; scope?: { kind?: string } }>
): string | null {
  for (const o of objects) {
    if (o.scope?.kind === 'raw') return o.objectName
  }
  return objects.length > 0 ? (objects[0]?.objectName ?? null) : null
}

/**
 * S50 (A1) — did the ROOT object produce nothing, so that continuing would
 * deploy a DETACHED subtree?
 *
 * Live case (run 9, express scripts, 2026-09-07): the root Account failed on a
 * restricted picklist. Only `Contract.AccountId` is REQUIRED, so only the 3
 * Contracts cascaded; every other child lookup is nillable, so
 * `stripMissingParentRefs` dropped the link and the rows deployed anyway — 249
 * Contacts, 18 Opportunities and 5 Quotes landed on target with NO account,
 * and the run reported `Completed`.
 *
 * Counter-derived on purpose: `failedObjects` is in-memory only
 * (never persisted), so a resumed run would have forgotten the root died. The
 * counters are persisted, so this predicate re-evaluates identically on resume.
 */
export function rootProducedNothing(
  counters: { recordsQueried: number; recordsDeployed: number } | undefined,
  plannedRecordCount: number,
  /** Did the root exhaust its whole-object retries? The only evidence available
   *  when the object threw and therefore recorded no rows at all. */
  rootExhausted: boolean
): boolean {
  // PRIMARY, and the only resume-safe case: the root was queried and NOTHING
  // landed. Purely counter-derived, so a resumed run re-evaluates identically.
  if (counters != null && counters.recordsQueried > 0) return counters.recordsDeployed === 0

  // SECONDARY: the root threw and exhausted its retries, so there are no
  // counters to read. Requires the exhaustion flag as positive evidence —
  // "no counters" ALONE must never abort, or any caller that doesn't track
  // counters (and every scripted test fake) would abort on a healthy run.
  if (rootExhausted) return (counters?.recordsDeployed ?? 0) === 0

  // No counters and no failure: nothing happened worth aborting over. An empty
  // scope is a legal no-op; `plannedRecordCount` alone is not evidence of harm.
  void plannedRecordCount
  return false
}

/** S50 (A1): raised when the root object produced nothing. Routed to teardown('failed'). */
export class RootFailureSignal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RootFailureSignal'
  }
}

export async function runDeployment(
  runId: number,
  io: DeployIo,
  passes: PassExecutors,
  opts: RunDeploymentOptions = {}
): Promise<RunOutcome> {
  const run = io.store.getRun(runId)
  if (run == null) throw new Error(`Run ${runId} not found`)
  if (run.phase === 'Completed' || run.phase === 'Failed' || run.phase === 'Cancelled') {
    throw new Error(`Run ${runId} is already terminal (${run.phase})`)
  }
  const planRow = io.store.getPlanById(run.planId)
  if (planRow == null) throw new Error(`Run ${runId}: frozen plan ${run.planId} not found`)
  // The persisted planJson is the full FrozenObjectPlan[], so `scope` is
  // ALREADY there — widening the parse type costs nothing and avoids adding an
  // `isRoot` field, which would change canonicalPlanJson and therefore the plan
  // HASH, breaking every existing frozen plan and resumable run (S50 A1).
  const plan = JSON.parse(planRow.planJson) as {
    objects: Array<WalkObject & { scope?: { kind?: string } }>
  }
  const objects = [...plan.objects].sort((a, b) => a.sortOrder - b.sortOrder)
  const rootObjectName = deriveRootObjectName(objects)

  const state = new WalkState(runId, io, passes, objects, opts, rootObjectName)
  try {
    return await state.run(run)
  } catch (e) {
    if (e instanceof CancelSignal) return state.teardown('cancelled')
    if (e instanceof TripwireSignal) {
      state.log('Error', e.message)
      return state.teardown('failed')
    }
    // S50 (A1): root produced nothing — stop before a detached subtree is written.
    if (e instanceof RootFailureSignal) {
      state.log('Error', e.message)
      return state.teardown('failed')
    }
    // Orchestrator-level unexpected error: still try to tear down (restore
    // must run), then surface the failure.
    state.log('Error', `Deployment run error: ${errorDetail(e)}`)
    return state.teardown('failed')
  }
}

class WalkState {
  /** Objects that exhausted their whole-object retries this run. The walk and
   *  second pass skip them; TARGETED retry does not (Apex's candidate query
   *  had no Status filter — an exhausted object's recorded failures are still
   *  retried, DDQ L2929-2939). In-memory only: after a crash-resume an
   *  exhausted circular-ref object can re-enter the second pass, where its
   *  updateOnly PATCHes no-op against the missing target rows (benign;
   *  E4E.6's recovery formalizes persisted per-object state). */
  private readonly failedObjects = new Set<string>()

  /**
   * Targeted-retry budget, consumed AT SELECTION TIME like the Apex persisted
   * Retry_Count__c / Previous_Failure_Count__c pair (DDQ L2976-2983) — NOT
   * derived from executor-written rows. This is what bounds the retry loop
   * when a drain records nothing (source records deleted mid-run) or a
   * throwing drain alternates with whole-object reruns: budget advances every
   * selection regardless of what the drain produced, and the progress gate
   * remembers the last selection's failure count across whole-object attempts
   * (E4E.1 review fix — both shapes were reproduced looping forever).
   * Seeded lazily from recorded rows on resume; a crash refreshes at most one
   * session's budget (bounded per session, documented divergence).
   */
  private readonly retryState = new Map<
    string,
    { retryCount: number; previousFailureCount: number | null }
  >()

  constructor(
    private readonly runId: number,
    private readonly io: DeployIo,
    private readonly passes: PassExecutors,
    private readonly objects: WalkObject[],
    private readonly opts: RunDeploymentOptions,
    /** S50 (A1): the scope root, derived from the frozen plan; null disables the gate. */
    private readonly rootObjectName: string | null = null
  ) {}

  async run(run: RunState): Promise<RunOutcome> {
    const resume = this.resumeEntry(run)

    if (resume.stage === 'teardown') {
      // The walk is over — never re-enter it (a stale (object, pass) resume
      // point survives into teardown phases; E4E.1 review fix).
      return this.teardown(resume.outcome)
    }

    if (resume.stage === 'first') {
      // 'DisablingAutomation' re-runs the interrupted disable (idempotent by
      // the E4A contract) — skipping it would deploy over half-live automation.
      if (
        run.phase === 'Frozen' ||
        run.phase === 'Stalled' ||
        run.phase === 'DisablingAutomation'
      ) {
        if (this.passes.disableAutomation) {
          this.phase('DisablingAutomation')
          await this.passes.disableAutomation(this.runId, this.io)
        }
      }
      this.phase('Deploying')
      await this.firstPassWalk(resume.fromObject)
      await this.retryRounds()
      await this.secondPassWalk(null)
      await this.retryRounds()
    } else if (resume.stage === 'retry') {
      this.phase('Retrying')
      // A crash mid-retry-drain re-runs the whole object fresh (see header).
      if (resume.fromObject != null) {
        const obj = this.objects.find((o) => o.objectName === resume.fromObject)
        if (obj != null && !obj.isJunction) {
          this.io.store.clearRetryQueue(this.runId, obj.objectName)
          this.checkCancel()
          await this.runObjectBounded(obj, 'first')
        }
      }
      await this.retryRounds()
      await this.secondPassWalk(null)
      await this.retryRounds()
    } else {
      this.phase('SecondPass')
      await this.secondPassWalk(resume.fromObject)
      await this.retryRounds()
    }
    // A cancel that arrived during the LAST object's batches (executors stop
    // dispatching and return cleanly — E4E.2) has no later walk boundary to
    // catch it; check once more before completing (→ cancelled teardown).
    this.checkCancel()
    return this.teardown('completed')
  }

  /** Where to re-enter, from the persisted (phase, object, pass, teardown marker). */
  private resumeEntry(run: RunState):
    | { stage: 'first' | 'retry' | 'second'; fromObject: string | null }
    | { stage: 'teardown'; outcome: RunOutcome } {
    // The teardown marker outranks EVERYTHING, including Stalled parks: once
    // set, the walk is over and the ORIGINAL outcome is binding — a cancelled
    // or tripwired run crashed mid-teardown must not resurrect as 'completed'
    // (that would activate contracts for a cancelled deploy).
    if (run.teardownOutcome != null) {
      return { stage: 'teardown', outcome: run.teardownOutcome }
    }
    switch (run.phase) {
      case 'Frozen':
      case 'DisablingAutomation':
        return { stage: 'first', fromObject: null }
      case 'Deploying':
        return { stage: 'first', fromObject: run.currentObject }
      case 'Retrying':
        return { stage: 'retry', fromObject: run.currentObject }
      case 'SecondPass':
        return { stage: 'second', fromObject: run.currentObject }
      case 'Finalizing':
      case 'RestoringAutomation':
        // Defensive: teardown stamps the outcome before entering these phases,
        // so this branch only fires on a pre-marker legacy row.
        return { stage: 'teardown', outcome: run.cancelRequested ? 'cancelled' : 'completed' }
      case 'Stalled': {
        // Re-enter wherever the run parked (the resume point outlives Stalled).
        switch (run.currentPass) {
          case 'retry':
            return { stage: 'retry', fromObject: run.currentObject }
          case 'second':
            return { stage: 'second', fromObject: run.currentObject }
          default:
            return { stage: 'first', fromObject: run.currentObject }
        }
      }
      default:
        throw new Error(`Run ${this.runId}: cannot resume from phase ${run.phase}`)
    }
  }

  // ── The three walks ─────────────────────────────────────────

  private async firstPassWalk(fromObject: string | null): Promise<void> {
    const startIdx =
      fromObject == null ? 0 : this.objects.findIndex((o) => o.objectName === fromObject)
    const from = startIdx < 0 ? 0 : startIdx
    for (let i = from; i < this.objects.length; i++) {
      const obj = this.objects[i]!
      this.checkCancel()
      this.emitProgress(i + 1, this.objects.length, obj.objectName)
      await this.runObjectBounded(obj, obj.isJunction ? 'junction' : 'first')

      // ── S50 (A1): root-failure gate ──────────────────────────────────────
      // Checked HERE, after the object returns, rather than thrown from the
      // executor: a signal raised inside would match neither isTripwire nor
      // CancelSignal in runObjectBounded's catch, degrade into a generic
      // object error, burn the whole-object retries and then let the walk
      // CONTINUE — the exact behaviour this gate exists to prevent.
      if (this.rootObjectName != null && obj.objectName === this.rootObjectName) {
        if (
          rootProducedNothing(
            this.countersFor(obj.objectName),
            obj.recordCount,
            this.failedObjects.has(obj.objectName)
          )
        ) {
          throw new RootFailureSignal(
            `Root object ${obj.objectName} deployed no records — stopping before its ` +
              'children are written. Deploying them now would create records with no ' +
              `link back to their ${obj.objectName}, which is worse than a clean failure: ` +
              'they look deployed, they are unusable, and a re-run upserts against them. ' +
              'Fix the reported failure and re-run.'
          )
        }
      }
    }
  }

  /**
   * Targeted-retry rounds (DDQ L2938-3013): each round re-selects candidates
   * (failures > 0, retries < 5, strictly-decreasing progress), drains the full
   * previous-pass failure set, and repeats until no candidate survives.
   * Junction objects never retry (their path records no retry input — DDQ
   * L762 'No retries; failures land in Records_Failed and stop').
   */
  /** The (seeded) selection-time budget for one object — see retryState. */
  private retryStateFor(
    objectName: string,
    attempt: number
  ): { retryCount: number; previousFailureCount: number | null } {
    let st = this.retryState.get(objectName)
    if (st == null) {
      // Resume seed: recorded retry passes prove consumed budget; the
      // previous pass's failure count re-arms the progress gate.
      const k = this.io.store.maxRetryPass(this.runId, objectName, attempt)
      st = {
        retryCount: k,
        previousFailureCount:
          k > 0 ? this.io.store.failureCountAt(this.runId, objectName, k - 1, attempt) : null
      }
      this.retryState.set(objectName, st)
    }
    return st
  }

  private async retryRounds(): Promise<void> {
    for (;;) {
      const candidates: { obj: WalkObject; current: number; failPass: number; attempt: number }[] =
        []
      const givingUp: string[] = []
      // S50 (A2): ONE counters read per round, not one per object.
      // `countersFor` materialises the whole v_run_object_counters view and
      // discards all but one row; calling it inside this loop meant 11 objects
      // x N rounds full materialisations, on the main thread. Safe to snapshot
      // because candidate SELECTION performs no writes — counters cannot move
      // between iterations of this loop. (The A1 root gate deliberately keeps
      // using the uncached read: it runs right after an object wrote rows.)
      const roundCounters = new Map(
        this.io.store.objectCounters(this.runId).map((c) => [c.objectApiName, c])
      )
      for (const obj of this.objects) {
        // Junctions never retry; exhausted objects with recorded failures DO
        // (Apex candidate query has no Status filter).
        if (obj.isJunction) continue
        const attempt = this.io.store.maxObjectAttempt(this.runId, obj.objectName)
        if (attempt < 0) continue
        const counters = roundCounters.get(obj.objectName)
        if (counters == null || counters.recordsFailed <= 0) continue
        const k = this.io.store.maxRetryPass(this.runId, obj.objectName, attempt)
        const current = this.io.store.failureCountAt(this.runId, obj.objectName, k, attempt)
        if (current <= 0) continue // failures not source-id-addressable → not retryable
        const st = this.retryStateFor(obj.objectName, attempt)
        if (st.retryCount >= MAX_TARGETED_RETRIES) {
          givingUp.push(obj.objectName)
          continue
        }
        // Progress gate against the LAST SELECTION's count — survives no-row
        // drains and whole-object reruns, like the Apex persisted snapshot.
        if (st.previousFailureCount != null && current >= st.previousFailureCount) {
          givingUp.push(obj.objectName)
          continue
        }
        candidates.push({ obj, current, failPass: k, attempt })
      }
      if (candidates.length === 0) return

      this.phase('Retrying')
      // Consume budget AT SELECTION (Apex DDQ L2976-2983): the pass number is
      // the budget counter, not the recorded-row watermark.
      const selected = candidates.map((c) => {
        const st = this.retryStateFor(c.obj.objectName, c.attempt)
        st.previousFailureCount = c.current
        st.retryCount += 1
        return { ...c, nextPass: st.retryCount }
      })
      const summaries = selected.map(
        (c) => `${c.obj.objectName} (retry ${c.nextPass}, ${c.current} failed)`
      )
      const giveUpNote = givingUp.length > 0 ? ` (stopped retrying: ${givingUp.join(', ')})` : ''
      this.log(
        'Info',
        `Retrying ${selected.length} object(s) on failed records only: ` +
          summaries.join('; ') +
          giveUpNote
      )

      for (const c of selected) {
        this.checkCancel()
        const failures = this.io.store.listFailures(
          this.runId,
          c.obj.objectName,
          c.failPass,
          c.attempt
        )
        // Apex OVERWRITE parity (DDQ L2978: Retry_Pending_Ids = Retry_Source_Ids):
        // the retry transition REPLACED the pending queue with the current
        // failure set — never-attempted leftovers from an abandoned drain
        // (empty chunk query) are dropped, not merged ahead of the fresh seeds
        // (E4E.3 review: stale leftovers hijacked the next drain's chunks and
        // could starve the genuinely retryable records out of their round).
        this.io.store.clearRetryQueue(this.runId, c.obj.objectName)
        this.io.store.enqueueRetries(
          this.runId,
          c.obj.objectName,
          failures.map((f) => f.sourceId),
          c.nextPass
        )
        this.io.store.setResumePoint(this.runId, c.obj.objectName, 'retry')
        await this.runObjectBounded(c.obj, 'retry', c.nextPass)
      }
      this.phase('Deploying') // rounds re-enter per-object deploys (Apex loop shape)
    }
  }

  private async secondPassWalk(fromObject: string | null): Promise<void> {
    const awaiting = this.objects.filter(
      (o) => o.hasCircularReference && !o.isJunction && !this.failedObjects.has(o.objectName)
    )
    if (awaiting.length === 0) return
    this.phase('SecondPass')
    let list = awaiting
    if (fromObject != null) {
      const idx = awaiting.findIndex((o) => o.objectName === fromObject)
      if (idx >= 0) list = awaiting.slice(idx)
    } else {
      this.log(
        'Info',
        `Starting second pass on ${awaiting.length} object(s) (deferred references): ` +
          awaiting.map((o) => o.objectName).join(', ')
      )
    }
    for (const obj of list) {
      this.checkCancel()
      this.io.store.setResumePoint(this.runId, obj.objectName, 'second')
      await this.runObjectBounded(obj, 'second')
    }
  }

  // ── Bounded whole-object retry (DDQ L104-160) ───────────────

  private async runObjectBounded(
    obj: WalkObject,
    kind: 'first' | 'junction' | 'retry' | 'second',
    retryPass = 0
  ): Promise<void> {
    // Exhausted objects skip further walk/second passes but stay open to
    // TARGETED retries of their recorded failures (Apex parity — the retry
    // pass flipped a Failed object back to Pending, DDQ L2984-2985).
    if (this.failedObjects.has(obj.objectName) && kind !== 'retry') return
    if (kind !== 'retry') {
      this.io.store.setResumePoint(this.runId, obj.objectName, kind)
    }
    // Attempt coordinates: a FRESH first/junction pass opens the next attempt
    // (fresh object → 0; partial rows from a crash / bounded rerun → next);
    // retry drains and the second pass APPEND to the current attempt. The
    // whole-object retry budget: pre-existing first-pass attempts count as
    // consumed slots (a mid-object crash consumed one); targeted retries and
    // the second pass start with a fresh budget (Apex resets Retry_Count__c
    // at second-pass entry, DDQ L3037 — and the design separates the MAX-5
    // targeted budget from the MAX-2 whole-object budget, unlike the Apex
    // shared Retry_Count__c counter; design-authorized divergence).
    const currentAttempt = this.io.store.maxObjectAttempt(this.runId, obj.objectName)
    let attempt =
      kind === 'first' || kind === 'junction' ? currentAttempt + 1 : Math.max(currentAttempt, 0)
    let retriesUsed = kind === 'first' || kind === 'junction' ? Math.max(currentAttempt + 1, 0) : 0
    let passKind = kind
    let pass = retryPass
    for (;;) {
      this.checkCancel()
      try {
        const executor =
          passKind === 'junction'
            ? this.passes.junctionPass
            : passKind === 'second'
              ? this.passes.secondPass
              : passKind === 'retry'
                ? this.passes.retryPass
                : this.passes.firstPass
        await executor({
          runId: this.runId,
          object: obj,
          passKind,
          objectAttempt: Math.max(attempt, 0),
          retryPass: pass,
          io: this.io
        })
        return
      } catch (e) {
        if (isTripwire(e)) throw new TripwireSignal(e as Error)
        if (e instanceof CancelSignal) throw e
        const detail = errorDetail(e)
        this.io.store.clearRetryQueue(this.runId, obj.objectName)
        if (retriesUsed < MAX_OBJECT_RETRIES) {
          retriesUsed++
          this.log(
            'Warning',
            `Deployment errored for ${obj.objectName}: ${detail}` +
              ` — retrying whole object (attempt ${retriesUsed} of ${MAX_OBJECT_RETRIES})`
          )
          // A failed retry drain re-runs the object FRESH (Apex nulled the
          // pending queue and reset to Pending, DDQ L125-132); a second-pass
          // rerun stays second (pass-2 rows never touch counters).
          if (passKind === 'retry') {
            passKind = obj.isJunction ? 'junction' : 'first'
            pass = 0
          }
          if (passKind === 'first' || passKind === 'junction') {
            attempt = this.io.store.maxObjectAttempt(this.runId, obj.objectName) + 1
          }
          continue
        }
        this.log(
          'Error',
          `Deployment failed for ${obj.objectName} after ${retriesUsed} whole-object retries: ${detail}`
        )
        this.failedObjects.add(obj.objectName)
        return
      }
    }
  }

  // ── Teardown funnel (§1.4 — every exit path lands here) ─────

  async teardown(outcome: RunOutcome): Promise<RunOutcome> {
    // Persist the outcome at ENTRY (once): a resume re-enters teardown with
    // the ORIGINAL outcome — never 'completed'-by-default — so a cancelled or
    // tripwired run crashed mid-teardown cannot activate contracts, and a
    // stale walk resume point can never route past this marker.
    const run = this.io.store.getRun(this.runId)
    if (run?.teardownOutcome != null) {
      outcome = run.teardownOutcome
    } else {
      this.io.store.setTeardownOutcome(this.runId, outcome)
    }
    try {
      if (!run?.finalizeDone) {
        this.phase('Finalizing')
        if (this.passes.finalize) await this.passes.finalize(this.runId, this.io, outcome)
        // Contracts activated + guard disarmed exactly once — a resume after
        // a crash here goes straight to restore.
        this.io.store.markFinalizeDone(this.runId)
      }
      this.phase('RestoringAutomation')
      if (this.passes.restoreAutomation) {
        await this.passes.restoreAutomation(this.runId, this.io, outcome)
      }
    } catch (e) {
      // A failed RESTORE is worse than a failed deploy: park the run STALLED
      // (recoverable — the persisted teardown marker re-enters here on
      // resume) instead of a terminal Failed that would strand the target's
      // automation disabled behind a locked terminal phase.
      this.log('Error', `Teardown error: ${errorDetail(e)}`)
      this.phase('Stalled')
      return 'failed'
    }
    // S50 (A1 ride-along): the summary used to run ONLY for 'completed', so a
    // tripwire abort — and now a root-failure abort — emitted no failure
    // roll-up and no skip summary on precisely the runs where the user most
    // needs them. It is a read-only pass over the store; 'cancelled' is still
    // excluded because a cancelled run's counters are mid-flight by definition.
    if (outcome === 'completed' || outcome === 'failed') this.emitTerminalSummary()
    this.phase(outcome === 'completed' ? 'Completed' : outcome === 'cancelled' ? 'Cancelled' : 'Failed')
    return outcome
  }

  /**
   * Apex terminal summary (DDQ L3070-3090). Whole-object exhaustion may have
   * recorded no rows at all — Apex forced Records_Failed = Source_Record_Count
   * or 1 "so the terminal summary reports this object" (DDQ L144-149); here
   * the exhausted set contributes the same fallback counts.
   */
  private emitTerminalSummary(): void {
    const counters = this.io.store.objectCounters(this.runId)
    let totalLeft = 0
    const persistent: string[] = []
    const reported = new Set<string>()
    for (const c of counters) {
      if (c.recordsFailed <= 0) continue
      reported.add(c.objectApiName)
      totalLeft += c.recordsFailed
      const attempt = this.io.store.maxObjectAttempt(this.runId, c.objectApiName)
      const retries =
        this.retryState.get(c.objectApiName)?.retryCount ??
        this.io.store.maxRetryPass(this.runId, c.objectApiName, attempt)
      persistent.push(`${c.objectApiName} (${c.recordsFailed} after ${retries} retries)`)
    }
    for (const obj of this.objects) {
      if (!this.failedObjects.has(obj.objectName) || reported.has(obj.objectName)) continue
      const failed = obj.recordCount > 0 ? obj.recordCount : 1
      totalLeft += failed
      const retries = this.retryState.get(obj.objectName)?.retryCount ?? 0
      persistent.push(`${obj.objectName} (${failed} after ${retries} retries)`)
    }
    if (persistent.length === 0) {
      this.log('Info', 'Deployment completed successfully.')
      this.emitSkipSummary()
      this.emitOrphanSummary()
      return
    }
    this.log(
      'Warning',
      `Deployment completed with ${totalLeft} persistent failures: ${persistent.join(', ')}`
    )
    this.emitSkipSummary()
    this.emitOrphanSummary()
  }

  /**
   * S49 (BUG-1 pt3) — the skip roll-up.
   *
   * Skips are deliberate, correct outcomes, and S49 added several classes of
   * them (`unique_constraint_collision`, `pbe_missing_on_target`,
   * `referenced_parent_out_of_scope`). The per-record rows were always
   * persisted with their reasons, but the terminal summary never mentioned
   * them — so a run that reported "completed successfully" could silently have
   * dropped 370 records, and the only way to find out was to open the database.
   * Run 4 was exactly that: 942 queried / 572 deployed / 0 failed / 370 skipped.
   *
   * Emitted for BOTH terminal shapes: a clean run needs this line most.
   */
  private emitSkipSummary(): void {
    const skips = this.io.store.skipReasonCounts(this.runId)
    if (skips.length === 0) return
    const total = skips.reduce((sum, s) => sum + s.count, 0)
    const parts = skips.map((s) => `${s.reason}=${s.count}`)
    this.log('Info', `${total} record(s) skipped: ${parts.join(', ')}`)
  }

  /**
   * S50 (A5) — the orphan roll-up.
   *
   * `stripMissingParentRefs` drops a lookup whose parent is not on target so
   * the row still deploys. For a REQUIRED lookup that is loud and self-healing.
   * For a NILLABLE one the row deploys with a null FK and nothing ever
   * re-links it, so the deployment silently contains records detached from the
   * thing the user asked to deploy.
   *
   * Run 9 (express scripts, 2026-09-07) is the case: the root Account failed
   * and 249 Contacts + 18 Opportunities + 5 Quotes landed with no account link
   * while the run reported Completed. A1's root gate now prevents that
   * particular shape, but a NON-root parent failing produces the same thing on
   * a smaller scale, and there was no way to enumerate it afterwards.
   *
   * Emitted after the retry rounds have drained, so "did the parent land?" is
   * a settled question. That split is the actionable half: a parent that DID
   * land means re-running relinks the children; one that never landed means
   * the scope needs widening.
   *
   * Reporting only — it changes no deploy decision.
   */
  private emitOrphanSummary(): void {
    const groups = this.io.store.orphanedLinkSummary(this.runId)
    if (groups.length === 0) return
    const total = groups.reduce((sum, g) => sum + g.count, 0)
    const relinkable = groups.reduce((sum, g) => sum + g.parentLandedCount, 0)
    const parts = groups.map(
      (g) => `${g.objectApiName}.${g.fieldName} → ${g.refObject} (${g.count})`
    )
    this.log(
      'Warning',
      `${total} record(s) deployed WITHOUT a parent link because the parent was not on ` +
        `target: ${parts.join(', ')}. ` +
        (relinkable > 0
          ? `${relinkable} of those parents DID land later in this run — re-run to link them.`
          : 'None of those parents landed; widen the scope to include them.')
    )
  }

  // ── Small helpers ───────────────────────────────────────────

  private countersFor(objectName: string): ObjectCounters | undefined {
    return this.io.store.objectCounters(this.runId).find((c) => c.objectApiName === objectName)
  }

  private checkCancel(): void {
    if (this.opts.signal?.aborted || this.io.store.isCancelRequested(this.runId)) {
      throw new CancelSignal()
    }
  }

  private phase(p: Parameters<typeof transition>[2]): void {
    transition(this.io.store, this.runId, p)
    this.io.emit({ kind: 'phase', data: { runId: this.runId, phase: p } })
  }

  log(level: 'Info' | 'Warning' | 'Error', message: string): void {
    this.io.emit({ kind: 'log', data: { runId: this.runId, level, message } })
  }

  private emitProgress(value: number, max: number, label: string): void {
    this.io.emit({ kind: 'progress', data: { runId: this.runId, value, max, label } })
  }
}
