// @vitest-environment jsdom
/**
 * S64 P5 — the renderer side of "measure first, then the safe wins":
 *  - 5.5a the job store returns the SAME state for a `log` event, so pages
 *    subscribed to a job no longer re-render once per log line;
 *  - 5.4  the Deployment page and the template run report read their snapshot
 *    through ONE guarded path: overlapping triggers coalesce into at most one
 *    in-flight + one trailing read, and a stale response never overwrites a
 *    newer one; the report's live log publishes a burst of lines in one render;
 *  - 5.1  the per-phase duration strip from the persisted `run_phases` stamps.
 */
import '@testing-library/jest-dom/vitest'
import { Profiler } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, Link } from 'react-router-dom'
import {
  DeploymentDetailPage,
  peakMemoryLine,
  phaseSegments
} from '../../src/renderer/src/pages/DeploymentDetail'
import { TemplateRunReportPage } from '../../src/renderer/src/pages/templates/TemplateRunReportPage'
import { useJob, useJobsStore, useLatestJobForDeployment } from '../../src/renderer/src/store/jobs'
import { ToastProvider } from '../../src/renderer/src/ui/Toast'
import { ConfirmProvider } from '../../src/renderer/src/ui/ConfirmDialog'
import type { DeployRunStateView, JobEvent, JobSummary } from '../../src/shared/types'
import type { TemplateRunStateView, TemplateRunSummary } from '../../src/shared/templates/types'

type Resolve<T> = (value: T) => void

const deployJob = (over: Partial<JobSummary> = {}): JobSummary => ({
  id: 'job-3',
  kind: 'deploy',
  title: 'Deploy data',
  deploymentId: '4',
  status: 'running',
  startedAt: 0,
  ...over
})

const logEvent = (jobId: string, i: number): JobEvent => ({
  jobId,
  kind: 'log',
  ts: i,
  data: { level: 'info', message: `line ${i}` }
})

const progressEvent = (jobId: string, i: number): JobEvent => ({
  jobId,
  kind: 'progress',
  ts: i,
  data: { value: i, max: 100, label: `Object ${i}` }
})

function base(over: Partial<DeployRunStateView> = {}): DeployRunStateView {
  return {
    deployment: {
      id: 4,
      name: 'gpr test',
      status: 'Planned',
      errorMessage: null,
      sourceLabel: 'srcbox_829',
      targetLabel: 'sb1_830',
      createdAt: 1,
      updatedAt: 2
    },
    run: null,
    counters: null,
    objects: [],
    totalRecords: 0,
    cpqReminder: false,
    restoreUnconfirmed: 0,
    audit: null,
    job: null,
    ...over
  }
}

const runningState = (): DeployRunStateView =>
  base({
    deployment: { ...base().deployment, status: 'Deploying' },
    run: {
      id: 7,
      phase: 'Deploying',
      currentObject: 'Contact',
      currentPass: 'first',
      cancelRequested: false,
      teardownOutcome: null,
      startedAt: 10,
      finishedAt: null
    },
    counters: { recordsQueried: 13, recordsDeployed: 5, recordsFailed: 0, recordsSkipped: 0 }
  })

const completedState = (over: Partial<NonNullable<DeployRunStateView['run']>> = {}): DeployRunStateView =>
  base({
    deployment: { ...base().deployment, status: 'Completed' },
    run: {
      id: 15,
      phase: 'Completed',
      currentObject: null,
      currentPass: null,
      cancelRequested: false,
      teardownOutcome: 'completed',
      startedAt: 0,
      finishedAt: 40_000,
      ...over
    },
    counters: { recordsQueried: 10, recordsDeployed: 10, recordsFailed: 0, recordsSkipped: 0 }
  })

let stateCalls = 0
let rds: Record<string, unknown>

beforeEach(() => {
  useJobsStore.setState({ byId: {}, order: [] })
  stateCalls = 0
  rds = {
    deployRunState: async (): Promise<DeployRunStateView> => {
      stateCalls++
      return base()
    },
    jobCancel: async () => undefined,
    // Main's list is authoritative: the mount-time refresh REPLACES the store
    // with it, so the stub echoes whatever the test hydrated (as main would).
    jobList: async () => Object.values(useJobsStore.getState().byId),
    onJobEvent: () => () => undefined
  }
  ;(window as unknown as { rds: unknown }).rds = rds
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function renderDetail(id = '4'): void {
  render(
    <MemoryRouter initialEntries={[`/deployments/${id}`]}>
      <Routes>
        <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
      </Routes>
    </MemoryRouter>
  )
}

/** Resolve the next pending read with `value` and let the promise chain settle under fake timers. */
async function settle<T>(resolve: Resolve<T>, value: T): Promise<void> {
  await act(async () => {
    resolve(value)
    await vi.advanceTimersByTimeAsync(0)
  })
}

// ── 5.5a ─────────────────────────────────────────────────────────────────────

describe('jobs store — log events are not state changes (5.5a)', () => {
  it('a log for a known job returns the SAME state: same byId, same summary reference', () => {
    act(() => useJobsStore.getState().hydrate([deployJob()]))
    const before = useJobsStore.getState()
    const summary = before.byId['job-3']
    act(() => useJobsStore.getState().applyEvent(logEvent('job-3', 1)))
    const after = useJobsStore.getState()
    expect(after.byId['job-3']).toBe(summary)
    expect(after.byId).toBe(before.byId)
    expect(after.order).toBe(before.order)
  })

  it('a log for an UNKNOWN job still creates the stub (how a page learns a job exists before hydrate)', () => {
    act(() => useJobsStore.getState().applyEvent(logEvent('job-new', 1)))
    const stub = useJobsStore.getState().byId['job-new']
    expect(stub).toBeDefined()
    expect(stub!.status).toBe('running')
    expect(useJobsStore.getState().order).toEqual(['job-new'])
  })

  it('useJob / useLatestJobForDeployment subscribers do not re-render on log lines, and still do on progress', () => {
    const renders = { job: 0, latest: 0 }
    function JobWatcher(): React.JSX.Element {
      renders.job++
      const j = useJob('job-3')
      return <span data-testid="job-status">{j?.status ?? 'none'}</span>
    }
    function LatestWatcher(): React.JSX.Element {
      renders.latest++
      const j = useLatestJobForDeployment(4, 'deploy')
      return <span data-testid="latest-progress">{j?.progress?.value ?? 'none'}</span>
    }
    act(() => useJobsStore.getState().hydrate([deployJob()]))
    render(
      <>
        <JobWatcher />
        <LatestWatcher />
      </>
    )
    const before = { ...renders }
    act(() => {
      for (let i = 0; i < 40; i++) useJobsStore.getState().applyEvent(logEvent('job-3', i))
    })
    expect(renders).toEqual(before)
    expect(screen.getByTestId('job-status')).toHaveTextContent('running')

    act(() => useJobsStore.getState().applyEvent(progressEvent('job-3', 7)))
    expect(renders.job).toBe(before.job + 1)
    expect(renders.latest).toBe(before.latest + 1)
    expect(screen.getByTestId('latest-progress')).toHaveTextContent('7')
  })
})

// ── 5.4 — Deployment page ────────────────────────────────────────────────────

describe('DeploymentDetailPage — one guarded refresh path (5.4)', () => {
  it('coalesces: a burst of job events plus the 3 s poll while a read is pending costs at most ONE trailing read', async () => {
    vi.useFakeTimers()
    const pendingReads: Array<Resolve<DeployRunStateView>> = []
    rds.deployRunState = (): Promise<DeployRunStateView> => {
      stateCalls++
      return new Promise<DeployRunStateView>((res) => pendingReads.push(res))
    }
    act(() => useJobsStore.getState().hydrate([deployJob()]))
    renderDetail()
    // Mount: the store refresh + the first (immediate) read.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(stateCalls).toBe(1)

    // 12 progress events 500 ms apart (each past the 400 ms debounce) = 12
    // event-driven requests, plus 3+ poll ticks over the same 10 s window —
    // every one of them while the first read is still in flight.
    for (let i = 1; i <= 12; i++) {
      act(() => useJobsStore.getState().applyEvent(progressEvent('job-3', i)))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(stateCalls).toBe(1)

    // The first read settles → exactly one trailing read, carrying the latest truth.
    await settle(pendingReads[0]!, runningState())
    expect(stateCalls).toBe(2)
    expect(screen.getByRole('heading', { name: 'gpr test' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '12')

    // Nothing else was requested while the trailing read is pending; settling
    // it with no new trigger issues nothing further until the next poll tick.
    await settle(pendingReads[1]!, runningState())
    expect(stateCalls).toBe(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100)
    })
    expect(stateCalls).toBe(3) // the floor, exactly one tick later
  })

  it('a terminal job event that lands while a read is pending still gets its own final read, so the terminal state renders', async () => {
    vi.useFakeTimers()
    const pendingReads: Array<Resolve<DeployRunStateView>> = []
    rds.deployRunState = (): Promise<DeployRunStateView> => {
      stateCalls++
      return new Promise<DeployRunStateView>((res) => pendingReads.push(res))
    }
    act(() => useJobsStore.getState().hydrate([deployJob()]))
    renderDetail()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(stateCalls).toBe(1)

    act(() => useJobsStore.getState().applyEvent({ jobId: 'job-3', kind: 'done', ts: 9, data: {} }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(stateCalls).toBe(1) // requested, not issued — the first read is still out

    // The stale first read resolves with the pre-terminal snapshot…
    await settle(pendingReads[0]!, runningState())
    expect(stateCalls).toBe(2) // …and the requested final read goes out
    await settle(pendingReads[1]!, completedState())
    expect(screen.getByText('Deployment completed.')).toBeInTheDocument()
    // The job is done: no poll afterwards.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(stateCalls).toBe(2)
  })

  it('a response for the PREVIOUS deployment that resolves late is dropped (sequence check on a key change)', async () => {
    const reads = new Map<number, Resolve<DeployRunStateView>>()
    rds.deployRunState = (id: number): Promise<DeployRunStateView> => {
      stateCalls++
      return new Promise<DeployRunStateView>((res) => reads.set(id, res))
    }
    render(
      <MemoryRouter initialEntries={['/deployments/4']}>
        <Link to="/deployments/5">go five</Link>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    )
    await waitFor(() => expect(reads.has(4)).toBe(true))
    fireEvent.click(screen.getByRole('link', { name: 'go five' }))
    await waitFor(() => expect(reads.has(5)).toBe(true))

    await act(async () => {
      reads.get(5)!(base({ deployment: { ...base().deployment, id: 5, name: 'five' } }))
    })
    expect(await screen.findByRole('heading', { name: 'five' })).toBeInTheDocument()

    // The old read lands AFTER the new one: it must not overwrite the page.
    await act(async () => {
      reads.get(4)!(base({ deployment: { ...base().deployment, id: 4, name: 'four' } }))
    })
    expect(screen.getByRole('heading', { name: 'five' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'four' })).toBeNull()
    expect(stateCalls).toBe(2)
  })
})

// ── 5.1 — the phase strip ────────────────────────────────────────────────────

describe('phaseSegments / peakMemoryLine (5.1)', () => {
  it('needs two stamps, merges adjacent identical phases, and gives terminal stamps no segment', () => {
    expect(phaseSegments(undefined, null, 0, false)).toEqual([])
    expect(phaseSegments([{ phase: 'Deploying', at: 0 }], null, 0, false)).toEqual([])
    const segs = phaseSegments(
      [
        { phase: 'DisablingAutomation', at: 0 },
        { phase: 'Deploying', at: 10_000 },
        { phase: 'Deploying', at: 20_000 }, // re-entered: merged with the one before
        { phase: 'Retrying', at: 30_000 },
        { phase: 'Deploying', at: 35_000 }, // re-entered after another phase: its own segment
        { phase: 'Completed', at: 40_000 }
      ],
      40_000,
      99_999,
      false
    )
    expect(segs).toEqual([
      { phase: 'DisablingAutomation', start: 0, end: 10_000, current: false },
      { phase: 'Deploying', start: 10_000, end: 30_000, current: false },
      { phase: 'Retrying', start: 30_000, end: 35_000, current: false },
      { phase: 'Deploying', start: 35_000, end: 40_000, current: false }
    ])
  })

  it('the last stamp runs to finishedAt, else to now while running, else stays open', () => {
    const stamps = [
      { phase: 'Connecting', at: 0 },
      { phase: 'Deploying', at: 5_000 }
    ]
    expect(phaseSegments(stamps, 9_000, 50_000, false)[1]).toEqual({ phase: 'Deploying', start: 5_000, end: 9_000, current: false })
    expect(phaseSegments(stamps, null, 50_000, true)[1]).toEqual({ phase: 'Deploying', start: 5_000, end: 50_000, current: true })
    // A stranded run: no clock to run it to — the duration renders as "—".
    expect(phaseSegments(stamps, null, 50_000, false)[1]).toEqual({ phase: 'Deploying', start: 5_000, end: null, current: false })
    // A stalled teardown is a stamp too (no finishedAt — a segment for it would grow forever).
    expect(phaseSegments([...stamps, { phase: 'Stalled', at: 7_000 }], null, 50_000, false)).toEqual([
      { phase: 'Connecting', start: 0, end: 5_000, current: false },
      { phase: 'Deploying', start: 5_000, end: 7_000, current: false }
    ])
  })

  it('the post-run audit (after Completed) runs to the Finished stamp, never to the earlier finishedAt (lead fix)', () => {
    const stamps = [
      { phase: 'RestoringAutomation', at: 1_000 },
      { phase: 'Completed', at: 5_000 },
      { phase: 'Auditing target', at: 5_200 },
      { phase: 'Finished', at: 9_000 }
    ]
    expect(phaseSegments(stamps, 5_000, 50_000, false)).toEqual([
      { phase: 'RestoringAutomation', start: 1_000, end: 5_000, current: false },
      { phase: 'Auditing target', start: 5_200, end: 9_000, current: false }
    ])
    // Without the Finished stamp (a job that died in the audit) the span is open, not negative.
    expect(phaseSegments(stamps.slice(0, 3), 5_000, 50_000, false)).toEqual([
      { phase: 'RestoringAutomation', start: 1_000, end: 5_000, current: false },
      { phase: 'Auditing target', start: 5_200, end: null, current: false }
    ])
    expect(phaseSegments(stamps.slice(0, 3), 5_000, 50_000, true)).toEqual([
      { phase: 'RestoringAutomation', start: 1_000, end: 5_000, current: false },
      { phase: 'Auditing target', start: 5_200, end: 50_000, current: true }
    ])
  })

  it('peak memory lists main, renderer, gpu first, then any other process, and is null when absent', () => {
    expect(peakMemoryLine(null)).toBeNull()
    expect(peakMemoryLine(undefined)).toBeNull()
    expect(peakMemoryLine({})).toBeNull()
    expect(peakMemoryLine({ utility: 50, gpu: 120.4, main: 310, renderer: 220 })).toBe(
      'Peak memory: main 310 MB · renderer 220 MB · gpu 120 MB · utility 50 MB'
    )
    expect(peakMemoryLine({ main: 1234.6 })).toBe('Peak memory: main 1,235 MB')
  })
})

describe('DeploymentDetailPage — phase strip (5.1)', () => {
  it('renders one labelled segment per phase span on a completed run, plus the memory line', async () => {
    rds.deployRunState = async (): Promise<DeployRunStateView> =>
      completedState({
        phases: [
          { phase: 'DisablingAutomation', at: 0 },
          { phase: 'Deploying', at: 10_000 },
          { phase: 'Deploying', at: 20_000 },
          { phase: 'Retrying', at: 30_000 },
          { phase: 'Deploying', at: 35_000 },
          { phase: 'Completed', at: 40_000 }
        ],
        peakMemoryMB: { gpu: 120.4, main: 310, renderer: 220 }
      })
    renderDetail()
    const strip = await screen.findByRole('region', { name: 'Run phases' })
    const items = within(strip).getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual([
      'Disabling automation10s',
      'Deploying records20s',
      'Retrying failed rows5s',
      'Deploying records5s'
    ])
    // Raw phase names stay on title; no segment is "current" once the run is over.
    expect(items[0]).toHaveAttribute('title', 'DisablingAutomation')
    expect(strip.querySelector('[aria-current="step"]')).toBeNull()
    expect(within(strip).getByTestId('peak-memory')).toHaveTextContent(
      'Peak memory: main 310 MB · renderer 220 MB · gpu 120 MB'
    )
  })

  it('marks the open last segment while the job runs and keeps its duration ticking with the page clock', async () => {
    const T0 = Date.UTC(2026, 9, 19, 12, 0, 0)
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    const live = runningState()
    live.run!.phases = [
      { phase: 'Connecting', at: T0 - 100_000 },
      { phase: 'Deploying', at: T0 - 65_400 }
    ]
    rds.deployRunState = async (): Promise<DeployRunStateView> => live
    act(() => useJobsStore.getState().hydrate([deployJob()]))
    renderDetail()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    const strip = screen.getByRole('region', { name: 'Run phases' })
    const items = within(strip).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Connecting35s')
    expect(items[0]).not.toHaveAttribute('aria-current')
    expect(items[1]).toHaveAttribute('aria-current', 'step')
    expect(items[1]).toHaveClass('current')
    expect(items[1]).toHaveTextContent(/Deploying records1m 5s/)
    // The once-a-second clock moves the open segment on.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(within(strip).getAllByRole('listitem')[1]).toHaveTextContent(/Deploying records1m 7s/)
  })

  it('renders no strip for a pre-014 run (no phases) or a single stamp', async () => {
    rds.deployRunState = async (): Promise<DeployRunStateView> => completedState()
    renderDetail()
    await screen.findByRole('heading', { name: 'gpr test' })
    expect(screen.queryByTestId('phase-strip')).toBeNull()

    cleanup()
    rds.deployRunState = async (): Promise<DeployRunStateView> =>
      completedState({ phases: [{ phase: 'Completed', at: 40_000 }], peakMemoryMB: null })
    renderDetail()
    await screen.findByRole('heading', { name: 'gpr test' })
    expect(screen.queryByTestId('phase-strip')).toBeNull()
  })
})

// ── 5.4 — template run report ────────────────────────────────────────────────

function templateRun(over: Partial<TemplateRunSummary> = {}): TemplateRunSummary {
  return {
    id: 9,
    templateId: 1,
    templateKind: 'seed',
    templateName: 'Acme CPQ configuration',
    mode: 'apply',
    state: 'running',
    sourceConnectionId: 'srcbox',
    sourceLabel: 'srcbox',
    targetConnectionId: 'tgt_a',
    targetLabel: 'tgt_a',
    targetOrgId: '00Dtgt_a000000000AAA',
    jobId: 'job-1',
    startedAt: 200,
    finishedAt: null,
    deploymentId: null,
    ...over
  }
}

function templateState(): TemplateRunStateView {
  return {
    run: templateRun(),
    snapshot: {},
    steps: { automation: false, seeds: [{ name: 'Acme CPQ configuration', groups: [] }], optInPatches: [] },
    options: { disableTargetAutomation: true, cpqAttestation: true, purge: false, resume: false },
    report: null,
    job: null,
    unrestoredTemporary: 0
  }
}

const templateJob = (over: Partial<JobSummary> = {}): JobSummary => ({
  id: 'job-1',
  kind: 'template-apply',
  title: 'Apply "Acme CPQ configuration"',
  templateId: 1,
  templateRunId: 9,
  status: 'running',
  startedAt: 0,
  ...over
})

function renderReport(onCommit?: () => void): void {
  render(
    <ToastProvider>
      <ConfirmProvider>
        <MemoryRouter initialEntries={['/templates/1/runs/9']}>
          <Profiler id="report" onRender={() => onCommit?.()}>
            <Routes>
              <Route path="/templates/:id/runs/:runId" element={<TemplateRunReportPage />} />
            </Routes>
          </Profiler>
        </MemoryRouter>
      </ConfirmProvider>
    </ToastProvider>
  )
}

describe('TemplateRunReportPage — guarded refresh + batched log (5.4)', () => {
  beforeEach(() => {
    rds.templateRunState = vi.fn(async () => templateState())
    rds.templateGet = vi.fn(async () => null)
    rds.jobList = vi.fn(async () => [])
  })

  it('a burst of log lines is published in ONE render and keeps the last 400, with the errors-only filter intact', async () => {
    let handler: ((e: JobEvent) => void) | null = null
    rds.onJobEvent = (cb: (e: JobEvent) => void) => {
      handler = cb
      return () => undefined
    }
    const commits = { n: 0 }
    renderReport(() => commits.n++)
    await screen.findByRole('heading', { name: 'Apply: Acme CPQ configuration' })
    await waitFor(() => expect(handler).not.toBeNull())
    // Let the mount-time reads (template, job list) settle before counting.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    const before = commits.n

    act(() => {
      for (let i = 0; i < 450; i++) {
        handler!({ jobId: 'job-1', kind: 'log', ts: i, data: { level: i % 100 === 0 ? 'error' : 'info', message: `line ${i}` } })
      }
      handler!({ jobId: 'other', kind: 'log', ts: 0, data: { level: 'error', message: 'not this run' } })
    })
    const log = await screen.findByTestId('run-log')
    // Ring buffer: 450 in, the last 400 kept (50…449).
    expect(within(log).queryByText('line 49')).toBeNull()
    expect(within(log).getByText('line 50')).toBeInTheDocument()
    expect(within(log).getByText('line 449')).toBeInTheDocument()
    expect(within(log).queryByText('not this run')).toBeNull()
    expect(screen.getByTestId('log-cap')).toHaveTextContent('showing the last 400 lines')
    // One flush → one commit for the whole burst (not 450).
    expect(commits.n - before).toBeLessThanOrEqual(2)

    fireEvent.click(screen.getByLabelText('Errors and warnings only'))
    expect(within(log).queryByText('line 51')).toBeNull()
    expect(within(log).getByText('line 100')).toBeInTheDocument()
    expect(within(log).getByText('line 400')).toBeInTheDocument()
  })

  it('coalesces templateRunState reads: events + the poll while a read is pending issue at most one trailing read', async () => {
    vi.useFakeTimers()
    let calls = 0
    const pendingReads: Array<Resolve<TemplateRunStateView>> = []
    rds.templateRunState = (): Promise<TemplateRunStateView> => {
      calls++
      if (calls === 1) return Promise.resolve(templateState())
      return new Promise<TemplateRunStateView>((res) => pendingReads.push(res))
    }
    renderReport()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(calls).toBe(1)
    expect(screen.getByRole('heading', { name: 'Apply: Acme CPQ configuration' })).toBeInTheDocument()

    // The live job appears → one debounced read, which we hold open.
    act(() => useJobsStore.getState().hydrate([templateJob()]))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    expect(calls).toBe(2)

    for (let i = 1; i <= 10; i++) {
      act(() => useJobsStore.getState().applyEvent(progressEvent('job-1', i)))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500)
      })
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(calls).toBe(2)

    await settle(pendingReads[0]!, templateState())
    expect(calls).toBe(3)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '10')
  })
})
