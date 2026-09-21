// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
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
    warnings: []
  }
}

let currentOrder: string[]
let reorderCalls: Array<{ deploymentId: number; objectOrder: string[] }>
let reorderFails: boolean
let selectedObjects: string[]
let storeJobs: Array<Record<string, unknown>>
let holdReorder: boolean
let releaseReorder: (() => void) | null

function install(): void {
  currentOrder = ['Account', 'Contact', 'OpportunityContactRole', 'Opportunity']
  reorderCalls = []
  reorderFails = false
  selectedObjects = ['Account', 'Contact', 'Opportunity']
  storeJobs = []
  holdReorder = false
  releaseReorder = null
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
        selectedObjects,
        readiness: readinessReady(selectedObjects)
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
    expect(screen.getByText('junction — matched, not upserted')).toBeInTheDocument()
    const junctionRow = await findRow('OpportunityContactRole')
    expect(junctionRow.draggable).toBe(false)
    expect(junctionRow.querySelector('.drag-handle')).toBeNull()
    // No move buttons on the junction row.
    expect(junctionRow.querySelector('button')).toBeNull()
    // Draggable rows really are draggable.
    expect((await findRow('Account')).draggable).toBe(true)
  })

  it('renders deferred fields as a revisit-pass badge on the object row', async () => {
    renderPlan()
    await screen.findByText(/revisit pass · 1 deferred field/)
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
