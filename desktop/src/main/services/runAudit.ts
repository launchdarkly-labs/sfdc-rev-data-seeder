/**
 * S53 (item 1) — the automation-born-row audit, bound to a live target
 * (engine/deploy/automationAudit.ts is the pure half). Two entry points the
 * rds:deploy.start job calls around `runDeployment`:
 *
 *   preRunAudit   after the plan is frozen and the run row exists, BEFORE
 *                 automation is disabled: "the target already holds unkeyed
 *                 rows under RDS-keyed parents" (residue of an earlier run's
 *                 automation, or hand-made records). Warns + persists.
 *   postRunAudit  after `runDeployment` returns (any outcome): "rows created
 *                 during the run window by the deploying user with no key" —
 *                 the fingerprint of target automation that ran during the
 *                 load. Warns loudly + persists + stamps the run audited.
 *
 * READ-ONLY on the target (SELECT COUNT() / SELECT Id … LIMIT 5) and FAIL-OPEN:
 * an audit error is logged and recorded in `deploy_runs.audit_note`; it never
 * changes the run's outcome. The findings are observability for the operator,
 * who is the only one who can flip CPQ "Triggers Disabled".
 */
import type { GuardedOrg } from './salesforce'
import { runQuery } from './analysisIo'
import type { DeployStore } from './deployStore'
import type { DeployPlan } from '../engine/deploy/planFreeze'
import type { DescribeField } from '../engine/deploy/transform/fieldFilter'
import { scopeParentFieldOf } from '../engine/deploy/firstPass'
import {
  describeFindings,
  postRunAuditQueries,
  preRunAuditQueries,
  runAudit,
  type AuditFinding,
  type AuditRunner,
  type PreRunAuditObject
} from '../engine/deploy/automationAudit'
import { AUTOMATION_BORN_GUIDANCE, PRE_RUN_UNKEYED_GUIDANCE } from '../../shared/recoveryCopy'

export type AuditLog = (level: 'info' | 'warn' | 'error', message: string) => void

/** The pure audit's IO over one GuardedOrg (read-only queries; no assertWritable). */
export function auditRunnerFor(target: GuardedOrg): AuditRunner {
  return {
    async count(soql: string): Promise<number> {
      const res = await runQuery(target.conn, soql)
      return Number(res.totalSize ?? 0)
    },
    async sampleIds(soql: string): Promise<string[]> {
      const res = await runQuery(target.conn, soql)
      return res.records
        .map((r) => (r['Id'] == null ? '' : String(r['Id'])))
        .filter((id) => id !== '')
    }
  }
}

/** The pre-run audit's per-object input, from the frozen plan + the target describes. */
export function preRunAuditObjects(
  plan: DeployPlan,
  targetFieldsByObject: ReadonlyMap<string, ReadonlyArray<DescribeField>>
): PreRunAuditObject[] {
  return plan.objects.map((o) => {
    const lookup = scopeParentFieldOf(o)
    const scope = o.scope
    const parentObject =
      scope != null && (scope.kind === 'parentIn' || scope.kind === 'parentSubquery')
        ? scope.parentObject
        : null
    const field =
      lookup == null
        ? undefined
        : targetFieldsByObject.get(o.objectName)?.find((f) => f.apiName === lookup)
    // Polymorphic lookups cannot be traversed by relationship name.
    const relationship =
      field != null && field.referenceTo.length === 1 ? (field.relationshipName ?? null) : null
    return {
      objectName: o.objectName,
      isJunction: o.isJunction,
      scopeParentField: lookup,
      scopeParentObject: parentObject,
      scopeParentRelationship: relationship
    }
  })
}

export interface PreRunAuditOptions {
  target: GuardedOrg
  store: DeployStore
  runId: number
  plan: DeployPlan
  targetFieldsByObject: ReadonlyMap<string, ReadonlyArray<DescribeField>>
  targetHasExtId: ReadonlySet<string>
  log: AuditLog
}

export async function preRunAudit(opts: PreRunAuditOptions): Promise<AuditFinding[]> {
  const queries = preRunAuditQueries(
    preRunAuditObjects(opts.plan, opts.targetFieldsByObject),
    opts.targetHasExtId
  )
  if (queries.length === 0) return []
  const result = await runAudit(queries, auditRunnerFor(opts.target))
  for (const e of result.errors) {
    opts.log('warn', `Pre-run audit could not check ${e.objectApiName}: ${e.error}`)
  }
  if (result.findings.length > 0) {
    opts.store.recordAuditFindings(opts.runId, result.findings)
    const total = result.findings.reduce((n, f) => n + f.count, 0)
    opts.log(
      'warn',
      `Before this run: the target already holds ${total} row(s) WITHOUT the RDS key under ` +
        `RDS-keyed parents — ${describeFindings(result.findings)}. ${PRE_RUN_UNKEYED_GUIDANCE}`
    )
  }
  return result.findings
}

export interface PostRunAuditOptions {
  target: GuardedOrg
  store: DeployStore
  runId: number
  plan: DeployPlan
  targetHasExtId: ReadonlySet<string>
  log: AuditLog
}

export async function postRunAudit(opts: PostRunAuditOptions): Promise<AuditFinding[]> {
  const run = opts.store.getRun(opts.runId)
  if (run == null || run.startedAt == null) {
    const note = 'skipped: the run has no recorded start time'
    opts.log('warn', `Post-run audit ${note}.`)
    if (run != null) opts.store.markAuditComplete(opts.runId, note)
    return []
  }

  let deployingUserId: string | null = null
  try {
    const identity = await opts.target.conn.identity()
    deployingUserId = identity.user_id != null ? String(identity.user_id) : null
  } catch (e) {
    opts.log(
      'warn',
      `Post-run audit: identity() failed — ${e instanceof Error ? e.message : String(e)}`
    )
  }
  if (deployingUserId == null) {
    const note = 'skipped: could not resolve the deploying user on the target'
    opts.log('warn', `Post-run audit ${note}.`)
    opts.store.markAuditComplete(opts.runId, note)
    return []
  }

  const queries = postRunAuditQueries({
    objects: opts.plan.objects,
    targetHasExtId: opts.targetHasExtId,
    runStartedAtMs: run.startedAt,
    runFinishedAtMs: run.finishedAt,
    deployingUserId
  })
  const result = await runAudit(queries, auditRunnerFor(opts.target))
  opts.store.recordAuditFindings(opts.runId, result.findings)
  for (const e of result.errors) {
    opts.log('warn', `Post-run audit could not check ${e.objectApiName}: ${e.error}`)
  }

  if (result.findings.length > 0) {
    const total = result.findings.reduce((n, f) => n + f.count, 0)
    const samples = result.findings
      .filter((f) => f.sampleIds.length > 0)
      .map((f) => `${f.objectApiName}: ${f.sampleIds.join(', ')}`)
      .join('; ')
    opts.log(
      'error',
      `AUDIT: ${total} record(s) were created on the target by its OWN automation during this run ` +
        `(no RDS key) — ${describeFindings(result.findings)}.` +
        (samples ? ` Sample ids — ${samples}.` : '') +
        ` ${AUTOMATION_BORN_GUIDANCE}`
    )
  } else {
    const checked = queries.length - result.skippedMissingObjects.length
    opts.log(
      'info',
      `Audit: no records were created by target-org automation during this run ` +
        `(${checked} object(s) checked).`
    )
  }
  const note =
    result.errors.length > 0
      ? `${result.errors.length} object(s) could not be audited: ` +
        result.errors.map((e) => e.objectApiName).join(', ')
      : null
  opts.store.markAuditComplete(opts.runId, note)
  return result.findings
}
