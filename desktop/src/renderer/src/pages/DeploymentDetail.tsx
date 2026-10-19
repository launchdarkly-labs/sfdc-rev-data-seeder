import { Fragment, useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type {
  DeployRunPhaseStamp,
  DeployRunStateView,
  JobSummary,
  DeployStageView,
  TextIdRelinkSummaryView
} from '../../../shared/types'
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
import { GLOSSARY, PRE_RUN_PHASES, phaseLabel } from '../../../shared/labels'
import { callIpc, toRdsError } from '../ipc/client'
import { useGuardedRefresh } from '../ipc/guardedRefresh'
import { useJobsStore, useLatestJobForDeployment } from '../store/jobs'
import { fmtDuration } from './templates/templateUi'
import { Badge, type BadgeTone } from '../ui/Badge'
import { CancelJobButton } from '../ui/CancelJobButton'
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
 * every change of this deployment's live deploy job in the renderer job store,
 * with a 3 s floor while the job runs (UI-4); both go through one guarded
 * path (`useGuardedRefresh`, S64 P5). The log pane / per-object status /
 * results grid are 5C.1-full (D4/D5-full) and deliberately absent here.
 */

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
  // S64 (P3, ux F-6): when the persisted view was last read, and a once-a-second clock
  // (ticking only while a job runs) for the "updated Ns ago" stamp.
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

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
  // to it — status, phase, progress — requests one debounced re-read of the
  // persisted state, so status/counters/error track the run (the fast path).
  const liveJob = useLatestJobForDeployment(deploymentId, 'deploy')
  // `label` is part of the key: a progress event that advances only its label
  // (which is what per-item restore progress looks like) must still invalidate.
  const jobKey = liveJob
    ? `${liveJob.id}|${liveJob.status}|${liveJob.phase ?? ''}|${liveJob.progress?.value ?? ''}/${liveJob.progress?.max ?? ''}|${liveJob.progress?.label ?? ''}`
    : ''

  // UI-4 backstop. `jobKey` changes only on a phase transition or a progress
  // event, and `emitProgress` has exactly ONE call site — the first-pass walk
  // (orchestrator.ts:335). The second pass, Finalizing and the ~340-item
  // automation restore therefore emit nothing that invalidates it, so the
  // persisted view froze for minutes at a time and showed a stale phase and a
  // stale current object while the run was elsewhere. Event-driven refresh
  // stays the fast path; the poll only guarantees a floor. It is the least
  // elegant fix and the most robust: a future long phase that forgets to emit
  // cannot reintroduce the freeze. Both paths share the guarded `load` (P5 5.4).
  const jobIsRunning = (liveJob ?? state?.job)?.status === 'running'
  const onLoaded = useCallback((next: DeployRunStateView): void => {
    setState(next)
    setError(null)
    setLoadedAt(Date.now())
  }, [])
  const load = useGuardedRefresh<DeployRunStateView>({
    key: deploymentId,
    enabled: validId,
    fetch: () => window.rds.deployRunState(deploymentId),
    onLoaded,
    onError: setError,
    jobKey,
    polling: jobIsRunning
  })
  useEffect(() => {
    if (!jobIsRunning) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [jobIsRunning])

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
          <button className="btn" onClick={load}>
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
  // S63: the text-Id relink roll-up (fields that hold record Ids as TEXT, relinked after the load).
  const relinks = state.textIdRelinks ?? []
  const relinkTotals = relinks.reduce(
    (acc, r) => ({ relinked: acc.relinked + r.relinked, unresolved: acc.unresolved + r.unresolved + r.failed }),
    { relinked: 0, unresolved: 0 }
  )
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
  // F-3: the job is live but no run row exists yet — the engine is connecting, checking
  // gates and freezing the plan, and has emitted no phase of its own.
  const preRunChecklist = jobRunning && run == null
  const hasJunction = objects.some((o) => o.isJunction)
  const secondsAgo = loadedAt == null ? null : Math.max(0, Math.round((now - loadedAt) / 1000))

  return (
    <>
      <div className="wizard-head">
        <h1>{deployment.name}</h1>
        <p className="sub">
          {deployment.sourceLabel} → {deployment.targetLabel} ·{' '}
          <Badge tone={statusTone(status)}>{status}</Badge>
          {phase && phase !== status && (
            <span className="muted" title={phase}>
              {' '}
              · phase: {phaseLabel(phase)}
            </span>
          )}
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
              {job.phase ? ` — ${phaseLabel(job.phase)}` : ''}
              {secondsAgo != null && (
                <span className="muted last-updated" data-testid="last-updated">
                  {' '}
                  · updated {secondsAgo}s ago
                </span>
              )}
            </span>
            {/*
             * Cancel is withdrawn once teardown starts. There is nothing left
             * to cancel — the data passes are done and `checkCancel` is only
             * consulted at batch boundaries — while interrupting the restore is
             * the one action that can leave the target's automation disabled.
             * A-9: the reason is visible helper text, not only a `title`.
             */}
            {inTeardown ? (
              <CancelJobButton
                jobId={job.id}
                label="Restoring — cannot cancel"
                disabled
                helper="Automation is being restored — interrupting it is the one thing that could leave the target disabled."
              />
            ) : run?.cancelRequested ? (
              <CancelJobButton
                jobId={job.id}
                label="Cancel requested…"
                disabled
                helper="Stopping at the next batch boundary; automation restore still runs afterwards."
              />
            ) : (
              <CancelJobButton
                jobId={job.id}
                helper="Stops at the next batch, then restores automation and audits the run. Records already written stay on the target."
              />
            )}
          </div>
          {job.progress && (
            <ProgressBar
              value={job.progress.value}
              max={job.progress.max}
              label={job.progress.label}
            />
          )}
          {preRunChecklist && (
            <ol className="prerun-steps" aria-label="Before the run starts" data-testid="prerun-phases">
              {PRE_RUN_PHASES.map((p) => (
                <li key={p}>
                  <span className="prerun-mark" aria-hidden="true">
                    …
                  </span>
                  {p}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {/* S64 P5 (5.1): where the run's time went, from the persisted phase stamps (migration 014). */}
      {run && (
        <PhaseStrip
          phases={run.phases}
          finishedAt={run.finishedAt}
          now={now}
          running={jobRunning}
          peakMemoryMB={run.peakMemoryMB}
        />
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
              — it creates the missing External Id field(s) and grants the connected user
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
          <strong>Before this run</strong> the target already held rows without this app&rsquo;s
          External Id under parents that have it:{' '}
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
          target (re-running updates the same rows);{' '}
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

      {(state.stages?.length ?? 0) > 0 && <StagesStrip stages={state.stages!} />}

      {/* T-8: planned first, then the run's funnel; every tile says what it counts. */}
      {counters && (
        <div className="kpi-row">
          <Kpi label="Planned" value={state.totalRecords} hint={GLOSSARY.planned} />
          <Kpi label="Queried" value={counters.recordsQueried} hint={GLOSSARY.queried} />
          <Kpi label="Deployed" value={counters.recordsDeployed} hint={GLOSSARY.deployed} />
          <Kpi
            label="Failed"
            value={counters.recordsFailed}
            tone={counters.recordsFailed > 0 ? 'danger' : undefined}
            hint={GLOSSARY.failed}
          />
          <Kpi label="Skipped" value={counters.recordsSkipped} hint={GLOSSARY.skipped} />
          {(counters.recordsAlreadyOnTarget ?? 0) > 0 && (
            <Kpi label="Already on target" value={counters.recordsAlreadyOnTarget ?? 0} hint={GLOSSARY.alreadyOnTarget} />
          )}
          {relinkTotals.relinked > 0 && <Kpi label="Relinked" value={relinkTotals.relinked} hint={GLOSSARY.relinked} />}
          {relinkTotals.unresolved > 0 && (
            <Kpi label="Unresolved Ids" value={relinkTotals.unresolved} tone="danger" hint={GLOSSARY.unresolved} />
          )}
        </div>
      )}

      {objects.length > 0 && (
        <table className="orgs run-objects">
          <thead>
            <tr>
              <th>#</th>
              <th>Object</th>
              <th className="num">Planned</th>
              <th className="num">Queried</th>
              <th className="num">Deployed</th>
              <th className="num">Failed</th>
              <th className="num">Skipped</th>
              {jobRunning && !finishedRun && <th>Progress</th>}
            </tr>
          </thead>
          <tbody>
            {objects.map((o, i) => {
              const current = run?.currentObject === o.objectName && !finishedRun && jobRunning
              const handled = o.recordsDeployed + o.recordsFailed + o.recordsSkipped
              return (
              <tr key={o.objectName} className={current ? 'current' : undefined} aria-current={current ? 'step' : undefined}>
                <td className="num">{i + 1}</td>
                <td>
                  {o.objectName}{' '}
                  {o.isJunction && (
                    <span className="badge badge-accent" title={GLOSSARY.junction}>
                      junction
                    </span>
                  )}
                  {current && <Badge tone="accent">current</Badge>}
                </td>
                <td className="num">{o.recordCount.toLocaleString()}</td>
                <td className="num">{o.recordsQueried.toLocaleString()}</td>
                <td className="num">
                  {o.recordsDeployed.toLocaleString()}
                  {(o.recordsAlreadyOnTarget ?? 0) > 0 && !o.isJunction && (
                    <span className="muted already-note"> ({o.recordsAlreadyOnTarget} already on target)</span>
                  )}
                </td>
                <td className={o.recordsFailed > 0 ? 'num status-err' : 'num'}>
                  {o.recordsFailed.toLocaleString()}
                </td>
                <td className="num">
                  {o.recordsSkipped.toLocaleString()}
                  {(o.recordsAlreadyOnTarget ?? 0) > 0 && o.isJunction && (
                    <span className="muted already-note"> ({o.recordsAlreadyOnTarget} already on target)</span>
                  )}
                </td>
                {jobRunning && !finishedRun && (
                  <td className="mini-progress">
                    <MiniBar done={handled} total={o.recordCount} />
                  </td>
                )}
              </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {hasJunction && (
        <p className="muted legend">
          <span className="badge badge-accent">junction</span> {GLOSSARY.junction}
        </p>
      )}

      {relinks.length > 0 && <RelinkTable rows={relinks} />}

      <p className="muted">
        Counters and per-object rows are the persisted truth for the latest run; they update live
        while a run is in progress.
      </p>

      <div className="toolbar">
        <Link className="btn" to="/">
          Home
        </Link>
        {finishedRun && counters && counters.recordsFailed > 0 && (
          <button
            className="btn"
            onClick={() =>
              void window.rds
                .deployExportFailures(deploymentId)
                .then((p) => p && toast(`Saved the failure list to ${p}`, 'success'))
                .catch((e: unknown) => toast(toRdsError(e).message, 'error'))
            }
          >
            Export failure list (JSON)
          </button>
        )}
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

/** S62 (U-2): the stages of a composed attempt, in run order, each linking to its own report. */
/**
 * S63: one row per (object, field) the relink pass handled. Unresolved values stayed as the
 * SOURCE Id on the target — the samples say which rows and why, so the fix is a scope change
 * (bring the parent object in) or a catalog fix on the target, never a guess.
 */
function RelinkTable({ rows }: { rows: TextIdRelinkSummaryView[] }): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div className="relinks" data-testid="relinks">
      <h2>Text-Id fields relinked</h2>
      <p className="muted">
        These fields hold record Ids as text, so the lookup remap never sees them. They were rewritten to the
        target&apos;s Ids after the data landed. An unresolved value is left as the source Id.
      </p>
      <table className="orgs">
        <thead>
          <tr>
            <th>Field</th>
            <th>Points at</th>
            <th className="num">Relinked</th>
            <th className="num">Already current</th>
            <th className="num">Unresolved</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const key = `${r.objectApiName}.${r.fieldName}`
            const bad = r.unresolved + r.failed
            return (
              <Fragment key={key}>
                <tr>
                  <td>{key}</td>
                  <td>{r.refObject}</td>
                  <td className="num">{r.relinked}</td>
                  <td className="num">{r.alreadyCurrent}</td>
                  <td className={bad > 0 ? 'num status-err' : 'num'}>
                    {bad}
                    {bad > 0 && r.samples.length > 0 && (
                      <>
                        {' '}
                        <button className="btn btn-small" onClick={() => setOpen(open === key ? null : key)}>
                          {open === key ? 'hide' : 'why'}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
                {open === key && (
                  <tr className="relink-why">
                    <td colSpan={5}>
                      <ul>
                        {r.samples.map((smp) => (
                          <li key={`${smp.sourceId}-${smp.sourceValue}`}>
                            <code>{smp.sourceId}</code> → <code>{smp.sourceValue}</code>: {smp.reason ?? smp.outcome}
                          </li>
                        ))}
                        {bad > r.samples.length && <li className="muted">… {bad - r.samples.length} more</li>}
                      </ul>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * S64 P5 (5.1): phases that are a moment, not a span. They end the previous
 * segment and get no segment of their own. (Stalled is the lead's three plus
 * one: a stalled teardown has no finishedAt, so a segment for it would grow
 * forever. `Finished` is the handler's end-of-job stamp after the post-run
 * audit, which runs AFTER the engine's terminal phase.)
 */
const PHASE_STAMP_ONLY = new Set(['Completed', 'Failed', 'Cancelled', 'Stalled', 'Finished'])

export interface PhaseSegment {
  phase: string
  start: number
  /** Null when the span is open with no clock to run it to (a stranded run). */
  end: number | null
  /** The last segment while the job runs — its duration is still growing. */
  current: boolean
}

/**
 * Stamps → segments. Each phase runs to the next stamp; the last runs to
 * `finishedAt`, else to `now` while the job runs, else is open. Adjacent
 * stamps with the same name (the engine re-enters a phase) merge into one
 * segment — since they abut, extending the end IS summing the durations.
 */
export function phaseSegments(
  phases: DeployRunPhaseStamp[] | undefined,
  finishedAt: number | null,
  now: number,
  running: boolean
): PhaseSegment[] {
  if (!phases || phases.length < 2) return []
  const out: PhaseSegment[] = []
  let prevIndex = -2
  for (let i = 0; i < phases.length; i++) {
    const stamp = phases[i]!
    if (PHASE_STAMP_ONLY.has(stamp.phase)) continue
    const next = phases[i + 1]
    const last = next == null
    // The last stamp runs to finishedAt only if it started BEFORE the run
    // finished (the post-run audit starts after it, and ends at `Finished`).
    const toFinish = finishedAt != null && finishedAt >= stamp.at ? finishedAt : null
    const end = next ? next.at : (toFinish ?? (running ? now : null))
    const prev = out[out.length - 1]
    if (prev && prevIndex === i - 1 && prev.phase === stamp.phase) {
      prev.end = end
      prev.current = last && running
    } else {
      out.push({ phase: stamp.phase, start: stamp.at, end, current: last && running })
    }
    prevIndex = i
  }
  return out
}

const MEMORY_ORDER = ['main', 'renderer', 'gpu']

/** "Peak memory: main N MB · renderer N MB · gpu N MB" — the known processes first, any others after. */
export function peakMemoryLine(peak: Record<string, number> | null | undefined): string | null {
  if (!peak) return null
  const keys = Object.keys(peak)
  if (keys.length === 0) return null
  const ordered = [...MEMORY_ORDER.filter((k) => k in peak), ...keys.filter((k) => !MEMORY_ORDER.includes(k)).sort()]
  return `Peak memory: ${ordered.map((k) => `${k} ${Math.round(peak[k]!).toLocaleString()} MB`).join(' · ')}`
}

/**
 * S64 P5 (5.1): where the run's time went. One segment per phase span from the
 * persisted `run_phases` stamps; nothing for pre-014 runs (no stamps) or a run
 * with a single stamp. The current segment ticks with the page's clock.
 */
function PhaseStrip({
  phases,
  finishedAt,
  now,
  running,
  peakMemoryMB
}: {
  phases: DeployRunPhaseStamp[] | undefined
  finishedAt: number | null
  now: number
  running: boolean
  peakMemoryMB: Record<string, number> | null | undefined
}): React.JSX.Element | null {
  const segments = phaseSegments(phases, finishedAt, now, running)
  const memory = peakMemoryLine(peakMemoryMB)
  if (segments.length === 0 && memory == null) return null
  return (
    <section className="phase-strip" aria-label="Run phases" data-testid="phase-strip">
      {segments.length > 0 && (
        <ol className="phase-strip-list">
          {segments.map((s) => (
            <li
              key={`${s.phase}-${s.start}`}
              className={s.current ? 'phase-strip-seg current' : 'phase-strip-seg'}
              aria-current={s.current ? 'step' : undefined}
              title={s.phase}
            >
              <span className="phase-strip-name">{phaseLabel(s.phase)}</span>
              <span className="phase-strip-time">{fmtDuration(s.start, s.end)}</span>
            </li>
          ))}
        </ol>
      )}
      {memory != null && (
        <p className="muted phase-strip-memory" data-testid="peak-memory">
          {memory}
        </p>
      )}
    </section>
  )
}

function StagesStrip({ stages }: { stages: DeployStageView[] }): React.JSX.Element {
  return (
    <section className="stages" aria-label="Stages">
      <h2>Stages</h2>
      <ol className="stage-list">
        {stages.map((s) => (
          <li key={s.position} className="stage" data-state={s.state}>
            <span className="stage-pos">{s.position + 1}</span>
            <span className="stage-label">
              {s.kind === 'template' && s.templateId != null && s.templateRunId != null ? (
                <Link to={`/templates/${s.templateId}/runs/${s.templateRunId}`}>{s.label}</Link>
              ) : (
                s.label
              )}
              {s.kind === 'template' && <span className="muted"> · template</span>}
            </span>
            <Badge tone={stageTone(s.state)}>{s.state}</Badge>
            <span className="muted stage-time">
              {s.startedAt != null ? fmtDuration(s.startedAt, s.finishedAt) : '—'}
            </span>
            {s.note && <span className="muted stage-note">{s.note}</span>}
          </li>
        ))}
      </ol>
    </section>
  )
}

function stageTone(state: DeployStageView['state']): BadgeTone {
  switch (state) {
    case 'clean':
      return 'success'
    case 'failed':
      return 'danger'
    case 'partial':
    case 'blocked':
      return 'warn'
    case 'running':
      return 'accent'
    default:
      return 'neutral'
  }
}

function Kpi({
  label,
  value,
  tone,
  hint
}: {
  label: string
  value: number
  tone?: 'danger'
  /** One line from GLOSSARY, shown on hover (ux T-8: KPIs did not explain themselves). */
  hint?: string
}): React.JSX.Element {
  return (
    <div className="kpi" title={hint}>
      <span className={tone === 'danger' && value > 0 ? 'kpi-value status-err' : 'kpi-value'}>
        {value.toLocaleString()}
      </span>
      <span className="kpi-label">{label}</span>
    </div>
  )
}

/** Per-row deployed/planned bar for the live table (ux F-6). Decorative; the text carries the numbers. */
function MiniBar({ done, total }: { done: number; total: number }): React.JSX.Element {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <>
      <span className="mini-bar" aria-hidden="true">
        <span className="mini-bar-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="mini-bar-text muted">
        {done.toLocaleString()} / {total.toLocaleString()}
      </span>
    </>
  )
}

/** The E2 manual-restore steps (shared copy — identical to the job error text). */
function RestoreSteps(): React.JSX.Element {
  return (
    <>
      <p>
        Restore the target&rsquo;s automation manually, in this order. The app recorded exactly which
        items it disabled before changing them; the steps below are in restore order.
      </p>
      <ol className="restore-steps">
        {MANUAL_RESTORE_STEPS.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </>
  )
}
