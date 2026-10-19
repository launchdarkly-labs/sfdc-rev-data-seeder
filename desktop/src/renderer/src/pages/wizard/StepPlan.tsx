import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { isDeployFinished,
  attestationBlocked,
  effectiveDisable,
  hasTemplateSteps,
  isKeyless,
  KEYLESS_CAUTION_LEAD,
  KEYLESS_CAUTION_MORE,
  readinessGate,
  readinessGateMessage,
  snapshotWithTemplateGates,
  stageLabels,
  templateStepsOf
} from '../../../../shared/wizard'
import { GLOSSARY } from '../../../../shared/labels'
import { isWillFailWarning } from '../../../../shared/scopeAdvisor'
import { textIdRelinkPreview } from '../../../../shared/fieldPolicy'
import type { AutomationSnapshot, PlanObjectView, PlanView } from '../../../../shared/types'
import { Badge } from '../../ui/Badge'
import { useIpcMutation, useIpcQuery } from '../../ipc/hooks'
import { useConfirm } from '../../ui/ConfirmDialog'
import { Icon, type IconName } from '../../ui/Icon'
import { useJobsStore, useLatestJobForDeployment } from '../../store/jobs'
import { AutomationPanel, CpqTriggersNotice, cpqNoticeRequired } from './AutomationPanel'
import { useWizard } from './WizardShell'

/**
 * Wizard Step 7 — Plan review (5B.8). The persisted analysis plan in true
 * per-object deploy order, with drag-and-drop (and ↑/↓) reorder implementing
 * the SLOT-REFILL INVARIANT in main (`rds:plan.reorder` — the Session-16
 * `applyDeploymentPlan` fix): omitted objects and junctions keep their
 * analysis slots; only the rows the user placed are refilled in their order.
 * Junction rows are non-draggable (matched by lookup pair, not upserted);
 * deferred-field second passes render as non-draggable badges on their
 * object's row — a second pass has no slot of its own to move.
 *
 * Reordering is blocked while an analysis job for this deployment is running
 * (main enforces the same guard — a completing analysis rewrites every plan
 * row) and while the scope has drifted from the analyzed plan (the header nav
 * can reach this step without passing StepSummary's staleness gate).
 *
 * S64 (P3, ux IA-7): the six banners that used to stack above Deploy are ONE
 * "Pre-flight" checklist — one row per gate (automation scan, the CPQ
 * "Triggers Disabled" confirmation, objects that will fail entirely, readiness,
 * the text-Id relink, stages), each with a ✓ / ☐ / ⚠ state, a one-line summary
 * and the former banner text behind a disclosure. The automation table lives
 * under the Automation row. Every gate predicate is unchanged.
 */
export function StepPlan(): React.JSX.Element {
  const { deploymentId, config, updateConfig, goToStep, status } = useWizard()
  // S54 (L1): defence in depth — the readiness gate also closes Deploy here.
  const gate = readinessGate(config)
  const navigate = useNavigate()
  const confirm = useConfirm()
  // S64 (P2): a Completed / Failed / Cancelled deployment reaching Deploy is a RE-RUN — say so, and ask.
  const rerun = isDeployFinished(status)
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

  // S62 (U-2): the template stages' CPQ-gated objects join the attestation — one tick covers every
  // stage (the runner re-checks the same flag per stage). Seeds are matched by NAME, as the templates
  // engine resolves them.
  const composed = hasTemplateSteps(config)
  const templatesQ = useIpcQuery(() => (composed ? window.rds.templateListAll() : Promise.resolve([])), [composed])
  const templateGated = useMemo(() => {
    if (!composed) return [] as string[]
    const t = templateStepsOf(config)
    const names = new Set([...t.before, ...t.after].flatMap((r) => r.steps.seeds.map((s) => s.name)))
    return [...new Set((templatesQ.data ?? []).filter((s) => s.kind === 'seed' && names.has(s.name)).flatMap((s) => s.cpqGatedObjects ?? []))].sort()
  }, [composed, config, templatesQ.data])
  const gateSnapshot = snapshotWithTemplateGates(snapshot, templateGated)
  const labels = stageLabels(config)

  // S62-1: warnings that predict a WHOLE object failing get their own block and an explicit
  // acknowledgement; the tick is keyed to the exact text so a re-analysis re-asks.
  const willFail = useMemo(() => (plan?.warnings ?? []).filter(isWillFailWarning), [plan])
  // S63: the text-Id fields this plan will relink after the load, and the scope gaps that would
  // leave some unresolved (an in-run field whose parent object is not in the plan).
  const relinkPreview = useMemo(() => textIdRelinkPreview((plan?.objects ?? []).map((o) => o.objectName)), [plan])
  const relinkGaps = relinkPreview.filter((r) => !r.refInPlan)
  const willFailKey = willFail.join('\n')
  const [ackedKey, setAckedKey] = useState<string | null>(null)
  const willFailAcked = willFail.length === 0 || ackedKey === willFailKey

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
    if (reorderBlocked) {
      // A-11: the buttons stay focusable (aria-disabled), so a blocked click says why in the live region.
      setLiveMessage(
        analysisRunning
          ? 'Reordering is disabled while analysis runs'
          : scopeChanged
            ? 'Reordering is disabled until the plan is re-analyzed for the changed scope'
            : 'A reorder is already in progress'
      )
      return
    }
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

  // ── Pre-flight rows ──
  const cpqRequired = cpqNoticeRequired(gateSnapshot, discover.loading)
  const cpqBlocked = attestationBlocked(gateSnapshot, discover.loading, config.cpqAttestation)
  const keyless = isKeyless(config)
  const snapshotItems = gateSnapshot?.items ?? []
  const toDisableCount = snapshotItems.filter((i) => effectiveDisable(i, config)).length
  const mastersOff = !(config.disableAutomations ?? true) && !(config.disableDuplicateRules ?? false)
  const hasJunction = (plan?.objects ?? []).some((o) => o.isJunction)

  const automationState: PreflightState = discover.loading
    ? 'pending'
    : discover.error
      ? 'warn'
      : gateSnapshot
        ? 'ok'
        : 'pending'
  const automationSummary = discover.loading
    ? 'Scanning the target org for active automation…'
    : discover.error
      ? `Scan failed — ${discover.error.message}`
      : gateSnapshot
        ? snapshotItems.length === 0
          ? 'No active automation on the target'
          : mastersOff
            ? 'Automation stays active during the deploy'
            : `${toDisableCount} of ${snapshotItems.length} item${snapshotItems.length === 1 ? '' : 's'} will be disabled, then restored`
        : 'Not scanned yet'

  const cpqState: PreflightState = discover.loading || !gateSnapshot
    ? discover.error
      ? 'warn'
      : 'pending'
    : cpqBlocked
      ? 'todo'
      : 'ok'
  const cpqSummary = discover.loading
    ? 'Waiting for the automation scan'
    : !gateSnapshot
      ? 'Needs a successful automation scan'
      : cpqBlocked
        ? 'Confirm you checked Triggers Disabled in the target org'
        : cpqRequired
          ? 'Confirmed for this scan'
          : gateSnapshot.hasCpqTriggerSetting
            ? 'Not needed — the target’s legacy CPQ trigger setting is disabled by the app'
            : 'Not needed — no CPQ-gated objects in this run'

  const willFailState: PreflightState = willFail.length === 0 ? 'ok' : willFailAcked ? 'ok' : 'todo'
  const willFailSummary =
    willFail.length === 0
      ? 'No object is predicted to fail entirely'
      : willFailAcked
        ? `Acknowledged — ${willFail.length} object${willFail.length === 1 ? '' : 's'} will fail entirely`
        : `${willFail.length} object${willFail.length === 1 ? '' : 's'} will fail entirely — acknowledge to deploy anyway`

  const readinessState: PreflightState = keyless ? 'ok' : gate.blocked ? 'warn' : 'ok'
  const readinessSummary = keyless
    ? 'Not needed — without an External Id (insert-only)'
    : gate.blocked
      ? gate.reason === 'blocked'
        ? `${gate.objects.length} object${gate.objects.length === 1 ? ' has' : 's have'} no usable External Id field on the target`
        : gate.reason === 'stale'
          ? 'Scope changed since the last Readiness check'
          : 'Target not checked for this scope yet'
      : `Target ready for this scope${config.readiness?.checkedAt ? ` · checked ${new Date(config.readiness.checkedAt).toLocaleString()}` : ''}`

  const relinkState: PreflightState = relinkGaps.length > 0 ? 'warn' : 'ok'
  const relinkLabel =
    relinkPreview.length === 0
      ? 'Relink of text-Id fields'
      : `Relink of ${relinkPreview.length} text-Id field${relinkPreview.length === 1 ? '' : 's'}`
  const relinkSummary =
    relinkPreview.length === 0
      ? 'No text fields in this plan hold record Ids'
      : relinkGaps.length > 0
        ? `${relinkGaps.length} point${relinkGaps.length === 1 ? 's' : ''} at an object outside this deployment`
        : 'Rewritten to the target’s Ids after the data lands'

  const stagesSummary = composed
    ? `${labels.length} stage${labels.length === 1 ? '' : 's'}, run in order`
    : 'Data deployment only'

  const gateNote = gate.blocked
    ? readinessGateMessage(gate)
    : cpqBlocked
      ? 'Deploy is blocked until you confirm the CPQ “Triggers Disabled” step above.'
      : !willFailAcked
        ? 'Deploy is blocked until you acknowledge the objects that will fail entirely (above).'
        : composed
          ? 'Deploy runs the stages in order: templates before the data, the data deployment, templates after.'
          : 'Deploy freezes the plan, disables the selected automation, loads the data, then restores automation.'

  return (
    <>
      <h2>Deployment plan</h2>
      <p className="muted">
        The exact per-object order the deploy will run — drag a row (or use ↑/↓) to reorder. Objects
        you don&rsquo;t move keep their analysis position; junctions are matched by their parent
        lookups rather than by an External Id, and always keep their slot.
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
      {hasJunction && (
        <p className="muted legend">
          <span className="badge badge-accent">junction</span> {GLOSSARY.junction}
        </p>
      )}

      <section className="preflight" aria-labelledby="preflight-heading" data-testid="preflight">
        <h3 id="preflight-heading">Pre-flight</h3>
        <ul className="preflight-list">
          <PreflightRow label="Automation scan" state={automationState} summary={automationSummary} testId="preflight-automation">
            <AutomationPanel
              snapshot={gateSnapshot}
              discovering={discover.loading}
              error={discover.error}
              onRescan={() => void runDiscovery()}
            />
          </PreflightRow>

          <PreflightRow
            label="CPQ “Triggers Disabled” confirmation"
            state={cpqState}
            summary={cpqSummary}
            open={cpqState === 'todo'}
            testId="preflight-cpq"
          >
            {cpqRequired && gateSnapshot ? (
              <CpqTriggersNotice snapshot={gateSnapshot} />
            ) : (
              <p className="muted">
                {GLOSSARY.attestation} It is only asked for when the run touches objects that Salesforce
                CPQ&rsquo;s managed triggers react to and the target has no legacy trigger setting the app
                can turn off itself.
              </p>
            )}
          </PreflightRow>

          <PreflightRow
            label="Objects that will fail entirely"
            state={willFailState}
            summary={willFailSummary}
            open={willFailState === 'todo'}
            testId="preflight-will-fail"
          >
            {willFail.length > 0 ? (
              <div className="will-fail" role="alert" data-testid="will-fail">
                <strong>
                  {willFail.length} object{willFail.length === 1 ? '' : 's'} will fail entirely as planned.
                </strong>
                <ul>
                  {willFail.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
                <label className="master-toggle">
                  <input
                    type="checkbox"
                    checked={willFailAcked}
                    onChange={(e) => setAckedKey(e.target.checked ? willFailKey : null)}
                  />{' '}
                  Deploy anyway — I understand every row of {willFail.length === 1 ? 'this object' : 'these objects'} will fail
                </label>
              </div>
            ) : (
              <p className="muted">
                The analysis predicts a whole object failing when a required lookup points at an object
                that is not in this deployment. None was found in this plan.
              </p>
            )}
          </PreflightRow>

          <PreflightRow label="Readiness" state={readinessState} summary={readinessSummary} open={readinessState === 'warn'} testId="preflight-readiness">
            {keyless ? (
              <div role="note" data-testid="keyless-note">
                <strong>Without an External Id (insert-only).</strong> {KEYLESS_CAUTION_LEAD}
                <details className="learn-more">
                  <summary>Learn more</summary>
                  <p>{KEYLESS_CAUTION_MORE}</p>
                </details>
              </div>
            ) : gate.blocked ? (
              <>
                <p>{readinessGateMessage(gate)}</p>
                <button className="btn btn-small" onClick={() => goToStep('readiness')}>
                  Open the Readiness step
                </button>
              </>
            ) : (
              <p className="muted">
                Every object in scope carries the External Id field this app adds to the target, so re-running
                this deployment updates the same rows.
              </p>
            )}
          </PreflightRow>

          <PreflightRow label={relinkLabel} state={relinkState} summary={relinkSummary} open={relinkState === 'warn'} testId="preflight-relink">
            {relinkPreview.length > 0 ? (
              <div role="note" data-testid="relink-notice">
                <strong>
                  {relinkPreview.length} text field{relinkPreview.length === 1 ? '' : 's'} that hold record Ids will be relinked
                  after the data lands:
                </strong>{' '}
                {relinkPreview.map((r) => `${r.object}.${r.field}`).join(', ')}.
                {relinkGaps.length > 0 && (
                  <>
                    {' '}
                    <strong>Scope gap:</strong>{' '}
                    {relinkGaps.map((r) => `${r.object}.${r.field} points at ${r.refObject}, which is not in this deployment`).join('; ')}
                    . Those values can only resolve to rows an earlier deployment mapped; add the object to link them in this run.
                  </>
                )}
              </div>
            ) : (
              <p className="muted">
                Some fields hold record Ids as text rather than as lookups; when a plan includes them they are
                rewritten to the target&rsquo;s Ids after the load. This plan has none.
              </p>
            )}
          </PreflightRow>

          <PreflightRow label="Stages" state="ok" summary={stagesSummary} testId="preflight-stages">
            {composed ? (
              <div role="note" data-testid="stage-list">
                <strong>
                  This run has {labels.length} stage{labels.length === 1 ? '' : 's'}:
                </strong>{' '}
                {labels.map((l, i) => `${i + 1}. ${l}`).join(' → ')}. A stage that ends blocked, failed or cancelled stops the
                sequence.
              </div>
            ) : (
              <p className="muted">
                Only the data deployment runs. Templates can run before or after it — add them on the Stages step.
              </p>
            )}
          </PreflightRow>
        </ul>
        <p className="muted deploy-gate-note">{gateNote}</p>
      </section>

      {rerun && (
        <div className="banner warn" role="note" data-testid="rerun-note">
          <strong>This deployment already ran ({status}).</strong>{' '}
          {isKeyless(config)
            ? 'Deploying again is a re-run: rows this app mapped before are updated through its id map; anything it has not mapped lands again as new rows.'
            : 'Deploying again is a re-run: rows already on the target are updated in place (matched by the External Id) and new rows are inserted.'}
        </div>
      )}

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
            !willFailAcked ||
            cpqBlocked
          }
          onClick={() =>
            void (async () => {
              if (rerun) {
                const ok = await confirm({
                  title: 'Re-run this deployment?',
                  message: isKeyless(config)
                    ? 'Without an External Id: rows this app mapped before are updated through its id map; anything it has not mapped lands again as new rows.'
                    : 'Rows already on the target are updated in place (matched by the External Id); new rows are inserted.',
                  confirmLabel: 'Re-run deploy'
                })
                if (!ok) return
              }
              const started = await deploy.mutate()
              // failure surfaces via deploy.error below; only navigate on start
              if (!started) return
              // Re-hydrate the job store BEFORE navigating: a job known only
              // through its events is a bare stub (kind 'demo', no
              // deploymentId) that useLatestJobForDeployment never matches —
              // the monitor would load once and never update (S47 review).
              await useJobsStore.getState().refresh()
              navigate(`/deployments/${deploymentId}`)
            })()
          }
        >
          {deploy.loading ? 'Starting…' : rerun ? (composed ? 'Re-run stages & deploy' : 'Re-run deploy') : composed ? 'Run stages & deploy' : 'Deploy'}
        </button>
      </div>
      {deploy.error && <p className="error">Deploy failed to start: {deploy.error.message}</p>}
    </>
  )
}

/**
 * The CPQ attestation gate — moved to shared/wizard.ts (5B.9) so the MAIN-side
 * rds:deploy.start handler enforces exactly this predicate; re-exported so
 * existing imports keep working.
 */
export { attestationBlocked }

type PreflightState = 'ok' | 'todo' | 'warn' | 'pending'

const PREFLIGHT_ICON: Record<PreflightState, IconName> = { ok: 'check', todo: 'square', warn: 'warn', pending: 'dots' }
const PREFLIGHT_WORD: Record<PreflightState, string> = {
  ok: 'Done',
  todo: 'To do',
  warn: 'Needs attention',
  pending: 'In progress'
}

/**
 * One gate of the Pre-flight card: a state glyph (decorative — the state word is
 * read by assistive tech), a label, a one-line summary and the detail behind a
 * native disclosure. `open` is applied as the initial state and re-applied only
 * when it changes, so a user who toggles the row keeps their choice.
 */
function PreflightRow({
  label,
  state,
  summary,
  open,
  testId,
  children
}: {
  label: string
  state: PreflightState
  summary: string
  open?: boolean
  testId?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <li className="preflight-row" data-state={state} data-testid={testId}>
      <details open={open || undefined}>
        <summary className="preflight-summary">
          <span className="preflight-mark" aria-hidden="true">
            <Icon name={PREFLIGHT_ICON[state]} />
          </span>
          <span className="sr-only">{PREFLIGHT_WORD[state]}: </span>
          <span className="preflight-label">{label}</span>
          <span className="preflight-line muted">{summary}</span>
        </summary>
        <div className="preflight-body">{children}</div>
      </details>
    </li>
  )
}

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
        {obj.isJunction && (
          <span className="badge badge-accent" title={GLOSSARY.junction}>
            junction
          </span>
        )}
        {obj.hasCircularReference && <Badge tone="warn">cycle</Badge>}
        {obj.requiresTriggerBypass && <Badge tone="danger">CPQ</Badge>}
      </td>
      <td className="num">{obj.recordCount.toLocaleString()}</td>
      <td>
        <Badge tone="neutral">First pass · {obj.apiStrategy}</Badge>{' '}
        {obj.deferredFields.length > 0 && (
          <span className="badge badge-neutral" title={GLOSSARY.deferred}>
            Second pass · {obj.deferredFields.length} deferred field
            {obj.deferredFields.length === 1 ? '' : 's'}
          </span>
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
