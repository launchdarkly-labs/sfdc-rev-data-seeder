/**
 * S73 — the data-less sandbox-setup STARTER over the REAL sqlite Store.
 *
 * S72 built `startSetupRun` (reached through `startDeployRun` for a
 * sandboxSetup draft with includeData false) and tested its store writers in
 * isolation, but nothing ever executed the starter itself. These tests drive
 * it end to end with ONE fake: the template-stage runner (`runTemplateStage`),
 * which S71 proved live. Everything else — the draft, the locks, the stage
 * rows, the job, the terminal status writers, closeOutAttempt — is real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Store } from '../../src/main/services/store'
import { JobManager, JobCancelledError } from '../../src/main/jobs'
import type { JobContext } from '../../src/main/jobs'
import { emptyReport } from '../../src/main/engine/templates/runner'
import type { TemplateReport } from '../../src/shared/templates/types'
import type { TemplateStepRef } from '../../src/shared/wizard'

// deployRuns → templateRuns → ipc/templates imports `electron` at module scope;
// none of it is touched here, so stub the module for the node lane.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  dialog: {},
  ipcMain: { handle: () => undefined }
}))

type StageInput = {
  templateId: number
  options: { disableTargetAutomation: boolean; cpqAttestation: boolean; purge: boolean; resume: boolean }
  deploymentId: number
  onRunCreated?: (runId: number) => void
}
type StageScript = (ctx: JobContext, input: StageInput) => Promise<{ runId: number; report: TemplateReport }>

// vi.mock factories are hoisted above every import, so the script hook must be too.
const fake = vi.hoisted(() => ({
  script: null as StageScript | null,
  calls: [] as StageInput[]
}))

vi.mock('../../src/main/ipc/templateRuns', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/main/ipc/templateRuns')>()
  return {
    ...mod,
    runTemplateStage: (_deps: unknown, ctx: JobContext, input: StageInput) => {
      fake.calls.push(input)
      if (!fake.script) throw new Error('test did not script the stage runner')
      return fake.script(ctx, input)
    }
  }
})

import { closeStagesOnThrow, startDeployRun, type DeployRunDeps } from '../../src/main/ipc/deployRuns'

let store: Store
let jobs: JobManager
let deps: DeployRunDeps

beforeEach(() => {
  store = new Store(':memory:')
  jobs = new JobManager(() => {})
  fake.script = null
  fake.calls = []
  store.upsertConnections([
    {
      alias: 'src',
      username: 's@x.io',
      orgId: '00Dsrc00000000',
      instanceUrl: 'https://src.my.salesforce.com',
      connectedStatus: 'Connected',
      isSandbox: true
    },
    {
      alias: 'tgt',
      username: 't@x.io',
      orgId: '00Dtgt00000000',
      instanceUrl: 'https://tgt.my.salesforce.com',
      connectedStatus: 'Connected',
      isSandbox: true
    }
  ])
  deps = {
    store,
    jobs,
    // The stage runner is faked, so a real org connection must never be asked for.
    connectById: async (): Promise<never> => {
      throw new Error('connectById must not be called — the stage runner is faked')
    },
    deployRunByJob: new Map(),
    appMetrics: () => []
  }
})
afterEach(() => store.close())

const status = (id: number): string => store.getDeploymentHeader(id)!.status
const error = (id: number): string | null => store.getDeploymentHeader(id)!.errorMessage

function report(state: TemplateReport['state'], blockers: string[] = []): TemplateReport {
  const r = emptyReport('apply', Date.now())
  r.state = state
  r.finishedAt = Date.now()
  r.preflight.blockers = blockers
  return r
}

/** Two saved runnable templates (payload content is irrelevant to the starter). */
function templates(): { postRefresh: TemplateStepRef; seed: TemplateStepRef } {
  const pr = store.templates.saveRunnable({
    kind: 'postRefresh',
    name: 'LD dev sandbox',
    description: null,
    payload: {
      schemaVersion: 1,
      automation: { flows: [], triggers: [], settingPatches: [] },
      seedTemplates: [],
      verify: { safetyCheck: true }
    }
  })
  const seed = store.templates.saveRunnable({
    kind: 'seed',
    name: 'LD CPQ configuration',
    description: null,
    payload: { schemaVersion: 1 }
  })
  return {
    postRefresh: {
      templateId: pr.id,
      name: pr.name,
      kind: 'postRefresh',
      steps: { automation: true, seeds: [], optInPatches: [] }
    },
    seed: {
      templateId: seed.id,
      name: seed.name,
      kind: 'seed',
      steps: { automation: false, seeds: [{ name: seed.name, groups: [] }], optInPatches: [] }
    }
  }
}

function setupDeployment(before: TemplateStepRef[], includeData = false): number {
  const id = store.createDeployment({
    name: 'week45 setup',
    sourceConnectionId: 'src',
    targetConnectionId: 'tgt',
    kind: 'sandboxSetup',
    includeData
  })
  const draft = store.loadDraft(id)!
  store.saveDraft(id, includeData ? 'templates' : 'review', {
    ...draft.config,
    templateSteps: { before, after: [] }
  })
  return id
}

/** Poll the manager until the job leaves 'running' (the work is async, in-process). */
async function settle(jobId: string): Promise<ReturnType<JobManager['get']>> {
  for (let i = 0; i < 400; i++) {
    const j = jobs.get(jobId)
    if (j && j.status !== 'running') return j
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`job ${jobId} never settled`)
}

describe('S73 — startSetupRun (data-less sandbox setup) over the real Store', () => {
  it('two clean stages → Completed; two template stage rows; NO deploy_runs row; one deploy job', async () => {
    const t = templates()
    const id = setupDeployment([t.postRefresh, t.seed])
    const seen: string[] = []
    fake.script = async () => {
      // While a stage runs the row is 'Deploying' (markDeployStarted) — the
      // same busy status the data path writes, so every busy-status guard sees it.
      seen.push(status(id))
      return { runId: 0, report: report('clean') }
    }

    const { jobId } = await startDeployRun(deps, id)
    const job = await settle(jobId)

    expect(job!.status).toBe('done')
    expect(job!.kind).toBe('deploy')
    expect(job!.title).toBe('Set up sandbox (2 stages)')
    expect(job!.deploymentId).toBe(String(id))
    expect(seen).toEqual(['Deploying', 'Deploying'])

    expect(status(id)).toBe('Completed')
    expect(error(id)).toBeNull()
    // The whole point of the S72 writers: no run row exists to mirror from.
    expect(store.deploy.listRunsForDeployment(id)).toHaveLength(0)

    const stages = store.deploy.latestStages(id)
    expect(stages.map((s) => [s.position, s.kind, s.label, s.state])).toEqual([
      [0, 'template', 'LD dev sandbox', 'clean'],
      [1, 'template', 'LD CPQ configuration', 'clean']
    ])
    expect(stages.every((s) => s.deployRunId == null)).toBe(true)

    // Each stage ran as a composed stage: apply, automation off, no purge, no resume (D3).
    expect(fake.calls.map((c) => c.templateId)).toEqual([t.postRefresh.templateId, t.seed.templateId])
    for (const c of fake.calls) {
      expect(c.deploymentId).toBe(id)
      expect(c.options).toEqual({
        disableTargetAutomation: true,
        cpqAttestation: false,
        purge: false,
        resume: false
      })
    }
  })

  it('stage 1 blocked → Failed with the blocker in the note; stage 2 skipped; the runner ran once', async () => {
    const t = templates()
    const id = setupDeployment([t.postRefresh, t.seed])
    const blocker = 'Account already holds 12 rows on the target — purge or resume'
    fake.script = async () => ({ runId: 0, report: report('blocked', [blocker]) })

    const { jobId } = await startDeployRun(deps, id)
    const job = await settle(jobId)

    expect(job!.status).toBe('error')
    expect(fake.calls).toHaveLength(1)
    expect(status(id)).toBe('Failed')
    expect(error(id)).toContain('LD dev sandbox')
    expect(error(id)).toContain('blocked')
    expect(error(id)).toContain(blocker)
    expect(store.deploy.listRunsForDeployment(id)).toHaveLength(0)

    const stages = store.deploy.latestStages(id)
    expect(stages[0]!.state).toBe('blocked')
    expect(stages[0]!.note).toBe(blocker)
    expect(stages[1]!.state).toBe('skipped')
    expect(stages[1]!.note).toContain('stage 1')
  })

  it('cancel mid-stage → Cancelled with no error text; the stage is cancelled, the rest skipped', async () => {
    const t = templates()
    const id = setupDeployment([t.postRefresh, t.seed])
    fake.script = async (ctx) => {
      // The user presses Cancel while stage 1 runs; the runner reports it as a result, not a throw.
      jobs.cancel(ctx.jobId)
      return { runId: 0, report: report('cancelled') }
    }

    const { jobId } = await startDeployRun(deps, id)
    const job = await settle(jobId)

    expect(job!.status).toBe('cancelled')
    expect(fake.calls).toHaveLength(1)
    expect(status(id)).toBe('Cancelled')
    expect(error(id)).toBeNull()
    const stages = store.deploy.latestStages(id)
    expect(stages.map((s) => s.state)).toEqual(['cancelled', 'skipped'])
  })

  it('a stage runner that THROWS (connect failure) → Failed with the message; later stages skipped', async () => {
    const t = templates()
    const id = setupDeployment([t.postRefresh, t.seed])
    fake.script = async () => {
      throw new Error('target org refused the connection')
    }

    const { jobId } = await startDeployRun(deps, id)
    const job = await settle(jobId)

    expect(job!.status).toBe('error')
    expect(status(id)).toBe('Failed')
    expect(error(id)).toBe('target org refused the connection')
    // S73: the throw escaped before stageFinished; the catch block now closes
    // the open rows itself instead of leaving them for the next launch.
    const stages = store.deploy.latestStages(id)
    expect(stages[0]!.state).toBe('failed')
    expect(stages[0]!.note).toBe('target org refused the connection')
    expect(stages[1]!.state).toBe('skipped')
  })

  it('S73: Cancel pressed BETWEEN stages → stage 1 clean, stage 2 cancelled (not left running), Cancelled', async () => {
    const t = templates()
    const id = setupDeployment([t.postRefresh, t.seed])
    fake.script = async (ctx) => {
      // Stage 1 finishes clean, but the user pressed Cancel while it ran; the
      // loop sees the token only at stage 2's throwIfCancelled, AFTER that row
      // was marked running.
      jobs.cancel(ctx.jobId)
      return { runId: 0, report: report('clean') }
    }

    const { jobId } = await startDeployRun(deps, id)
    const job = await settle(jobId)

    expect(job!.status).toBe('cancelled')
    expect(fake.calls).toHaveLength(1)
    expect(status(id)).toBe('Cancelled')
    expect(error(id)).toBeNull()
    const stages = store.deploy.latestStages(id)
    expect(stages.map((s) => s.state)).toEqual(['clean', 'cancelled'])
    expect(stages.every((s) => s.finishedAt != null)).toBe(true)
  })

  it('a data-less setup with NO stages is refused before any job starts', async () => {
    const id = setupDeployment([])
    await expect(startDeployRun(deps, id)).rejects.toThrow(/no template stages/)
    expect(jobs.list()).toHaveLength(0)
    expect(status(id)).toBe('Draft')
    expect(fake.calls).toHaveLength(0)
  })

  it('S73 fix: a sandbox setup WITH its data stage and no stages is refused at run start too', async () => {
    // The Setup step disables Next, but a stale URL to Plan bypasses the UI;
    // the starter must enforce the type's promise itself.
    const id = setupDeployment([], true)
    await expect(startDeployRun(deps, id)).rejects.toThrow(/no template stages/)
    expect(jobs.list()).toHaveLength(0)
    expect(status(id)).toBe('Draft')
  })

  it("the data kind is untouched: a data deployment with no stages and no plan still says 'Run analysis before deploying.'", async () => {
    const id = store.createDeployment({ name: 'plain', sourceConnectionId: 'src', targetConnectionId: 'tgt' })
    await expect(startDeployRun(deps, id)).rejects.toThrow('Run analysis before deploying.')
    expect(jobs.list()).toHaveLength(0)
  })

  it('the shared start locks apply: a running deploy job on a sibling aimed at the same target refuses the setup', async () => {
    const t = templates()
    const id = setupDeployment([t.postRefresh])
    const sibling = store.createDeployment({ name: 'sibling', sourceConnectionId: 'src', targetConnectionId: 'tgt' })
    let release: () => void = () => undefined
    const siblingJob = jobs.start(
      'deploy',
      'sibling deploy',
      () => new Promise<void>((r) => (release = r)),
      { deploymentId: String(sibling) }
    )

    await expect(startDeployRun(deps, id)).rejects.toThrow(/sibling/)
    expect(jobs.list().filter((j) => j.deploymentId === String(id))).toHaveLength(0)
    expect(fake.calls).toHaveLength(0)

    release()
    await settle(siblingJob)
  })

  it('S73 twin: closeStagesOnThrow closes a COMPOSED data attempt the same way — running → failed/cancelled, pending → skipped, finished rows untouched', () => {
    // The composed data path's shape: before stage · data stage · after stage.
    const id = store.createDeployment({ name: 'composed', sourceConnectionId: 'src', targetConnectionId: 'tgt' })
    const rows = store.deploy.createStages(id, 'attempt-1', [
      { kind: 'template', label: 'LD dev sandbox', templateId: null },
      { kind: 'deploy', label: 'Data deployment', templateId: null },
      { kind: 'template', label: 'After seed', templateId: null }
    ])
    store.deploy.stageFinished(rows[0]!.id, 'clean')
    store.deploy.stageStarted(rows[1]!.id)

    closeStagesOnThrow(store, id, 'attempt-1', new Error('freeze blew up'))
    let after = store.deploy.stagesForAttempt(id, 'attempt-1')
    expect(after.map((s) => s.state)).toEqual(['clean', 'failed', 'skipped'])
    expect(after[1]!.note).toBe('freeze blew up')
    expect(after[2]!.note).toBe('an earlier stage failed')

    // Idempotent: a second call (or one after the normal path already closed everything) changes nothing.
    closeStagesOnThrow(store, id, 'attempt-1', new JobCancelledError())
    expect(store.deploy.stagesForAttempt(id, 'attempt-1').map((s) => s.state)).toEqual(['clean', 'failed', 'skipped'])

    // And the cancel flavour on a fresh attempt.
    const rows2 = store.deploy.createStages(id, 'attempt-2', [
      { kind: 'template', label: 'LD dev sandbox', templateId: null },
      { kind: 'deploy', label: 'Data deployment', templateId: null }
    ])
    store.deploy.stageStarted(rows2[0]!.id)
    closeStagesOnThrow(store, id, 'attempt-2', new JobCancelledError())
    after = store.deploy.stagesForAttempt(id, 'attempt-2')
    expect(after.map((s) => [s.state, s.note])).toEqual([
      ['cancelled', 'cancelled'],
      ['skipped', 'the attempt was cancelled']
    ])
  })

  it('a second start while the setup job is running adopts the in-flight job (no double run)', async () => {
    const t = templates()
    const id = setupDeployment([t.postRefresh])
    let finish: () => void = () => undefined
    fake.script = () =>
      new Promise((r) => {
        finish = () => r({ runId: 0, report: report('clean') })
      })

    const first = await startDeployRun(deps, id)
    const second = await startDeployRun(deps, id)
    expect(second.jobId).toBe(first.jobId)
    expect(fake.calls).toHaveLength(1)

    finish()
    await settle(first.jobId)
    expect(status(id)).toBe('Completed')
  })
})
