// @vitest-environment jsdom
/**
 * S64 P3 — the Plan step's Pre-flight checklist (ux IA-7) and the related a11y
 * fixes: one row per gate with a state, the former banner text behind each
 * row's disclosure, a blocked ↑/↓ click announced in the live region (A-11),
 * and the keyless caution as a lead + "Learn more" (T-6 / T-16).
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { WizardShell } from '../../src/renderer/src/pages/wizard/WizardShell'
import { ToastProvider } from '../../src/renderer/src/ui/Toast'
import { emptyWizardConfig, KEYLESS_CAUTION_LEAD, KEYLESS_CAUTION_MORE, readinessScopeKey, type WizardConfig } from '../../src/shared/wizard'
import type { AutomationSnapshot, DraftDetail, PlanObjectView, PlanView } from '../../src/shared/types'

function planObj(objectName: string, over: Partial<PlanObjectView> = {}): PlanObjectView {
  return {
    objectName,
    sortOrder: 0,
    recordCount: 10,
    apiStrategy: 'REST',
    gatingTier: null,
    isJunction: false,
    hasCircularReference: false,
    deferredFields: [],
    scopedFilterDisplay: null,
    junctionParents: null,
    requiresTriggerBypass: false,
    recommendedBatchSize: 200,
    ...over
  }
}

const emptySnapshot: AutomationSnapshot = {
  items: [],
  validationRuleCount: 0,
  flowCount: 0,
  triggerCount: 0,
  duplicateRuleCount: 0,
  hasCpqTriggerSetting: false,
  cpqTriggerGatedObjects: [],
  flowScopeFallback: false,
  sectionErrors: []
}

let configOver: Partial<WizardConfig>
let snapshot: AutomationSnapshot
let storeJobs: Array<Record<string, unknown>>
let planWarnings: string[]

function install(): void {
  configOver = {}
  snapshot = emptySnapshot
  storeJobs = []
  planWarnings = []
  ;(window as unknown as { rds: unknown }).rds = {
    templateListAll: async () => [],
    draftLoad: async (): Promise<DraftDetail> => {
      const selectedObjects = ['Account', 'Contact']
      return {
        name: 'Acme',
        sourceConnectionId: 'src',
        targetConnectionId: 'tgt',
        sourceLabel: 'src',
        targetLabel: 'tgt',
        step: 'plan',
        config: {
          ...emptyWizardConfig(),
          selectedObjects,
          readiness: { scopeKey: readinessScopeKey({ selectedObjects }), ready: true, blockingObjects: [], checkedAt: '2026-10-19T00:00:00.000Z' },
          ...configOver
        },
        status: 'Planned'
      }
    },
    draftSave: async () => {},
    jobList: async () => storeJobs,
    onJobEvent: () => () => undefined,
    automationDiscover: async () => snapshot,
    planGet: async (): Promise<PlanView> => ({
      deploymentId: 1,
      objects: [planObj('Account'), planObj('Contact', { sortOrder: 1 })],
      totalObjects: 2,
      totalRecords: 20,
      autoInjectedJunctions: [],
      warnings: planWarnings
    }),
    planReorder: async () => null
  }
}

function renderPlan(): void {
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

const rowState = (id: string): string | null => screen.getByTestId(id).getAttribute('data-state')

beforeEach(install)
afterEach(cleanup)

describe('Plan step — Pre-flight checklist (IA-7)', () => {
  it('renders one row per gate, all ✓ for a clean keyed plan, with the old banners gone', async () => {
    renderPlan()
    const card = await screen.findByTestId('preflight')
    expect(within(card).getByRole('heading', { name: 'Pre-flight' })).toBeInTheDocument()
    const rows = within(card).getAllByRole('listitem')
    expect(rows.map((r) => r.querySelector('.preflight-label')?.textContent)).toEqual([
      'Automation scan',
      'CPQ “Triggers Disabled” confirmation',
      'Objects that will fail entirely',
      'Readiness',
      'Relink of text-Id fields',
      'Stages'
    ])
    await waitFor(() => expect(rowState('preflight-automation')).toBe('ok'))
    expect(screen.getByTestId('preflight-automation')).toHaveTextContent('No active automation on the target')
    expect(rowState('preflight-cpq')).toBe('ok')
    expect(screen.getByTestId('preflight-cpq')).toHaveTextContent('Not needed — no CPQ-gated objects in this run')
    expect(rowState('preflight-will-fail')).toBe('ok')
    expect(rowState('preflight-readiness')).toBe('ok')
    expect(screen.getByTestId('preflight-readiness')).toHaveTextContent(/Target ready for this scope/)
    expect(rowState('preflight-stages')).toBe('ok')
    expect(screen.getByTestId('preflight-stages')).toHaveTextContent('Data deployment only')
    // The glyphs are decorative; the state word is what assistive tech reads.
    for (const r of rows) {
      expect(r.querySelector('.preflight-mark')).toHaveAttribute('aria-hidden', 'true')
      expect(r.querySelector('.sr-only')!.textContent).toMatch(/Done|To do|Needs attention|In progress/)
    }
    // No stand-alone banners between the table and Deploy any more.
    expect(screen.queryByTestId('keyless-note')).toBeNull()
    expect(screen.queryByTestId('stage-list')).toBeNull()
    expect(screen.getByText(/Deploy freezes the plan, disables the selected automation/)).toHaveClass('deploy-gate-note')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deploy' })).toBeEnabled())
  })

  it('the automation table sits under a disclosure inside the Automation row; the panel keeps Re-scan and the masters', async () => {
    snapshot = {
      ...emptySnapshot,
      items: [
        { id: '0VR1', name: 'Opp_VR', objectName: 'Opportunity', automationType: 'ValidationRule', isActive: true, processType: null, isManagedPackage: false, restoreVersionNumber: null }
      ],
      validationRuleCount: 1
    }
    renderPlan()
    const row = await screen.findByTestId('preflight-automation')
    await waitFor(() => expect(row).toHaveAttribute('data-state', 'ok'))
    expect(row).toHaveTextContent('1 of 1 item will be disabled')
    const details = within(row).getByText(/Show the 1 discovered item/).closest('details')!
    expect(details).toHaveClass('automation-details')
    expect(within(details).getByText('Opp_VR')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Re-scan' })).toBeInTheDocument()
    expect(within(row).getByLabelText('Disable automations while deploying')).toBeChecked()
  })

  it('a will-fail warning makes its row "to do" and open, with the ack checkbox inside', async () => {
    planWarnings = ['Contact.AccountId is required and Account is not in this deployment — every Contact row will fail with REQUIRED_FIELD_MISSING. Add Account on the Scope step.']
    const user = userEvent.setup()
    renderPlan()
    const row = await screen.findByTestId('preflight-will-fail')
    await waitFor(() => expect(row).toHaveAttribute('data-state', 'todo'))
    expect(row.querySelector('details')).toHaveAttribute('open')
    expect(row).toHaveTextContent('1 object will fail entirely — acknowledge to deploy anyway')
    await user.click(within(screen.getByTestId('will-fail')).getByRole('checkbox'))
    await waitFor(() => expect(row).toHaveAttribute('data-state', 'ok'))
    expect(row).toHaveTextContent('Acknowledged')
  })

  it('a keyless draft: the Readiness row says "Without an External Id (insert-only)" with the caution as lead + Learn more', async () => {
    configOver = { useExternalIds: false, readiness: undefined }
    renderPlan()
    const row = await screen.findByTestId('preflight-readiness')
    expect(row).toHaveAttribute('data-state', 'ok')
    expect(row).toHaveTextContent('Not needed — without an External Id (insert-only)')
    const note = screen.getByTestId('keyless-note')
    expect(note).toHaveTextContent('Without an External Id (insert-only).')
    expect(note).toHaveTextContent(KEYLESS_CAUTION_LEAD)
    expect(within(note).getByText('Learn more').tagName).toBe('SUMMARY')
    expect(note).toHaveTextContent(KEYLESS_CAUTION_MORE)
    expect(note.textContent).not.toMatch(/Keyless deployment/)
  })

  // (A closed readiness gate never reaches this step through the shell — it routes back to
  // Readiness, see stepReadiness.test.tsx — so the row's warning branch is defence in depth.)

  it('A-11: a blocked ↑/↓ click announces why in the live region', async () => {
    storeJobs = [{ id: 'j1', kind: 'analysis', title: 'Analyze deployment', deploymentId: '1', status: 'running', startedAt: 1 }]
    const user = userEvent.setup()
    renderPlan()
    const btn = await screen.findByRole('button', { name: 'Move Account down' })
    await screen.findByText(/Analysis is running/)
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    await user.click(btn)
    const live = document.querySelector('[aria-live="polite"]')!
    expect(live).toHaveTextContent('Reordering is disabled while analysis runs')
  })
})
