/**
 * S47 — the deploy ATTEMPT's main-side glue, extracted from the rds:deploy.start
 * / rds:job.cancel closures so it is testable in the sqlite lane (review F3:
 * the D1/D3 decision logic had zero tests):
 *
 *  - closeOutAttempt: which `deployments.status` / `error_message` writer runs
 *    when the job throws, depending on whether a run row exists yet (D1).
 *  - bridgeCancel: the jobId → runId cancel bridge (D3).
 *  - runFailureMessage / stalledMessage: the persisted terminal texts, which
 *    now carry the LAST Error-level engine log line (review F2 — the CPQ
 *    tripwire / whole-object-exhaustion reason used to live only in a 'log'
 *    event the renderer discards).
 *
 * No Electron, no jsforce: Store + JobManager only.
 */
import { RUN_LOG_POINTER, STALLED_TEARDOWN_MESSAGE } from '../../shared/recoveryCopy'
import { transition } from '../engine/deploy/stateMachine'
import { JobCancelledError, type JobManager } from '../jobs'
import type { Store } from './store'

/**
 * Close out an attempt whose job threw.
 *  - No run row (connect / gates / freeze refused): the attempt owns its
 *    status — Failed + the FULL error text, or Cancelled (Apex DDS:219).
 *  - Run row still 'Frozen' (a throw between createRun and the orchestrator's
 *    first transition — the walk never started, nothing on the target was
 *    touched): close the run Failed/Cancelled through the state machine so the
 *    deployment is not locked forever behind a phantom live run.
 *  - Otherwise the run mirrored its own terminal status (Failed / Stalled /
 *    Cancelled via setRunPhase): record WHY without touching status.
 */
export function closeOutAttempt(
  store: Store,
  deploymentId: number,
  runId: number | null,
  err: unknown
): void {
  const message = err instanceof Error ? err.message : String(err)
  const cancelled = err instanceof JobCancelledError
  if (runId == null) {
    if (cancelled) store.markDeployCancelledBeforeRun(deploymentId)
    else store.markDeployFailedBeforeRun(deploymentId, message)
    return
  }
  const run = store.deploy.getRun(runId)
  if (run?.phase === 'Frozen') {
    transition(store.deploy, runId, cancelled ? 'Cancelled' : 'Failed')
  }
  if (!cancelled) store.setDeployErrorMessage(deploymentId, message)
}

/**
 * D3 cancel bridge: flip the job's cooperative token AND, for a RUNNING deploy
 * job, the run's persisted cancel flag — the orchestrator and executors read
 * deploy_runs.cancel_requested at each batch boundary (before this the flag had
 * no writer). Apex parity: DataSeederController:1652-1659 persisted the
 * request; DDQ:52-76 checked it per hop.
 */
export function bridgeCancel(
  store: Store,
  jobs: JobManager,
  deployRunByJob: ReadonlyMap<string, number>,
  jobId: string
): void {
  const wasRunning = jobs.get(jobId)?.status === 'running'
  jobs.cancel(jobId)
  const runId = deployRunByJob.get(jobId)
  if (wasRunning && runId != null) {
    try {
      store.deploy.requestCancel(runId)
    } catch {
      // Run row gone (deployment deleted mid-run?) — the job token still stops
      // the work at its next checkpoint; nothing more to persist.
    }
  }
}

/** Terminal text for a run that ended 'failed' (not Stalled). */
export function runFailureMessage(recordsFailed: number, lastErrorLine: string | null): string {
  const head =
    recordsFailed > 0
      ? `Deployment failed — ${recordsFailed} record(s) failed; ${RUN_LOG_POINTER}`
      : `Deployment failed — ${RUN_LOG_POINTER}`
  return lastErrorLine ? `${head}\n${lastErrorLine}` : head
}

/** Terminal text for a run parked Stalled (teardown did not complete). */
export function stalledMessage(lastErrorLine: string | null): string {
  return lastErrorLine ? `${STALLED_TEARDOWN_MESSAGE}\n${lastErrorLine}` : STALLED_TEARDOWN_MESSAGE
}
