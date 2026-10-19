import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { useJobsStore } from '../store/jobs'
import { callIpc, toRdsError } from '../ipc/client'
import { useIpcQuery } from '../ipc/hooks'
import { ProgressBar } from '../ui/ProgressBar'
import { Badge } from '../ui/Badge'
import { useConfirm } from '../ui/ConfirmDialog'
import { useToast } from '../ui/Toast'
import type { DeploymentSummary, JobSummary } from '../../../shared/types'
import { phaseLabel, statusLabel, statusTone } from '../../../shared/labels'
import { canDeleteDeployment, canEditPlan, isDeployBusy } from '../../../shared/wizard'
import { firstLine } from './DeploymentDetail'
import { WelcomeChecklist } from './placeholders'

/**
 * Deployments (the index route) — ONE activity list (S64 P3, ux IA-10 / IA-13 / C-5).
 *
 * Before: "Jobs this session" (ephemeral, lowercase `running/done`) and
 * "Deployments" (durable, `Draft/Completed`) were two sections in one card
 * style, and a running deploy showed up twice. Now every card is an activity:
 * a kind badge (Deployment / Template run / Analysis), one status badge from
 * the shared vocabulary, ONE primary action per status and a "…" menu for the
 * rest. A running job attaches to its deployment's card (phase + progress)
 * instead of being a card of its own; jobs without a listed deployment
 * (template runs, analyses, a demo) are their own cards.
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
  // S64 (P2): the first-run branch needs to know whether any org is connected.
  const { data: orgs } = useIpcQuery(() => window.rds.listOrgs(), [])
  const firstRun = deployments != null && deployments.length === 0 && orgs != null && orgs.length === 0
  // S64 P5 (5.5b): `refetch` from useIpcQuery is a new function every render, so
  // handing it straight to the memoised DeploymentCard would defeat the memo.
  // Route it through a ref (refreshed after each commit) behind one stable callback.
  const refetchRef = useRef(refetchDeployments)
  useEffect(() => {
    refetchRef.current = refetchDeployments
  })
  const onDeleted = useCallback((): void => refetchRef.current(), [])

  const runDemo = async (): Promise<void> => {
    await window.rds.jobDemo()
    await refresh()
  }

  // Latest running job per deployment id → attaches to that card.
  const listed = new Set((deployments ?? []).map((d) => String(d.id)))
  const attached = new Map<string, JobSummary>()
  for (const job of jobs) {
    if (job.deploymentId && job.status === 'running' && listed.has(job.deploymentId)) {
      attached.set(job.deploymentId, job)
    }
  }
  // Everything else is its own card: template runs, analyses, demos, and a
  // finished deploy job whose deployment is not (yet) in the list. Newest first.
  const standalone = jobs
    .filter((job) => !(job.deploymentId && job.status === 'running' && listed.has(job.deploymentId)))
    .reverse()

  return (
    <>
      <h1>Deployments</h1>
      <p className="sub">Every deployment and this session&rsquo;s runs, newest first.</p>

      <div className="toolbar">
        <Link className="btn primary" to="/deployments/new">
          New deployment
        </Link>
        {import.meta.env.DEV && (
          <button className="btn" onClick={() => void runDemo()}>
            Run demo job
          </button>
        )}
      </div>

      {listError && <div className="banner">{listError.message}</div>}
      {firstRun && <WelcomeChecklist orgCount={0} deploymentCount={0} />}
      {!firstRun && deployments && deployments.length === 0 && (
        <p className="muted">
          No deployments yet — <Link to="/deployments/new">create one</Link>.
        </p>
      )}
      {(standalone.length > 0 || (deployments && deployments.length > 0)) && (
        <div className="activity-list" data-testid="activity">
          {standalone.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
          {(deployments ?? []).map((d) => (
            <DeploymentCard key={d.id} d={d} job={attached.get(String(d.id))} onDeleted={onDeleted} />
          ))}
        </div>
      )}
    </>
  )
}

/** Activity kind for a job card — jobs on a deployment are "Deployment" activity. */
function jobKindLabel(job: JobSummary): string {
  if (job.deploymentId) return 'Deployment'
  if (job.kind.startsWith('template-')) return 'Template run'
  if (job.kind === 'analysis') return 'Analysis'
  return 'Job'
}

/**
 * One error, one line (ux T-12). The first line is shown with the full text
 * on `title`; "Show more" expands to the whole message in place.
 */
export function ErrorLine({ text }: { text: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const line = firstLine(text)
  const hasMore = line !== text
  return (
    <div className={`error-line${expanded ? ' expanded' : ''}`} title={text}>
      <span>{expanded ? text : line}</span>
      {hasMore && (
        <button type="button" className="btn subtle btn-small error-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

/** "…" overflow menu (ux C-8): a <details>, so it needs no state and works without JS. */
function OverflowMenu({ children, label }: { children: React.ReactNode; label: string }): React.JSX.Element {
  return (
    <details className="card-menu">
      <summary className="btn btn-small" aria-label={label} title={label}>
        …
      </summary>
      <div className="card-menu-list">{children}</div>
    </details>
  )
}

function JobCard({ job }: { job: JobSummary }): React.JSX.Element {
  const to = job.deploymentId
    ? `/deployments/${job.deploymentId}`
    : job.templateRunId != null && job.templateId != null
      ? `/templates/${job.templateId}/runs/${job.templateRunId}`
      : null
  const running = job.status === 'running'
  const cta = to ? (running ? 'Monitor' : 'View report') : null
  return (
    <div className="job-card" data-testid={`job-${job.id}`}>
      <div className="job-card-head">
        <span className="card-title">
          <Badge>{jobKindLabel(job)}</Badge>
          {to ? <Link to={to}>{job.title}</Link> : <span>{job.title}</span>}
          {job.phase && running && <span className="card-phase">{phaseLabel(job.phase)}</span>}
        </span>
        <Badge tone={statusTone('job', job.status)}>{statusLabel('job', job.status)}</Badge>
      </div>
      {job.progress && (
        <ProgressBar
          value={job.progress.value}
          max={job.progress.max}
          tone={job.status === 'error' ? 'danger' : job.status === 'done' ? 'success' : 'accent'}
          label={job.progress.label}
        />
      )}
      {job.error && <ErrorLine text={job.error} />}
      {(cta || running) && (
        <div className="card-actions">
          {cta && to && (
            <Link className="btn btn-small primary" to={to}>
              {cta}
            </Link>
          )}
          {running && (
            <OverflowMenu label={`More actions for ${job.title}`}>
              <button type="button" className="menu-danger" onClick={() => void window.rds.jobCancel(job.id)}>
                Cancel
              </button>
            </OverflowMenu>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * S64 P5 (5.5b): memoised. Its props are stable between list renders — `d` is a
 * row of the last `draftList` result, `job` the store's summary reference (which
 * no longer changes on log lines), `onDeleted` one stable callback — so a job
 * event re-renders only the card that job is attached to, not every card.
 */
const DeploymentCard = memo(function DeploymentCard({
  d,
  job,
  onDeleted
}: {
  d: DeploymentSummary
  job: JobSummary | undefined
  onDeleted: () => void
}): React.JSX.Element {
  const confirm = useConfirm()
  const toast = useToast()
  const busy = isDeployBusy(d.status) || job != null
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
  const planTo = `/deployments/${d.id}/wizard/plan`
  const detailTo = `/deployments/${d.id}`

  // ONE primary action per status (ux IA-13). Drafts have nothing to monitor
  // yet; everything that ran leads to the detail page first (that is where a
  // failure's full text lives).
  let cta: { label: string; to: string }
  if (d.status === 'Draft') cta = { label: 'Continue', to: wizardTo }
  else if (d.status === 'Planned' && !busy) cta = { label: 'Review plan', to: planTo }
  else if (busy) cta = { label: 'Monitor', to: detailTo }
  else cta = { label: 'View report', to: detailTo }

  const menu: React.ReactNode[] = []
  if (d.status === 'Planned' && !busy) {
    menu.push(
      <Link key="details" to={detailTo}>
        Details
      </Link>
    )
  }
  if (!busy && d.status !== 'Draft' && d.status !== 'Planned' && canEditPlan(d.status)) {
    menu.push(
      <Link key="plan" to={planTo}>
        Open plan
      </Link>
    )
  }
  if (job) {
    menu.push(
      <button key="cancel" type="button" className="menu-danger" onClick={() => void window.rds.jobCancel(job.id)}>
        Cancel run
      </button>
    )
  }
  if (deletable) {
    menu.push(
      <button key="delete" type="button" className="menu-danger" onClick={() => void remove()}>
        Delete
      </button>
    )
  }

  const phase = job?.phase ?? (isDeployBusy(d.status) ? d.status : null)
  return (
    <div className="job-card" data-testid={`deployment-${d.id}`}>
      <div className="job-card-head">
        <span className="card-title">
          <Badge>Deployment</Badge>
          <Link to={cta.to}>{d.name}</Link>
          <span className="card-meta">
            {d.sourceLabel} → {d.targetLabel}
            {d.totalObjects != null && ` · ${d.totalObjects} object${d.totalObjects === 1 ? '' : 's'}`}
            {d.totalRecords != null && ` · ${d.totalRecords.toLocaleString()} records`}
          </span>
          {busy && phase && <span className="card-phase">{phaseLabel(phase)}</span>}
        </span>
        <Badge tone={statusTone('deployment', d.status)}>{statusLabel('deployment', d.status)}</Badge>
      </div>
      {job?.progress && (
        <ProgressBar value={job.progress.value} max={job.progress.max} tone="accent" label={job.progress.label} />
      )}
      {d.errorMessage && <ErrorLine text={d.errorMessage} />}
      {d.status === 'Stalled' && (
        <div className="card-note">Stalled during teardown — restore the target&rsquo;s automation by hand, then start a new deployment.</div>
      )}
      <div className="card-actions">
        <Link className="btn btn-small primary" to={cta.to}>
          {cta.label}
        </Link>
        {menu.length > 0 && <OverflowMenu label={`More actions for ${d.name}`}>{menu}</OverflowMenu>}
      </div>
    </div>
  )
})
