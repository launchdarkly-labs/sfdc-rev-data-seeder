import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { DeployRunStateView, JobSummary } from '../../../shared/types'
import { canDeleteDeployment, canEditPlan, isDeployBusy } from '../../../shared/wizard'
import {
  AUTOMATION_BORN_GUIDANCE,
  CPQ_UNCHECK_REMINDER,
  EXT_ID_REFUSAL_MARKER,
  MANUAL_RESTORE_STEPS,
  PRE_RUN_UNKEYED_GUIDANCE,
  RUN_LOG_POINTER,
  STALLED_NEXT_STEP,
  STALLED_TEARDOWN_MESSAGE,
  STRANDED_RUN_MESSAGE
} from '../../../shared/recoveryCopy'
import { callIpc, toRdsError } from '../ipc/client'
import { useJobsStore, useLatestJobForDeployment } from '../store/jobs'
import { Badge, type BadgeTone } from '../ui/Badge'
import { useConfirm } from '../ui/ConfirmDialog'
import { ProgressBar } from '../ui/ProgressBar'
import { useToast } from '../ui/Toast'

/**
 * Deployment detail — the S46 D5 MINIMAL slice of the 5C.1 monitor.
 *
 * What it must do (the first live deploy failed INVISIBLY without it): show
 * the deployment's mirrored status and full error text from the persisted
 * row, so a failure survives navigation and relaunch; show the live job's
 * phase/progress with a Cancel that reaches the run; and never promise a
 * recovery that does not exist (E2 text: manual Setup steps instead).
 *
 * Data: one `deployRunState` read (persisted truth), re-read — debounced — on
 * every change of this deployment's live deploy job in the renderer job store
 * (event-driven; no polling interval). The log pane / per-object status /
 * results grid are 5C.1-full (D4/D5-full) and deliberately absent here.
 */

const REFETCH_DEBOUNCE_MS = 400

/**
 * Backstop cadence for the run's long tail (UI-4). Deliberately slow: one
 * `deployRunState` read, whose counter views are 25 ms since migration 007.
 */
const TAIL_POLL_MS = 3000

const TERMINAL_PHASES = new Set(['Completed', 'Failed', 'Cancelled'])

/**
 * Phases after all data work is done. No object is being deployed, so naming
 * one is a lie; and a cancel here is the one that can strand the target with
 * automation disabled — the exact state `deploy.start` later refuses to deploy
 * over.
 */
const TEARDOWN_PHASES = new Set(['Finalizing', 'RestoringAutomation'])

export function statusTone(status: string): BadgeTone {
  if (status === 'Completed') return 'success'
  if (status === 'Failed' || status === 'Stalled') return 'danger'
  if (isDeployBusy(status)) return 'accent'
  if (status === 'Cancelled') return 'neutral'
  return 'neutral'
}

/** First line of an error, for compact places. */
export function firstLine(text: string, max = 200): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

export function DeploymentDetailPage(): React.JSX.Element {
  const { id } = useParams()
  const deploymentId = Number(id)
  const validId = Number.isInteger(deploymentId) && deploymentId > 0

  const [state, setState] = useState<DeployRunStateView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!validId) return
    try {
      const next = await callIpc(() => window.rds.deployRunState(deploymentId))
      setState(next)
      setError(null)
    } catch (e) {
      setError(toRdsError(e).message)
    }
  }, [deploymentId, validId])

  // S52 F4 — delete (guarded main-side; see canDeleteDeployment). Confirm first;
  // nothing in either org is touched by a delete.
  const navigate = useNavigate()
  const confirm = useConfirm()
  const toast = useToast()
  const deleteDeployment = async (): Promise<void> => {
    const name = state?.deployment.name ?? `deployment ${deploymentId}`
    const ok = await confirm({
      title: `Delete "${name}"?`,
      message: 'This removes the local deployment and its plan. Nothing in either org is changed.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    try {
      await callIpc(() => window.rds.draftDelete(deploymentId))
      toast(`Deleted "${name}"`, 'success')
      navigate('/')
    } catch (e) {
      setError(toRdsError(e).message)
    }
  }

  // Re-hydrate the job store on mount so a cold-opened page (reload, deep
  // link) re-attaches to a deploy job started earlier — a job known only from
  // its events is a bare stub that useLatestJobForDeployment never matches.
  useEffect(() => {
    void useJobsStore.getState().refresh()
  }, [deploymentId])

  // Live job (renderer store, fed by the single job-event stream). Any change
  // to it — status, phase, progress — schedules one debounced re-read of the
  // persisted state, so status/counters/error track the run without polling.
  const liveJob = useLatestJobForDeployment(deploymentId, 'deploy')
  // `label` is part of the key: a progress event that advances only its label
  // (which is what per-item restore progress looks like) must still invalidate.
  const jobKey = liveJob
    ? `${liveJob.id}|${liveJob.status}|${liveJob.phase ?? ''}|${liveJob.progress?.value ?? ''}/${liveJob.progress?.max ?? ''}|${liveJob.progress?.label ?? ''}`
    : ''
  useEffect(() => {
    let cancelled = false
    const t = setTimeout(
      () => {
        if (!cancelled) void load()
      },
      jobKey === '' ? 0 : REFETCH_DEBOUNCE_MS
    )
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [load, jobKey])

  // UI-4 backstop. `jobKey` changes only on a phase transition or a progress
  // event, and `emitProgress` has exactly ONE call site — the first-pass walk
  // (orchestrator.ts:335). The second pass, Finalizing and the ~340-item
  // automation restore therefore emit nothing that invalidates it, so the
  // persisted view froze for minutes at a time and showed a stale phase and a
  // stale current object while the run was elsewhere. Event-driven refresh
  // stays the fast path; this only guarantees a floor. It is the least elegant
  // fix and the most robust: a future long phase that forgets to emit cannot
  // reintroduce the freeze.
  const jobIsRunning = (liveJob ?? state?.job)?.status === 'running'
  useEffect(() => {
    if (!jobIsRunning) return
    const t = setInterval(() => void load(), TAIL_POLL_MS)
    return () => clearInterval(t)
  }, [jobIsRunning, load])

  if (!validId) {
    return (
      <>
        <h1>Deployment</h1>
        <p className="sub">No deployment matches &ldquo;{id}&rdquo;.</p>
      </>
    )
  }
  if (error && !state) {
    return (
      <>
        <h1>Deployment {deploymentId}</h1>
        <div className="banner">
          {error}{' '}
          <button className="btn" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </>
    )
  }
  if (!state) {
    return (
      <>
        <h1>Deployment {deploymentId}</h1>
        <p className="muted">Loading…</p>
      </>
    )
  }

  const { deployment, run, counters, objects } = state
  const status = deployment.status
  // Prefer the renderer's live summary (it moves first); fall back to the
  // snapshot main attached so a cold-loaded page still shows the job.
  const job: JobSummary | null = liveJob ?? state.job
  const jobRunning = job?.status === 'running'
  const phase = run?.phase ?? job?.phase ?? null
  const inTeardown = phase != null && TEARDOWN_PHASES.has(phase)

  const preRunFailure = run == null && status === 'Failed'
  // S52 F2: a role refusal is fixed on the Orgs step, not in mappings/fields.
  const roleRefusal = /cannot be a deploy target/.test(deployment.errorMessage ?? '')
  // S53 (item 3): an unusable upsert key is fixed on the Readiness step.
  const extIdRefusal = (deployment.errorMessage ?? '').includes(EXT_ID_REFUSAL_MARKER)
  // S53 (item 1): the run's automation audit.
  const audit = state.audit
  const automationBorn = audit?.findings.filter((f) => f.kind === 'automation_born') ?? []
  const preRunUnkeyed = audit?.findings.filter((f) => f.kind === 'pre_run_unkeyed') ?? []
  const auditClean = audit != null && audit.completedAt != null && automationBorn.length === 0
  // S52 F4: pre-run Failed/Cancelled (nothing touched the target) + Draft/Planned/
  // Stalled are deletable; main re-checks (incl. the unconfirmed-ledger guard).
  const deletable = !jobRunning && canDeleteDeployment(status, false, run != null).ok
  const preRunCancelled = run == null && status === 'Cancelled'
  const preRunInterrupted = run == null && isDeployBusy(status) && !jobRunning
  const stalled = run?.phase === 'Stalled'
  const stranded = run != null && !stalled && !TERMINAL_PHASES.has(run.phase) && !jobRunning
  const finishedRun = run != null && TERMINAL_PHASES.has(run.phase)

  return (
    <>
      <div className="wizard-head">
        <h1>{deployment.name}</h1>
        <p className="sub">
          {deployment.sourceLabel} → {deployment.targetLabel} ·{' '}
          <Badge tone={statusTone(status)}>{status}</Badge>
          {phase && phase !== status && <span className="muted"> · phase: {phase}</span>}
          {run?.currentObject && !finishedRun && !inTeardown && (
            <span className="muted">
              {' '}
              · {run.currentObject}
              {run.currentPass ? ` (${run.currentPass} pass)` : ''}
            </span>
          )}
        </p>
        {deletable && (
          <div className="toolbar">
            <button className="btn danger" onClick={() => void deleteDeployment()}>
              Delete deployment
            </button>
          </div>
        )}
      </div>

      {jobRunning && job && (
        <div className="job-card">
          <div className="job-card-head">
            <span>
              {job.title}
              {job.phase ? ` — ${job.phase}` : ''}
            </span>
            {/*
             * Cancel is withdrawn once teardown starts. There is nothing left
             * to cancel — the data passes are done and `checkCancel` is only
             * consulted at batch boundaries — while interrupting the restore is
             * the one action that can leave the target's automation disabled.
             */}
            <button
              className="btn"
              disabled={run?.cancelRequested === true || inTeardown}
              onClick={() => void window.rds.jobCancel(job.id)}
              title={
                inTeardown
                  ? 'Automation is being restored — interrupting it is the one thing that could leave the target disabled.'
                  : 'Stops at the next batch boundary, then restores automation and audits the run. ' +
                    'Records already written stay on the target; a later re-run updates them in place.'
              }
            >
              {inTeardown
                ? 'Restoring — cannot cancel'
                : run?.cancelRequested
                  ? 'Cancel requested…'
                  : 'Cancel'}
            </button>
          </div>
          {job.progress && (
            <ProgressBar
              value={job.progress.value}
              max={job.progress.max}
              label={job.progress.label}
            />
          )}
          {run?.cancelRequested && (
            <p className="muted">
              Stopping at the next batch boundary; automation restore still runs afterwards.
            </p>
          )}
        </div>
      )}

      {preRunFailure && (
        <div className="banner" role="alert">
          <strong>Deploy did not start.</strong> The target org was not changed — the plan was
          refused before any automation was touched or any record written.
          {deployment.errorMessage && <pre className="error-text">{deployment.errorMessage}</pre>}
          {roleRefusal ? (
            <p>
              <Link to={`/deployments/${deploymentId}/wizard/orgs`}>Open the Orgs step</Link> — it
              shows both connections' roles and assigns the missing one in a click; then deploy
              again from the plan.
            </p>
          ) : extIdRefusal ? (
            <p>
              <Link to={`/deployments/${deploymentId}/wizard/readiness`}>
                Open the Readiness step
              </Link>{' '}
              — Provision creates the missing External ID field(s) and grants the connected user
              access to them; then deploy again from the plan.
            </p>
          ) : (
            <p>
              <Link to={`/deployments/${deploymentId}/wizard/plan`}>Back to plan</Link> — fix the
              mappings or fields it names, then deploy again.
            </p>
          )}
        </div>
      )}

      {preRunCancelled && (
        <div className="banner warn">
          Cancelled before the run started — the target org was not changed.{' '}
          <Link to={`/deployments/${deploymentId}/wizard/plan`}>Back to plan</Link>.
        </div>
      )}

      {preRunInterrupted && (
        <div className="banner warn">
          Recorded as {status.toLowerCase()} but no deploy job is running in this session — the app
          was closed during connect / gates / freeze. Nothing was changed on the target. Relaunch
          the app: startup reconciliation marks this attempt Failed with that note, and the Plan
          step reopens for another deploy.
        </div>
      )}

      {stalled && (
        <div className="banner" role="alert">
          <strong>Teardown stalled.</strong> {STALLED_TEARDOWN_MESSAGE}
          <RestoreSteps />
        </div>
      )}

      {stranded && (
        <div className="banner" role="alert">
          <strong>Run interrupted.</strong> {STRANDED_RUN_MESSAGE}
          <RestoreSteps />
        </div>
      )}

      {finishedRun && status === 'Failed' && (
        <div className="banner" role="alert">
          <strong>Deployment failed.</strong>
          {deployment.errorMessage && <pre className="error-text">{deployment.errorMessage}</pre>}
        </div>
      )}
      {finishedRun && status === 'Completed' && (
        <div className="banner ok">
          <strong>Deployment completed.</strong>{' '}
          {counters && counters.recordsFailed > 0
            ? `${counters.recordsFailed} record(s) still failed after retries — ${RUN_LOG_POINTER}`
            : 'All records deployed.'}
          {auditClean && ' No records were created by target-org automation during this run.'}
        </div>
      )}

      {/*
       * S53 (item 1) — the re-run duplicate class. Rows the TARGET's own automation created
       * during the run (created in the run window by the deploying user, no RDS
       * key). The upsert never sees them, so a re-run neither updates nor removes
       * them; the operator has to know, and has to know WHICH rows.
       */}
      {automationBorn.length > 0 && (
        <div className="banner" role="alert">
          <strong>
            Target automation created{' '}
            {automationBorn.reduce((n, f) => n + f.count, 0).toLocaleString()} record
            {automationBorn.reduce((n, f) => n + f.count, 0) === 1 ? '' : 's'} during this run.
          </strong>{' '}
          {AUTOMATION_BORN_GUIDANCE}
          <ul>
            {automationBorn.map((f) => (
              <li key={f.objectApiName}>
                {f.objectApiName}: {f.count.toLocaleString()}
                {f.sampleIds.length > 0 && (
                  <span className="muted"> — e.g. {f.sampleIds.join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preRunUnkeyed.length > 0 && (
        <div className="banner warn">
          <strong>Before this run</strong> the target already held rows without the RDS key under
          RDS-keyed parents:{' '}
          {preRunUnkeyed
            .map((f) => `${f.objectApiName} (${f.count.toLocaleString()} under ${f.refObject})`)
            .join(', ')}
          . {PRE_RUN_UNKEYED_GUIDANCE}
        </div>
      )}

      {finishedRun && audit != null && audit.completedAt == null && (
        <p className="muted">
          The post-run automation audit did not run for this deployment
          {audit.note ? ` (${audit.note})` : ''}.
        </p>
      )}
      {audit?.note && audit.completedAt != null && (
        <p className="muted">Post-run automation audit was partial: {audit.note}.</p>
      )}
      {finishedRun && status === 'Cancelled' && (
        <div className="banner warn">
          <strong>Deployment cancelled.</strong> Records written before the cancel remain on the
          target (upserts are idempotent — re-running updates them);{' '}
          {state.restoreUnconfirmed === 0
            ? 'automation was restored.'
            : 'automation restore did not fully confirm — see below.'}
        </div>
      )}

      {state.restoreUnconfirmed > 0 && (finishedRun || stalled || stranded) && (
        <div className="banner" role="alert">
          <strong>{state.restoreUnconfirmed}</strong> automation item
          {state.restoreUnconfirmed === 1 ? '' : 's'} disabled by this run{' '}
          {state.restoreUnconfirmed === 1 ? 'is' : 'are'} not confirmed restored on the target.
          {!stalled && !stranded && <RestoreSteps />}
        </div>
      )}

      {state.cpqReminder && (
        <div className="banner warn">
          <strong>CPQ:</strong> {CPQ_UNCHECK_REMINDER}
        </div>
      )}

      {counters && (
        <div className="kpi-row">
          <Kpi label="queried" value={counters.recordsQueried} />
          <Kpi label="deployed" value={counters.recordsDeployed} />
          <Kpi
            label="failed"
            value={counters.recordsFailed}
            tone={counters.recordsFailed > 0 ? 'danger' : undefined}
          />
          <Kpi label="skipped" value={counters.recordsSkipped} />
          <Kpi label="planned" value={state.totalRecords} />
        </div>
      )}

      {objects.length > 0 && (
        <table className="orgs">
          <thead>
            <tr>
              <th>#</th>
              <th>Object</th>
              <th className="num">Planned</th>
              <th className="num">Queried</th>
              <th className="num">Deployed</th>
              <th className="num">Failed</th>
              <th className="num">Skipped</th>
            </tr>
          </thead>
          <tbody>
            {objects.map((o, i) => (
              <tr key={o.objectName}>
                <td className="num">{i + 1}</td>
                <td>
                  {o.objectName} {o.isJunction && <Badge tone="accent">junction</Badge>}
                  {run?.currentObject === o.objectName && !finishedRun && jobRunning && (
                    <Badge tone="accent">current</Badge>
                  )}
                </td>
                <td className="num">{o.recordCount.toLocaleString()}</td>
                <td className="num">{o.recordsQueried.toLocaleString()}</td>
                <td className="num">{o.recordsDeployed.toLocaleString()}</td>
                <td className={o.recordsFailed > 0 ? 'num status-err' : 'num'}>
                  {o.recordsFailed.toLocaleString()}
                </td>
                <td className="num">{o.recordsSkipped.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="muted">
        Counters and per-object rows are the persisted truth for the latest run; they update live
        while a run is in progress.
      </p>

      <div className="toolbar">
        <Link className="btn" to="/">
          Home
        </Link>
        {canEditPlan(status) && (
          <Link className="btn" to={`/deployments/${deploymentId}/wizard/plan`}>
            Open plan
          </Link>
        )}
        {status === 'Stalled' && <span className="muted">{STALLED_NEXT_STEP}</span>}
      </div>
    </>
  )
}

function Kpi({
  label,
  value,
  tone
}: {
  label: string
  value: number
  tone?: 'danger'
}): React.JSX.Element {
  return (
    <div className="kpi">
      <span className={tone === 'danger' && value > 0 ? 'kpi-value status-err' : 'kpi-value'}>
        {value.toLocaleString()}
      </span>
      <span className="kpi-label">{label}</span>
    </div>
  )
}

/** The E2 manual-restore steps (shared copy — identical to the job error text). */
function RestoreSteps(): React.JSX.Element {
  return (
    <>
      <p>
        Restore the target&rsquo;s automation manually, in this order. The app&rsquo;s ledger
        (automation_ledger_mirror in the app database) lists exactly which items it disabled.
      </p>
      <ol className="restore-steps">
        {MANUAL_RESTORE_STEPS.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </>
  )
}
