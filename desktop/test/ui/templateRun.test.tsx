// @vitest-environment jsdom
/**
 * S59 — the run form (/templates/:id/run) and the report page: Apply disabled
 * until a dry run of this revision on this target ends without blockers; the
 * dry-run caveat verbatim on the form and in the Apply confirm; the purge
 * confirm requires the alias; the CPQ attestation block appears for CPQ
 * objects; the report renders its tables and the Resume / Restore actions.
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, within, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { TemplateRunPage, applyUnlockedBy, splitLead } from '../../src/renderer/src/pages/templates/TemplateRunPage'
import { TemplateRunReportPage } from '../../src/renderer/src/pages/templates/TemplateRunReportPage'
import { useJobsStore } from '../../src/renderer/src/store/jobs'
import { ToastProvider } from '../../src/renderer/src/ui/Toast'
import { ConfirmProvider } from '../../src/renderer/src/ui/ConfirmDialog'
import type { JobSummary, OrgConnection } from '../../src/shared/types'
import {
  DRY_RUN_CAVEAT,
  type TemplateDetail,
  type TemplateReport,
  type TemplateRunInput,
  type TemplateRunStateView,
  type TemplateRunSummary
} from '../../src/shared/templates/types'
import { SAMPLE_POST_REFRESH_TEMPLATE, SAMPLE_SEED_TEMPLATE } from '../../src/shared/templates/samples'

function org(id: string, role: OrgConnection['role']): OrgConnection {
  return {
    id,
    label: id,
    cliAlias: id,
    loginUrl: null,
    username: `${id}@x`,
    orgId: `00D${id}000000000AAA`.slice(0, 18),
    instanceUrl: '',
    role,
    authKind: 'cli',
    status: 'Active',
    cliStatus: 'Connected',
    isSandbox: true,
    lastVerifiedAt: null,
    prodPinned: false,
    supersededBy: null
  }
}
const ORGS = [org('srcbox', 'source'), org('sb3', 'target')]

const SEED: TemplateDetail = {
  id: 1,
  kind: 'seed',
  name: 'Acme CPQ configuration',
  description: null,
  builtFrom: { orgId: ORGS[0]!.orgId, label: 'srcbox' },
  detail: '36 objects in 2 groups',
  seedGroups: ['default', 'forms'],
  cpqGatedObjects: ['SBQQ__BlockPrice__c', 'SBQQ__PriceRule__c'],
  createdAt: 1,
  updatedAt: 100,
  lastRun: null,
  payload: SAMPLE_SEED_TEMPLATE
}

const POST: TemplateDetail = {
  id: 2,
  kind: 'postRefresh',
  name: 'Acme dev sandbox',
  description: null,
  builtFrom: null,
  detail: '3 flows, 2 triggers, 2 setting patches, 1 seed template',
  seedGroups: [],
  cpqGatedObjects: [],
  createdAt: 1,
  updatedAt: 100,
  lastRun: null,
  payload: SAMPLE_POST_REFRESH_TEMPLATE
}

function run(over: Partial<TemplateRunSummary>): TemplateRunSummary {
  return {
    id: 9,
    templateId: 1,
    templateKind: 'seed',
    templateName: 'Acme CPQ configuration',
    mode: 'dry-run',
    state: 'clean',
    sourceConnectionId: 'srcbox',
    sourceLabel: 'srcbox',
    targetConnectionId: 'sb3',
    targetLabel: 'sb3',
    targetOrgId: ORGS[1]!.orgId,
    jobId: 'job-1',
    startedAt: 200,
    finishedAt: 260,
    deploymentId: null,
    ...over
  }
}

let runs: TemplateRunSummary[]
let started: TemplateRunInput[]
let runState: TemplateRunStateView
let restored: number[]

function report(over: Partial<TemplateReport> = {}): TemplateReport {
  return {
    schemaVersion: 1,
    mode: 'apply',
    state: 'failed',
    startedAt: 200,
    finishedAt: 260,
    preflight: { blockers: [], notes: ['target sb3: Acme Dev (sandbox, 00Dsb3000000000)'] },
    automation: [],
    settingPatches: [],
    safetyCheck: null,
    targetAutomation: { planned: 2, disabled: 2, restored: 1, unconfirmed: 1, items: [] },
    purge: null,
    seed: [
      {
        object: 'SBQQ__BlockPrice__c',
        group: 'default',
        source: 40,
        loaded: 38,
        failed: 2,
        skipped: 0,
        nulled: 0,
        fields: 12,
        resumed: 0,
        failures: [{ recordId: 'a0B1', message: 'UNKNOWN_EXCEPTION: boom' }],
        skips: [],
        nulledFields: {},
        noAccess: [],
        missingOnTarget: [],
        savedOnSingleRetry: 12,
        bulkOnlyFailures: 2,
        skippedObject: null,
        note: null,
        pruned: null,
        bytes: null
      }
    ],
    secondPass: [],
    relink: [],
    verify: { counts: [{ object: 'SBQQ__BlockPrice__c', source: 40, loaded: 38, target: 38, gap: true }], dangling: [], parity: [] },
    problems: [],
    summary: {
      unexpected: 2,
      expected: 0,
      unexpectedGroups: [{ step: 'seed', object: 'SBQQ__BlockPrice__c', count: 2, example: 'UNKNOWN_EXCEPTION: boom', why: null }],
      expectedGroups: [],
      nextAction: 'resume',
      batchSizeSuggestions: [{ object: 'SBQQ__BlockPrice__c', reason: '12 rows saved only on the single-record retry' }]
    },
    ...over
  }
}

beforeEach(() => {
  runs = []
  started = []
  restored = []
  runState = {
    run: run({ id: 9, mode: 'apply', state: 'failed' }),
    snapshot: {},
    steps: { automation: false, seeds: [{ name: 'Acme CPQ configuration', groups: [] }], optInPatches: [] },
    options: { disableTargetAutomation: true, cpqAttestation: true, purge: false, resume: false },
    report: report(),
    job: null,
    unrestoredTemporary: 1
  }
  useJobsStore.setState({ byId: {}, order: [] })
  ;(window as unknown as { rds: unknown }).rds = {
    templateGet: vi.fn(async (id: number) => (id === POST.id ? POST : SEED)),
    listOrgs: vi.fn(async () => ORGS),
    templateListAll: vi.fn(async () => [{ ...SEED, payload: undefined }, { ...POST, payload: undefined }]),
    templateRuns: vi.fn(async () => runs),
    templateRun: vi.fn(async (input: TemplateRunInput) => {
      started.push(input)
      return { jobId: 'job-2', runId: 42 }
    }),
    templateRunState: vi.fn(async () => runState),
    templateRestoreAutomation: vi.fn(async (id: number) => {
      restored.push(id)
      return { jobId: 'job-3' }
    }),
    templateSaveRunnable: vi.fn(async (input: { payload: unknown }) => ({ ...SEED, payload: input.payload })),
    jobList: vi.fn(async () => []),
    jobCancel: vi.fn(async () => undefined),
    onJobEvent: () => () => undefined
  }
})
afterEach(cleanup)

function renderAt(path: string): void {
  render(
    <ToastProvider>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/templates/:id/run" element={<TemplateRunPage />} />
            <Route path="/templates/:id/runs/:runId" element={<TemplateRunReportPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </ToastProvider>
  )
}

const job = (over: Partial<JobSummary>): JobSummary => ({ id: 'job-1', kind: 'template-dry-run', title: 'Dry run', status: 'done', startedAt: 200, templateId: 1, templateRunId: 9, ...over })

describe('applyUnlockedBy (D8)', () => {
  it('needs a terminal dry run of THIS revision on THIS target without blockers, in this session', () => {
    const t = { id: 1, updatedAt: 100 }
    expect(applyUnlockedBy(t, 'sb3', [], [run({})])).toBe(false) // no job this session
    expect(applyUnlockedBy(t, 'sb3', [job({})], [run({})])).toBe(true)
    expect(applyUnlockedBy(t, 'other', [job({})], [run({})])).toBe(false) // other target
    expect(applyUnlockedBy(t, 'sb3', [job({})], [run({ state: 'blocked' })])).toBe(false)
    expect(applyUnlockedBy(t, 'sb3', [job({})], [run({ startedAt: 50 })])).toBe(false) // older revision
    expect(applyUnlockedBy(t, 'sb3', [job({ status: 'running' })], [run({ state: 'running' })])).toBe(false)
    expect(applyUnlockedBy(t, 'sb3', [job({ status: 'error' })], [run({ state: 'failed' })])).toBe(true) // failed-not-blocked unlocks
    expect(applyUnlockedBy(t, 'sb3', [job({ kind: 'template-apply' })], [run({ mode: 'apply' })])).toBe(false)
  })
})

describe('TemplateRunPage', () => {
  it('shows the caveat verbatim, the CPQ attestation for CPQ objects, defaults target + source, and starts a dry run', async () => {
    const user = userEvent.setup()
    renderAt('/templates/1/run')
    expect(await screen.findByRole('heading', { name: 'Run: Acme CPQ configuration' })).toBeInTheDocument()
    // T-16: the first sentence leads; the rest sits behind "Learn more" (the confirm shows the full text).
    const [lead, more] = splitLead(DRY_RUN_CAVEAT)
    expect(more).not.toBe('')
    const caveat = screen.getByTestId('dry-run-caveat')
    expect(caveat).toHaveTextContent(lead)
    expect(caveat).toHaveTextContent(more)
    expect(within(caveat).getByText('Learn more').tagName).toBe('SUMMARY')
    expect(screen.getByLabelText('Target org')).toHaveValue('sb3')
    expect(screen.getByLabelText('Source org')).toHaveValue('srcbox')
    expect(screen.getByRole('alert')).toHaveTextContent(/disable Salesforce CPQ triggers on the target org before applying/)
    expect(screen.getByText(/Seed: Acme CPQ configuration/)).toBeInTheDocument()
    expect(screen.getByLabelText('forms')).toBeChecked()
    // Apply is locked until a dry run.
    const apply = screen.getByRole('button', { name: 'Apply' })
    expect(apply).toBeDisabled()
    expect(screen.getByText(/Apply unlocks after a dry run of this revision on sb3/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dry run' }))
    await waitFor(() => expect(started).toHaveLength(1))
    expect(started[0]).toMatchObject({
      templateId: 1,
      mode: 'dry-run',
      targetConnectionId: 'sb3',
      sourceConnectionId: 'srcbox',
      steps: { seeds: [{ name: 'Acme CPQ configuration', groups: ['default', 'forms'] }] },
      options: { disableTargetAutomation: true, cpqAttestation: false, purge: false, resume: false }
    })
  })

  it('a post-refresh template shows the CPQ attestation for its EMBEDDED seed, and hides it when the seed is unticked', async () => {
    const user = userEvent.setup()
    renderAt('/templates/2/run')
    expect(await screen.findByRole('heading', { name: 'Run: Acme dev sandbox' })).toBeInTheDocument()
    // The gated list comes from the seed's summary (main resolves it), not from the post-refresh payload.
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/disable Salesforce CPQ triggers on the target org before applying/)
    expect(alert).toHaveTextContent(/SBQQ__BlockPrice__c, SBQQ__PriceRule__c/)
    await user.click(screen.getByLabelText(/^Seed: Acme CPQ configuration/))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Apply unlocks after a clean dry run this session, and the confirm repeats the caveat', async () => {
    const user = userEvent.setup()
    runs = [run({})]
    renderAt('/templates/1/run')
    await screen.findByRole('heading', { name: 'Run: Acme CPQ configuration' })
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    act(() => useJobsStore.getState().hydrate([job({})]))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(DRY_RUN_CAVEAT)
    expect(dialog).toHaveTextContent(/This WRITES to sb3 from srcbox/)
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(started.map((s) => s.mode)).toEqual(['apply']))
  })

  it('purge needs the target alias typed; Resume appears when a non-clean apply exists on this target', async () => {
    const user = userEvent.setup()
    runs = [run({ id: 12, mode: 'apply', state: 'failed' })]
    renderAt('/templates/1/run')
    await screen.findByRole('heading', { name: 'Run: Acme CPQ configuration' })
    await user.click(screen.getByLabelText(/Purge existing rows/))
    expect(screen.getByRole('button', { name: 'Dry run' })).toBeDisabled()
    await user.type(screen.getByLabelText('Purge confirmation'), 'sb3')
    expect(screen.getByRole('button', { name: 'Dry run' })).toBeEnabled()
    expect(screen.getByLabelText(/Resume from the last apply/)).toBeDisabled() // purge and resume exclude each other
    await user.click(screen.getByLabelText(/Purge existing rows/))
    await user.click(screen.getByLabelText(/Resume from the last apply/))
    // History lists the run (checked before Dry run navigates to the report page).
    expect(within(screen.getByRole('table', { name: 'Run history' })).getByText('#12')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dry run' }))
    await waitFor(() => expect(started).toHaveLength(1))
    expect(started[0]!.options).toMatchObject({ purge: false, resume: true })
  })
})

describe('TemplateRunPage — S61 UAT fixes', () => {
  it('U-9: "run again" (?from=) starts from THAT run’s target, source, steps and options — never the first target in the list', async () => {
    const rds = (window as unknown as { rds: Record<string, unknown> }).rds
    rds.listOrgs = vi.fn(async () => [org('other', 'target'), ...ORGS]) // 'other' is first — the old default
    runState = {
      ...runState,
      run: run({ id: 9, mode: 'dry-run', state: 'clean', targetConnectionId: 'sb3', sourceConnectionId: 'srcbox' }),
      steps: { automation: false, seeds: [{ name: 'Acme CPQ configuration', groups: ['default'] }], optInPatches: [] },
      options: { disableTargetAutomation: false, cpqAttestation: true, purge: true, resume: false }
    }
    renderAt('/templates/1/run?from=9')
    await screen.findByRole('heading', { name: 'Run: Acme CPQ configuration' })
    expect(screen.getByLabelText('Target org')).toHaveValue('sb3')
    expect(screen.getByLabelText('Source org')).toHaveValue('srcbox')
    expect(screen.getByLabelText('default')).toBeChecked()
    expect(screen.getByLabelText('forms')).not.toBeChecked() // the run's groups, not the template's default
    expect(screen.getByLabelText(/Disable the target/)).not.toBeChecked()
    expect(screen.getByLabelText(/Purge existing rows/)).toBeChecked()
    expect(screen.getByLabelText('Purge confirmation')).toHaveValue('') // the alias is retyped every time
    expect(screen.getByLabelText(/Confirmed — I checked/)).not.toBeChecked() // the attestation is never carried over
  })

  it('U-9: a preset target that is no longer a Target connection leaves the pick EMPTY and says so', async () => {
    runState = { ...runState, run: run({ id: 9, targetConnectionId: 'gone', targetLabel: 'gone' }) }
    renderAt('/templates/1/run?from=9')
    await screen.findByRole('heading', { name: 'Run: Acme CPQ configuration' })
    expect(screen.getByLabelText('Target org')).toHaveValue('')
    expect(screen.getAllByRole('alert').some((a) => /targeted gone, which is no longer a Target connection/.test(a.textContent ?? ''))).toBe(true)
    expect(screen.getByRole('button', { name: 'Dry run' })).toBeDisabled()
  })

  it('U-4: Source is listed before Target on the run form, and the history table shows Source before Target', async () => {
    runs = [run({})]
    renderAt('/templates/1/run')
    await screen.findByRole('heading', { name: 'Run: Acme CPQ configuration' })
    const selects = screen.getAllByRole('combobox')
    expect(selects[0]).toHaveAccessibleName('Source org')
    expect(selects[1]).toHaveAccessibleName('Target org')
    const headers = within(screen.getByRole('table', { name: 'Run history' })).getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers.indexOf('Source')).toBe(headers.indexOf('Target') - 1)
  })
})

describe('TemplateRunReportPage', () => {
  it('renders the summary, seed table, verify gaps, the batch-size suggestion with Apply to template, Resume, and Restore target automation', async () => {
    const user = userEvent.setup()
    renderAt('/templates/1/runs/9')
    expect(await screen.findByRole('heading', { name: 'Apply: Acme CPQ configuration' })).toBeInTheDocument()
    expect(screen.getByText('failed')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/1 temporary automation item this run disabled on sb3 is not confirmed restored/)
    expect(screen.getByText('unexpected problems').previousSibling).toHaveTextContent('2')
    expect(screen.getByTestId('batch-suggestions')).toHaveTextContent(/set batchSize 1 for SBQQ__BlockPrice__c/)
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument()
    expect(screen.getByText('gap')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Apply to template' }))
    const rds = (window as unknown as { rds: { templateSaveRunnable: ReturnType<typeof vi.fn> } }).rds
    await waitFor(() => expect(rds.templateSaveRunnable).toHaveBeenCalled())
    const payload = rds.templateSaveRunnable.mock.calls[0]![0].payload as { tiers: Array<{ object: string; batchSize?: number }> }
    expect(payload.tiers.find((t) => t.object === 'SBQQ__BlockPrice__c')!.batchSize).toBe(1)
    await user.click(screen.getByRole('button', { name: 'Restore target automation' }))
    await waitFor(() => expect(restored).toEqual([9]))
  })

  it('a running job shows the phase and a Cancel that reaches the job (with visible helper text)', async () => {
    const user = userEvent.setup()
    runState = { ...runState, run: run({ id: 9, mode: 'apply', state: 'running', jobId: 'job-1' }), report: null, unrestoredTemporary: 0 }
    renderAt('/templates/1/runs/9')
    await screen.findByRole('heading', { name: 'Apply: Acme CPQ configuration' })
    act(() => useJobsStore.getState().hydrate([job({ id: 'job-1', kind: 'template-apply', status: 'running', phase: 'Seed: SBQQ__PriceRule__c', progress: { value: 3, max: 10 } })]))
    expect(await screen.findByText(/Seed: SBQQ__PriceRule__c/)).toBeInTheDocument()
    expect(screen.getByText(/Stops at the next batch; records already written stay/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect((window as unknown as { rds: { jobCancel: ReturnType<typeof vi.fn> } }).rds.jobCancel).toHaveBeenCalledWith('job-1')
    expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled()
  })

  it('F-7: the live log names its cap and can be narrowed to errors and warnings', async () => {
    const user = userEvent.setup()
    let handler: ((e: { jobId: string; kind: string; ts: number; data: Record<string, unknown> }) => void) | null = null
    const rds = (window as unknown as { rds: Record<string, unknown> }).rds
    rds.onJobEvent = (cb: typeof handler) => {
      handler = cb
      return () => undefined
    }
    runState = { ...runState, run: run({ id: 9, mode: 'apply', state: 'running', jobId: 'job-1' }), report: null, unrestoredTemporary: 0 }
    renderAt('/templates/1/runs/9')
    await screen.findByRole('heading', { name: 'Apply: Acme CPQ configuration' })
    await waitFor(() => expect(handler).not.toBeNull())
    act(() => {
      handler!({ jobId: 'job-1', kind: 'log', ts: 1, data: { level: 'info', message: 'seeding Account' } })
      handler!({ jobId: 'job-1', kind: 'log', ts: 2, data: { level: 'warn', message: 'slow batch on Contact' } })
      handler!({ jobId: 'job-1', kind: 'log', ts: 3, data: { level: 'error', message: 'UNKNOWN_EXCEPTION on Opportunity' } })
      handler!({ jobId: 'other', kind: 'log', ts: 4, data: { level: 'error', message: 'not this run' } })
    })
    const log = await screen.findByTestId('run-log')
    expect(log).toHaveTextContent('seeding Account')
    expect(log).not.toHaveTextContent('not this run')
    expect(screen.getByTestId('log-cap')).toHaveTextContent(/showing the last 400/)
    await user.click(screen.getByLabelText('Errors and warnings only'))
    expect(log).not.toHaveTextContent('seeding Account')
    expect(log).toHaveTextContent('slow batch on Contact')
    expect(log).toHaveTextContent('UNKNOWN_EXCEPTION on Opportunity')
  })

  it('T-11: report headers carry units or titles', async () => {
    renderAt('/templates/1/runs/9')
    await screen.findByRole('heading', { name: 'Apply: Acme CPQ configuration' })
    expect(screen.getByRole('columnheader', { name: 'Fields written' })).toHaveAttribute('title')
    expect(screen.getByRole('columnheader', { name: 'Nulled lookups' })).toHaveAttribute('title')
    expect(screen.getByRole('columnheader', { name: 'Load group' })).toBeInTheDocument()
  })

  it('U-1: a clean dry run of this revision, run THIS session, offers "Apply with these settings" and starts the apply with the same steps and options', async () => {
    const user = userEvent.setup()
    runState = {
      ...runState,
      run: run({ id: 9, mode: 'dry-run', state: 'clean', jobId: 'job-1' }),
      options: { disableTargetAutomation: true, cpqAttestation: true, purge: true, resume: false },
      report: report({ mode: 'dry-run', state: 'clean', summary: { unexpected: 0, expected: 0, unexpectedGroups: [], expectedGroups: [], nextAction: 'none', batchSizeSuggestions: [] } }),
      unrestoredTemporary: 0
    }
    renderAt('/templates/1/runs/9')
    await screen.findByRole('heading', { name: 'Dry run: Acme CPQ configuration' })
    // The run's job is not in this session's store → no button (the D8 rule).
    expect(screen.queryByRole('button', { name: 'Apply with these settings' })).not.toBeInTheDocument()
    act(() => useJobsStore.getState().hydrate([job({ id: 'job-1', status: 'done' })]))
    const btn = await screen.findByRole('button', { name: 'Apply with these settings' })
    // U-9: "run again" names the run so the form starts from ITS target.
    expect(screen.getByRole('link', { name: 'run again' })).toHaveAttribute('href', '/templates/1/run?from=9')
    await user.click(btn)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/exactly the steps and options of dry run #9/)
    expect(dialog).toHaveTextContent(/DELETED first/)
    expect(dialog).toHaveTextContent(DRY_RUN_CAVEAT)
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(started).toHaveLength(1))
    expect(started[0]).toEqual({
      templateId: 1,
      mode: 'apply',
      targetConnectionId: 'sb3',
      sourceConnectionId: 'srcbox',
      steps: runState.steps,
      options: { disableTargetAutomation: true, cpqAttestation: true, purge: true, resume: false }
    })
  })

  it('U-8: a partial run carries the unexpected count on its badge and does not offer Resume for non-retryable misses', async () => {
    runState = {
      ...runState,
      run: run({ id: 9, mode: 'apply', state: 'partial' }),
      report: report({ state: 'partial', summary: { unexpected: 4, expected: 6, unexpectedGroups: [], expectedGroups: [], nextAction: 'fixAndRerun', batchSizeSuggestions: [] } }),
      unrestoredTemporary: 0
    }
    renderAt('/templates/1/runs/9')
    await screen.findByRole('heading', { name: 'Apply: Acme CPQ configuration' })
    expect(screen.getByText('partial · 4 unexpected')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument()
    expect(screen.getByText(/record it as an expected failure on the template/)).toBeInTheDocument()
  })
})
