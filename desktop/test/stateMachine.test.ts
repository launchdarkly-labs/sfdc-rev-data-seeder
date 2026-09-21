/**
 * E4E.1 — run state machine: legal-transition table, terminal lockout,
 * idempotent same-phase re-assert, single-writer persistence.
 */
import { describe, it, expect } from 'vitest'
import {
  canTransition,
  IllegalTransitionError,
  isTerminal,
  transition
} from '../src/main/engine/deploy/stateMachine'
import type { DeployRunStore, RunPhase, RunState } from '../src/main/engine/deploy/types'
import { RUN_PHASES } from '../src/main/engine/deploy/types'

function fakeStore(initial: RunPhase): { store: DeployRunStore; phases: RunPhase[] } {
  let phase = initial
  const phases: RunPhase[] = []
  const store = {
    getRun: (runId: number): RunState => ({
      id: runId,
      deploymentId: 1,
      planId: 1,
      planHash: 'h',
      phase,
      currentObject: null,
      currentPass: null,
      cancelRequested: false,
      teardownOutcome: null,
      finalizeDone: false,
      startedAt: null,
      finishedAt: null,
      createdAt: 0
    }),
    setRunPhase: (_runId: number, p: RunPhase): void => {
      phase = p
      phases.push(p)
    }
  } as unknown as DeployRunStore
  return { store, phases }
}

describe('stateMachine — transition table', () => {
  it('walks the happy path end to end', () => {
    const { store, phases } = fakeStore('Frozen')
    for (const p of [
      'DisablingAutomation',
      'Deploying',
      'Retrying',
      'Deploying',
      'SecondPass',
      'Finalizing',
      'RestoringAutomation',
      'Completed'
    ] as const) {
      transition(store, 1, p)
    }
    expect(phases.at(-1)).toBe('Completed')
  })

  it('Frozen can skip automation-disable straight to Deploying', () => {
    expect(canTransition('Frozen', 'Deploying')).toBe(true)
  })

  it('SecondPass can bounce to Retrying (Apex preserves the pass marker)', () => {
    expect(canTransition('SecondPass', 'Retrying')).toBe(true)
  })

  it('terminal phases have NO exits — recovery reopens Stalled only', () => {
    for (const terminal of ['Completed', 'Failed', 'Cancelled'] as const) {
      expect(isTerminal(terminal)).toBe(true)
      for (const to of RUN_PHASES) {
        if (to === terminal) continue
        expect(canTransition(terminal, to), `${terminal} → ${to}`).toBe(false)
      }
    }
  })

  it('any working phase can stall, and Stalled resumes into any working phase', () => {
    for (const from of [
      'Frozen',
      'DisablingAutomation',
      'Deploying',
      'Retrying',
      'SecondPass',
      'Finalizing',
      'RestoringAutomation'
    ] as const) {
      expect(canTransition(from, 'Stalled'), `${from} → Stalled`).toBe(true)
    }
    for (const to of ['Deploying', 'Retrying', 'SecondPass', 'Finalizing'] as const) {
      expect(canTransition('Stalled', to), `Stalled → ${to}`).toBe(true)
    }
    expect(canTransition('Stalled', 'Completed')).toBe(false) // must finish through teardown
  })

  it('illegal jumps throw IllegalTransitionError and persist nothing', () => {
    const { store, phases } = fakeStore('Frozen')
    expect(() => transition(store, 1, 'SecondPass')).toThrow(IllegalTransitionError)
    expect(() => transition(store, 1, 'Completed')).toThrow(/Frozen → Completed/)
    expect(phases).toEqual([])
  })

  it('same-phase transition is an idempotent no-op (resume re-assert)', () => {
    const { store, phases } = fakeStore('Deploying')
    expect(transition(store, 1, 'Deploying')).toBe('Deploying')
    expect(phases).toEqual([]) // not persisted — nothing changed
  })
})
