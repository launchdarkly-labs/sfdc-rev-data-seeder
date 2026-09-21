import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { attestationBlocked, readinessGate, readinessGateMessage } from '../../../../shared/wizard'
import type { AutomationSnapshot, PlanObjectView, PlanView } from '../../../../shared/types'
import { Badge } from '../../ui/Badge'
import { useIpcMutation } from '../../ipc/hooks'
import { useJobsStore, useLatestJobForDeployment } from '../../store/jobs'
import { AutomationPanel } from './AutomationPanel'
import { useWizard } from './WizardShell'

/**
 * Wizard Step 7 — Plan review (5B.8). The persisted analysis plan in true
 * per-object deploy order, with drag-and-drop (and ↑/↓) reorder implementing
 * the SLOT-REFILL INVARIANT in main (`rds:plan.reorder` — the Session-16
 * `applyDeploymentPlan` fix): omitted objects and junctions keep their
 * analysis slots; only the rows the user placed are refilled in their order.
 * Junction rows are non-draggable (matched by lookup pair, not upserted);
 * deferred-field revisit passes render as non-draggable badges on their
 * object's row — a revisit pass has no slot of its own to move.
 *
 * Reordering is blocked while an analysis job for this deployment is running
 * (main enforces the same guard — a completing analysis rewrites every plan
 * row) and while the scope has drifted from the analyzed plan (the header nav
 * can reach this step without passing StepSummary's staleness gate).
 */
export function StepPlan(): React.JSX.Element {
  const { deploymentId, config, updateConfig, goToStep } = useWizard()
  // S54 (L1): defence in depth — the readiness gate also closes Deploy here.
  const gate = readinessGate(config)
  const navigate = useNavigate()
  const [plan, setPlan] = useState<PlanView | null | undefined>(undefined)
  const [planError, setPlanError] = useState<string | undefined>(undefined)
  const reorder = useIpcMutation((input: { deploymentId: number; objectOrder: string[] }) =>
    window.rds.planReorder(input)
  )
  // 5B.9 — Start Deploy: kick off the run job, then straight to the monitor.
  const deploy = useIpcMutation(() => window.rds.deployStart(deploymentId))
  const [dragName, setDragName] = useState<string | null>(null)
  const [dropName, setDropName] = useState<string | null>(null)
  const [liveMessage, setLiveMessage] = useState('')

  // Re-attach to an analysis started elsewhere (StepSummary, a reload) so a
  // completing re-analysis refreshes this view instead of leaving a phantom
  // order on screen.
  const analysisJob = useLatestJobForDeployment(deploymentId, 'analysis')
  const analysisRunning = analysisJob?.status === 'running'
  useEffect(() => {
    void useJobsStore.getState().refresh()
  }, [])

  // ── Automation discovery + CPQ attestation gate (5B.8-b) ──
  const discover = useIpcMutation(() => window.rds.automationDiscover(deploymentId))
  const [snapshot, setSnapshot] = useState<AutomationSnapshot | undefined>(undefined)

  async function runDiscovery(): Promise<void> {
    const snap = await discover.mutate()
    // LWC parity: a failed discovery CLEARS the snapshot (the stale table and
    // its gate state must not keep rendering under the error banner), and the
    // CPQ manual-disable confirmation is re-given after EVERY discovery
    // attempt — success or failure — never left granted against a stale scan.
    setSnapshot(snap ?? undefined)
    updateConfig({ cpqAttestation: false })
  }

  // Discover on step entry (mirrors the LWC's step-6 entry discovery). Ref-guard
  // instead of a deps array: discover.mutate/updateConfig are unstable closures.
  const discoveredFor = useRef<number | null>(null)
  useEffect(() => {
    if (discoveredFor.current === deploymentId) return
    discoveredFor.current = deploymentId
    void runDiscovery()
  })

  // Load the persisted plan on mount and again when an analysis reaches a
  // terminal state (done → the plan was rewritten in analysis order).
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
  }, [deploymentId, analysisJob?.status])

  // Staleness: the persisted plan's user objects vs the current selection
  // (same computation as StepSummary — the wizard header nav can reach this
  // step directly, bypassing StepSummary's disabled Next button).
  const planUserObjects = plan
    ? new Set(
        plan.objects.map((o) => o.objectName).filter((n) => !plan.autoInjectedJunctions.includes(n))
      )
    : null
  const scopeChanged =
    planUserObjects != null &&
    (planUserObjects.size !== config.selectedObjects.length ||
      config.selectedObjects.some((o) => !planUserObjects.has(o)))

  const busy = reorder.loading
  const reorderBlocked = busy || analysisRunning || scopeChanged

  /** The reorderable (non-junction) object names in current plan order. */
  function draggableOrder(): string[] {
    return (plan?.objects ?? []).filter((o) => !o.isJunction).map((o) => o.objectName)
  }

  async function applyOrder(objectOrder: string[], movedName: string): Promise<void> {
    const fresh = await reorder.mutate({ deploymentId, objectOrder })
    if (fresh) {
      setPlan(fresh)
      const pos = fresh.objects.findIndex((o) => o.objectName === movedName)
      if (pos >= 0)
        setLiveMessage(`${movedName} moved to position ${pos + 1} of ${fresh.objects.length}`)
    }
  }

  function moveRow(name: string, dir: -1 | 1): void {
    if (reorderBlocked) return // buttons stay focusable (aria-disabled), so guard here
    const names = draggableOrder()
    const i = names.indexOf(name)
    const j = i + dir
    if (i < 0 || j < 0 || j >= names.length) return
    const other = names[j]
    if (other === undefined) return
    names[j] = name
    names[i] = other
    void applyOrder(names, name)
  }

  function dropOn(targetName: string): void {
    if (reorderBlocked || !dragName || dragName === targetName) return
    const names = draggableOrder()
    const from = names.indexOf(dragName)
    const to = names.indexOf(targetName)
    if (from < 0 || to < 0) return
    const moved = dragName
    names.splice(from, 1)
    names.splice(to, 0, moved)
    void applyOrder(names, moved)
  }

  return (
    <>
      <h2>Deployment plan</h2>
      <p className="muted">
        The exact per-object order the deploy will run — drag a row (or use ↑/↓) to reorder. Objects
        you don&rsquo;t move keep their analysis position; junctions are matched by their parent
        lookups, not upserted, and always keep their slot.
      </p>

      {planError && <div className="banner error">Could not load the plan: {planError}</div>}
      {reorder.error && <div className="banner error">Reorder failed: {reorder.error.message}</div>}
      {plan === null && (
        <div className="banner warn">No analyzed plan — go back and run the analysis first.</div>
      )}
      {analysisRunning && (
        <div className="banner warn">
          Analysis is running — the plan will refresh (and replace any manual order) when it
          finishes.
        </div>
      )}
      {scopeChanged && !analysisRunning && (
        <div className="banner warn">
          Scope changed since the last analysis — re-analyze on the Summary step to refresh the
          plan. Reordering is disabled until then.
        </div>
      )}

      <div aria-live="polite" className="sr-only">
        {liveMessage}
      </div>

      {plan && (
        <table className="plan-order" data-busy={busy || undefined}>
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Object</th>
              <th className="num">Records</th>
              <th>Passes</th>
              <th className="num">Move</th>
            </tr>
          </thead>
          <tbody>
            {plan.objects.map((o, idx) => (
              <PlanRow
                key={o.objectName}
                obj={o}
                position={idx + 1}
                blocked={reorderBlocked}
                dragging={dragName === o.objectName}
                dropTarget={dragName !== null && dropName === o.objectName}
                canMoveUp={draggableOrder().indexOf(o.objectName) > 0}
                canMoveDown={
                  !o.isJunction &&
                  draggableOrder().indexOf(o.objectName) < draggableOrder().length - 1
                }
                onDragStart={() => setDragName(o.objectName)}
                onDragOver={() => setDropName(o.objectName)}
                onDragLeave={() => setDropName((d) => (d === o.objectName ? null : d))}
                dragActive={dragName !== null}
                onDrop={() => {
                  dropOn(o.objectName)
                  setDragName(null)
                  setDropName(null)
                }}
                onDragEnd={() => {
                  setDragName(null)
                  setDropName(null)
                }}
                onMove={(dir) => moveRow(o.objectName, dir)}
              />
            ))}
          </tbody>
        </table>
      )}

      <AutomationPanel
        snapshot={snapshot}
        discovering={discover.loading}
        error={discover.error}
        onRescan={() => void runDiscovery()}
      />

      <div className="toolbar">
        <button className="btn" onClick={() => goToStep('summary')}>
          Back
        </button>
        <button
          className="btn primary"
          disabled={
            !plan ||
            analysisRunning ||
            scopeChanged ||
            deploy.loading ||
            gate.blocked ||
            attestationBlocked(snapshot, discover.loading, config.cpqAttestation)
          }
          onClick={() =>
            void deploy.mutate().then(async (started) => {
              // failure surfaces via deploy.error below; only navigate on start
              if (!started) return
              // Re-hydrate the job store BEFORE navigating: a job known only
              // through its events is a bare stub (kind 'demo', no
              // deploymentId) that useLatestJobForDeployment never matches —
              // the monitor would load once and never update (S47 review).
              await useJobsStore.getState().refresh()
              navigate(`/deployments/${deploymentId}`)
            })
          }
        >
          {deploy.loading ? 'Starting…' : 'Deploy'}
        </button>
      </div>
      {deploy.error && <p className="error">Deploy failed to start: {deploy.error.message}</p>}
      <p className="muted deploy-gate-note">
        {gate.blocked
          ? readinessGateMessage(gate)
          : attestationBlocked(snapshot, discover.loading, config.cpqAttestation)
            ? 'Deploy is blocked until you confirm the CPQ "Triggers Disabled" step above.'
            : 'Deploy freezes the plan, disables the selected automation, loads the data, then restores automation.'}
      </p>
    </>
  )
}

/**
 * The CPQ attestation gate — moved to shared/wizard.ts (5B.9) so the MAIN-side
 * rds:deploy.start handler enforces exactly this predicate; re-exported so
 * existing imports keep working.
 */
export { attestationBlocked }

function PlanRow({
  obj,
  position,
  blocked,
  dragging,
  dropTarget,
  canMoveUp,
  canMoveDown,
  dragActive,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onMove
}: {
  obj: PlanObjectView
  position: number
  blocked: boolean
  dragging: boolean
  dropTarget: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  dragActive: boolean
  onDragStart: () => void
  onDragOver: () => void
  onDragLeave: () => void
  onDrop: () => void
  onDragEnd: () => void
  onMove: (dir: -1 | 1) => void
}): React.JSX.Element {
  const draggable = !obj.isJunction && !blocked
  return (
    <tr
      className={[
        'plan-order-row',
        obj.isJunction ? 'junction' : 'draggable',
        dragging ? 'dragging' : '',
        dropTarget ? 'drop-target' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragOver={
        !obj.isJunction
          ? (e) => {
              // Only advertise a drop target for OUR row drag — external drags
              // (Finder files, text selections) must not light rows up.
              if (!dragActive) return
              e.preventDefault()
              onDragOver()
            }
          : undefined
      }
      onDragLeave={!obj.isJunction ? onDragLeave : undefined}
      onDrop={
        !obj.isJunction
          ? (e) => {
              if (!dragActive) return
              e.preventDefault()
              onDrop()
            }
          : undefined
      }
      onDragEnd={onDragEnd}
    >
      <td className="num">{position}</td>
      <td>
        {!obj.isJunction && (
          <span className="drag-handle" aria-hidden="true">
            ⋮⋮{' '}
          </span>
        )}
        {obj.objectName}{' '}
        {obj.isJunction && <Badge tone="accent">junction — matched, not upserted</Badge>}
        {obj.hasCircularReference && <Badge tone="warn">cycle</Badge>}
        {obj.requiresTriggerBypass && <Badge tone="danger">CPQ</Badge>}
      </td>
      <td className="num">{obj.recordCount.toLocaleString()}</td>
      <td>
        <Badge tone="neutral">pass 1 · {obj.apiStrategy}</Badge>{' '}
        {obj.deferredFields.length > 0 && (
          <Badge tone="neutral">
            revisit pass · {obj.deferredFields.length} deferred field
            {obj.deferredFields.length === 1 ? '' : 's'}
          </Badge>
        )}
      </td>
      <td className="num">
        {!obj.isJunction && (
          <>
            {/* aria-disabled (not disabled): a hard-disabled button steals keyboard
                focus mid-reorder (Chromium blurs it), making ↑/↓ single-use per Tab
                traversal. moveRow guards re-entry while blocked. */}
            <button
              className="btn icon"
              aria-label={`Move ${obj.objectName} up`}
              aria-disabled={blocked || !canMoveUp}
              onClick={() => onMove(-1)}
            >
              ↑
            </button>
            <button
              className="btn icon"
              aria-label={`Move ${obj.objectName} down`}
              aria-disabled={blocked || !canMoveDown}
              onClick={() => onMove(1)}
            >
              ↓
            </button>
          </>
        )}
      </td>
    </tr>
  )
}
