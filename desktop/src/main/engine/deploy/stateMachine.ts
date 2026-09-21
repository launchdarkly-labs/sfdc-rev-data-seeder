/**
 * E4E.1 — the single-writer run state machine (deployDesign §1.3).
 *
 *   Frozen → DisablingAutomation → Deploying ⇄ Retrying → SecondPass
 *          → Finalizing (contracts → guard disarm) → RestoringAutomation
 *          → Completed | Failed | Cancelled       (+ Stalled = parked, resumable)
 *
 * ONLY this module may change deploy_runs.phase once a run is live — the
 * store's setRunPhase is a legality-agnostic primitive; every caller goes
 * through transition(). This kills the Apex bug class 5 (last-writer-wins
 * field clobbering across queueable hops): one process, one writer, explicit
 * legal-transition table.
 *
 * Notes on shape:
 *  - DisablingAutomation is skippable (Frozen → Deploying) until E4A lands.
 *  - Retrying can bounce back to Deploying (the Apex retry loop re-enters
 *    per-object deploys) and can follow SecondPass (Apex preserves the pass
 *    marker: retry of a second-pass object stays second-pass).
 *  - Failed/Cancelled are reachable from any non-terminal phase — but the
 *    orchestrator routes through Finalizing → RestoringAutomation first so
 *    teardown always runs (§1.4); direct jumps exist for irrecoverable exits
 *    (e.g. the store itself is broken).
 *  - Stalled is the recovery parking state: any non-terminal phase may stall,
 *    and a stalled run may resume into any working phase (the resume point
 *    decides which), or be cancelled/failed by the recovery UI.
 *  - Terminal phases have NO exits. (Recovery reopens Stalled runs, never
 *    Completed/Failed/Cancelled ones.)
 */
import type { DeployRunStore, RunPhase } from './types'
import { TERMINAL_RUN_PHASES } from './types'

const WORKING_PHASES: readonly RunPhase[] = [
  'DisablingAutomation',
  'Deploying',
  'Retrying',
  'SecondPass',
  'Finalizing',
  'RestoringAutomation'
]

const TRANSITIONS: Readonly<Record<RunPhase, readonly RunPhase[]>> = {
  Frozen: ['DisablingAutomation', 'Deploying', 'Failed', 'Cancelled', 'Stalled'],
  DisablingAutomation: ['Deploying', 'Finalizing', 'Failed', 'Cancelled', 'Stalled'],
  Deploying: ['Retrying', 'SecondPass', 'Finalizing', 'Failed', 'Cancelled', 'Stalled'],
  Retrying: ['Deploying', 'SecondPass', 'Finalizing', 'Failed', 'Cancelled', 'Stalled'],
  SecondPass: ['Retrying', 'Finalizing', 'Failed', 'Cancelled', 'Stalled'],
  Finalizing: ['RestoringAutomation', 'Completed', 'Failed', 'Cancelled', 'Stalled'],
  RestoringAutomation: ['Completed', 'Failed', 'Cancelled', 'Stalled'],
  Stalled: [...WORKING_PHASES, 'Failed', 'Cancelled'],
  Completed: [],
  Failed: [],
  Cancelled: []
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly runId: number,
    readonly from: RunPhase,
    readonly to: RunPhase
  ) {
    super(`Run ${runId}: illegal phase transition ${from} → ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

export function canTransition(from: RunPhase, to: RunPhase): boolean {
  if (from === to) return true // idempotent re-assert (resume re-enters a phase)
  return TRANSITIONS[from].includes(to)
}

export function isTerminal(phase: RunPhase): boolean {
  return TERMINAL_RUN_PHASES.has(phase)
}

/**
 * Validate + persist a phase change. Same-phase transitions are no-ops (legal:
 * resume re-asserts the phase it parks in). Throws IllegalTransitionError on a
 * table violation and NOT_FOUND (from the store) on an unknown run.
 */
export function transition(store: DeployRunStore, runId: number, to: RunPhase): RunPhase {
  const run = store.getRun(runId)
  if (run == null) throw new Error(`Run ${runId} not found`)
  if (run.phase === to) return to
  if (!canTransition(run.phase, to)) throw new IllegalTransitionError(runId, run.phase, to)
  store.setRunPhase(runId, to)
  return to
}
