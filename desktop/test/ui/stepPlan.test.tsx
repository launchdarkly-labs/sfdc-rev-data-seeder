// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { WizardShell } from '../../src/renderer/src/pages/wizard/WizardShell'
import { ToastProvider } from '../../src/renderer/src/ui/Toast'
import { emptyWizardConfig, readinessScopeKey } from '../../src/shared/wizard'
import { GLOSSARY } from '../../src/shared/labels'
/** S54 (L1): a Readiness verdict that OPENS the gate for exactly this scope. */
function readinessReady(objects: string[]) {
  return {
    scopeKey: readinessScopeKey({ selectedObjects: objects }),
    ready: true,
    blockingObjects: [],
    checkedAt: '2026-09-13T00:00:00.000Z'
  }
}

import type { DraftDetail, PlanObjectView, PlanView } from '../../src/shared/types'

/**
 * Fixture-local slot-refill: every test sends a full permutation of the
 * non-junction names, so the refill reduces to "walk the current order,
 * junction keeps its slot, other slots take the desired names in sequence".
 * The real algorithm's goldens live in test/planReorder.test.ts (pure lane);
 * this mock only mirrors what the main handler returns to the UI.
 */
function refillMock(current: string[], desired: string[]): string[] {
  const queue = [...desired]
  return current.map((n) => (n === 'OpportunityContactRole' ? n : (queue.shift() ?? n)))
}

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

/** Account → Contact → OCR (junction) → Opportunity, with a revisit pass on Contact. */
function makePlan(names?: string[]): PlanView {
  const order = names ?? ['Account', 'Contact', 'OpportunityContactRole', 'Opportunity']
  return {
    deploymentId: 1,
    objects: order.map((n, i) =>
      planObj(n, {
        sortOrder: i,
        isJunction: n === 'OpportunityContactRole',
        deferredFields: n === 'Contact' ? ['ReportsToId'] : []
      })
    ),
    totalObjects: order.length,
    totalRecords: order.length * 10,
    autoInjectedJunctions: ['OpportunityContactRole'],
    warnings: planWarnings
  }
}

let currentOrder: string[]
let reorderCalls: Array<{ deploymentId: number; objectOrder: string[] }>
let reorderFails: boolean
let selectedObjects: string[]
let storeJobs: Array<Record<string, unknown>>
let holdReorder: boolean
let releaseReorder: (() => void) | null
/** S62: plan warnings the stubbed planGet returns, and template stages on the draft. */
let planWarnings: string[]
let templateSteps: import('../../src/shared/wizard').TemplateStepsConfig | undefined

function install(): void {
  currentOrder = ['Account', 'Contact', 'OpportunityContactRole', 'Opportunity']
  reorderCalls = []
  reorderFails = false
  selectedObjects = ['Account', 'Contact', 'Opportunity']
  storeJobs = []
  holdReorder = false
  releaseReorder = null
  planWarnings = []
  templateSteps = undefined
  ;(window as unknown as { rds: unknown }).rds = {
    // S62: the Plan step reads seed templates' gated objects only when stages are configured.
    templateListAll: async () => [
      { id: 3, kind: 'seed', name: 'LD CPQ configuration', description: null, builtFrom: null, detail: '', seedGroups: ['cpq'], cpqGatedObjects: ['SBQQ__PriceRule__c'], createdAt: 1, updatedAt: 1, lastRun: null }
    ],
    draftLoad: async (): Promise<DraftDetail> => ({
      name: 'Acme',
      sourceConnectionId: 'src',
      targetConnectionId: 'tgt',
      sourceLabel: 'src',
      targetLabel: 'tgt',
      step: 'plan',
      config: {
        ...emptyWizardConfig(),
        selectedObjects,
        readiness: readinessReady(selectedObjects),
        ...(templateSteps ? { templateSteps } : {})
      },
      status: 'Planned'
    }),
    draftSave: async () => {},
    jobList: async () => storeJobs,
    onJobEvent: () => () => undefined,
    automationDiscover: async () => ({
      items: [],
      validationRuleCount: 0,
      flowCount: 0,
      triggerCount: 0,
      duplicateRuleCount: 0,
      hasCpqTriggerSetting: false,
      cpqTriggerGatedObjects: [],
      flowScopeFallback: false,
      sectionErrors: []
    }),
    planGet: async (): Promise<PlanView> => makePlan(currentOrder),
    planReorder: async (input: {
      deploymentId: number
      objectOrder: string[]
    }): Promise<PlanView> => {
      if (reorderFails) throw new Error('boom')
      reorderCalls.push(input)
      // Optional hold: lets a test assert the busy re-entry guard.
      if (holdReorder) {
        await new Promise<void>((res) => {
          releaseReorder = res
        })
      }
      // Mirror the main-side handler: slot-refill over the persisted order.
      currentOrder = refillMock(currentOrder, input.objectOrder)
      return makePlan(currentOrder)
    }
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

function rowName(r: HTMLTableRowElement): string {
  const text = r.cells[1]?.textContent ?? ''
  return (
    text
      .trim()
      .split(/[\s⋮]+/)
      .filter(Boolean)[0] ?? ''
  )
}

/** Body rows of the PLAN table only (the automation panel renders its own table). */
function planRows(): HTMLTableRowElement[] {
  const table = document.querySelector('table.plan-order')
  if (!table) return []
  return Array.from(table.querySelectorAll('tbody tr')) as HTMLTableRowElement[]
}

async function findRow(name: string): Promise<HTMLTableRowElement> {
  let row: HTMLTableRowElement | undefined
  await waitFor(() => {
    row = planRows().find((r) => rowName(r) === name)
    expect(row).toBeDefined()
  })
  return row as HTMLTableRowElement
}

function rowOrder(): string[] {
  return planRows().map(rowName)
}

beforeEach(install)
afterEach(cleanup)

describe('StepPlan (5B.8-a)', () => {
  it('renders the plan in deploy order; junction is labeled and non-draggable', async () => {
    renderPlan()
    await screen.findByRole('heading', { name: 'Deployment plan' })
    await waitFor(() =>
      expect(rowOrder()).toEqual(['Account', 'Contact', 'OpportunityContactRole', 'Opportunity'])
    )
    // T-5: the badge says "junction" and carries the glossary line; a legend repeats it once.
    const badge = screen.getByTitle(GLOSSARY.junction)
    expect(badge).toHaveTextContent('junction')
    expect(screen.getByText(GLOSSARY.junction, { exact: false, selector: '.legend' })).toBeInTheDocument()
    const junctionRow = await findRow('OpportunityContactRole')
    expect(junctionRow.draggable).toBe(false)
    expect(junctionRow.querySelector('.drag-handle')).toBeNull()
    // No move buttons on the junction row.
    expect(junctionRow.querySelector('button')).toBeNull()
    // Draggable rows really are draggable.
    expect((await findRow('Account')).draggable).toBe(true)
  })

  it('renders deferred fields as a second-pass badge on the object row (T-15 wording)', async () => {
    renderPlan()
    const badge = await screen.findByText(/Second pass · 1 deferred field/)
    expect(badge).toHaveAttribute('title', GLOSSARY.deferred)
    expect(screen.getAllByText(/First pass · REST/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/revisit pass/)).toBeNull()
  })

  it('move-down sends the slot-refill order (junction excluded) and re-renders the result', async () => {
    const user = userEvent.setup()
    renderPlan()
    await user.click(await screen.findByRole('button', { name: 'Move Account down' }))
    await waitFor(() => expect(reorderCalls).toHaveLength(1))
    // Draggable order was [Account, Contact, Opportunity]; Account moved down one.
    expect(reorderCalls[0]!.objectOrder).toEqual(['Contact', 'Account', 'Opportunity'])
    // Junction slot (index 2) untouched by the refill.
    await waitFor(() =>
      expect(rowOrder()).toEqual(['Contact', 'Account', 'OpportunityContactRole', 'Opportunity'])
    )
  })

  it('drag-and-drop reorders via slot-refill', async () => {
    renderPlan()
    const opp = await findRow('Opportunity')
    const account = await findRow('Account')
    fireEvent.dragStart(opp)
    fireEvent.dragOver(account)
    fireEvent.drop(account)
    await waitFor(() => expect(reorderCalls).toHaveLength(1))
    // Opportunity dropped onto Account's position (front of the draggable list).
    expect(reorderCalls[0]!.objectOrder).toEqual(['Opportunity', 'Account', 'Contact'])
    await waitFor(() =>
      expect(rowOrder()).toEqual(['Opportunity', 'Account', 'OpportunityContactRole', 'Contact'])
    )
  })

  it('surfaces a reorder failure as a banner and keeps the old order', async () => {
    reorderFails = true
    const user = userEvent.setup()
    renderPlan()
    await user.click(await screen.findByRole('button', { name: 'Move Account down' }))
    await screen.findByText(/Reorder failed/)
    expect(rowOrder()).toEqual(['Account', 'Contact', 'OpportunityContactRole', 'Opportunity'])
  })

  it('shows a warning when there is no analyzed plan', async () => {
    ;(window as unknown as { rds: { planGet: () => Promise<null> } }).rds.planGet = async () => null
    renderPlan()
    await screen.findByText(/No analyzed plan/)
  })

  it('ignores external drags: dragover without our dragstart never highlights or reorders', async () => {
    renderPlan()
    const account = await findRow('Account')
    // No dragStart on any row — simulates a Finder-file / text-selection drag.
    fireEvent.dragOver(account)
    expect(account.className).not.toContain('drop-target')
    fireEvent.drop(account)
    expect(reorderCalls).toHaveLength(0)
  })

  it('a second click while a reorder is in flight is a no-op (focusable aria-disabled guard)', async () => {
    holdReorder = true
    const user = userEvent.setup()
    renderPlan()
    const btn = await screen.findByRole('button', { name: 'Move Account down' })
    await user.click(btn)
    await waitFor(() => expect(reorderCalls).toHaveLength(1))
    // The button is NOT hard-disabled (keyboard focus survives) but the guard
    // refuses re-entry while the first reorder is awaiting.
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    expect(btn).not.toBeDisabled()
    await user.click(btn)
    expect(reorderCalls).toHaveLength(1)
    releaseReorder?.()
    await waitFor(() =>
      expect(rowOrder()).toEqual(['Contact', 'Account', 'OpportunityContactRole', 'Opportunity'])
    )
  })

  it('scope drift blocks reordering with a warning (header nav bypasses the Summary gate)', async () => {
    selectedObjects = ['Account', 'Contact', 'Opportunity', 'SBQQ__Quote__c'] // drifted
    const user = userEvent.setup()
    renderPlan()
    await screen.findByText(/Scope changed since the last analysis/)
    await user.click(screen.getByRole('button', { name: 'Move Account down' }))
    expect(reorderCalls).toHaveLength(0)
  })

  it('a running analysis for this deployment blocks reordering with a banner', async () => {
    storeJobs = [
      {
        id: 'j1',
        kind: 'analysis',
        title: 'Analyze deployment',
        deploymentId: '1',
        status: 'running',
        startedAt: 1
      }
    ]
    const user = userEvent.setup()
    renderPlan()
    await screen.findByText(/Analysis is running/)
    await user.click(screen.getByRole('button', { name: 'Move Account down' }))
    expect(reorderCalls).toHaveLength(0)
  })
})


describe('StepPlan — S62-1 whole-object failure acknowledgement', () => {
  const WILL_FAIL =
    'CampaignMember.CampaignId is required and Campaign is not in this deployment — every CampaignMember row will fail with REQUIRED_FIELD_MISSING. Add Campaign on the Scope step.'
  it('a will-fail warning renders in its own alert and keeps Deploy disabled until acknowledged', async () => {
    planWarnings = ['Auto-promoted 2 reference field(s) from skip → externalId on Account (…)', WILL_FAIL]
    renderPlan()
    await screen.findByRole('heading', { name: 'Deployment plan' })
    const block = await screen.findByTestId('will-fail')
    expect(block).toHaveTextContent('1 object will fail entirely')
    expect(block).toHaveTextContent(WILL_FAIL)
    // The routine notice is NOT in the block.
    expect(block).not.toHaveTextContent('Auto-promoted')
    const deploy = screen.getByRole('button', { name: 'Deploy' })
    await waitFor(() => expect(deploy).toBeDisabled())
    expect(screen.getByText(/blocked until you acknowledge/)).toBeInTheDocument()
    await userEvent.click(within(block).getByRole('checkbox'))
    await waitFor(() => expect(deploy).toBeEnabled())
  })
  it('no will-fail warning → no block, Deploy as before', async () => {
    planWarnings = ['Auto-promoted 2 reference field(s) from skip → externalId on Account (…)']
    renderPlan()
    await screen.findByRole('heading', { name: 'Deployment plan' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deploy' })).toBeEnabled())
    expect(screen.queryByTestId('will-fail')).toBeNull()
  })
})

describe('StepPlan — S62 (U-2) composed deployments', () => {
  it('lists the stages in run order, relabels the button, and makes a seed’s gated objects demand the attestation', async () => {
    templateSteps = {
      before: [
        { templateId: 4, name: 'LD dev sandbox', kind: 'postRefresh', steps: { automation: true, seeds: [{ name: 'LD CPQ configuration', groups: [] }], optInPatches: [] } }
      ],
      after: []
    }
    renderPlan()
    await screen.findByRole('heading', { name: 'Deployment plan' })
    const list = await screen.findByTestId('stage-list')
    expect(list).toHaveTextContent('This run has 2 stages')
    expect(list).toHaveTextContent('1. LD dev sandbox → 2. Data deployment')
    const btn = screen.getByRole('button', { name: 'Run stages & deploy' })
    // Discovery found no gated objects, but the embedded seed brings SBQQ__PriceRule__c — attestation required.
    await waitFor(() => expect(btn).toBeDisabled())
    expect(screen.getByText(/blocked until you confirm the CPQ/)).toBeInTheDocument()
  })
})

describe('StepPlan — S63 text-Id relink notice', () => {
  it('names the text-Id fields the run will relink; no listed object → no notice', async () => {
    currentOrder = ['Account', 'SBQQ__Quote__c', 'SBQQ__Subscription__c']
    selectedObjects = [...currentOrder]
    renderPlan()
    await screen.findByRole('heading', { name: 'Deployment plan' })
    const note = await screen.findByTestId('relink-notice')
    expect(note).toHaveTextContent('5 text fields that hold record Ids will be relinked after the data lands')
    expect(note).toHaveTextContent('SBQQ__Subscription__c.SBQQ__RequiredById__c')
    expect(note).toHaveTextContent('SBQQ__Quote__c.SBQQ__PricebookId__c')
    expect(note).not.toHaveTextContent('Scope gap')
    // No scope gap → the Pre-flight row is a plain ✓, not a warning.
    expect(note.closest('.preflight-row')).toHaveAttribute('data-state', 'ok')
    expect(screen.getByTestId('preflight-relink')).toHaveTextContent('Relink of 5 text-Id fields')
  })
  it('plain Account/Contact plan → no notice, and the row says so', async () => {
    currentOrder = ['Account', 'Contact']
    selectedObjects = [...currentOrder]
    renderPlan()
    await screen.findByRole('heading', { name: 'Deployment plan' })
    expect(screen.queryByTestId('relink-notice')).toBeNull()
    expect(screen.getByTestId('preflight-relink')).toHaveTextContent('No text fields in this plan hold record Ids')
  })
})
