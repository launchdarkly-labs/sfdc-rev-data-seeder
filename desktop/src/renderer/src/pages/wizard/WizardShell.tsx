import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { DraftDetail } from '../../../../shared/types'
import {
  clampStep,
  isDeployBusy,
  readinessGate,
  readinessGateMessage,
  stepClosedByReadiness,
  stepIndex,
  STEP_LABELS,
  type WizardConfig,
  type WizardStep, isKeyless, visibleWizardSteps } from '../../../../shared/wizard'
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
  const requested = (step as WizardStep) ?? 'orgs'
  const resolvedStep: WizardStep | null =
    draft && config && !isDeployBusy(draft.status)
      ? (() => {
          // S54 (L1): the readiness gate closes every step after Readiness. A
          // direct URL / stale bookmark past the gate lands ON the Readiness step.
          const gate = readinessGate(config)
          const clamped0 = clampStep(requested, draft.status)
          // S61 (U-5): a keyless draft has no Readiness step — a stale link to it lands on Mappings.
          const clamped = isKeyless(config) && clamped0 === 'readiness' ? 'mappings' : clamped0
          return gate.blocked && stepClosedByReadiness(clamped) ? 'readiness' : clamped
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
  const goToStep = useCallback(
    (target: WizardStep): void => {
      const live = configRef.current
      if (!draftStatus || !live) return
      const clamped0 = clampStep(target, draftStatus)
      const clamped = isKeyless(live) && clamped0 === 'readiness' ? 'mappings' : clamped0
      // The gate is read from the LIVE config (a Readiness check that just
      // persisted opens it in the same tick).
      const liveGate = readinessGate(live)
      const dest = liveGate.blocked && stepClosedByReadiness(clamped) ? 'readiness' : clamped
      if (dest !== clamped) toast(readinessGateMessage(liveGate), 'error')
      // Flush: the pending debounced save (if any) is superseded by this write
      // of the freshest config at the destination step — exactly one save.
      cancelPendingSave()
      persistNow(dest, live)
      navigate(`/deployments/${deploymentId}/wizard/${dest}`)
    },
    [draftStatus, deploymentId, navigate, toast, cancelPendingSave, persistNow]
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

  const cap = clampStep('plan', draft.status)
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
    step: activeStep,
    config: config!,
    updateConfig,
    goToStep,
    refreshDraft,
    describe: describeCache.describe
  }

  const visible = visibleWizardSteps(config!)
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
          {visible.filter((s) => stepIndex(s) <= stepIndex(cap)).map((s) => {
            const closed = gate.blocked && stepClosedByReadiness(s)
            return (
              <button
                key={s}
                className={`wizard-step ${s === activeStep ? 'active' : ''} ${closed ? 'gated' : ''}`}
                onClick={() => goToStep(s)}
                aria-disabled={closed || undefined}
                title={closed ? readinessGateMessage(gate) : undefined}
              >
                {STEP_LABELS[s]}
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
      </div>
    </WizardContext.Provider>
  )
}
