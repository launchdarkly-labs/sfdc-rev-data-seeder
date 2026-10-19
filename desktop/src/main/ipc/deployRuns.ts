/**
 * S62 — the deploy ATTEMPT starter, lifted out of ipc.ts (`rds:deploy.start`) so a COMPOSED run
 * (U-2: templates as stages of a deployment) can drive the same gates and the same work function
 * from one job. Behaviour for a deployment WITHOUT template stages is the S61 handler, byte for
 * byte: the move changed indentation and the dependency injection, nothing else.
 *
 * Composed run (config.templateSteps non-empty):
 *   job 'deploy' → markDeployStarted → [BEFORE template stages] → the data work → [AFTER stages]
 * Each template stage is a real template run (its own template_runs row, ledger, report — the
 * templates engine is untouched) started IN this job through `runTemplateStage`; the sequence is
 * recorded in deploy_stages (migration 012). A stage that ends blocked/failed/cancelled stops the
 * sequence; later stages are recorded 'skipped'. One job ⇒ one lock: every existing per-target-org
 * gate (deploy siblings, template applies) sees a running 'deploy' job for this deployment.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { OrgRole } from '../../shared/types'
import type { TemplateStepRef } from '../../shared/wizard'
import {
  attestationBlocked,
  effectiveDisable,
  isKeyless,
  KEYLESS_CAUTION,
  templateStepsOf
} from '../../shared/wizard'
import { outOfScopeRefs, type RefFieldLike } from '../../shared/scopeAdvisor'
import type { Store } from '../services/store'
import type { JobContext, JobManager } from '../jobs'
import { JobCancelledError } from '../jobs'
import { RdsHandlerError } from '../errors'
import type { GuardedOrg } from '../services/salesforce'
import {
  discoverAutomation,
  discoverySummaryLines,
  makeAutomationIo,
  queryWorkflowRules
} from '../services/automationDiscovery'
import { closeOutAttempt, runFailureMessage, stalledMessage } from '../services/deployAttempt'
import { makeAutomationToggleIo, makeTriggerToggleIo, makeCpqGuardIo } from '../services/automationToggleIo'
import { makeMetadataToggleIo } from '../services/metadataToggleIo'
import { targetHasExtIdOrgWide } from '../services/targetSchemaProbe'
import { probeKeyedRows } from '../services/targetKeys'
import { targetLockConflict, type TargetLockCandidate } from '../services/runLock'
import { preRunAudit, postRunAudit } from '../services/runAudit'
import { startMemorySampler } from '../services/memorySampler'
import { runUuidFor } from '../services/deployStore'
import { makeDeployIo, describeDeployFields, makeDeployIdMap } from '../services/deployIo'
import { freezePlan } from '../engine/deploy/planFreeze'
import { makePassExecutors } from '../engine/deploy/passes'
import { runDeployment } from '../engine/deploy/orchestrator'
import { makeAutomationHooks } from '../engine/automation/hooks'
import type { RunCounters, RunOutcome } from '../engine/deploy/types'
import { TERMINAL_RUN_PHASES } from '../engine/deploy/types'
import { dataStageState, stageAllowsContinue, stageStateOf } from '../engine/deploy/stages'
import { templateTargetLockConflict, runTemplateStage } from './templateRuns'

export interface DeployRunDeps {
  store: Store
  jobs: JobManager
  connectById(connectionId: string, roleOverride?: OrgRole): Promise<GuardedOrg>
  /** S46 D3 cancel bridge: jobId → deploy_runs.id for RUNNING deploy jobs (owned by ipc.ts). */
  deployRunByJob: Map<string, number>
  /** `app.getAppMetrics()` (S54 F5 peak-memory line); injectable so this module has no Electron import. */
  appMetrics(): Array<{ type: string; memory: { workingSetSize: number } }>
}

/**
 * Non-blank sample probe for populated-only (the rds:fields.populated logic,
 * reused by the 5B.9 freeze loop). THROWS on a query failure — a deploy that
 * promised populated-only must never silently widen to every field.
 */
async function probePopulatedFields(
  org: GuardedOrg,
  objectName: string,
  fieldNames: string[]
): Promise<string[]> {
  const fields = Array.from(new Set(fieldNames.filter((f) => !!f)))
  if (fields.length === 0) return []
  const CHUNK = 100
  const SAMPLE = 20
  const populated = new Set<string>()
  try {
    for (let i = 0; i < fields.length; i += CHUNK) {
      const chunk = fields.slice(i, i + CHUNK)
      const res = await org.conn.query(
        `SELECT ${chunk.join(', ')} FROM ${objectName} LIMIT ${SAMPLE}`
      )
      for (const rec of (res.records ?? []) as Record<string, unknown>[]) {
        for (const f of chunk) {
          const v = rec[f]
          if (v !== null && v !== undefined && v !== '') populated.add(f)
        }
      }
    }
  } catch (err) {
    throw new RdsHandlerError(
      'INVALID_STATE',
      `Populated-fields probe failed for ${objectName} — retry, or turn off "populated only": ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return [...populated]
}

/**
 * `rds:deploy.start` — 5B.9: freeze the plan and run the deployment as a background job
 * (disable → deploy → finalize → restore, orchestrator + E4A hooks). Returns { jobId }
 * immediately; refuses when the CPQ attestation is required-but-false or the target connection's
 * role is not 'target' (a prod-pinned or source org can never be deployed into).
 */
export async function startDeployRun(deps: DeployRunDeps, deploymentId: number): Promise<{ jobId: string }> {
  const { store, jobs, connectById, deployRunByJob } = deps
  // Run-lock: one deploy per deployment (same adopt-in-flight pattern as
  // rds:analyze) — a double-click must not race two runs at one target.
  const inFlight = jobs
    .list()
    .find(
      (j) =>
        j.kind === 'deploy' && j.deploymentId === String(deploymentId) && j.status === 'running'
    )
  if (inFlight) return { jobId: inFlight.id }

  const draft = store.loadDraft(deploymentId)
  if (!draft) throw new RdsHandlerError('NOT_FOUND', `Deployment ${deploymentId} not found`)
  const planned = store.getPlannedObjects(deploymentId)
  if (planned.length === 0) {
    throw new RdsHandlerError('INVALID_STATE', 'Run analysis before deploying.')
  }

  // D1 run-lock across app sessions: deploy_runs is the source of truth.
  // A NON-terminal run (incl. Stalled) means the target may still have
  // automation disabled — never deploy over it. (A busy STATUS with no
  // live run is a crash artifact; Store.reconcileOnStartup marks it Failed
  // at launch, so by the time a button can be pressed it is gone.)
  const runs = store.deploy.listRunsForDeployment(deploymentId)
  const liveRun = runs.find((r) => !TERMINAL_RUN_PHASES.has(r.phase))
  if (liveRun) {
    throw new RdsHandlerError(
      'INVALID_STATE',
      liveRun.phase === 'Stalled'
        ? 'A previous run of this deployment stalled during teardown — its target-org automation ' +
            'may still be disabled. Restore it manually (steps on the deployment page), then create ' +
            'a NEW deployment for the next attempt; recovery/acknowledge arrives with the E2 slice.'
        : `A previous run of this deployment is still recorded as ${liveRun.phase} — its target-org ` +
            'automation may still be disabled. Restore it manually (steps on the deployment page) ' +
            'before deploying again.'
    )
  }
  // The other strand shape (PLAN RC-4b): a TERMINAL run whose per-item
  // restore did not fully confirm — restore never throws per item, so
  // this is how a stranded target normally looks. A new run cannot
  // re-discover items that are already disabled; refuse until they are
  // restored (the E2 slice adds acknowledge/recovery).
  const lastRun = runs.length > 0 ? runs[runs.length - 1]! : null
  if (lastRun && store.deploy.ledgerUnconfirmed(runUuidFor(lastRun.id)).length > 0) {
    throw new RdsHandlerError(
      'INVALID_STATE',
      'The previous run of this deployment ended with automation items NOT confirmed restored on ' +
        'the target. Restore them manually (steps on the deployment page), then create a NEW ' +
        'deployment for the next attempt; acknowledge/recovery arrives with the E2 slice.'
    )
  }

  // S53 (item 2) — the SAME three gates, per TARGET ORG. Every check above
  // is scoped to this deployment; two deployments aimed at one org passed
  // them all and could run at once, and a stranded run of ANOTHER
  // deployment (Stalled / restore unconfirmed) left the target's automation
  // disabled while this one deployed over it. Siblings = every other
  // deployment whose target connection resolves to the same org id
  // (superseded aliases included). Never adopt a sibling's job.
  const siblings = store.deploymentsSharingTarget(deploymentId)
  if (siblings.length > 0) {
    const runningDeploys = new Set(
      jobs
        .list()
        .filter((j) => j.kind === 'deploy' && j.status === 'running' && j.deploymentId != null)
        .map((j) => j.deploymentId as string)
    )
    const candidates: TargetLockCandidate[] = siblings.map((s) => {
      const sRuns = store.deploy.listRunsForDeployment(s.id)
      const sLive = sRuns.find((r) => !TERMINAL_RUN_PHASES.has(r.phase))
      const sLast = sRuns.length > 0 ? sRuns[sRuns.length - 1]! : null
      return {
        deploymentId: s.id,
        name: s.name,
        runningJob: runningDeploys.has(String(s.id)),
        liveRunPhase: sLive?.phase ?? null,
        unconfirmedRestore:
          sLast != null ? store.deploy.ledgerUnconfirmed(runUuidFor(sLast.id)).length : 0
      }
    })
    const conflict = targetLockConflict(candidates, draft.targetLabel)
    if (conflict != null) throw new RdsHandlerError('INVALID_STATE', conflict)
  }

  // S59 (plan §6.5) — the symmetric lock: a template APPLY / RESTORE job
  // running against this target org, or temporary seed-time automation a
  // template run left disabled there, refuses the deploy.
  {
    const targetRow = store.getConnection(draft.targetConnectionId)
    const templateConflict = templateTargetLockConflict(store, jobs, targetRow?.orgId ?? '', draft.targetLabel)
    if (templateConflict != null) throw new RdsHandlerError('INVALID_STATE', templateConflict)
  }

  // Analysis run-lock (mirror of rds:plan.reorder): a completing analysis
  // rewrites every plan row — never freeze/deploy while one runs.
  const analysisInFlight = jobs
    .list()
    .find(
      (j) =>
        j.kind === 'analysis' &&
        j.deploymentId === String(deploymentId) &&
        j.status === 'running'
    )
  if (analysisInFlight) {
    throw new RdsHandlerError(
      'INVALID_STATE',
      'Analysis is in progress — wait for it to finish before deploying.'
    )
  }

  // Scope-drift gate (the StepPlan scopeChanged predicate, enforced
  // main-side): the analyzed plan's user objects must equal the draft's
  // current selection — freezing a stale plan resolves mappings against
  // objects the analysis never saw.
  const planView = store.getPlan(deploymentId)
  const planUserObjects = new Set(
    (planView?.objects ?? [])
      .map((o) => o.objectName)
      .filter((n) => !(planView?.autoInjectedJunctions ?? []).includes(n))
  )
  if (
    planUserObjects.size !== draft.config.selectedObjects.length ||
    draft.config.selectedObjects.some((o) => !planUserObjects.has(o))
  ) {
    throw new RdsHandlerError(
      'INVALID_STATE',
      'The object scope changed after analysis — re-run analysis before deploying.'
    )
  }

  // The attempt body. `onRun` fires once, right after createRun, so the
  // wrapper below knows whether a run row (and its status mirror) exists
  // when something throws.
  const work = async (
    ctx: JobContext,
    onRun: (runId: number) => void
  ): Promise<{ outcome: RunOutcome } & RunCounters> => {
    const cfg = draft.config

    ctx.phase('Connecting')
    const source = await connectById(draft.sourceConnectionId, 'source')
    // NO role override (REVIEW-FIX): overriding to 'target' would
    // silently re-promote a connection the user demoted on the
    // Connections page. The STORED role must be exactly 'target' (and
    // connect() may still downgrade it — prod pin / untrusted OAuth).
    const target = await connectById(draft.targetConnectionId)
    if (target.role !== 'target') {
      throw new RdsHandlerError(
        'READ_ONLY_ORG',
        `Org '${target.alias}' cannot be a deploy target (role '${target.role}') — ` +
          `set its role to Target on the Orgs step or the Connections page, then deploy again.`
      )
    }
    ctx.cancel.throwIfCancelled()

    // FRESH automation discovery — the attestation gate re-evaluates
    // against current target state, never a stale wizard snapshot.
    ctx.phase('Gates')
    const scope = planned.map((p) => p.objectName)
    const discoveryIo = makeAutomationIo(target)
    const snapshot = await discoverAutomation(discoveryIo, scope)
    // S54 F2: the counts and the flow-set actually in play go in the job
    // log, not just the wizard panel (the L2 lesson).
    for (const line of discoverySummaryLines(snapshot)) ctx.log(line.message, line.level)
    if (attestationBlocked(snapshot, false, cfg.cpqAttestation)) {
      throw new RdsHandlerError(
        'INVALID_STATE',
        'CPQ "Triggers Disabled" attestation is required before deploying — confirm it on the plan step.'
      )
    }
    // S32 per-run WFR toggle ANDed with the master switch — off means
    // the slice never even queries the rules.
    const workflowRulesEnabled =
      (cfg.disableAutomations ?? true) && (cfg.disableWorkflowRules ?? true)
    const workflowRules = workflowRulesEnabled ? await queryWorkflowRules(discoveryIo) : []
    const items = snapshot.items.filter((i) => effectiveDisable(i, cfg))
    ctx.cancel.throwIfCancelled()

    // Freeze: ORG-WIDE targetHasExtId (batchCheckRdsField oracle — a
    // scoped set over-downgrades A10), full describes per object.
    ctx.phase('Freezing plan')
    // S61 (U-5): keyless = no External Id field anywhere — no org-wide key probe, no keyed-row
    // probe, no own-key refusal; the id map is the matching mechanism for this run.
    const keyless = isKeyless(cfg)
    if (keyless) {
      ctx.log(
        'KEYLESS deployment: records are inserted and matched through this app’s local id map; the External Id field is not used. ' +
          KEYLESS_CAUTION,
        'warn'
      )
    }
    const targetHasExtId = keyless ? new Set<string>() : await targetHasExtIdOrgWide(target)
    const objects = []
    for (const p of planned) {
      const sourceFields = await describeDeployFields(source, p.objectName)
      // populated-only (REVIEW-FIX): when the user chose it, the probe
      // MUST run — populatedFields:null excludes nothing, silently
      // deploying every field the wizard displayed as excluded. A probe
      // failure refuses the deploy rather than guessing.
      let populatedFields: string[] | null = null
      if (cfg.populatedOnly) {
        populatedFields = await probePopulatedFields(
          source,
          p.objectName,
          sourceFields.map((f) => f.apiName)
        )
      }
      objects.push({
        planned: p,
        sourceFields,
        targetFields: await describeDeployFields(target, p.objectName),
        populatedFields
      })
      ctx.cancel.throwIfCancelled()
    }
    // S57 (B1): parents OUTSIDE the plan that the target can key — probed once
    // here so the frozen plan resolves exactly what the Mappings step showed
    // (same policy call, same two sets). Read-only, one LIMIT 1 query per parent.
    const srcByObject: Record<string, readonly RefFieldLike[]> = {}
    const tgtByObject: Record<string, readonly RefFieldLike[]> = {}
    for (const o of objects) {
      srcByObject[o.planned.objectName] = o.sourceFields
      tgtByObject[o.planned.objectName] = o.targetFields
    }
    const outOfScope = outOfScopeRefs(cfg.selectedObjects, srcByObject, tgtByObject)
    const targetKeyedRows = keyless
      ? new Set<string>()
      : await probeKeyedRows(
          target.conn,
          targetHasExtId,
          outOfScope.map((r) => r.refTo)
        )
    if (targetKeyedRows.size > 0) {
      ctx.log(
        'Parents outside the plan will resolve against RDS-keyed rows already on the target: ' +
          [...targetKeyedRows].sort().join(', ') +
          '.',
        'info'
      )
    }
    const plan = freezePlan({ objects, config: cfg, targetHasExtId, targetKeyedRows })
    // A2: freeze warnings (repairs A7/A9/A10/A12 + the S46 excluded-
    // deferred drops) were persisted only inside plan_json — surface
    // each as a job log line (Apex logged its repairs at Info,
    // DDQ:2017-2025; these are operator-actionable, so warn).
    for (const w of plan.warnings) ctx.log(w, 'warn')
    const planJson = JSON.stringify(plan)
    const planRow = store.deploy.savePlan(
      deploymentId,
      planJson,
      createHash('sha256').update(planJson).digest('hex')
    )
    const run = store.deploy.createRun(deploymentId, planRow.id)
    // Attempt linkage (S47): this attempt's run + the gate-time CPQ probe.
    store.setCurrentRun(deploymentId, run.id)
    store.deploy.setRunCpqTriggerSetting(run.id, snapshot.hasCpqTriggerSetting)
    onRun(run.id)

    // S53 (item 1) — pre-run audit, READ-ONLY, fail-open: does the target
    // already hold unkeyed rows under RDS-keyed parents (an earlier run's
    // automation residue, or hand-made records)? Said BEFORE the run so the
    // operator knows a re-run cannot remove or de-duplicate them.
    ctx.phase('Auditing target')
    if (keyless) ctx.log('Pre-run audit skipped: a keyless deployment leaves no RDS key to tell its rows from others.', 'info')
    else try {
      await preRunAudit({
        target,
        store: store.deploy,
        runId: run.id,
        plan,
        targetFieldsByObject: new Map(
          objects.map((o) => [o.planned.objectName, o.targetFields])
        ),
        targetHasExtId,
        log: (level, message) => ctx.log(message, level)
      })
    } catch (e) {
      ctx.log(`Pre-run audit skipped: ${e instanceof Error ? e.message : String(e)}`, 'warn')
    }
    ctx.cancel.throwIfCancelled()

    ctx.phase('Deploying')
    const log = (level: 'warn' | 'error', message: string): void => ctx.log(message, level)
    // The last Error-level engine line (tripwire text, whole-object
    // exhaustion detail, teardown error) — persisted with the terminal
    // status so the REASON survives (review F2; Apex kept it in
    // Error_Message__c). The renderer has no log pane yet (5C.1).
    let lastErrorLine: string | null = null
    const io = makeDeployIo({
      source,
      target,
      store: store.deploy,
      ...(keyless ? { idMap: makeDeployIdMap(store.deploy, target, deploymentId) } : {}),
      emit: (event) => {
        if (event.kind === 'phase') ctx.phase(String(event.data.phase ?? ''))
        else if (event.kind === 'log') {
          const message = String(event.data.message ?? '')
          if (event.data.level === 'Error') lastErrorLine = message
          ctx.log(
            message,
            event.data.level === 'Error'
              ? 'error'
              : event.data.level === 'Warning'
                ? 'warn'
                : 'info'
          )
        } else if (event.kind === 'progress')
          ctx.progress(
            Number(event.data.value ?? 0),
            Number(event.data.max ?? 0),
            String(event.data.label ?? '')
          )
      }
    })
    const hooks = makeAutomationHooks({
      deploymentId,
      runUuid: runUuidFor(run.id),
      plan,
      items,
      workflowRules,
      workflowRulesEnabled,
      ledger: store.deploy,
      toggleIo: makeAutomationToggleIo(target, log),
      triggerIo: makeTriggerToggleIo(target, log),
      metadataIo: makeMetadataToggleIo(target, log),
      guardIo: makeCpqGuardIo(target, log),
      // S61 (U-5): Contract activation scopes by mapped target ids when there is no key.
      ...(keyless
        ? { idMapLookup: (objectApiName: string, sourceIds: ReadonlyArray<string>) => store.deploy.idMapLookup(target.orgId, objectApiName, sourceIds) }
        : {})
    })
    const outcome = await runDeployment(
      run.id,
      io,
      { ...makePassExecutors(plan), ...hooks },
      {
        signal: {
          get aborted() {
            return ctx.cancel.cancelled
          }
        }
      }
    )
    // S53 (item 1) — post-run audit, READ-ONLY, fail-open, EVERY outcome:
    // rows created on the target during the run window by the deploying
    // user WITHOUT the RDS key are the fingerprint of target automation
    // that ran during the load (the "two of every product" class).
    // Runs after teardown so restore is already done; changes no outcome.
    ctx.phase('Auditing target')
    try {
      await postRunAudit({
        target,
        store: store.deploy,
        runId: run.id,
        plan,
        targetHasExtId,
        ...(keyless ? { keyless: { deploymentId, targetOrgId: target.orgId } } : {}),
        log: (level, message) => ctx.log(message, level)
      })
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      ctx.log(`Post-run audit failed: ${why}`, 'warn')
      try {
        store.deploy.markAuditComplete(run.id, `failed: ${why}`)
      } catch {
        /* the run row is gone — nothing to stamp */
      }
    }

    const counters = store.deploy.runCounters(run.id)
    // Terminal mapping (orchestrator.ts:34-36 contract): 'cancelled'
    // must surface as the job's cancelled event, not a normal 'done'.
    if (outcome === 'cancelled') throw new JobCancelledError()
    if (outcome === 'failed') {
      // A Stalled run means the RESTORE did not complete — the target's
      // automation may still be disabled. That message must never hide
      // behind a record-failure count (REVIEW-FIX).
      const finalPhase = store.deploy.getRun(run.id)?.phase
      if (finalPhase === 'Stalled') {
        // E2 (text slice): no recovery exists yet — say so, and point at
        // the manual Setup steps rendered on the deployment page.
        throw new RdsHandlerError('INVALID_STATE', stalledMessage(lastErrorLine))
      }
      throw new RdsHandlerError(
        'INVALID_STATE',
        runFailureMessage(counters.recordsFailed, lastErrorLine)
      )
    }
    return { outcome, ...counters }
  }

  // S62 (U-2): the template stages this deployment runs around its data, from the draft.
  const templateSteps = templateStepsOf(draft.config)
  const composed = templateSteps.before.length + templateSteps.after.length > 0
  const targetRowForStages = store.getConnection(draft.targetConnectionId)

  const jobId = jobs.start(
    'deploy',
    composed ? 'Deploy data (with template stages)' : 'Deploy data',
    async (ctx) => {
      // D1: the attempt owns the row from its first instant (Apex DDS:70
      // flipped Status to 'Deploying' before the first hop); the previous
      // attempt's error is cleared with it.
      store.markDeployStarted(deploymentId)
      const attempt: { runId: number | null } = { runId: null }
      // S54 F5: peak working set per process over the run → one log line.
      const memory = startMemorySampler(() =>
        deps.appMetrics().map((m) => ({ type: m.type, workingSetKB: m.memory.workingSetSize }))
      )
      // S62: stage rows for a composed attempt (none for a plain deployment — nothing changes).
      const attemptId = randomUUID()
      const stageRows = composed
        ? store.deploy.createStages(deploymentId, attemptId, [
            ...templateSteps.before.map((s) => ({ kind: 'template' as const, label: s.name, templateId: s.templateId })),
            { kind: 'deploy' as const, label: 'Data deployment', templateId: null },
            ...templateSteps.after.map((s) => ({ kind: 'template' as const, label: s.name, templateId: s.templateId }))
          ])
        : []
      const dataStage = stageRows.find((s) => s.kind === 'deploy') ?? null
      const stageFor = (ref: TemplateStepRef, offset: number): (typeof stageRows)[number] | null => stageRows[offset] ?? null
      const skipFrom = (position: number, why: string): void => {
        for (const s of stageRows) if (s.position >= position && s.state === 'pending') store.deploy.stageFinished(s.id, 'skipped', why)
      }
      /** Run one template stage; returns false when the sequence must stop. */
      const runStage = async (ref: TemplateStepRef, offset: number): Promise<boolean> => {
        const row = stageFor(ref, offset)
        if (!row) return true
        ctx.phase(`Stage ${row.position + 1}: ${ref.name}`)
        store.deploy.stageStarted(row.id)
        ctx.cancel.throwIfCancelled()
        const out = await runTemplateStage(
          { store, jobs, connectById },
          ctx,
          {
            templateId: ref.templateId,
            steps: ref.steps,
            options: {
              disableTargetAutomation: true,
              cpqAttestation: draft.config.cpqAttestation,
              purge: false,
              resume: false
            },
            sourceConnectionId: draft.sourceConnectionId,
            targetConnectionId: draft.targetConnectionId,
            deploymentId,
            onRunCreated: (runId) => store.deploy.stageLinkRun(row.id, { templateRunId: runId })
          }
        )
        const state = stageStateOf(out.report.state)
        const note =
          state === 'blocked'
            ? out.report.preflight.blockers.join(' · ')
            : out.report.summary.unexpected > 0
              ? `${out.report.summary.unexpected} unexpected problem${out.report.summary.unexpected === 1 ? '' : 's'}`
              : null
        store.deploy.stageFinished(row.id, state, note)
        ctx.log(`stage ${row.position + 1} "${ref.name}": ${state}${note ? ` — ${note}` : ''}`, stageAllowsContinue(state) ? 'info' : 'error')
        if (!stageAllowsContinue(state)) {
          skipFrom(row.position + 1, `stage ${row.position + 1} "${ref.name}" ended ${state}`)
          if (state === 'cancelled') throw new JobCancelledError()
          throw new RdsHandlerError('INVALID_STATE', `Stage "${ref.name}" (${state})${note ? `: ${note}` : ''} — the deployment did not run. See the stage's report.`)
        }
        return true
      }
      try {
        // ── BEFORE stages ──
        for (let i = 0; i < templateSteps.before.length; i++) await runStage(templateSteps.before[i]!, i)
        if (composed && targetRowForStages) {
          // A before-stage must leave the org restorable before the data stage touches it.
          const left = templateTargetLockConflict(store, jobs, targetRowForStages.orgId, draft.targetLabel)
          if (left) {
            if (dataStage) skipFrom(dataStage.position, left)
            throw new RdsHandlerError('INVALID_STATE', left)
          }
        }
        // ── the data run ──
        if (dataStage) {
          ctx.phase(`Stage ${dataStage.position + 1}: data deployment`)
          store.deploy.stageStarted(dataStage.id)
        }
        let result: Awaited<ReturnType<typeof work>>
        try {
          result = await work(ctx, (runId) => {
            attempt.runId = runId
            deployRunByJob.set(ctx.jobId, runId)
            if (dataStage) store.deploy.stageLinkRun(dataStage.id, { deployRunId: runId })
          })
        } catch (err) {
          if (dataStage) {
            const cancelled = err instanceof JobCancelledError
            store.deploy.stageFinished(dataStage.id, cancelled ? 'cancelled' : 'failed', err instanceof Error ? err.message : String(err))
            skipFrom(dataStage.position + 1, cancelled ? 'the data deployment was cancelled' : 'the data deployment failed')
          }
          throw err
        }
        if (dataStage) {
          store.deploy.stageFinished(dataStage.id, dataStageState(result.recordsFailed), result.recordsFailed > 0 ? `${result.recordsFailed} record${result.recordsFailed === 1 ? '' : 's'} failed` : null)
        }
        // ── AFTER stages ──
        const afterOffset = templateSteps.before.length + 1
        for (let i = 0; i < templateSteps.after.length; i++) await runStage(templateSteps.after[i]!, afterOffset + i)
        return result
      } catch (err) {
        // D1 close-out (services/deployAttempt.ts — tested in the sqlite
        // lane): pre-run → Failed + FULL text / Cancelled; run still Frozen
        // → close it through the state machine; otherwise the run mirrored
        // its own status and only the reason is recorded.
        closeOutAttempt(store, deploymentId, attempt.runId, err)
        throw err
      } finally {
        const peak = memory.stop()
        if (peak) ctx.log(peak, 'info')
        deployRunByJob.delete(ctx.jobId)
      }
    },
    { deploymentId: String(deploymentId) }
  )
  return { jobId }
}
