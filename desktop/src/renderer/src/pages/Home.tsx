import { Link } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { useJobsStore } from '../store/jobs'
import { callIpc, toRdsError } from '../ipc/client'
import { useIpcQuery } from '../ipc/hooks'
import { ProgressBar } from '../ui/ProgressBar'
import { Badge, type BadgeTone } from '../ui/Badge'
import { useConfirm } from '../ui/ConfirmDialog'
import { useToast } from '../ui/Toast'
import type { DeploymentSummary, JobStatus } from '../../../shared/types'
import { canDeleteDeployment, canEditPlan, isDeployBusy } from '../../../shared/wizard'
import { firstLine, statusTone } from './DeploymentDetail'

const STATUS_TONE: Record<JobStatus, BadgeTone> = {
  running: 'accent',
  done: 'success',
  error: 'danger',
  cancelled: 'neutral'
}

/**
 * Home — running jobs + EVERY deployment with its mirrored status (S46 D3).
 * Before D1/D3 a failed deploy was visible only as a job card in the session
 * that ran it; the deployment row stayed 'Planned' and the list hid anything
 * that was not Draft/Planned/Stalled. Now the list is the durable view and
 * the job cards are the live one; both link to the deployment detail page.
 */
export function HomePage(): React.JSX.Element {
  const jobs = useJobsStore(useShallow((s) => s.order.map((id) => s.byId[id]!)))
  const refresh = useJobsStore((s) => s.refresh)

  // Re-read the list whenever any job changes status — that is exactly when
  // a deployment's mirrored status/error changes on disk.
  const jobsKey = jobs.map((j) => `${j.id}:${j.status}`).join('|')
  const {
    data: deployments,
    error: listError,
    refetch: refetchDeployments
  } = useIpcQuery(() => window.rds.draftList(), [jobsKey])

  const runDemo = async (): Promise<void> => {
    await window.rds.jobDemo()
    await refresh()
  }

  return (
    <>
      <h1>Home</h1>
      <p className="sub">Running jobs and every deployment, newest first.</p>

      <div className="toolbar">
        <Link className="btn primary" to="/deployments/new">
          New deployment
        </Link>
        <button className="btn" onClick={() => void runDemo()}>
          Run demo job
        </button>
      </div>

      <h2>Jobs this session</h2>
      {jobs.length === 0 ? (
        <p className="muted">No jobs yet.</p>
      ) : (
        <div className="job-list">
          {jobs.map((job) => (
            <div key={job.id} className="job-card">
              <div className="job-card-head">
                <span>
                  {job.deploymentId ? (
                    <Link to={`/deployments/${job.deploymentId}`}>{job.title}</Link>
                  ) : (
                    job.title
                  )}
                  {job.phase && job.status === 'running' && (
                    <span className="muted"> — {job.phase}</span>
                  )}
                </span>
                <Badge tone={STATUS_TONE[job.status]}>{job.status}</Badge>
              </div>
              {job.progress && (
                <ProgressBar
                  value={job.progress.value}
                  max={job.progress.max}
                  tone={
                    job.status === 'error' ? 'danger' : job.status === 'done' ? 'success' : 'accent'
                  }
                  label={job.progress.label}
                />
              )}
              {job.status === 'running' && (
                <button className="btn" onClick={() => void window.rds.jobCancel(job.id)}>
                  Cancel
                </button>
              )}
              {job.error && <div className="status-err">{job.error}</div>}
            </div>
          ))}
        </div>
      )}

      <h2>Deployments</h2>
      {listError && <div className="banner">{listError.message}</div>}
      {deployments && deployments.length === 0 && (
        <p className="muted">
          No deployments yet — <Link to="/deployments/new">create one</Link>.
        </p>
      )}
      {deployments && deployments.length > 0 && (
        <div className="deployment-list">
          {deployments.map((d) => (
            <DeploymentCard key={d.id} d={d} onDeleted={refetchDeployments} />
          ))}
        </div>
      )}
    </>
  )
}

function DeploymentCard({
  d,
  onDeleted
}: {
  d: DeploymentSummary
  onDeleted: () => void
}): React.JSX.Element {
  const confirm = useConfirm()
  const toast = useToast()
  const busy = isDeployBusy(d.status)
  // S52 F4: Draft/Planned/Stalled, plus a Failed/Cancelled that never ran
  // (dep 23: refused at deploy start, nothing touched the target). Main
  // re-checks, including the unconfirmed-ledger guard for Stalled.
  const deletable = !busy && canDeleteDeployment(d.status, false, d.runCount > 0).ok
  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: `Delete "${d.name}"?`,
      message:
        d.status === 'Stalled'
          ? 'This deployment stalled during teardown. Deleting removes its local record; the target org is not changed.'
          : 'This removes the local deployment and its plan. Nothing in either org is changed.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    try {
      await callIpc(() => window.rds.draftDelete(d.id))
      toast(`Deleted "${d.name}"`, 'success')
      onDeleted()
    } catch (e) {
      toast(toRdsError(e).message, 'error')
    }
  }
  const wizardTo = `/deployments/${d.id}/wizard/${d.wizardStep ?? 'orgs'}`
  const detailTo = `/deployments/${d.id}`
  // Drafts have nothing to monitor yet; everything else leads to the detail
  // page first (that is where a failure's full text lives).
  const primaryTo = d.status === 'Draft' ? wizardTo : detailTo
  return (
    <div className="job-card">
      <div className="job-card-head">
        <span>
          <Link to={primaryTo}>{d.name}</Link>
          <span className="card-meta">
            {' '}
            · {d.sourceLabel} → {d.targetLabel}
            {d.totalObjects != null &&
              ` · ${d.totalObjects} object${d.totalObjects === 1 ? '' : 's'}`}
            {d.totalRecords != null && ` · ${d.totalRecords.toLocaleString()} records`}
          </span>
        </span>
        <Badge tone={statusTone(d.status)}>{d.status}</Badge>
      </div>
      {d.errorMessage && (
        <div className="error-snippet" title={d.errorMessage}>
          {firstLine(d.errorMessage)}
        </div>
      )}
      <div className="card-actions">
        {d.status !== 'Draft' && <Link to={detailTo}>Details</Link>}
        {!busy && d.status !== 'Stalled' && (
          <Link to={canEditPlan(d.status) ? `/deployments/${d.id}/wizard/plan` : wizardTo}>
            {d.status === 'Draft'
              ? 'Continue wizard'
              : canEditPlan(d.status)
                ? 'Open plan'
                : 'Open wizard'}
          </Link>
        )}
        {busy && <span className="muted">running — wizard locked</span>}
        {d.status === 'Stalled' && (
          <span className="muted">stalled — restore manually, then create a new deployment</span>
        )}
        {deletable && (
          <button className="btn danger btn-small" onClick={() => void remove()}>
            Delete
          </button>
        )}
      </div>
    </div>
  )
}
