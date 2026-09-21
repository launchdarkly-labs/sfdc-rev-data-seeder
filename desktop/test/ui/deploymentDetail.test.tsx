// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import {
  DeploymentDetailPage,
  firstLine,
  statusTone
} from '../../src/renderer/src/pages/DeploymentDetail'
import { useJobsStore } from '../../src/renderer/src/store/jobs'
import type { DeployRunStateView } from '../../src/shared/types'
import {
  MANUAL_RESTORE_STEPS,
  STALLED_NEXT_STEP,
  STALLED_TEARDOWN_MESSAGE
} from '../../src/shared/recoveryCopy'

/**
 * S46 D5-min — the deployment detail page. The first live deploy failed with
 * NOTHING persisted and a stub page; these pin the three things the minimal
 * slice must do: show the persisted status + FULL error, show a live job with
 * a Cancel that reaches the run, and never promise a recovery that does not
 * exist (manual Setup steps instead).
 */

let state: DeployRunStateView
let stateCalls = 0
let cancelled: string[] = []
let jobListCalls = 0

function base(over: Partial<DeployRunStateView> = {}): DeployRunStateView {
  return {
    deployment: {
      id: 4,
      name: 'gpr test',
      status: 'Planned',
      errorMessage: null,
      sourceLabel: 'darkb_829',
      targetLabel: 'sb1_830',
      createdAt: 1,
      updatedAt: 2
    },
    run: null,
    counters: null,
    objects: [
      {
        objectName: 'Account',
        sortOrder: 0,
        isJunction: false,
        recordCount: 1,
        recordsQueried: 0,
        recordsDeployed: 0,
        recordsFailed: 0,
        recordsSkipped: 0
      },
      {
        objectName: 'Contact',
        sortOrder: 1,
        isJunction: false,
        recordCount: 12,
        recordsQueried: 0,
        recordsDeployed: 0,
        recordsFailed: 0,
        recordsSkipped: 0
      }
    ],
    totalRecords: 13,
    cpqReminder: false,
    restoreUnconfirmed: 0,
    audit: null,
    job: null,
    ...over
  }
}

beforeEach(() => {
  useJobsStore.setState({ byId: {}, order: [] })
  stateCalls = 0
  cancelled = []
  jobListCalls = 0
  state = base()
  ;(window as unknown as { rds: unknown }).rds = {
    deployRunState: async (): Promise<DeployRunStateView> => {
      stateCalls++
      return state
    },
    jobCancel: async (jobId: string) => {
      cancelled.push(jobId)
    },
    // Main's list is authoritative: the mount-time refresh REPLACES the store
    // with it, so the stub must echo whatever the test hydrated (as main would).
    jobList: async () => {
      jobListCalls++
      return Object.values(useJobsStore.getState().byId)
    },
    onJobEvent: () => () => undefined
  }
})
afterEach(cleanup)

function renderAt(id = '4'): void {
  render(
    <MemoryRouter initialEntries={[`/deployments/${id}`]}>
      <Routes>
        <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('DeploymentDetailPage — persisted failure (the S46 incident shape)', () => {
  it('pre-run failure: status Failed, no run → "did not start" banner with the FULL error text + Back to plan', async () => {
    const error =
      'Plan freeze refused: Account: deferred field Gone__c no longer exists on the source object (stale plan) — re-run analysis before deploying;\nContact: deferred field Name is not a reference field on the current source describe (stale plan) — re-run analysis before deploying'
    state = base({ deployment: { ...base().deployment, status: 'Failed', errorMessage: error } })
    renderAt()
    expect(await screen.findByRole('heading', { name: 'gpr test' })).toBeInTheDocument()
    expect(screen.getByText('Failed', { selector: '.badge' })).toBeInTheDocument()
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Deploy did not start')
    expect(alert).toHaveTextContent('was not changed')
    // FULL text, both lines (no 255-char truncation, no first-line-only).
    expect(alert.querySelector('pre')!.textContent).toBe(error)
    expect(screen.getByRole('link', { name: 'Back to plan' })).toHaveAttribute(
      'href',
      '/deployments/4/wizard/plan'
    )
    // Fix-and-redeploy path is open from a Failed deployment.
    expect(screen.getByRole('link', { name: 'Open plan' })).toBeInTheDocument()
  })

  it('pre-run cancel: status Cancelled, no run → cancelled-before-start banner, no alert', async () => {
    state = base({ deployment: { ...base().deployment, status: 'Cancelled' } })
    renderAt()
    expect(await screen.findByText(/Cancelled before the run started/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('busy status with no run and no live job → "interrupted before the run started" (nothing touched, deploy again)', async () => {
    state = base({ deployment: { ...base().deployment, status: 'Deploying' } })
    renderAt()
    expect(await screen.findByText(/no deploy job is running in this session/)).toBeInTheDocument()
    expect(screen.getByText(/Nothing was changed on the target/)).toBeInTheDocument()
  })

  it('invalid id renders a not-found message without calling IPC', () => {
    renderAt('nope')
    expect(screen.getByText(/No deployment matches/)).toBeInTheDocument()
    expect(stateCalls).toBe(0)
  })
})

describe('DeploymentDetailPage — live run', () => {
  const running = (): DeployRunStateView =>
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
      counters: { recordsQueried: 13, recordsDeployed: 5, recordsFailed: 1, recordsSkipped: 0 },
      objects: [
        {
          objectName: 'Account',
          sortOrder: 0,
          isJunction: false,
          recordCount: 1,
          recordsQueried: 1,
          recordsDeployed: 1,
          recordsFailed: 0,
          recordsSkipped: 0
        },
        {
          objectName: 'Contact',
          sortOrder: 1,
          isJunction: false,
          recordCount: 12,
          recordsQueried: 12,
          recordsDeployed: 4,
          recordsFailed: 1,
          recordsSkipped: 0
        }
      ]
    })

  it('shows phase, progress, counters, the current object, and a Cancel that calls jobCancel', async () => {
    state = running()
    act(() =>
      useJobsStore.getState().hydrate([
        {
          id: 'job-3',
          kind: 'deploy',
          title: 'Deploy data',
          deploymentId: '4',
          status: 'running',
          startedAt: 0,
          phase: 'Deploying',
          progress: { value: 2, max: 2, label: 'Contact' }
        }
      ])
    )
    renderAt()
    expect(await screen.findByRole('heading', { name: 'gpr test' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    // KPIs
    expect(screen.getByText('deployed').previousSibling!.textContent).toBe('5')
    expect(screen.getByText('failed').previousSibling!.textContent).toBe('1')
    expect(screen.getByText('current')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cancelled).toEqual(['job-3'])
  })

  it('cancelRequested disables the button and explains the batch-boundary stop', async () => {
    state = running()
    state.run!.cancelRequested = true
    act(() =>
      useJobsStore.getState().hydrate([
        {
          id: 'job-3',
          kind: 'deploy',
          title: 'Deploy data',
          deploymentId: '4',
          status: 'running',
          startedAt: 0
        }
      ])
    )
    renderAt()
    expect(await screen.findByRole('button', { name: /Cancel requested/ })).toBeDisabled()
    expect(screen.getByText(/next batch boundary/)).toBeInTheDocument()
  })

  it('re-reads persisted state when the live job changes (event-driven, debounced — the fast path)', async () => {
    state = running()
    act(() =>
      useJobsStore.getState().hydrate([
        {
          id: 'job-3',
          kind: 'deploy',
          title: 'Deploy data',
          deploymentId: '4',
          status: 'running',
          startedAt: 0
        }
      ])
    )
    renderAt()
    await screen.findByRole('heading', { name: 'gpr test' })
    await waitFor(() => expect(stateCalls).toBeGreaterThanOrEqual(1))
    const before = stateCalls
    state = base({
      ...running(),
      deployment: {
        ...base().deployment,
        status: 'Failed',
        errorMessage: 'Deployment failed — 1 record(s) failed; see the run log.'
      },
      run: { ...running().run!, phase: 'Failed', finishedAt: 20 }
    })
    act(() =>
      useJobsStore
        .getState()
        .applyEvent({ jobId: 'job-3', kind: 'error', ts: 3, data: { message: 'x' } })
    )
    await waitFor(() => expect(stateCalls).toBeGreaterThan(before))
    expect(await screen.findByText('Deployment failed.')).toBeInTheDocument()
    expect(screen.getByText(/1 record\(s\) failed/)).toBeInTheDocument()
  })
})

describe('DeploymentDetailPage — recovery copy (E2 text: no false promises)', () => {
  it('Stalled run → the stalled message + every manual restore step; never mentions relaunch recovery', async () => {
    state = base({
      deployment: {
        ...base().deployment,
        status: 'Stalled',
        errorMessage: STALLED_TEARDOWN_MESSAGE
      },
      run: {
        id: 7,
        phase: 'Stalled',
        currentObject: null,
        currentPass: null,
        cancelRequested: false,
        teardownOutcome: 'failed',
        startedAt: 1,
        finishedAt: null
      },
      counters: { recordsQueried: 1, recordsDeployed: 1, recordsFailed: 0, recordsSkipped: 0 },
      restoreUnconfirmed: 3
    })
    renderAt()
    const alerts = await screen.findAllByRole('alert')
    const text = alerts.map((a) => a.textContent).join('\n')
    expect(text).toContain('Teardown stalled')
    expect(text).toContain('Automatic recovery is not built yet')
    for (const step of MANUAL_RESTORE_STEPS) expect(text).toContain(step)
    expect(text).not.toMatch(/Relaunching the app offers recovery/)
    expect(text).toContain('3 automation items')
  })

  it('a non-terminal run with no live job → "Run interrupted" + steps', async () => {
    state = base({
      deployment: { ...base().deployment, status: 'Restoring Automation' },
      run: {
        id: 7,
        phase: 'RestoringAutomation',
        currentObject: null,
        currentPass: null,
        cancelRequested: false,
        teardownOutcome: 'completed',
        startedAt: 1,
        finishedAt: null
      },
      counters: { recordsQueried: 1, recordsDeployed: 1, recordsFailed: 0, recordsSkipped: 0 }
    })
    renderAt()
    expect(await screen.findByText('Run interrupted.')).toBeInTheDocument()
    expect(screen.getByRole('list')).toBeInTheDocument()
  })

  it('completed CPQ run → completion banner + the uncheck-Triggers-Disabled reminder', async () => {
    state = base({
      deployment: { ...base().deployment, status: 'Completed' },
      run: {
        id: 7,
        phase: 'Completed',
        currentObject: null,
        currentPass: null,
        cancelRequested: false,
        teardownOutcome: 'completed',
        startedAt: 1,
        finishedAt: 2
      },
      counters: { recordsQueried: 13, recordsDeployed: 13, recordsFailed: 0, recordsSkipped: 0 },
      cpqReminder: true
    })
    renderAt()
    expect(await screen.findByText('Deployment completed.')).toBeInTheDocument()
    expect(screen.getByText(/uncheck it now/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('helpers', () => {
  it('statusTone maps the mirrored vocabulary', () => {
    expect(statusTone('Completed')).toBe('success')
    expect(statusTone('Failed')).toBe('danger')
    expect(statusTone('Stalled')).toBe('danger')
    expect(statusTone('Retrying')).toBe('accent')
    expect(statusTone('Restoring Automation')).toBe('accent')
    expect(statusTone('Planned')).toBe('neutral')
  })
  it('firstLine keeps the first line and caps length', () => {
    expect(firstLine('a\nb')).toBe('a')
    expect(firstLine('x'.repeat(300), 10)).toBe('x'.repeat(9) + '…')
  })
})

describe('DeploymentDetailPage — S47 review fixes', () => {
  it('re-hydrates the job store on mount (a cold-opened page re-attaches to the running deploy job)', async () => {
    renderAt()
    await screen.findByRole('heading', { name: 'gpr test' })
    await waitFor(() => expect(jobListCalls).toBeGreaterThanOrEqual(1))
  })

  it('Cancelled run with unconfirmed restore rows does NOT claim "automation was restored"', async () => {
    state = base({
      deployment: { ...base().deployment, status: 'Cancelled' },
      run: {
        id: 7,
        phase: 'Cancelled',
        currentObject: null,
        currentPass: null,
        cancelRequested: true,
        teardownOutcome: 'cancelled',
        startedAt: 1,
        finishedAt: 2
      },
      counters: { recordsQueried: 5, recordsDeployed: 3, recordsFailed: 0, recordsSkipped: 0 },
      restoreUnconfirmed: 2
    })
    renderAt()
    expect(await screen.findByText('Deployment cancelled.')).toBeInTheDocument()
    expect(screen.queryByText(/automation was restored/)).toBeNull()
    expect(screen.getByText(/did not fully confirm/)).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('2 automation items')
  })

  it('Stalled page has NO wizard link and says to create a new deployment; nothing says "see the run log"', async () => {
    state = base({
      deployment: { ...base().deployment, status: 'Stalled' },
      run: {
        id: 7,
        phase: 'Stalled',
        currentObject: null,
        currentPass: null,
        cancelRequested: false,
        teardownOutcome: 'failed',
        startedAt: 1,
        finishedAt: null
      },
      counters: { recordsQueried: 1, recordsDeployed: 1, recordsFailed: 0, recordsSkipped: 0 }
    })
    renderAt()
    await screen.findByText('Teardown stalled.')
    expect(screen.queryByRole('link', { name: /Open wizard/ })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Open plan' })).toBeNull()
    expect(screen.getByText(STALLED_NEXT_STEP)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/see the run log/)
  })

  it('Completed with residual failures points at the app database, not a non-existent run log', async () => {
    state = base({
      deployment: { ...base().deployment, status: 'Completed' },
      run: {
        id: 7,
        phase: 'Completed',
        currentObject: null,
        currentPass: null,
        cancelRequested: false,
        teardownOutcome: 'completed',
        startedAt: 1,
        finishedAt: 2
      },
      counters: { recordsQueried: 13, recordsDeployed: 12, recordsFailed: 1, recordsSkipped: 0 }
    })
    renderAt()
    expect(await screen.findByText(/1 record\(s\) still failed after retries/)).toBeInTheDocument()
    expect(document.body.textContent).toMatch(/failed_records/)
    expect(document.body.textContent).not.toMatch(/see the run log/)
  })
})

/**
 * UI-4 — the run's long tail. `emitProgress` has exactly ONE call site (the
 * first-pass walk, orchestrator.ts:335) and the restore pass emits only logs,
 * so after the first pass nothing invalidates `jobKey` except a phase change.
 * The monitor froze for minutes at a time, naming a stale phase and a stale
 * object while the run was somewhere else entirely.
 */
describe('DeploymentDetailPage — the run tail (UI-4)', () => {
  const tail = (phase: NonNullable<DeployRunStateView['run']>['phase']): DeployRunStateView =>
    base({
      deployment: { ...base().deployment, status: 'Restoring Automation' },
      run: {
        id: 9,
        phase,
        // The second pass left this set. No data object is current during
        // teardown, so showing it is the contradiction users reported.
        currentObject: 'SBQQ__Subscription__c',
        currentPass: 'second',
        cancelRequested: false,
        teardownOutcome: null,
        startedAt: 10,
        finishedAt: null
      },
      counters: { recordsQueried: 13, recordsDeployed: 13, recordsFailed: 0, recordsSkipped: 0 }
    })

  const hydrateRunning = (progress?: { value: number; max: number; label: string }): void => {
    act(() =>
      useJobsStore.getState().hydrate([
        {
          id: 'job-tail',
          kind: 'deploy',
          title: 'Deploy data',
          deploymentId: '4',
          status: 'running',
          startedAt: 0,
          ...(progress ? { progress } : {})
        }
      ])
    )
  }

  it('re-reads on a slow floor while the job runs, with NO job event at all (the frozen-tail case)', async () => {
    // Fake timers must be installed before render so the component's interval
    // is the faked one. Driven with explicit advancement rather than RTL async
    // helpers, which would need real timers to poll.
    vi.useFakeTimers()
    try {
      state = tail('RestoringAutomation')
      hydrateRunning()
      renderAt()
      // Flush mount refresh + the 400 ms debounced first read.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
      const before = stateCalls
      expect(before).toBeGreaterThanOrEqual(1)
      // The restore emits only logs: jobKey cannot change here.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(7000)
      })
      expect(stateCalls).toBeGreaterThan(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops polling once the run is no longer running (no unbounded reads after a terminal run)', async () => {
    vi.useFakeTimers()
    try {
      state = base({
        deployment: { ...base().deployment, status: 'Completed' },
        run: {
          id: 9,
          phase: 'Completed',
          currentObject: null,
          currentPass: null,
          cancelRequested: false,
          teardownOutcome: 'completed',
          startedAt: 1,
          finishedAt: 2
        }
      })
      act(() =>
        useJobsStore.getState().hydrate([
          {
            id: 'job-tail',
            kind: 'deploy',
            title: 'Deploy data',
            deploymentId: '4',
            status: 'done',
            startedAt: 0
          }
        ])
      )
      renderAt()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
      const before = stateCalls
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20000)
      })
      expect(stateCalls).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a progress event that advances only its LABEL still triggers a re-read', async () => {
    state = tail('SecondPass')
    hydrateRunning({ value: 11, max: 11, label: 'Account' })
    renderAt()
    await screen.findByRole('heading', { name: 'gpr test' })
    await waitFor(() => expect(stateCalls).toBeGreaterThanOrEqual(1))
    const before = stateCalls
    // value/max identical, label different — the shape of per-item restore
    // progress, and previously invisible to jobKey.
    act(() =>
      useJobsStore.getState().applyEvent({
        jobId: 'job-tail',
        kind: 'progress',
        ts: 4,
        data: { value: 11, max: 11, label: 'SBQQ__Subscription__c' }
      })
    )
    await waitFor(() => expect(stateCalls).toBeGreaterThan(before))
  })

  it('withdraws Cancel during teardown — the one cancel that can strand automation disabled', async () => {
    state = tail('RestoringAutomation')
    hydrateRunning()
    renderAt()
    const btn = await screen.findByRole('button', { name: /Restoring — cannot cancel/ })
    expect(btn).toBeDisabled()
    await userEvent.click(btn)
    expect(cancelled).toEqual([])
  })

  it('still offers Cancel during the data phases', async () => {
    state = base({
      deployment: { ...base().deployment, status: 'Deploying' },
      run: {
        id: 9,
        phase: 'Deploying',
        currentObject: 'Contact',
        currentPass: 'first',
        cancelRequested: false,
        teardownOutcome: null,
        startedAt: 10,
        finishedAt: null
      }
    })
    hydrateRunning()
    renderAt()
    const btn = await screen.findByRole('button', { name: 'Cancel' })
    expect(btn).toBeEnabled()
    await userEvent.click(btn)
    expect(cancelled).toEqual(['job-tail'])
  })

  it('does not name a data object while tearing down, but does during a data phase', async () => {
    state = tail('RestoringAutomation')
    hydrateRunning()
    renderAt()
    await screen.findByRole('heading', { name: 'gpr test' })
    expect(screen.getByText(/phase: RestoringAutomation/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/SBQQ__Subscription__c \(second pass\)/)

    cleanup()
    state = { ...tail('SecondPass') }
    hydrateRunning()
    renderAt()
    await screen.findByRole('heading', { name: 'gpr test' })
    expect(await screen.findByText(/SBQQ__Subscription__c/)).toBeInTheDocument()
  })
})

describe('DeploymentDetailPage — S53 automation audit + ExtId refusal link', () => {
  const completedRun = (): DeployRunStateView =>
    base({
      deployment: { ...base().deployment, status: 'Completed' },
      run: {
        id: 15,
        phase: 'Completed',
        currentObject: null,
        currentPass: null,
        cancelRequested: false,
        teardownOutcome: 'completed',
        startedAt: 1,
        finishedAt: 2
      },
      counters: { recordsQueried: 10, recordsDeployed: 10, recordsFailed: 0, recordsSkipped: 0 }
    })

  it('automation-born findings render as an alert naming each object, count and sample ids', async () => {
    state = {
      ...completedRun(),
      audit: {
        completedAt: 3,
        note: null,
        findings: [
          {
            kind: 'automation_born',
            objectApiName: 'OpportunityLineItem',
            refObject: null,
            refField: null,
            count: 59,
            sampleIds: ['00k1', '00k2']
          },
          {
            kind: 'automation_born',
            objectApiName: 'SBQQ__QuoteLine__c',
            refObject: null,
            refField: null,
            count: 137,
            sampleIds: []
          }
        ]
      }
    }
    renderAt()
    const alerts = await screen.findAllByRole('alert')
    const text = alerts.map((a) => a.textContent).join('\n')
    expect(text).toContain('Target automation created 196 records during this run.')
    expect(text).toContain('OpportunityLineItem: 59')
    expect(text).toContain('e.g. 00k1, 00k2')
    expect(text).toContain('SBQQ__QuoteLine__c: 137')
    expect(text).toContain('a re-run will neither update nor remove them')
    // Not "clean".
    expect(screen.queryByText(/No records were created by target-org automation/)).toBeNull()
  })

  it('a clean, completed audit says so in the completed banner; pre-run residue is a warning', async () => {
    state = {
      ...completedRun(),
      audit: {
        completedAt: 3,
        note: null,
        findings: [
          {
            kind: 'pre_run_unkeyed',
            objectApiName: 'SBQQ__QuoteLine__c',
            refObject: 'SBQQ__Quote__c',
            refField: 'SBQQ__Quote__c',
            count: 137,
            sampleIds: []
          }
        ]
      }
    }
    renderAt()
    expect(
      await screen.findByText(/No records were created by target-org automation during this run/)
    ).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    const warn = screen.getByText(/Before this run/).closest('.banner')!
    expect(warn.textContent).toContain('SBQQ__QuoteLine__c (137 under SBQQ__Quote__c)')
    expect(warn.textContent).toContain('cannot remove or de-duplicate them')
  })

  it('an audit that never ran is said plainly, never claimed clean', async () => {
    state = {
      ...completedRun(),
      audit: {
        completedAt: null,
        note: 'skipped: could not resolve the deploying user on the target',
        findings: []
      }
    }
    renderAt()
    expect(await screen.findByText(/post-run automation audit did not run/)).toBeInTheDocument()
    expect(screen.queryByText(/No records were created by target-org automation/)).toBeNull()
  })

  it('pre-run ExtId refusal links to the Readiness step, not the plan', async () => {
    state = base({
      deployment: {
        ...base().deployment,
        status: 'Failed',
        errorMessage:
          'Plan freeze refused: Contact has no usable Data_Deployment_External_Id__c field on the target — every record would fail on upsert. the field does not exist on the target object (create it on the Readiness step).'
      }
    })
    renderAt()
    expect(await screen.findByRole('link', { name: 'Open the Readiness step' })).toHaveAttribute(
      'href',
      '/deployments/4/wizard/readiness'
    )
    expect(screen.queryByRole('link', { name: 'Back to plan' })).toBeNull()
  })
})
