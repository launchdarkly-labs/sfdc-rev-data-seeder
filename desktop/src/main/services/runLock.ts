/**
 * S53 (item 2) — the deploy run lock, per TARGET ORG.
 *
 * `rds:deploy.start` used to lock per DEPLOYMENT: one running job, one live
 * run and one unconfirmed-restore check, all scoped to the deployment being
 * started. Two deployments aimed at the same target org therefore passed every
 * gate and could run at once — and the automation subsystem is org-wide: run B
 * disables what run A already disabled (no-op), then whichever finishes first
 * RESTORES the org's automation under the other run's still-running data
 * passes (the "wreck each other's automation restore" shape,
 * [[gotcha_deploy_run_lock_per_deployment]]). Likewise a stranded run of
 * deployment A (Stalled, or restore unconfirmed) left the target's automation
 * disabled, and deployment B into the same org sailed past.
 *
 * This module is the PURE decision: given the state of every other deployment
 * that shares the target org (same connection org id — which also covers a
 * superseded alias, S52 F3: `onesolve` and `one_solve` are one org), name the
 * conflict or return null. The store resolves "shares the target org"
 * (Store.deploymentsSharingTarget); ipc.ts assembles the candidates. Priority:
 * a job running right now beats a recorded live run beats an unconfirmed
 * restore — the first is the one that can still be waited out.
 *
 * Pure: no sqlite, no Electron.
 */
import type { RunPhase } from '../engine/deploy/types'

export interface TargetLockCandidate {
  deploymentId: number
  name: string
  /** A 'deploy' job for this deployment is running in this app session. */
  runningJob: boolean
  /** Phase of this deployment's NON-terminal run, if any (incl. 'Stalled'). */
  liveRunPhase: RunPhase | null
  /** Ledger rows of this deployment's LAST run still awaiting a confirmed restore. */
  unconfirmedRestore: number
}

/**
 * The refusal message for the first conflicting sibling, or null when the
 * target org is free. `targetLabel` is the connection label the user sees.
 */
export function targetLockConflict(
  candidates: ReadonlyArray<TargetLockCandidate>,
  targetLabel: string
): string | null {
  const who = (c: TargetLockCandidate): string => `Deployment "${c.name}" (#${c.deploymentId})`

  const running = candidates.find((c) => c.runningJob)
  if (running != null) {
    return (
      `${who(running)} is deploying into ${targetLabel} right now — wait for it to finish. ` +
      'Two runs against one target org would disable and restore each other’s automation.'
    )
  }
  const live = candidates.find((c) => c.liveRunPhase != null)
  if (live != null) {
    return (
      `${who(live)} has a run recorded as ${live.liveRunPhase} against ${targetLabel} — its ` +
      'automation may still be disabled there. Restore it (steps on that deployment’s page) ' +
      'before deploying into this org.'
    )
  }
  const unconfirmed = candidates.find((c) => c.unconfirmedRestore > 0)
  if (unconfirmed != null) {
    const n = unconfirmed.unconfirmedRestore
    return (
      `${who(unconfirmed)} ended with ${n} automation item${n === 1 ? '' : 's'} not confirmed ` +
      `restored on ${targetLabel}. Restore ${n === 1 ? 'it' : 'them'} (steps on that ` +
      'deployment’s page) before deploying into this org.'
    )
  }
  return null
}
