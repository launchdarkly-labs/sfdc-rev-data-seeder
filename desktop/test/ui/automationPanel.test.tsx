// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { WizardShell } from '../../src/renderer/src/pages/wizard/WizardShell'
import { ToastProvider } from '../../src/renderer/src/ui/Toast'
import { emptyWizardConfig, readinessScopeKey } from '../../src/shared/wizard'

/** S54 (L1): a Readiness verdict that OPENS the gate for exactly this scope. */
function readinessReady(objects: string[]) {
  return {
    scopeKey: readinessScopeKey({ selectedObjects: objects }),
    ready: true,
    blockingObjects: [],
    checkedAt: '2026-09-13T00:00:00.000Z'
  }
}
import type {
  AutomationItem,
  AutomationSnapshot,
  DraftDetail,
  PlanObjectView,
  PlanView
} from '../../src/shared/types'

function item(over: Partial<AutomationItem>): AutomationItem {
  return {
    id: 'id1',
    name: 'Item',
    objectName: 'Opportunity',
    automationType: 'ValidationRule',
    isActive: true,
    processType: null,
    isManagedPackage: false,
    restoreVersionNumber: null,
    ...over
  }
}

function snapshot(over: Partial<AutomationSnapshot> = {}): AutomationSnapshot {
  const items = over.items ?? [
    item({ id: '0VR1', name: 'Opp_VR', automationType: 'ValidationRule' }),
    item({ id: '301A', name: 'Opp_Flow', automationType: 'Flow' }),
    item({ id: '01q1', name: 'OppTrigger', automationType: 'ApexTrigger' }),
    item({
      id: '0Bm1',
      name: 'Account.Std_Rule',
      objectName: 'Account',
      automationType: 'DuplicateRule'
    })
  ]
  return {
    items,
    validationRuleCount: 1,
    flowCount: 1,
    triggerCount: 1,
    duplicateRuleCount: 1,
    hasCpqTriggerSetting: false,
    cpqTriggerGatedObjects: ['Contract', 'SBQQ__Quote__c'],
    flowScopeFallback: false,
    sectionErrors: [],
    ...over
  }
}

const PLAN: PlanView = {
  deploymentId: 1,
  objects: [
    {
      objectName: 'Account',
      sortOrder: 0,
      recordCount: 1,
      apiStrategy: 'REST',
      gatingTier: null,
      isJunction: false,
      hasCircularReference: false,
      deferredFields: [],
      scopedFilterDisplay: null,
      junctionParents: null,
      requiresTriggerBypass: false,
      recommendedBatchSize: 200
    } satisfies PlanObjectView
  ],
  totalObjects: 1,
  totalRecords: 1,
  autoInjectedJunctions: [],
  warnings: []
}

let saved: Array<{ step: string; config: Record<string, unknown> }>
let discoverCalls: number
let deployStartCalls: number[] = []
let jobListCalls = 0
let nextSnapshot: AutomationSnapshot
let discoverFailsOnCall: number | null
let holdDiscover: boolean
let releaseDiscover: (() => void) | null

function install(): void {
  saved = []
  discoverCalls = 0
  deployStartCalls = []
  jobListCalls = 0
  nextSnapshot = snapshot()
  discoverFailsOnCall = null
  holdDiscover = false
  releaseDiscover = null
  ;(window as unknown as { rds: unknown }).rds = {
    draftLoad: async (): Promise<DraftDetail> => ({
      name: 'Acme',
      sourceConnectionId: 'src',
      targetConnectionId: 'tgt',
      sourceLabel: 'src',
      targetLabel: 'tgt',
      step: 'plan',
      config: {
        ...emptyWizardConfig(),
        selectedObjects: ['Account'],
        readiness: readinessReady(['Account'])
      },
      status: 'Planned'
    }),
    draftSave: async (input: { step: string; config: Record<string, unknown> }) => {
      saved.push({ step: input.step, config: input.config })
    },
    jobList: async () => {
      jobListCalls++
      return []
    },
    onJobEvent: () => () => undefined,
    planGet: async (): Promise<PlanView> => PLAN,
    planReorder: async (): Promise<PlanView> => PLAN,
    automationDiscover: async (): Promise<AutomationSnapshot> => {
      discoverCalls++
      if (holdDiscover) {
        await new Promise<void>((res) => {
          releaseDiscover = res
        })
      }
      if (discoverFailsOnCall === discoverCalls) throw new Error('discovery blew up')
      return nextSnapshot
    },
    deployStart: async (deploymentId: number): Promise<{ jobId: string }> => {
      deployStartCalls.push(deploymentId)
      return { jobId: 'job-9' }
    }
  }
}

function renderPlanStep(): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/deployments/1/wizard/plan']}>
        <Routes>
          <Route path="/deployments/:id/wizard/:step" element={<WizardShell />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  )
}

const cfg = (): Record<string, unknown> => saved[saved.length - 1]!.config

beforeEach(install)
afterEach(cleanup)

describe('AutomationPanel + CPQ attestation (5B.8-b)', () => {
  it('shows the verbatim CPQ notice when gated objects exist and no legacy setting', async () => {
    renderPlanStep()
    await screen.findByText(
      'Required — disable Salesforce CPQ triggers on the target org before deploying.'
    )
    // The 4-step Setup instruction list + the gated-object summary.
    expect(screen.getByText(/Contract, SBQQ__Quote__c/)).toBeInTheDocument()
    expect(screen.getByText(/Additional Settings tab/)).toBeInTheDocument()
    expect(screen.getByText(/uncheck it/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Confirmed — I checked/)).toBeInTheDocument()
    // Deploy stays disabled and the gate note names the attestation.
    expect(screen.getByRole('button', { name: 'Deploy' })).toBeDisabled()
    expect(screen.getByText(/Deploy is blocked until you confirm/)).toBeInTheDocument()
  })

  it('checking the attestation persists cpqAttestation and clears the blocked note', async () => {
    const user = userEvent.setup()
    renderPlanStep()
    const box = await screen.findByLabelText(/Confirmed — I checked/)
    await user.click(box)
    await waitFor(() => expect(cfg().cpqAttestation).toBe(true))
    expect(screen.queryByText(/Deploy is blocked until you confirm/)).not.toBeInTheDocument()
    // 5B.9: attestation given + plan loaded → Deploy is LIVE.
    expect(screen.getByRole('button', { name: 'Deploy' })).toBeEnabled()
  })

  it('5B.9: clicking Deploy calls rds.deployStart with the deployment id', async () => {
    const user = userEvent.setup()
    renderPlanStep()
    const box = await screen.findByLabelText(/Confirmed — I checked/)
    await user.click(box)
    await waitFor(() => expect(cfg().cpqAttestation).toBe(true))
    const hydratedBefore = jobListCalls
    await user.click(screen.getByRole('button', { name: 'Deploy' }))
    await waitFor(() => expect(deployStartCalls).toEqual([1]))
    // S47: the job store is re-hydrated after start so the monitor page can
    // match the new deploy job by kind + deploymentId (not a bare event stub).
    await waitFor(() => expect(jobListCalls).toBeGreaterThan(hydratedBefore))
  })

  it('re-discovery RESETS the attestation (fresh snapshot → confirmation re-given)', async () => {
    const user = userEvent.setup()
    renderPlanStep()
    const box = await screen.findByLabelText(/Confirmed — I checked/)
    await user.click(box)
    await waitFor(() => expect(cfg().cpqAttestation).toBe(true))

    await user.click(screen.getByRole('button', { name: 'Re-scan' }))
    await waitFor(() => expect(discoverCalls).toBe(2))
    await waitFor(() => expect(cfg().cpqAttestation).toBe(false))
    expect(screen.getByLabelText(/Confirmed — I checked/)).not.toBeChecked()
  })

  it('hides the notice when the legacy CPQ trigger setting exists or nothing is gated', async () => {
    nextSnapshot = snapshot({ hasCpqTriggerSetting: true })
    renderPlanStep()
    await screen.findByText('Found:', { exact: false })
    expect(screen.queryByText(/Required — disable Salesforce CPQ triggers/)).not.toBeInTheDocument()
    expect(
      screen.getByText(/freezes the plan, disables the selected automation/)
    ).toBeInTheDocument()

    cleanup()
    install()
    nextSnapshot = snapshot({ cpqTriggerGatedObjects: [] })
    renderPlanStep()
    await screen.findByText('Found:', { exact: false })
    expect(screen.queryByText(/Required — disable Salesforce CPQ triggers/)).not.toBeInTheDocument()
  })

  it('trigger rows are non-toggleable (N/A + note); other rows toggle sparsely', async () => {
    const user = userEvent.setup()
    renderPlanStep()
    await screen.findByText('OppTrigger')
    expect(screen.getByText('(cannot toggle via API)')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Disable Apex Trigger OppTrigger/)).not.toBeInTheDocument()
    expect(screen.getByText('N/A')).toBeInTheDocument()

    // Untoggle the VR → sparse false override persisted.
    await user.click(screen.getByLabelText('Disable Validation Rule Opp_VR on Opportunity'))
    await waitFor(() =>
      expect((cfg().automationToggles as Record<string, boolean>)['ValidationRule|0VR1']).toBe(
        false
      )
    )
    // Re-toggle → the key is REMOVED (defaults stay sparse).
    await user.click(screen.getByLabelText('Disable Validation Rule Opp_VR on Opportunity'))
    await waitFor(() =>
      expect('ValidationRule|0VR1' in (cfg().automationToggles as Record<string, boolean>)).toBe(
        false
      )
    )
  })

  it('count line honors masters and per-item toggles', async () => {
    const user = userEvent.setup()
    renderPlanStep()
    // disableAutomations defaults ON, duplicate rules OFF → VR+Flow+Trigger = 3.
    await screen.findByText(/3.*item.*will be disabled|items will be disabled/)
    expect(screen.getByText('3')).toBeInTheDocument()

    // Turn the dup-rule master on → 4.
    await user.click(screen.getByLabelText('Disable duplicate rules while deploying'))
    await waitFor(() => expect(screen.getByText('4')).toBeInTheDocument())
    await waitFor(() => expect(cfg().disableDuplicateRules).toBe(true))

    // Untoggle the flow → 3.
    await user.click(screen.getByLabelText('Disable Flow Opp_Flow on Opportunity'))
    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument())
  })

  it('masters off → table hidden with the stay-active note (attestation still shown)', async () => {
    const user = userEvent.setup()
    renderPlanStep()
    await screen.findByText('Opp_VR')
    await user.click(screen.getByLabelText('Disable automations while deploying'))
    await waitFor(() => expect(screen.queryByText('Opp_VR')).not.toBeInTheDocument())
    expect(screen.getByText('Automation will stay active during the deploy.')).toBeInTheDocument()
    // The CPQ gate is independent of the masters.
    expect(screen.getByText(/Required — disable Salesforce CPQ triggers/)).toBeInTheDocument()
  })

  it('surfaces the flow org-wide fallback and section errors as warnings', async () => {
    nextSnapshot = snapshot({
      flowScopeFallback: true,
      sectionErrors: ['Duplicate rules could not be read: INVALID_TYPE']
    })
    renderPlanStep()
    await screen.findByText(/org-wide flow sweep/)
    expect(screen.getByText(/Duplicate rules could not be read/)).toBeInTheDocument()
  })

  it('pins the attestation checkbox label VERBATIM (straight quotes, LWC html:571)', async () => {
    renderPlanStep()
    await screen.findByLabelText("Confirmed — I checked 'Triggers Disabled' in the target org")
  })

  it('an empty snapshot shows the LWC no-automation note, never "Found: ."', async () => {
    nextSnapshot = snapshot({
      items: [],
      validationRuleCount: 0,
      flowCount: 0,
      triggerCount: 0,
      duplicateRuleCount: 0,
      cpqTriggerGatedObjects: []
    })
    renderPlanStep()
    await screen.findByText('No active automation found on the target org.')
    expect(screen.queryByText(/Found:/)).not.toBeInTheDocument()
  })

  it('items hidden by the masters are named as hidden, not "no automation found"', async () => {
    // Only dup rules discovered; dup master defaults OFF → table shows the hidden note.
    nextSnapshot = snapshot({
      items: [
        item({
          id: '0Bm1',
          name: 'Account.Std_Rule',
          objectName: 'Account',
          automationType: 'DuplicateRule'
        })
      ],
      validationRuleCount: 0,
      flowCount: 0,
      triggerCount: 0,
      duplicateRuleCount: 1
    })
    renderPlanStep()
    await screen.findByText(/1 discovered item is hidden by the master toggles above/)
    expect(
      screen.queryByText('No active automation found on the target org.')
    ).not.toBeInTheDocument()
  })

  it('a FAILED re-scan clears the stale snapshot and resets the attestation (LWC parity)', async () => {
    const user = userEvent.setup()
    renderPlanStep()
    const box = await screen.findByLabelText(/Confirmed — I checked/)
    await user.click(box)
    await waitFor(() => expect(cfg().cpqAttestation).toBe(true))

    discoverFailsOnCall = 2
    await user.click(screen.getByRole('button', { name: 'Re-scan' }))
    await screen.findByText(/Automation discovery failed/)
    // Stale table + notice are gone; the granted attestation is revoked.
    expect(screen.queryByText('Opp_VR')).not.toBeInTheDocument()
    expect(screen.queryByText(/Required — disable Salesforce CPQ triggers/)).not.toBeInTheDocument()
    await waitFor(() => expect(cfg().cpqAttestation).toBe(false))
  })

  it('a config edit made WHILE discovery runs survives the post-scan attestation reset', async () => {
    holdDiscover = true
    const user = userEvent.setup()
    renderPlanStep()
    // Discovery is in flight (held). Flip the dup-rules master mid-scan.
    await user.click(await screen.findByLabelText('Disable duplicate rules while deploying'))
    await waitFor(() => expect(cfg().disableDuplicateRules).toBe(true))
    // Scan completes → the attestation reset must MERGE, not clobber.
    releaseDiscover?.()
    await waitFor(() => expect(cfg().cpqAttestation).toBe(false))
    expect(cfg().disableDuplicateRules).toBe(true)
  })
})
