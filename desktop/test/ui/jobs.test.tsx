// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { HomePage } from '../../src/renderer/src/pages/Home'
import { useJobsStore } from '../../src/renderer/src/store/jobs'
import type { DeploymentSummary, JobEvent } from '../../src/shared/types'

let deployments: DeploymentSummary[]
let listCalls = 0

beforeEach(() => {
  useJobsStore.setState({ byId: {}, order: [] })
  deployments = []
  listCalls = 0
  ;(window as unknown as { rds: unknown }).rds = {
    draftList: async (): Promise<DeploymentSummary[]> => {
      listCalls++
      return deployments
    },
    jobList: async () => [],
    jobCancel: async () => undefined,
    jobDemo: async () => ({ jobId: 'job-1' })
  }
})
afterEach(cleanup)

const ev = (kind: JobEvent['kind'], data: Record<string, unknown>): JobEvent => ({
  jobId: 'job-1',
  kind,
  ts: 1,
  data
})

function summary(over: Partial<DeploymentSummary> = {}): DeploymentSummary {
  return {
    id: 4,
    name: 'gpr test',
    sourceConnectionId: 'darkb_829',
    targetConnectionId: 'sb1_830',
    sourceLabel: 'darkb_829',
    targetLabel: 'sb1_830',
    status: 'Planned',
    errorMessage: null,
    wizardStep: 'plan',
    totalObjects: 11,
    totalRecords: 97,
    runCount: 0,
    createdAt: 1,
    updatedAt: 2,
    ...over
  }
}

const renderHome = (): ReturnType<typeof render> =>
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>
  )

describe('jobs store', () => {
  it('creates a stub summary for an event on an unknown job', () => {
    act(() => useJobsStore.getState().applyEvent(ev('progress', { value: 1, max: 4 })))
    const s = useJobsStore.getState().byId['job-1']
    expect(s).toBeDefined()
    expect(s!.status).toBe('running')
    expect(s!.progress).toEqual({ value: 1, max: 4 })
  })

  it('marks status + message on an error event', () => {
    act(() => useJobsStore.getState().applyEvent(ev('error', { message: 'kaboom' })))
    const s = useJobsStore.getState().byId['job-1']
    expect(s!.status).toBe('error')
    expect(s!.error).toBe('kaboom')
  })

  it('S46 D3: a phase event stamps the summary phase', () => {
    act(() => useJobsStore.getState().applyEvent(ev('phase', { name: 'Freezing plan' })))
    expect(useJobsStore.getState().byId['job-1']!.phase).toBe('Freezing plan')
  })
})

describe('Home job list', () => {
  it('tracks synthetic progress events through to done', () => {
    renderHome()
    expect(screen.getByText('No jobs yet.')).toBeInTheDocument()

    act(() =>
      useJobsStore
        .getState()
        .hydrate([
          { id: 'job-1', kind: 'demo', title: 'Demo job', status: 'running', startedAt: 0 }
        ])
    )
    expect(screen.getByText('Demo job')).toBeInTheDocument()
    expect(screen.getByText('running')).toBeInTheDocument()

    act(() =>
      useJobsStore
        .getState()
        .applyEvent(ev('progress', { value: 3, max: 10, label: 'Step 3 of 10' }))
    )
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '3')
    expect(screen.getByText('Step 3 of 10')).toBeInTheDocument()

    act(() => useJobsStore.getState().applyEvent(ev('done', {})))
    expect(screen.getByText('done')).toBeInTheDocument()
  })

  it('a deploy job card shows its phase and links to the deployment detail page', () => {
    renderHome()
    act(() =>
      useJobsStore.getState().hydrate([
        {
          id: 'job-2',
          kind: 'deploy',
          title: 'Deploy data',
          deploymentId: '4',
          status: 'running',
          startedAt: 0,
          phase: 'Freezing plan'
        }
      ])
    )
    expect(screen.getByRole('link', { name: 'Deploy data' })).toHaveAttribute(
      'href',
      '/deployments/4'
    )
    expect(screen.getByText(/— Freezing plan/)).toBeInTheDocument()
  })
})

describe('Home deployment list (S46 D3 — every mirrored status)', () => {
  it('lists Failed and Completed deployments with status badge, error snippet, and detail/plan links', async () => {
    deployments = [
      summary({
        id: 4,
        status: 'Failed',
        errorMessage:
          'Plan freeze refused: Account: deferred field X is not a reference field\nsecond line'
      }),
      summary({ id: 3, name: 'done one', status: 'Completed' }),
      summary({
        id: 2,
        name: 'fresh draft',
        status: 'Draft',
        wizardStep: 'scope',
        totalObjects: null,
        totalRecords: null
      })
    ]
    renderHome()
    expect(await screen.findByText('gpr test')).toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
    // First line only, full text on the title attribute.
    const snippet = screen.getByText(/Plan freeze refused/)
    expect(snippet.textContent).not.toContain('second line')
    expect(snippet).toHaveAttribute('title', expect.stringContaining('second line'))
    // Failed → detail page + plan (fix & redeploy); Draft → wizard at its step.
    expect(screen.getByRole('link', { name: 'gpr test' })).toHaveAttribute('href', '/deployments/4')
    expect(screen.getAllByRole('link', { name: 'Open plan' })[0]).toHaveAttribute(
      'href',
      '/deployments/4/wizard/plan'
    )
    expect(screen.getByRole('link', { name: 'fresh draft' })).toHaveAttribute(
      'href',
      '/deployments/2/wizard/scope'
    )
    expect(screen.getByRole('link', { name: 'Continue wizard' })).toBeInTheDocument()
  })

  it('a running deployment shows the wizard as locked (no wizard link)', async () => {
    deployments = [summary({ status: 'Deploying' })]
    renderHome()
    expect(await screen.findByText('Deploying')).toBeInTheDocument()
    expect(screen.getByText(/wizard locked/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open plan' })).toBeNull()
  })

  it('re-reads the deployment list when a job reaches a terminal status (mirrored status changed on disk)', async () => {
    deployments = [summary({ status: 'Planned' })]
    renderHome()
    expect(await screen.findByText('Planned')).toBeInTheDocument()
    // A running job appears (its own refetch) — the list is still Planned.
    act(() =>
      useJobsStore
        .getState()
        .hydrate([
          {
            id: 'job-2',
            kind: 'deploy',
            title: 'Deploy data',
            deploymentId: '4',
            status: 'running',
            startedAt: 0
          }
        ])
    )
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2))
    expect(screen.getByText('Planned')).toBeInTheDocument()
    const before = listCalls
    // ONLY NOW does the persisted status change, and the terminal event fires.
    deployments = [summary({ status: 'Failed', errorMessage: 'boom' })]
    act(() =>
      useJobsStore
        .getState()
        .applyEvent({ jobId: 'job-2', kind: 'error', ts: 2, data: { message: 'boom' } })
    )
    expect(await screen.findByText('Failed')).toBeInTheDocument()
    expect(listCalls).toBeGreaterThan(before)
  })
})
