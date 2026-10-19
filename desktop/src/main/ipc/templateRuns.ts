/**
 * The template RUN surface: start a dry run / apply as a job, start a
 * restore-now for temporary automation a run left disabled, build the run
 * page's view, and the per-target-org lock shared with `rds:deploy.start`
 * (plan §6.5 — both directions, by target org id).
 */
import type { JobSummary, OrgRole } from '../../shared/types'
import type { TemplateReport, TemplateRunInput, TemplateRunStateView, TemplateRunSummary } from '../../shared/templates/types'
import { isRunnableKind } from '../../shared/templates/types'
import { TERMINAL_RUN_PHASES } from '../engine/deploy/types'
import { runUuidFor } from '../services/deployStore'
import { JobCancelledError, type JobContext, type JobManager } from '../jobs'
import { RdsHandlerError } from '../errors'
import type { Store } from '../services/store'
import type { GuardedOrg } from '../services/salesforce'
import { makeOrgReader, makeOrgWriter } from '../services/templateIo'
import type { TemplateIo } from '../engine/templates/io'
import { resolveRun } from '../engine/templates/resolve'
import { emptyReport, runTemplate, type RunLedger } from '../engine/templates/runner'
import { setFlowsActiveComposite, setValidationRulesActiveComposite } from '../engine/automationToggle'
import { toggleTriggersDetailed } from '../engine/triggerBodyToggle'
import type { AutomationItem } from '../../shared/types'
import { migratedPayload } from './templates'

export interface RunDeps {
  store: Store
  jobs: JobManager
  connectById(connectionId: string, roleOverride?: OrgRole): Promise<GuardedOrg>
}

const TEMPLATE_WRITE_KINDS = new Set<JobSummary['kind']>(['template-apply', 'template-restore'])

/**
 * The lock BOTH `rds:deploy.start` and a template apply consult, from the
 * template side: a template apply/restore job running against the org, a
 * template run recorded as running against it (another session), or temporary
 * seed-time automation a template run left unconfirmed there.
 */
export function templateTargetLockConflict(store: Store, jobs: JobManager, targetOrgId: string, targetLabel: string): string | null {
  if (!targetOrgId) return null
  const running = jobs.list().find((j) => TEMPLATE_WRITE_KINDS.has(j.kind) && j.status === 'running' && j.targetOrgId === targetOrgId)
  if (running) return `Template job "${running.title}" is writing to ${targetLabel} right now — wait for it to finish.`
  const recorded = store.templates.runningRunsForTarget(targetOrgId)
  const live = recorded.find((r) => r.jobId == null || jobs.get(r.jobId)?.status === 'running')
  if (live && !running) {
    // A run recorded running with no live job is a crash artifact — reconcileOnStartup closes it; here it is advisory.
    if (live.jobId != null && jobs.get(live.jobId) == null) {
      /* another app session may own it; fall through to the unrestored check */
    }
  }
  const unrestored = store.templates.unrestoredTemporary(targetOrgId)
  if (unrestored.length > 0) {
    const runIds = [...new Set(unrestored.map((u) => u.runId))]
    return (
      `A template run left ${unrestored.length} automation item${unrestored.length === 1 ? '' : 's'} disabled on ${targetLabel} ` +
      `(run${runIds.length === 1 ? '' : 's'} ${runIds.join(', ')}) — use "Restore target automation" on that run's page first.`
    )
  }
  return null
}

/** The DEPLOY side of the lock, as a template apply sees it. */
export function deployTargetLockConflict(store: Store, jobs: JobManager, targetOrgId: string, targetLabel: string): string | null {
  if (!targetOrgId) return null
  const deploying = jobs.list().find((j) => j.kind === 'deploy' && j.status === 'running')
  if (deploying?.deploymentId != null) {
    const header = store.getDeploymentHeader(Number(deploying.deploymentId))
    const dep = header ? store.getConnection(store.loadDraft(Number(deploying.deploymentId))?.targetConnectionId ?? '') : undefined
    if (dep?.orgId === targetOrgId) return `Deployment "${header?.name ?? deploying.deploymentId}" is deploying into ${targetLabel} right now — wait for it to finish.`
  }
  for (const d of store.listDrafts()) {
    const conn = store.getConnection(d.targetConnectionId)
    if (conn?.orgId !== targetOrgId) continue
    const runs = store.deploy.listRunsForDeployment(d.id)
    const live = runs.find((r) => !TERMINAL_RUN_PHASES.has(r.phase))
    if (live) return `Deployment "${d.name}" (#${d.id}) has a run recorded as ${live.phase} against ${targetLabel} — its automation may still be disabled there. Restore it first.`
    const last = runs.length > 0 ? runs[runs.length - 1]! : null
    if (last && store.deploy.ledgerUnconfirmed(runUuidFor(last.id)).length > 0) {
      return `Deployment "${d.name}" (#${d.id}) ended with automation items not confirmed restored on ${targetLabel}. Restore them first.`
    }
  }
  return null
}

function bindLedger(store: Store, runId: number, targetOrgId: string): RunLedger {
  return {
    recordChange: (mode, c) => store.templates.recordChange(runId, targetOrgId, mode, c),
    deleteChange: (rowId) => store.templates.deleteChange(rowId),
    confirmRestored: (rowIds) => store.templates.confirmRestored(rowIds),
    putIdMap: (rows) => store.templates.putIdMap(runId, targetOrgId, rows),
    idMapForTarget: () => store.templates.idMapForTarget(targetOrgId),
    idMapCounts: () => store.templates.idMapCounts(targetOrgId),
    deleteIdMap: (objects) => store.templates.deleteIdMap(targetOrgId, objects),
    saveReport: (report) => store.templates.saveReport(runId, report),
    unrestoredTemporaryCount: () => store.templates.unrestoredTemporaryForRun(runId).length
  }
}

function makeIo(ctx: JobContext, source: GuardedOrg | null, target: GuardedOrg): TemplateIo {
  const log = (level: 'warn' | 'error', message: string): void => ctx.log(message, level)
  return {
    source: source ? makeOrgReader(source, (m) => ctx.log(m, 'warn')) : null,
    target: makeOrgWriter(target, log),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (level, message) => ctx.log(message, level),
    phase: (name) => ctx.phase(name),
    progress: (value, max, label) => ctx.progress(value, max, label),
    cancelled: () => ctx.cancel.cancelled
  }
}

/** Everything a template run needs before its row exists: validated inputs, the resolved template, the lock verdict. */
interface PreparedTemplateRun {
  templateId: number
  templateKind: 'seed' | 'postRefresh'
  templateName: string
  resolved: ReturnType<typeof resolveRun>
  steps: TemplateRunInput['steps']
  options: TemplateRunInput['options']
  mode: TemplateRunInput['mode']
  sourceRow: ReturnType<Store['getConnection']> | undefined
  targetRow: NonNullable<ReturnType<Store['getConnection']>>
  lockConflict: string | null
}

function prepareTemplateRun(deps: RunDeps, input: TemplateRunInput, opts: { callerHoldsLock: boolean }): PreparedTemplateRun {
  const { store, jobs } = deps
  const t = store.templates.getTemplate(input.templateId)
  if (!t) throw new RdsHandlerError('NOT_FOUND', `Template ${input.templateId} not found`)
  if (!isRunnableKind(t.kind)) throw new RdsHandlerError('INVALID_STATE', 'Only Data seed and Post-refresh templates run')
  const targetRow = store.getConnection(input.targetConnectionId)
  if (!targetRow) throw new RdsHandlerError('NOT_FOUND', `Unknown connection: ${input.targetConnectionId}`)
  const sourceRow = input.sourceConnectionId ? store.getConnection(input.sourceConnectionId) : undefined
  if (input.sourceConnectionId && !sourceRow) throw new RdsHandlerError('NOT_FOUND', `Unknown connection: ${input.sourceConnectionId}`)
  const payload = migratedPayload(t.kind, t.payload)
  const seedsByName = new Map<string, unknown>()
  for (const [name, s] of store.templates.seedTemplatesByName()) seedsByName.set(name, migratedPayload('seed', s.payload))
  const steps = t.kind === 'seed' && input.steps.seeds.length === 0 ? { ...input.steps, seeds: [{ name: t.name, groups: [] }] } : input.steps
  const resolved = resolveRun({ kind: t.kind, name: t.name, payload, steps, seedTemplatesByName: seedsByName })
  const apply = input.mode === 'apply'
  // S62: a stage of a composed deployment runs INSIDE the deployment's job — that job IS the lock.
  const lockConflict =
    apply && !opts.callerHoldsLock
      ? (deployTargetLockConflict(store, jobs, targetRow.orgId, targetRow.label) ?? templateTargetLockConflict(store, jobs, targetRow.orgId, targetRow.label))
      : null
  return { templateId: t.id, templateKind: t.kind, templateName: t.name, resolved, steps, options: input.options, mode: input.mode, sourceRow, targetRow, lockConflict }
}

function createTemplateRunRow(store: Store, p: PreparedTemplateRun, jobId: string | null, deploymentId: number | null): TemplateRunSummary {
  return store.templates.createRun({
    templateId: p.templateId,
    templateKind: p.templateKind,
    templateName: p.templateName,
    snapshot: p.resolved.snapshot,
    mode: p.mode,
    steps: p.steps,
    options: p.options,
    sourceConnectionId: p.sourceRow?.id ?? null,
    targetConnectionId: p.targetRow.id,
    targetOrgId: p.targetRow.orgId,
    jobId,
    deploymentId
  })
}

/** Connect, run the template, persist the terminal state. Returns the report; never throws on a bad state. */
async function executeTemplateRun(deps: RunDeps, ctx: JobContext, p: PreparedTemplateRun, runId: number): Promise<TemplateReport> {
  const { store } = deps
  const ledger = bindLedger(store, runId, p.targetRow.orgId)
  ctx.phase('Connecting')
  // NO role override: the stored role must be exactly 'target' (connect may still
  // downgrade it — prod pin / untrusted OAuth) and the runner's preflight re-checks.
  const target = await deps.connectById(p.targetRow.id)
  const source = p.sourceRow ? await deps.connectById(p.sourceRow.id, 'source') : null
  const io = makeIo(ctx, source, target)
  const report = await runTemplate(io, p.resolved, ledger, {
    mode: p.mode,
    disableTargetAutomation: p.options.disableTargetAutomation,
    cpqAttestation: p.options.cpqAttestation,
    purge: p.options.purge,
    resume: p.options.resume,
    targetStoredRole: target.role,
    sourceStoredRole: source?.role ?? null,
    lockConflict: p.lockConflict
  })
  store.templates.finishRun(runId, report.state === 'running' ? 'failed' : report.state, report)
  return report
}

/** The job-level verdict for a standalone template run (the Templates tab): cancelled / blocked / failed throw. */
function throwForBadState(report: TemplateReport): void {
  if (report.state === 'cancelled') throw new JobCancelledError()
  if (report.state === 'blocked') throw new RdsHandlerError('INVALID_STATE', `Blocked: ${report.preflight.blockers.join(' · ')}`)
  if (report.state === 'failed') {
    throw new RdsHandlerError('INVALID_STATE', `${report.summary.unexpected} unexpected problem${report.summary.unexpected === 1 ? '' : 's'} — see the run report`)
  }
}

export async function startTemplateRun(deps: RunDeps, input: TemplateRunInput): Promise<{ jobId: string; runId: number }> {
  const { store, jobs } = deps
  const p = prepareTemplateRun(deps, input, { callerHoldsLock: false })
  const apply = input.mode === 'apply'
  const run = createTemplateRunRow(store, p, null, null)
  const jobId = jobs.start(
    apply ? 'template-apply' : 'template-dry-run',
    `${apply ? 'Apply' : 'Dry run'}: ${p.templateName}`,
    async (ctx) => {
      const report = await executeTemplateRun(deps, ctx, p, run.id)
      throwForBadState(report)
      return { state: report.state, unexpected: report.summary.unexpected }
    },
    {}
  )
  store.templates.setRunJob(run.id, jobId)
  stampJob(jobs, jobId, p.targetRow.orgId, run.id, p.templateId)
  // A connect/throw before the runner persisted anything must still close the row.
  void watchJob(store, jobs, jobId, run.id)
  return { jobId, runId: run.id }
}

/**
 * S62 (U-2): run ONE template as a stage of a composed deployment, inside the deployment's job.
 * Always mode 'apply'. The run row is created here (so its started_at is the stage's), linked to
 * the deployment, and tagged with the composed job's id. Returns the report; the CALLER applies the
 * stop rule — a blocked/failed/cancelled report is a result here, not a throw.
 */
export async function runTemplateStage(
  deps: RunDeps,
  ctx: JobContext,
  input: {
    templateId: number
    steps: TemplateRunInput['steps']
    options: TemplateRunInput['options']
    sourceConnectionId: string
    targetConnectionId: string
    deploymentId: number
    onRunCreated?: (runId: number) => void
  }
): Promise<{ runId: number; report: TemplateReport }> {
  const p = prepareTemplateRun(
    deps,
    {
      templateId: input.templateId,
      mode: 'apply',
      targetConnectionId: input.targetConnectionId,
      sourceConnectionId: input.sourceConnectionId,
      steps: input.steps,
      options: input.options
    },
    { callerHoldsLock: true }
  )
  const run = createTemplateRunRow(deps.store, p, ctx.jobId, input.deploymentId)
  input.onRunCreated?.(run.id)
  try {
    const report = await executeTemplateRun(deps, ctx, p, run.id)
    return { runId: run.id, report }
  } catch (e) {
    // A connect failure / cancel before the runner persisted anything: close the row with the reason.
    const detail = deps.store.templates.getRunDetail(run.id)
    const report = detail?.report ?? emptyReport('apply', run.startedAt)
    if (report.state === 'running') {
      const cancelled = e instanceof JobCancelledError || ctx.cancel.cancelled
      report.preflight.notes.push(cancelled ? 'cancelled before the run started' : e instanceof Error ? e.message : String(e))
      report.state = cancelled ? 'cancelled' : 'failed'
      report.finishedAt = Date.now()
      deps.store.templates.finishRun(run.id, report.state, report)
    }
    return { runId: run.id, report }
  }
}

function stampJob(jobs: JobManager, jobId: string, targetOrgId: string, runId: number, templateId: number | null): void {
  jobs.annotate(jobId, { targetOrgId, templateRunId: runId, templateId: templateId ?? undefined })
}

async function watchJob(store: Store, jobs: JobManager, jobId: string, runId: number): Promise<void> {
  // Poll the manager's summary until terminal (no event hook on the manager); cheap, in-process.
  for (;;) {
    await new Promise((r) => setTimeout(r, 500))
    const j = jobs.get(jobId)
    if (!j || j.status === 'running') continue
    const run = store.templates.getRun(runId)
    if (run && run.state === 'running') {
      const detail = store.templates.getRunDetail(runId)
      const report = detail?.report ?? emptyReport(run.mode, run.startedAt)
      report.preflight.notes.push(j.error ?? (j.status === 'cancelled' ? 'cancelled before the run started' : 'the job ended before the run was recorded'))
      report.state = j.status === 'cancelled' ? 'cancelled' : 'failed'
      report.finishedAt = Date.now()
      store.templates.finishRun(runId, report.state, report)
    }
    return
  }
}

/** Restore the temporary automation a run left unconfirmed — a job of its own. */
export async function startTemplateRestore(deps: RunDeps, runId: number): Promise<{ jobId: string }> {
  const { store, jobs } = deps
  const detail = store.templates.getRunDetail(runId)
  if (!detail) throw new RdsHandlerError('NOT_FOUND', `Template run ${runId} not found`)
  const rows = store.templates.unrestoredTemporaryForRun(runId)
  if (rows.length === 0) throw new RdsHandlerError('INVALID_STATE', 'Nothing to restore — every temporary item is confirmed')
  const running = jobs.list().find((j) => TEMPLATE_WRITE_KINDS.has(j.kind) && j.status === 'running' && j.targetOrgId === detail.run.targetOrgId)
  if (running) throw new RdsHandlerError('INVALID_STATE', `"${running.title}" is still running against this org`)
  const jobId = jobs.start('template-restore', `Restore target automation: ${detail.run.templateName}`, async (ctx) => {
    ctx.phase('Connecting')
    const target = await deps.connectById(detail.run.targetConnectionId)
    if (target.role !== 'target') throw new RdsHandlerError('READ_ONLY_ORG', `Org '${target.alias}' is not a target (role '${target.role}')`)
    const io = makeIo(ctx, null, target)
    io.phase('Restoring target automation')
    const items: Array<{ rowId: number; item: AutomationItem }> = rows.map((r) => ({
      rowId: r.id,
      item: {
        id: r.itemId ?? '',
        name: r.itemName,
        objectName: String(r.beforeState?.objectName ?? ''),
        automationType: r.itemType as AutomationItem['automationType'],
        isActive: true,
        processType: (r.beforeState?.processType as string | null) ?? null,
        isManagedPackage: false,
        restoreVersionNumber: typeof r.beforeState?.restoreVersionNumber === 'number' ? r.beforeState.restoreVersionNumber : null
      }
    }))
    const confirmed: number[] = []
    const vrs = items.filter((i) => i.item.automationType === 'ValidationRule')
    const flows = items.filter((i) => i.item.automationType === 'Flow')
    const triggers = items.filter((i) => i.item.automationType === 'ApexTrigger')
    const doneVr = new Set((await setValidationRulesActiveComposite(io.target.toggle, vrs.map((i) => i.item), true)).map((i) => i.id))
    for (const i of vrs) if (doneVr.has(i.item.id)) confirmed.push(i.rowId)
    const doneFlow = new Set((await setFlowsActiveComposite(io.target.toggle, flows.map((i) => i.item), false)).map((i) => i.id))
    for (const i of flows) if (doneFlow.has(i.item.id)) confirmed.push(i.rowId)
    const tr = await toggleTriggersDetailed(io.target.triggerIo, triggers.map((i) => i.item.id), false)
    for (const i of triggers) if (tr.succeededIds.has(i.item.id) || tr.alreadyInStateIds.has(i.item.id)) confirmed.push(i.rowId)
    store.templates.confirmRestored(confirmed)
    const left = rows.length - confirmed.length
    ctx.log(`restored ${confirmed.length} of ${rows.length}${left ? `; ${left} still unconfirmed` : ''}`, left ? 'warn' : 'info')
    if (detail.report) {
      const report = detail.report
      if (report.targetAutomation) {
        report.targetAutomation.restored += confirmed.length
        report.targetAutomation.unconfirmed = left
        for (const it of report.targetAutomation.items) {
          const row = rows.find((r) => r.itemName === it.name && r.itemType === it.itemType)
          if (row && confirmed.includes(row.id)) it.restored = true
        }
      }
      report.summary.nextAction = left > 0 ? 'restoreTargetAutomation' : report.summary.nextAction === 'restoreTargetAutomation' ? 'none' : report.summary.nextAction
      store.templates.saveReport(runId, report)
    }
    if (left > 0) throw new RdsHandlerError('INVALID_STATE', `${left} item${left === 1 ? '' : 's'} could not be restored — see the job log`)
    return { restored: confirmed.length }
  })
  stampJob(jobs, jobId, detail.run.targetOrgId, runId, detail.run.templateId)
  return { jobId }
}

export function buildRunStateView(store: Store, jobs: JobManager, runId: number): TemplateRunStateView {
  const detail = store.templates.getRunDetail(runId)
  if (!detail) throw new RdsHandlerError('NOT_FOUND', `Template run ${runId} not found`)
  const job = detail.run.jobId ? (jobs.get(detail.run.jobId) ?? null) : null
  return {
    run: detail.run,
    snapshot: detail.snapshot,
    steps: detail.steps,
    options: detail.options,
    report: detail.report,
    job,
    unrestoredTemporary: store.templates.unrestoredTemporaryForRun(runId).length
  }
}

export type { TemplateRunSummary }
