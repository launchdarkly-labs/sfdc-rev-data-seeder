// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { WizardShell } from '../../src/renderer/src/pages/wizard/WizardShell'
import { ToastProvider } from '../../src/renderer/src/ui/Toast'
import { useJobsStore } from '../../src/renderer/src/store/jobs'
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

import type { DraftDetail, JobSummary, PlanObjectView, PlanView } from '../../src/shared/types'

function planObject(
  name: string,
  order: number,
  over: Partial<PlanObjectView> = {}
): PlanObjectView {
  return {
    objectName: name,
    sortOrder: order,
    recordCount: 100,
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

const PLAN: PlanView = {
  deploymentId: 1,
  objects: [planObject('Account', 1), planObject('Contact', 2, { recordCount: 415 })],
  totalObjects: 2,
  totalRecords: 515,
  autoInjectedJunctions: [],
  warnings: []
}

const RUNNING_JOB: JobSummary = {
  id: 'job-analysis',
  kind: 'analysis',
  deploymentId: '1',
  title: 'Analyze deployment',
  status: 'running',
  startedAt: 0
}

let analyzeArgs: number[] = []
let storeJobs: JobSummary[] = []

function installStub(
  planSequence: (PlanView | null)[],
  selectedObjects = ['Account', 'Contact']
): void {
  analyzeArgs = []
  storeJobs = []
  let call = 0
  ;(window as unknown as { rds: unknown }).rds = {
    draftLoad: async (): Promise<DraftDetail> => ({
      name: 'Acme',
      sourceConnectionId: 'darkb',
      targetConnectionId: 'sb1',
      sourceLabel: 'darkb',
      targetLabel: 'sb1',
      step: 'summary',
      config: {
        ...emptyWizardConfig(),
        selectedObjects,
        readiness: readinessReady(selectedObjects)
      },
      status: 'Planned'
    }),
    draftSave: async () => undefined,
    planGet: async () => planSequence[Math.min(call++, planSequence.length - 1)] ?? null,
    analyze: async (id: number) => {
      analyzeArgs.push(id)
      storeJobs = [RUNNING_JOB] // main starts the job; jobList now reports it
      return { jobId: RUNNING_JOB.id }
    },
    jobList: async () => storeJobs,
    onJobEvent: () => () => undefined
  }
}

function renderSummary(): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/deployments/1/wizard/summary']}>
        <Routes>
          <Route path="/deployments/:id/wizard/:step" element={<WizardShell />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  )
}

beforeEach(() => act(() => useJobsStore.setState({ byId: {}, order: [] })))
afterEach(cleanup)

describe('StepSummary (5B.7 — M1 exit)', () => {
  it('renders an already-persisted plan (summary stats + object table)', async () => {
    installStub([PLAN])
    renderSummary()
    expect(await screen.findByText('2 objects')).toBeInTheDocument()
    expect(screen.getByText('515 records')).toBeInTheDocument()
    expect(screen.getByText('Account')).toBeInTheDocument()
    expect(screen.getByText('Contact')).toBeInTheDocument()
    expect(screen.getByText('415')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Re-analyze/ })).toBeInTheDocument()
  })

  it('runs analysis, then renders the plan when the job completes', async () => {
    installStub([null, PLAN]) // no plan on mount; plan after the done refetch
    const user = userEvent.setup()
    renderSummary()

    const btn = await screen.findByRole('button', { name: /Run analysis \(2 objects\)/ })
    await user.click(btn)
    await waitFor(() => expect(analyzeArgs).toEqual([1]))

    // The main process fires 'done' on the multiplexed bus; the store updates the
    // hydrated (deployment-keyed) job in place.
    act(() => {
      useJobsStore.getState().applyEvent({ jobId: RUNNING_JOB.id, kind: 'done', ts: 1, data: {} })
    })

    expect(await screen.findByText('2 objects')).toBeInTheDocument()
    expect(screen.getByText('Account')).toBeInTheDocument()
  })

  it('re-attaches to an analysis job already running for this deployment', async () => {
    installStub([null])
    // Simulate a job started before this mount (e.g. user navigated away/back).
    storeJobs = [RUNNING_JOB]
    act(() =>
      useJobsStore.setState({ byId: { [RUNNING_JOB.id]: RUNNING_JOB }, order: [RUNNING_JOB.id] })
    )
    renderSummary()
    // Without a local jobId, the store-keyed selector still shows it running.
    const btn = await screen.findByRole('button', { name: /Analyzing…/ })
    expect(btn).toBeDisabled()
  })

  it('warns when the scope changed since the last analysis', async () => {
    // Plan covers Account+Contact, but the current selection dropped Contact.
    installStub([PLAN], ['Account'])
    renderSummary()
    expect(await screen.findByText(/Scope changed since the last analysis/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Next: plan visualizer/ })).toBeDisabled()
  })

  it('shows an inline error when the analysis job fails', async () => {
    installStub([null])
    const user = userEvent.setup()
    renderSummary()
    await user.click(await screen.findByRole('button', { name: /Run analysis/ }))
    await waitFor(() => expect(analyzeArgs).toEqual([1]))

    act(() => {
      useJobsStore.getState().applyEvent({
        jobId: RUNNING_JOB.id,
        kind: 'error',
        ts: 1,
        data: { message: 'MALFORMED_QUERY on Contact' }
      })
    })
    expect(
      await screen.findByText(/Analysis failed: MALFORMED_QUERY on Contact/)
    ).toBeInTheDocument()
  })
})
