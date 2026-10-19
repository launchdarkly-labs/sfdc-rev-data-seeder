/**
 * S62 (U-2) — pure rules for the stages of a composed deployment (templates run as steps of a
 * deployment). The driver is ipc/deployRuns.ts; these are the two decisions it makes per stage,
 * kept Electron-free so they are unit-tested.
 */
import type { DeployStageState } from './types'

/** A template stage's terminal word from its run report's state. Anything unknown is a failure. */
export function stageStateOf(state: string): Exclude<DeployStageState, 'pending' | 'running'> {
  switch (state) {
    case 'clean':
    case 'partial':
    case 'failed':
    case 'blocked':
    case 'cancelled':
      return state
    default:
      return 'failed'
  }
}

/** The stop rule: only a clean or partial stage lets the sequence continue. */
export function stageAllowsContinue(state: DeployStageState): boolean {
  return state === 'clean' || state === 'partial'
}

/** The data stage's word from the run's counters: any failed record makes it partial, never failed (it finished). */
export function dataStageState(recordsFailed: number): 'clean' | 'partial' {
  return recordsFailed > 0 ? 'partial' : 'clean'
}
