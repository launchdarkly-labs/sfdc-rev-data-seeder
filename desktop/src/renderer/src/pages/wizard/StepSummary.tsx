import { useEffect, useState } from 'react'
import type { PlanObjectView, PlanView } from '../../../../shared/types'
import { readinessGate, readinessGateMessage } from '../../../../shared/wizard'
import { Badge } from '../../ui/Badge'
import { DataTable, type Column } from '../../ui/DataTable'
import { ProgressBar } from '../../ui/ProgressBar'
import { useIpcMutation } from '../../ipc/hooks'
import { useJobsStore, useLatestJobForDeployment } from '../../store/jobs'
import { useWizard } from './WizardShell'

const COLUMNS: Column<PlanObjectView>[] = [
  { key: 'order', header: '#', sortValue: (o) => o.sortOrder, align: 'right' },
  { key: 'object', header: 'Object', sortValue: (o) => o.objectName },
  {
    key: 'records',
    header: 'Records',
    align: 'right',
    sortValue: (o) => o.recordCount,
    render: (o) => o.recordCount.toLocaleString()
  },
  {
    key: 'api',
    header: 'API',
    sortValue: (o) => o.apiStrategy,
    render: (o) => (
      <Badge tone={o.apiStrategy === 'Bulk' ? 'warn' : 'neutral'}>{o.apiStrategy}</Badge>
    )
  },
  { key: 'tier', header: 'Tier', render: (o) => o.gatingTier ?? '—' },
  {
    key: 'flags',
    header: 'Flags',
    render: (o) => (
      <>
        {o.isJunction && <Badge tone="accent">junction</Badge>}
        {o.hasCircularReference && <Badge tone="warn">cycle</Badge>}
        {o.requiresTriggerBypass && <Badge tone="danger">CPQ</Badge>}
        {o.deferredFields.length > 0 && (
          <Badge tone="neutral">{o.deferredFields.length} deferred</Badge>
        )}
      </>
    )
  },
  {
    key: 'filter',
    header: 'Scope',
    render: (o) =>
      o.scopedFilterDisplay ? <code className="scope-clause">{o.scopedFilterDisplay}</code> : '—'
  }
]

/**
 * Wizard Step 6 — Analyze & Summary (M1 exit). Runs the parity-proven analysis
 * engine as a background job (rds:analyze), then renders the persisted plan
 * (rds:plan.get). Re-analyze re-runs it. The dependency-tier SVG visualizer is
 * the separate Plan step (5C.3).
 */
export function StepSummary(): React.JSX.Element {
  const { deploymentId, config, goToStep, refreshDraft } = useWizard()
  const analyze = useIpcMutation((id: number) => window.rds.analyze(id))
  // Track the analysis job via the shared store (keyed by deployment), so a
  // remount or renderer reload re-attaches instead of losing a local jobId.
  const job = useLatestJobForDeployment(deploymentId, 'analysis')
  const [plan, setPlan] = useState<PlanView | null | undefined>(undefined)
  const [planError, setPlanError] = useState<string | undefined>(undefined)
  const [launching, setLaunching] = useState(false)

  const running = job?.status === 'running'
  const done = job?.status === 'done'
  const busy = running || launching

  // Re-hydrate the jobs store on mount so a job started before this mount (nav
  // away/back, reload) is picked up by the deployment-keyed selector above.
  useEffect(() => {
    void useJobsStore.getState().refresh()
  }, [])

  // Load the persisted plan on mount and whenever an analysis completes.
  useEffect(() => {
    let cancelled = false
    window.rds
      .planGet(deploymentId)
      .then((p) => {
        if (!cancelled) {
          setPlan(p)
          setPlanError(undefined)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setPlanError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [deploymentId, done])

  // After Draft→Planned, refresh the wizard header status (refreshDraft is stable).
  useEffect(() => {
    if (done) refreshDraft()
  }, [done, refreshDraft])

  async function runAnalysis(): Promise<void> {
    setLaunching(true)
    try {
      await analyze.mutate(deploymentId)
      await useJobsStore.getState().refresh()
    } finally {
      setLaunching(false)
    }
  }

  const objectCount = config.selectedObjects.length
  // S54 (L1): the same predicate that closes the Readiness step's Next. The
  // shell normally routes a closed wizard back to Readiness, so this is the
  // in-step statement of WHY analysis is refused if we are rendered anyway.
  const gate = readinessGate(config)

  // Staleness: the persisted plan's user objects vs the current selection. Filter
  // edits are NOT diffed here (a re-analyze is the source of truth) — snapshotting
  // the analyzed config for a full diff is a tracked 5B.3/5B.5 follow-up.
  const planUserObjects = plan
    ? new Set(
        plan.objects.map((o) => o.objectName).filter((n) => !plan.autoInjectedJunctions.includes(n))
      )
    : null
  const scopeChanged =
    planUserObjects != null &&
    (planUserObjects.size !== objectCount ||
      config.selectedObjects.some((o) => !planUserObjects.has(o)))

  return (
    <>
      <h2>Analyze &amp; summary</h2>
      <p className="muted">
        Runs the analysis engine against the live source + target orgs — dependency order, scoped
        record counts, junction injection, and REST/Bulk routing — then persists the plan.
      </p>

      {gate.blocked && (
        <div className="banner error" role="alert">
          {readinessGateMessage(gate)}{' '}
          <button className="btn" onClick={() => goToStep('readiness')}>
            Open the Readiness step
          </button>
        </div>
      )}

      <div className="toolbar">
        <button
          className="btn primary"
          onClick={runAnalysis}
          disabled={busy || objectCount === 0 || gate.blocked}
        >
          {busy ? 'Analyzing…' : plan ? 'Re-analyze' : 'Run analysis'} ({objectCount} object
          {objectCount === 1 ? '' : 's'})
        </button>
      </div>

      {busy && (
        <div className="analysis-progress">
          <ProgressBar
            value={job?.progress?.value ?? 0}
            max={job?.progress?.max ?? 3}
            label={job?.progress?.label ?? 'Starting…'}
          />
        </div>
      )}

      {analyze.error && (
        <div className="banner error">Could not start analysis: {analyze.error.message}</div>
      )}
      {job?.status === 'error' && (
        <div className="banner error">Analysis failed: {job.error ?? 'unknown error'}</div>
      )}
      {planError && <div className="banner error">Could not load the plan: {planError}</div>}
      {scopeChanged && !busy && (
        <div className="banner warn">
          Scope changed since the last analysis — re-analyze to refresh the plan.
        </div>
      )}

      {plan && <PlanSummary plan={plan} />}

      {plan && (
        <div className="toolbar">
          <button className="btn" onClick={() => goToStep('fields')}>
            Back
          </button>
          <button
            className="btn primary"
            onClick={() => goToStep('plan')}
            disabled={scopeChanged || gate.blocked}
          >
            Next: plan visualizer
          </button>
        </div>
      )}
    </>
  )
}

function PlanSummary({ plan }: { plan: PlanView }): React.JSX.Element {
  return (
    <section className="plan-summary">
      <div className="plan-stats">
        <Badge tone="accent">{plan.totalObjects} objects</Badge>
        <Badge tone="neutral">{plan.totalRecords.toLocaleString()} records</Badge>
        {plan.autoInjectedJunctions.length > 0 && (
          <Badge tone="accent">{plan.autoInjectedJunctions.length} junction(s) auto-included</Badge>
        )}
        {plan.warnings.length > 0 && <Badge tone="warn">{plan.warnings.length} warning(s)</Badge>}
      </div>

      {plan.warnings.length > 0 && (
        <ul className="plan-warnings">
          {plan.warnings.map((w, i) => (
            <li key={i} className="muted">
              {w}
            </li>
          ))}
        </ul>
      )}

      <DataTable
        rows={plan.objects}
        columns={COLUMNS}
        rowKey={(o) => o.objectName}
        empty="No objects in the plan."
      />
    </section>
  )
}
