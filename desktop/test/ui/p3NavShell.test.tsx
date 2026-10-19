// @vitest-environment jsdom
/**
 * S64 P3 — the sidebar footer (ux IA-14 / F-11): Idle is text; with jobs
 * running it is a button that opens a popover listing each running job with
 * its phase and a Cancel. The popover closes itself when the last job ends.
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/src/App'
import { useJobsStore } from '../../src/renderer/src/store/jobs'
import type { JobSummary } from '../../src/shared/types'

let jobCancel: ReturnType<typeof vi.fn>
/** What the shell's mount-time `refresh()` hydrates from — set BEFORE render (it would overwrite a direct hydrate). */
let jobs: JobSummary[]

beforeEach(() => {
  useJobsStore.setState({ byId: {}, order: [] })
  jobCancel = vi.fn(async () => undefined)
  jobs = []
  ;(window as unknown as { rds: unknown }).rds = {
    listOrgs: async () => [{ id: 'x' }],
    jobList: async () => jobs,
    jobCancel,
    jobDemo: async () => ({ jobId: 'job-1' }),
    onJobEvent: () => () => undefined,
    draftList: async () => [],
    templateListAll: async () => []
  }
  window.location.hash = '#/'
})
afterEach(cleanup)

const footer = (): HTMLElement => screen.getByText(/Idle|job(s)? running/).closest('.sidebar-footer') as HTMLElement

describe('sidebar footer', () => {
  it('is plain Idle text with nothing running', () => {
    render(<App />)
    expect(within(footer()).getByText('Idle')).toBeInTheDocument()
    expect(within(footer()).queryByRole('button')).toBeNull()
    expect(within(footer()).queryByRole('link')).toBeNull()
  })

  it('becomes a "N jobs running" button whose popover lists the jobs with phase and Cancel', async () => {
    const user = userEvent.setup()
    jobs = [
      { id: 'j1', kind: 'deploy', title: 'Deploy data', deploymentId: '4', status: 'running', startedAt: 0, phase: 'RestoringAutomation' },
      { id: 'j2', kind: 'template-dry-run', title: 'Dry run "Acme"', status: 'running', startedAt: 1 },
      { id: 'j3', kind: 'demo', title: 'Finished', status: 'done', startedAt: 2 }
    ]
    render(<App />)
    const toggle = await screen.findByRole('button', { name: '2 jobs running' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('dialog', { name: 'Running jobs' })).toBeNull()

    await user.click(toggle)
    const popover = screen.getByRole('dialog', { name: 'Running jobs' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(popover).getByText('Deploy data')).toBeInTheDocument()
    expect(within(popover).getByText('Restoring automation')).toBeInTheDocument() // phaseLabel, not the raw phase
    expect(within(popover).getByText('Dry run "Acme"')).toBeInTheDocument()
    expect(within(popover).queryByText('Finished')).toBeNull()

    const cancels = within(popover).getAllByRole('button', { name: 'Cancel' })
    expect(cancels).toHaveLength(2)
    await user.click(cancels[1]!)
    expect(jobCancel).toHaveBeenCalledWith('j2')

    // Toggle closes it again.
    await user.click(toggle)
    expect(screen.queryByRole('dialog', { name: 'Running jobs' })).toBeNull()
  })

  it('singular label for one job, and the popover disappears when the last job ends', async () => {
    const user = userEvent.setup()
    jobs = [{ id: 'j1', kind: 'demo', title: 'Only one', status: 'running', startedAt: 0 }]
    render(<App />)
    await user.click(await screen.findByRole('button', { name: '1 job running' }))
    expect(screen.getByRole('dialog', { name: 'Running jobs' })).toBeInTheDocument()

    act(() => useJobsStore.getState().applyEvent({ jobId: 'j1', kind: 'done', ts: 3, data: {} }))
    expect(screen.queryByRole('dialog', { name: 'Running jobs' })).toBeNull()
    expect(screen.getByText('Idle')).toBeInTheDocument()
  })
})
