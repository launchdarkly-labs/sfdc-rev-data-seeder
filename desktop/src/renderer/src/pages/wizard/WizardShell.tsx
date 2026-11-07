import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { DraftDetail } from '../../../../shared/types'
import {
  clampStep,
  isDeployBusy,
  readinessGate,
  readinessGateMessage,
  stepAllowedFor,
  stepClosedByReadiness,
  stepLabel,
  wizardStepsFor,
  type WizardConfig,
  type WizardStep, isKeyless } from '../../../../shared/wizard'
import { useToast } from '../../ui/Toast'
import { StepOrgs } from './StepOrgs'
import { StepTemplates } from './StepTemplates'
import { StepObjects } from './StepObjects'
import { StepScope } from './StepScope'
import { StepReadiness } from './StepReadiness'
import { StepMappings } from './StepMappings'
import { StepFields } from './StepFields'
import { StepSummary } from './StepSummary'
import { StepPlan } from './StepPlan'
import { StepReview } from './StepReview'
import { createDescribeCache, type DescribeCache } from './describeCache'

/**
 * S64 P5 (5.6e): trailing debounce on config saves. Scope's filter box and
 * Mappings' inputs call `updateConfig` per keystroke, and each save used to be a
 * full-config IPC write. `goToStep` and unmount flush a pending save at once.
 */
export const DRAFT_SAVE_DEBOUNCE_MS = 500

/** A partial config, or an updater that derives one from the FRESHEST config
 *  (the latest-value ref, never a render snapshot) — lets a memoised child keep
 *  a referentially stable callback without closing over `config`. */
export type ConfigPatch = Partial<WizardConfig> | ((prev: WizardConfig) => Partial<WizardConfig>)

interface PendingSave {
  timer: ReturnType<typeof setTimeout>
  step: WizardStep
  config: WizardConfig
}

interface WizardContextValue {
  deploymentId: number
  name: string
  sourceConnectionId: string
  targetConnectionId: string
  sourceLabel: string
  targetLabel: string
  status: string
  /** S72: how this deployment starts ('data' | 'sandboxSetup') — drives the step list. */
  kind: DraftDetail['kind']
  /** S72: the sandbox setup's data stage (readers default ?? true). */
  includeData: boolean
  step: WizardStep
  config: WizardConfig
  /** Merge a partial config (or an updater over the freshest config) and
   *  persist — debounced, fire-and-forget with error toast. Referentially
   *  stable for the life of the shell. */
  updateConfig: (patch: ConfigPatch) => void
  /** Flush any pending save, persist the current config at `step`, then navigate there. */
  goToStep: (step: WizardStep) => void
  /** Re-load the draft row (status/config) — e.g. after analysis flips Draft→Planned. */
  refreshDraft: () => void
  /** S64 P5 (5.6a): describe an object on an org through the shell-scoped cache —
   *  one IPC per connection+object for as long as this wizard stays mounted. */
  describe: DescribeCache['describe']
}

const WizardContext = createContext<WizardContextValue | null>(null)

export function useWizard(): WizardContextValue {
  const ctx = useContext(WizardContext)
  if (!ctx) throw new Error('useWizard must be used inside <WizardShell>')
  return ctx
}

export function WizardShell(): React.JSX.Element {
  const { id, step } = useParams()
  const deploymentId = Number(id)
  const navigate = useNavigate()
  const toast = useToast()

  const [draft, setDraft] = useState<DraftDetail | null | undefined>(undefined)
  const [config, setConfig] = useState<WizardConfig | null>(null)

  // Latest-value refs. `updateConfig` may be called from a DELAYED async
  // continuation (e.g. StepPlan's post-discovery attestation reset) whose
  // render-time closure would otherwise merge its patch over a STALE config
  // snapshot — silently reverting (and re-persisting) any edit the user made
  // while the async work ran, at the step they had already navigated away
  // from. The refs are written at every mutation site, so late closures always
  // merge over the freshest config and persist at the step that is actually
  // active when they land.
  const configRef = useRef<WizardConfig | null>(null)
  const activeStepRef = useRef<WizardStep>('orgs')

  // 5.6a: one describe cache per mounted shell — leaving the wizard drops it.
  const [describeCache] = useState(() => createDescribeCache())

  // 5.6e: the one pending (debounced) config save, if any.
  const pendingSaveRef = useRef<PendingSave | null>(null)

  // Reload the draft row. On the initial load it also seeds the editable config;
  // a later refresh (post-analysis) only updates the row (status), leaving the
  // user's in-progress config edits intact.
  const reloadDraft = useCallback(
    (seedConfig: boolean): (() => void) => {
      let cancelled = false
      void window.rds.draftLoad(deploymentId).then((d) => {
        if (cancelled) return
        setDraft(d)
        if (seedConfig) {
          configRef.current = d?.config ?? null
          setConfig(d?.config ?? null)
        }
      })
      return () => {
        cancelled = true
      }
    },
    [deploymentId]
  )

  useEffect(() => reloadDraft(true), [reloadDraft])

  // Stable identity so consumers can safely depend on it in effects.
  const refreshDraft = useCallback(() => void reloadDraft(false), [reloadDraft])

  // The step this render shows, or null while loading / not found / a run owns
  // the deployment. Computed HERE (before the early returns) so the effect below
  // can sync the latest-value ref without writing a ref during render
  // (react-hooks/refs). The one-commit lag is harmless: `updateConfig` fires on
  // user input, long after commit.
  //
  // S72: two fallbacks — the STATUS clamp (kind-aware cap) and the KIND's step
  // list (a stale 'summary' bookmark on a now-data-less setup lands on 'orgs';
  // `review` sits after 'summary' in WIZARD_STEPS, so the index clamp alone
  // cannot catch it).
  const requested = (step as WizardStep) ?? 'orgs'
  const resolvedStep: WizardStep | null =
    draft && config && !isDeployBusy(draft.status)
      ? (() => {
          // S54 (L1): the readiness gate closes every step after Readiness. A
          // direct URL / stale bookmark past the gate lands ON the Readiness step.
          const gate = readinessGate(config)
          let clamped = clampStep(requested, draft.status, draft.kind, config)
          // S61 (U-5): a keyless draft has no Readiness step — a stale link to
          // it lands on Mappings. (Before the kind-membership fallback, so the
          // remap wins over the generic 'orgs' fallback.)
          if (isKeyless(config) && clamped === 'readiness') clamped = 'mappings'
          // S72: a step within the cap but not offered by this KIND's wizard
          // (stale 'summary' bookmark on a now-data-less setup) → first step.
          if (!stepAllowedFor(clamped, draft.kind, config)) clamped = 'orgs'
          return gate.blocked && stepClosedByReadiness(clamped, draft.kind, config) ? 'readiness' : clamped
        })()
      : null
  useEffect(() => {
    if (resolvedStep) activeStepRef.current = resolvedStep
  }, [resolvedStep])

  // ── Saves (5.6e) ──
  const persistNow = useCallback(
    (nextStep: WizardStep, nextConfig: WizardConfig): void => {
      void window.rds
        .draftSave({ deploymentId, step: nextStep, config: nextConfig })
        .catch((e: unknown) =>
          toast(e instanceof Error ? e.message : 'Failed to save draft', 'error')
        )
    },
    [deploymentId, toast]
  )

  // Drop the pending save WITHOUT writing it. Only called right before a save of
  // the freshest config (configRef), which supersedes whatever was pending.
  const cancelPendingSave = useCallback((): void => {
    const p = pendingSaveRef.current
    if (!p) return
    clearTimeout(p.timer)
    pendingSaveRef.current = null
  }, [])

  const scheduleSave = useCallback(
    (nextStep: WizardStep, nextConfig: WizardConfig): void => {
      cancelPendingSave()
      const timer = setTimeout(() => {
        pendingSaveRef.current = null
        persistNow(nextStep, nextConfig)
      }, DRAFT_SAVE_DEBOUNCE_MS)
      pendingSaveRef.current = { timer, step: nextStep, config: nextConfig }
    },
    [cancelPendingSave, persistNow]
  )

  // Unmount flushes a pending save, so leaving the wizard (or the app closing
  // the route) never loses the last half-second of edits. `persistNow` only
  // changes with the deployment id, in which case flushing the OLD draft's
  // pending save through the old closure is exactly right.
  useEffect(
    () => () => {
      const p = pendingSaveRef.current
      if (!p) return
      clearTimeout(p.timer)
      pendingSaveRef.current = null
      persistNow(p.step, p.config)
    },
    [persistNow]
  )

  const updateConfig = useCallback(
    (patch: ConfigPatch): void => {
      // Merge over the ref, not the render snapshot — see the ref docs above.
      const prev = configRef.current!
      const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }
      configRef.current = next
      setConfig(next)
      scheduleSave(activeStepRef.current, next)
    },
    [scheduleSave]
  )

  const draftStatus = draft?.status
  const draftKind = draft?.kind
  const goToStep = useCallback(
    (target: WizardStep): void => {
      const live = configRef.current
      if (!draftStatus || !draftKind || !live) return
      let clamped = clampStep(target, draftStatus, draftKind, live)
      if (isKeyless(live) && clamped === 'readiness') clamped = 'mappings'
      if (!stepAllowedFor(clamped, draftKind, live)) clamped = 'orgs'
      // The gate is read from the LIVE config (a Readiness check that just
      // persisted opens it in the same tick).
      const liveGate = readinessGate(live)
      const dest = liveGate.blocked && stepClosedByReadiness(clamped, draftKind, live) ? 'readiness' : clamped
      if (dest !== clamped) toast(readinessGateMessage(liveGate), 'error')
      // Flush: the pending debounced save (if any) is superseded by this write
      // of the freshest config at the destination step — exactly one save.
      cancelPendingSave()
      persistNow(dest, live)
      navigate(`/deployments/${deploymentId}/wizard/${dest}`)
    },
    [draftStatus, draftKind, deploymentId, navigate, toast, cancelPendingSave, persistNow]
  )

  if (draft === undefined || (draft && !config)) {
    return <p className="muted">Loading deployment…</p>
  }
  if (draft === null) {
    return (
      <>
        <h1>Deployment not found</h1>
        <p className="sub">No deployment #{deploymentId}.</p>
      </>
    )
  }

  // S46 D1: a live run owns the deployment — the wizard never opens on it
  // (main refuses draft writes too), so a stray edit can't race the run.
  if (isDeployBusy(draft.status)) {
    return (
      <>
        <div className="wizard-head">
          <h1>{draft.name}</h1>
          <p className="sub">
            {draft.sourceLabel} → {draft.targetLabel} · {draft.status}
          </p>
        </div>
        <div className="banner warn">
          This deployment is {draft.status.toLowerCase()} — the wizard is read-only until the run
          finishes. <Link to={`/deployments/${deploymentId}`}>Open the deployment monitor</Link>.
        </div>
      </>
    )
  }

  // S73: the step list is ORDERED per kind (a sandbox setup's Setup step is
  // second), so the cap and the nav cut are positions in THIS list, never
  // indexes into WIZARD_STEPS — 'review' sits last in the base tuple and used
  // to fall off the nav for data-less setups.
  const visible = wizardStepsFor(draft.kind, config!)
  // The furthest step this status allows: the kind's last step, clamped.
  const cap = clampStep(visible[visible.length - 1]!, draft.status, draft.kind, config!)
  const shown = visible.slice(0, visible.indexOf(cap) + 1)
  const gate = readinessGate(config!)
  // Non-null past the guards above (loaded, config seeded, not busy) — the same
  // condition `resolvedStep` was computed under.
  const activeStep = resolvedStep!

  const value: WizardContextValue = {
    deploymentId,
    name: draft.name,
    sourceConnectionId: draft.sourceConnectionId,
    targetConnectionId: draft.targetConnectionId,
    sourceLabel: draft.sourceLabel,
    targetLabel: draft.targetLabel,
    status: draft.status,
    kind: draft.kind,
    includeData: draft.config.includeData !== false,
    step: activeStep,
    config: config!,
    updateConfig,
    goToStep,
    refreshDraft,
    describe: describeCache.describe
  }

  const stepNumber = visible.indexOf(activeStep) + 1

  return (
    <WizardContext.Provider value={value}>
      <div className="wizard-head">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <Link to="/">Deployments</Link>
          <span aria-hidden="true"> › </span>
          <span>{draft.name}</span>
          {draft.status !== 'Draft' && (
            <>
              <span aria-hidden="true"> · </span>
              <Link to={`/deployments/${deploymentId}`}>Monitor</Link>
            </>
          )}
        </nav>
        <h1>{draft.name}</h1>
        <p className="sub">
          {draft.sourceLabel} → {draft.targetLabel} · {draft.status} · Step {stepNumber} of {visible.length}
        </p>
        <nav className="wizard-steps">
          {shown.map((s) => {
            const closed = gate.blocked && stepClosedByReadiness(s, draft.kind, config!)
            return (
              <button
                key={s}
                className={`wizard-step ${s === activeStep ? 'active' : ''} ${closed ? 'gated' : ''}`}
                onClick={() => goToStep(s)}
                aria-disabled={closed || undefined}
                title={closed ? readinessGateMessage(gate) : undefined}
              >
                {stepLabel(s, draft)}
              </button>
            )
          })}
        </nav>
      </div>
      <div className="wizard-body">
        {activeStep === 'orgs' && <StepOrgs />}
        {activeStep === 'templates' && <StepTemplates />}
        {activeStep === 'objects' && <StepObjects />}
        {activeStep === 'scope' && <StepScope />}
        {activeStep === 'readiness' && <StepReadiness />}
        {activeStep === 'mappings' && <StepMappings />}
        {activeStep === 'fields' && <StepFields />}
        {activeStep === 'summary' && <StepSummary />}
        {activeStep === 'plan' && <StepPlan />}
        {activeStep === 'review' && <StepReview />}
      </div>
    </WizardContext.Provider>
  )
}
