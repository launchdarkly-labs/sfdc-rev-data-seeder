// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { HomePage } from '../../src/renderer/src/pages/Home'
import { ToastProvider } from '../../src/renderer/src/ui/Toast'
import { ConfirmProvider } from '../../src/renderer/src/ui/ConfirmDialog'
import { useJobsStore } from '../../src/renderer/src/store/jobs'
import type { DeploymentSummary, JobEvent } from '../../src/shared/types'

let deployments: DeploymentSummary[]
let listCalls = 0
let jobCancel: ReturnType<typeof vi.fn>
let draftDelete: ReturnType<typeof vi.fn>

beforeEach(() => {
  useJobsStore.setState({ byId: {}, order: [] })
  deployments = []
  listCalls = 0
  jobCancel = vi.fn(async () => undefined)
  draftDelete = vi.fn(async () => undefined)
  ;(window as unknown as { rds: unknown }).rds = {
    draftList: async (): Promise<DeploymentSummary[]> => {
      listCalls++
      return deployments
    },
    draftDelete,
    listOrgs: async () => [{ id: 'x' }],
    jobList: async () => [],
    jobCancel,
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
    sourceConnectionId: 'srcbox_829',
    targetConnectionId: 'sb1_830',
    sourceLabel: 'srcbox_829',
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
    <ToastProvider>
      <ConfirmProvider>
        <MemoryRouter>
          <HomePage />
        </MemoryRouter>
      </ConfirmProvider>
    </ToastProvider>
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

describe('Deployments page — job activity (S64 P3: one list, shared status words)', () => {
  it('tracks synthetic progress events through to done, in Title Case', async () => {
    renderHome()
    expect(await screen.findByRole('link', { name: 'create one' })).toBeInTheDocument()

    act(() =>
      useJobsStore
        .getState()
        .hydrate([{ id: 'job-1', kind: 'demo', title: 'Demo job', status: 'running', startedAt: 0 }])
    )
    const card = screen.getByTestId('job-job-1')
    expect(within(card).getByText('Demo job')).toBeInTheDocument()
    expect(within(card).getByText('Job')).toBeInTheDocument() // kind badge
    expect(within(card).getByText('Running')).toBeInTheDocument()
    expect(screen.queryByText('running')).toBeNull()

    act(() => useJobsStore.getState().applyEvent(ev('progress', { value: 3, max: 10, label: 'Step 3 of 10' })))
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '3')
    expect(screen.getByText('Step 3 of 10')).toBeInTheDocument()

    act(() => useJobsStore.getState().applyEvent(ev('done', {})))
    expect(within(card).getByText('Completed')).toBeInTheDocument()
  })

  it('a deploy job with no listed deployment is a Deployment card: phase, Monitor CTA, Cancel in the menu', async () => {
    const user = userEvent.setup()
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
    const card = screen.getByTestId('job-job-2')
    expect(within(card).getByText('Deployment')).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Deploy data' })).toHaveAttribute('href', '/deployments/4')
    expect(within(card).getByText('Freezing plan')).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Monitor' })).toHaveAttribute('href', '/deployments/4')
    await user.click(within(card).getByRole('button', { name: 'Cancel' }))
    expect(jobCancel).toHaveBeenCalledWith('job-2')
  })

  it('a template-run job is a Template run card linking to its report', () => {
    renderHome()
    act(() =>
      useJobsStore.getState().hydrate([
        {
          id: 'job-3',
          kind: 'template-apply',
          title: 'Apply "Acme dev sandbox"',
          templateId: 2,
          templateRunId: 9,
          status: 'done',
          startedAt: 0
        }
      ])
    )
    const card = screen.getByTestId('job-job-3')
    expect(within(card).getByText('Template run')).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'View report' })).toHaveAttribute('href', '/templates/2/runs/9')
    expect(within(card).getByText('Completed')).toBeInTheDocument()
  })

  it('a running job attaches to its deployment card instead of being a second card', async () => {
    deployments = [summary({ status: 'Deploying' })]
    renderHome()
    const card = await screen.findByTestId('deployment-4')
    act(() =>
      useJobsStore.getState().hydrate([
        {
          id: 'job-2',
          kind: 'deploy',
          title: 'Deploy data',
          deploymentId: '4',
          status: 'running',
          startedAt: 0,
          phase: 'Deploying',
          progress: { value: 2, max: 11, label: 'Account' }
        }
      ])
    )
    await waitFor(() => expect(screen.queryByTestId('job-job-2')).toBeNull())
    expect(within(card).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2')
    expect(within(card).getByText('Deploying records')).toBeInTheDocument() // phaseLabel
    expect(within(card).getByRole('link', { name: 'Monitor' })).toHaveAttribute('href', '/deployments/4')
    expect(within(card).getByRole('button', { name: 'Cancel run' })).toBeInTheDocument()
    expect(within(card).queryByRole('link', { name: 'Open plan' })).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Delete' })).toBeNull()
  })
})

describe('Deployments page — deployment cards (S46 D3 — every mirrored status)', () => {
  it('lists Failed, Completed and Draft with a status badge, a one-line error and one CTA each', async () => {
    const user = userEvent.setup()
    deployments = [
      summary({
        id: 4,
        status: 'Failed',
        errorMessage: 'Plan freeze refused: Account: deferred field X is not a reference field\nsecond line'
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
    expect(screen.getByText('Draft')).toBeInTheDocument()

    // First line only, full text on the title attribute; Show more expands in place.
    const snippet = screen.getByText(/Plan freeze refused/)
    expect(snippet.textContent).not.toContain('second line')
    expect(snippet.closest('.error-line')).toHaveAttribute('title', expect.stringContaining('second line'))
    await user.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByText(/second line/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument()

    // Failed → View report (detail page) with Open plan in the menu; Draft → Continue at its step.
    const failed = screen.getByTestId('deployment-4')
    expect(within(failed).getByRole('link', { name: 'gpr test' })).toHaveAttribute('href', '/deployments/4')
    expect(within(failed).getByRole('link', { name: 'View report' })).toHaveAttribute('href', '/deployments/4')
    expect(within(failed).getByRole('link', { name: 'Open plan' })).toHaveAttribute('href', '/deployments/4/wizard/plan')
    const draft = screen.getByTestId('deployment-2')
    expect(within(draft).getByRole('link', { name: 'fresh draft' })).toHaveAttribute('href', '/deployments/2/wizard/scope')
    expect(within(draft).getByRole('link', { name: 'Continue' })).toHaveAttribute('href', '/deployments/2/wizard/scope')
    expect(within(screen.getByTestId('deployment-3')).getByRole('link', { name: 'View report' })).toBeInTheDocument()
    // Exactly one primary action per card.
    for (const card of screen.getAllByTestId(/^deployment-/)) {
      expect(card.querySelectorAll('.btn.primary')).toHaveLength(1)
    }
  })

  it('a Planned deployment offers Review plan, with Details and Delete in the menu', async () => {
    const user = userEvent.setup()
    deployments = [summary({ status: 'Planned' })]
    renderHome()
    const card = await screen.findByTestId('deployment-4')
    expect(within(card).getByRole('link', { name: 'Review plan' })).toHaveAttribute('href', '/deployments/4/wizard/plan')
    expect(within(card).getByRole('link', { name: 'Details' })).toHaveAttribute('href', '/deployments/4')
    await user.click(within(card).getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete "gpr test"?' })
    expect(dialog).toHaveTextContent(/Nothing in either org is changed/)
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(draftDelete).toHaveBeenCalledWith(4))
  })

  it('a running deployment shows Monitor only — no plan link, no Delete', async () => {
    deployments = [summary({ status: 'Deploying' })]
    renderHome()
    const card = await screen.findByTestId('deployment-4')
    expect(within(card).getByText('Deploying')).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Monitor' })).toHaveAttribute('href', '/deployments/4')
    expect(within(card).queryByRole('link', { name: 'Open plan' })).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('a Stalled deployment shows View report and the manual-restore note, with no wizard link', async () => {
    deployments = [summary({ status: 'Stalled', runCount: 1 })]
    renderHome()
    const card = await screen.findByTestId('deployment-4')
    expect(within(card).getByText('Stalled')).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'View report' })).toBeInTheDocument()
    expect(within(card).getByText(/restore the target/)).toBeInTheDocument()
    expect(within(card).queryByRole('link', { name: /plan|wizard/i })).toBeNull()
  })

  it('re-reads the deployment list when a job reaches a terminal status (mirrored status changed on disk)', async () => {
    deployments = [summary({ status: 'Planned' })]
    renderHome()
    expect(await screen.findByText('Planned')).toBeInTheDocument()
    // A running job appears (its own refetch) — the list is still Planned.
    act(() =>
      useJobsStore.getState().hydrate([
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
    act(() => useJobsStore.getState().applyEvent({ jobId: 'job-2', kind: 'error', ts: 2, data: { message: 'boom' } }))
    // The deployment card flips to Failed (and the finished job becomes its own card, also Failed).
    expect(await within(await screen.findByTestId('deployment-4')).findByText('Failed')).toBeInTheDocument()
    expect(listCalls).toBeGreaterThan(before)
  })
})
