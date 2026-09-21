import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { DraftDetail } from '../../../../shared/types'
import {
  WIZARD_STEPS,
  clampStep,
  isDeployBusy,
  readinessGate,
  readinessGateMessage,
  stepClosedByReadiness,
  stepIndex,
  type WizardConfig,
  type WizardStep
} from '../../../../shared/wizard'
import { useToast } from '../../ui/Toast'
import { StepOrgs } from './StepOrgs'
import { StepObjects } from './StepObjects'
import { StepScope } from './StepScope'
import { StepReadiness } from './StepReadiness'
import { StepMappings } from './StepMappings'
import { StepFields } from './StepFields'
import { StepSummary } from './StepSummary'
import { StepPlan } from './StepPlan'

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
  /** Merge a partial config and persist (fire-and-forget with error toast). */
  updateConfig: (patch: Partial<WizardConfig>) => void
  /** Persist current config at `step` then navigate there. */
  goToStep: (step: WizardStep) => void
  /** Re-load the draft row (status/config) — e.g. after analysis flips Draft→Planned. */
  refreshDraft: () => void
}

const WizardContext = createContext<WizardContextValue | null>(null)

export function useWizard(): WizardContextValue {
  const ctx = useContext(WizardContext)
  if (!ctx) throw new Error('useWizard must be used inside <WizardShell>')
  return ctx
}

const STEP_LABELS: Record<WizardStep, string> = {
  orgs: 'Orgs',
  objects: 'Objects',
  scope: 'Scope',
  readiness: 'Readiness',
  mappings: 'Mappings',
  fields: 'Fields',
  summary: 'Summary',
  plan: 'Plan'
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
          const clamped = clampStep(requested, draft.status)
          return gate.blocked && stepClosedByReadiness(clamped) ? 'readiness' : clamped
        })()
      : null
  useEffect(() => {
    if (resolvedStep) activeStepRef.current = resolvedStep
  }, [resolvedStep])

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

  const persist = (nextStep: WizardStep, nextConfig: WizardConfig): void => {
    void window.rds
      .draftSave({ deploymentId, step: nextStep, config: nextConfig })
      .catch((e: unknown) =>
        toast(e instanceof Error ? e.message : 'Failed to save draft', 'error')
      )
  }

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
    updateConfig: (patch) => {
      // Merge over the ref, not the render snapshot — see the ref docs above.
      const next = { ...configRef.current!, ...patch }
      configRef.current = next
      setConfig(next)
      persist(activeStepRef.current, next)
    },
    goToStep: (target) => {
      const clamped = clampStep(target, draft.status)
      // The gate is read from the LIVE config (a Readiness check that just
      // persisted opens it in the same tick).
      const liveGate = readinessGate(configRef.current!)
      const dest = liveGate.blocked && stepClosedByReadiness(clamped) ? 'readiness' : clamped
      if (dest !== clamped) toast(readinessGateMessage(liveGate), 'error')
      persist(dest, configRef.current!)
      navigate(`/deployments/${deploymentId}/wizard/${dest}`)
    },
    refreshDraft
  }

  return (
    <WizardContext.Provider value={value}>
      <div className="wizard-head">
        <h1>{draft.name}</h1>
        <p className="sub">
          {draft.sourceLabel} → {draft.targetLabel} · {draft.status}
        </p>
        <nav className="wizard-steps">
          {WIZARD_STEPS.filter((s) => stepIndex(s) <= stepIndex(cap)).map((s) => {
            const closed = gate.blocked && stepClosedByReadiness(s)
            return (
              <button
                key={s}
                className={`wizard-step ${s === activeStep ? 'active' : ''} ${closed ? 'gated' : ''}`}
                onClick={() => value.goToStep(s)}
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
