/**
 * S53 (item 1) — the automation-born-row audit: detecting the re-run duplicate class.
 *
 * THE CLASS. Every record the engine writes carries the upsert key
 * (`Data_Deployment_External_Id__c`, stamped from the source Id), so a re-run
 * updates in place — the local DB proves it for the re-run test deployments (deployments
 * 9 and 10 wrote the same 137 SBQQ__QuoteLine__c / 59 OLI / 13 Quote / 24
 * Opportunity source records to IDENTICAL target ids). What the engine cannot
 * see is what the TARGET ORG creates on its own while the load runs: CPQ's
 * quote→opportunity sync spawning OpportunityLineItems from quote lines,
 * bundle triggers auto-adding option quote lines, contracting spawning
 * Contract/Subscription/Asset, customer flows cloning children. Those rows
 * carry NO key, so the upsert never matches them, a re-run leaves them in
 * place and adds nothing — and the user sees "two of every product on the
 * opportunity" with the run reporting Completed. The only protection was the
 * operator's manual "Triggers Disabled" attestation plus an error-text
 * tripwire that fires ONLY when a managed trigger actually errors.
 *
 * THE FINGERPRINT is trivial to query: rows CREATED DURING THE RUN WINDOW, BY
 * THE DEPLOYING USER (triggers and record-triggered flows run as the user who
 * caused the DML), WITHOUT the key. Verified read-only on onesolve after run
 * 15 (2026-09-12): 1,031 keyed OLIs and 1,586 keyed quote lines under deployed
 * parents, ZERO unkeyed — a clean run reads as zero everywhere.
 *
 * Two audits, both READ-ONLY, both fail-open (a query error is a warning, never
 * a deploy decision):
 *   • POST-RUN (`postRunAuditQueries`): per non-junction plan object, plus the
 *     known CPQ spawn objects that are NOT in the plan (they need no key on
 *     target — nothing of ours could have landed there), count rows created in
 *     the window by the deploying user with a null key (or any key-less row for
 *     an object that has no key field). A hit is reported as "created by
 *     target-org automation", with sample ids.
 *   • PRE-RUN (`preRunAuditQueries`): per scoped child object, count rows that
 *     already sit under RDS-keyed parents WITHOUT a key — the residue of an
 *     earlier run's automation (or hand-made test records). Informational: a
 *     re-run updates keyed rows only and can neither remove nor de-duplicate
 *     these, and the user should know before the run, not after.
 *
 * Junctions (OpportunityContactRole) are excluded from both: the engine itself
 * inserts them without a key.
 *
 * Pure: SOQL builders + result shaping over injected `count` / `sample`
 * callbacks. No jsforce, no sqlite, no clock (the window start is an input).
 */
import { EXTERNAL_ID_FIELD } from './transform/sfid'
import { escapeSingleQuotes, isBlank } from './transform/apexSemantics'

/**
 * Objects target-org automation is KNOWN to create rows on during a CPQ data
 * load (objectPolicy gatedBy notes: quote→opp twin/sync, contracting,
 * bundle option auto-add). Audited even when not in the plan.
 */
export const AUTOMATION_SPAWN_OBJECTS: readonly string[] = [
  'OpportunityLineItem',
  'SBQQ__QuoteLine__c',
  'SBQQ__QuoteLineGroup__c',
  'Contract',
  'SBQQ__Subscription__c',
  'Asset'
]

/**
 * Clock-skew allowance between this machine (`deploy_runs.started_at`) and
 * the org's CreatedDate. Generous on purpose: a minute of pre-run rows by the
 * same user is a cheap false positive; a missed automation burst is not.
 */
export const AUDIT_WINDOW_SKEW_MS = 60_000

/** How many offending ids to fetch per object for the report. */
export const AUDIT_SAMPLE_LIMIT = 5

/**
 * Per-object predicates that EXCLUDE known, unavoidable platform artefacts —
 * rows the platform itself creates on every load and that are neither
 * duplicates nor CPQ automation:
 *   • OpportunityTeamMember 'Opportunity Owner' — Salesforce adds the owner to
 *     the team the moment the first team member is inserted (system-managed
 *     row). Live evidence: run 15 on onesolve (2026-09-11) left exactly 6 of
 *     them, all created 08:00:45 UTC while OpportunityTeamMember was loading,
 *     one per Westpac opportunity that received team members; nothing else in
 *     the run window was unkeyed once the finish bound was applied.
 * Reporting these would train the operator to ignore the audit.
 */
export const AUDIT_PLATFORM_ARTEFACT_EXCLUSIONS: Readonly<Record<string, string>> = {
  OpportunityTeamMember: "TeamMemberRole != 'Opportunity Owner'"
}

function platformArtefactClause(objectApiName: string): string {
  const extra = AUDIT_PLATFORM_ARTEFACT_EXCLUSIONS[objectApiName]
  return extra == null ? '' : ` AND ${extra}`
}

export type AuditKind = 'automation_born' | 'pre_run_unkeyed'

export interface AuditFinding {
  kind: AuditKind
  objectApiName: string
  /** pre_run_unkeyed: the RDS-keyed parent object the rows sit under. */
  refObject: string | null
  /** pre_run_unkeyed: the lookup field to that parent. */
  refField: string | null
  count: number
  sampleIds: string[]
}

export interface AuditQuery {
  kind: AuditKind
  objectApiName: string
  refObject: string | null
  refField: string | null
  countSoql: string
  /** Null when no sample makes sense (pre-run counts are informational). */
  sampleSoql: string | null
}

/** SOQL datetime literal (UTC, no fractional seconds — SOQL rejects them). */
export function soqlDateTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export interface PostRunAuditInput {
  /** The frozen plan's objects (junctions are skipped). */
  objects: ReadonlyArray<{ objectName: string; isJunction: boolean }>
  /** Org-wide set of target objects carrying the key field (Tooling probe). */
  targetHasExtId: ReadonlySet<string>
  /** `deploy_runs.started_at` — the first phase transition out of Frozen. */
  runStartedAtMs: number
  /**
   * `deploy_runs.finished_at` — the terminal phase stamp. Bounds the window
   * from above so an audit that runs (or is re-run) later never attributes the
   * operator's own post-run work in the org to the run: the first live probe
   * (onesolve, 2026-09-12, a day after run 15) counted the quotes Jack had
   * built by hand in the meantime. Null/omitted (a Stalled run has no stamp)
   * leaves the window open-ended.
   */
  runFinishedAtMs?: number | null
  /** The deploying (connected) user's Id on the target. */
  deployingUserId: string
}

/** The post-run "rows created by target automation" queries. */
export function postRunAuditQueries(input: PostRunAuditInput): AuditQuery[] {
  const since = soqlDateTime(input.runStartedAtMs - AUDIT_WINDOW_SKEW_MS)
  const until =
    input.runFinishedAtMs == null
      ? null
      : soqlDateTime(input.runFinishedAtMs + AUDIT_WINDOW_SKEW_MS)
  const user = escapeSingleQuotes(input.deployingUserId)
  const planObjects = new Set<string>()
  const out: AuditQuery[] = []
  const add = (objectApiName: string, inPlan: boolean): void => {
    const hasKey = input.targetHasExtId.has(objectApiName)
    // In-plan objects always have the key (the S53 freeze gate refuses
    // otherwise); a spawn object without the key has no RDS rows at all, so
    // every row in the window is foreign.
    const where =
      `CreatedDate >= ${since}` +
      (until == null ? '' : ` AND CreatedDate <= ${until}`) +
      ` AND CreatedById = '${user}'` +
      (hasKey || inPlan ? ` AND ${EXTERNAL_ID_FIELD} = null` : '') +
      platformArtefactClause(objectApiName)
    out.push({
      kind: 'automation_born',
      objectApiName,
      refObject: null,
      refField: null,
      countSoql: `SELECT COUNT() FROM ${objectApiName} WHERE ${where}`,
      sampleSoql:
        `SELECT Id FROM ${objectApiName} WHERE ${where} ORDER BY CreatedDate DESC ` +
        `LIMIT ${AUDIT_SAMPLE_LIMIT}`
    })
  }
  for (const o of input.objects) {
    if (o.isJunction) continue
    planObjects.add(o.objectName)
    add(o.objectName, true)
  }
  for (const spawn of AUTOMATION_SPAWN_OBJECTS) {
    if (planObjects.has(spawn)) continue
    add(spawn, false)
  }
  return out
}

export interface PreRunAuditObject {
  objectName: string
  isJunction: boolean
  /** `scope.lookupField` of a parentIn / parentSubquery scope, else null. */
  scopeParentField: string | null
  /** `scope.parentObject`, else null. */
  scopeParentObject: string | null
  /** relationshipName of `scopeParentField` on the TARGET describe, else null. */
  scopeParentRelationship: string | null
}

/**
 * The pre-run "already-unkeyed children under RDS-keyed parents" queries —
 * one per scoped child object, along the relationship its scope was built on
 * (the same one the operator's manual probe used: QuoteLine → Quote,
 * OLI → Opportunity). Polymorphic and relationship-less lookups yield none.
 */
export function preRunAuditQueries(
  objects: ReadonlyArray<PreRunAuditObject>,
  targetHasExtId: ReadonlySet<string>
): AuditQuery[] {
  const out: AuditQuery[] = []
  for (const o of objects) {
    if (o.isJunction) continue
    if (
      isBlank(o.scopeParentField) ||
      isBlank(o.scopeParentObject) ||
      isBlank(o.scopeParentRelationship)
    ) {
      continue
    }
    if (!targetHasExtId.has(o.objectName) || !targetHasExtId.has(o.scopeParentObject as string)) {
      continue
    }
    out.push({
      kind: 'pre_run_unkeyed',
      objectApiName: o.objectName,
      refObject: o.scopeParentObject,
      refField: o.scopeParentField,
      countSoql:
        `SELECT COUNT() FROM ${o.objectName} WHERE ` +
        `${o.scopeParentRelationship}.${EXTERNAL_ID_FIELD} != null AND ${EXTERNAL_ID_FIELD} = null` +
        platformArtefactClause(o.objectName),
      sampleSoql: null
    })
  }
  return out
}

export interface AuditRunner {
  /** `SELECT COUNT() …` → totalSize. Rejects on a query error. */
  count(soql: string): Promise<number>
  /** `SELECT Id …` → the ids. Rejects on a query error. */
  sampleIds(soql: string): Promise<string[]>
}

export interface AuditResult {
  findings: AuditFinding[]
  /** Objects whose query failed for a reason other than "no such object". */
  errors: { objectApiName: string; error: string }[]
  /** Objects skipped because the target has no such sObject (spawn list). */
  skippedMissingObjects: string[]
}

/** "sObject type 'X' is not supported" / INVALID_TYPE — the object is absent on target. */
export function isMissingObjectError(message: string): boolean {
  return /INVALID_TYPE|sObject type .* is not supported|Didn't understand relationship/i.test(
    message
  )
}

/**
 * Run the queries, fail-open per object. Findings carry only objects with a
 * non-zero count; samples are fetched for those only.
 */
export async function runAudit(
  queries: ReadonlyArray<AuditQuery>,
  io: AuditRunner
): Promise<AuditResult> {
  const result: AuditResult = { findings: [], errors: [], skippedMissingObjects: [] }
  for (const q of queries) {
    let count: number
    try {
      count = await io.count(q.countSoql)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (isMissingObjectError(message)) result.skippedMissingObjects.push(q.objectApiName)
      else result.errors.push({ objectApiName: q.objectApiName, error: message })
      continue
    }
    if (count <= 0) continue
    let sampleIds: string[] = []
    if (q.sampleSoql != null) {
      try {
        sampleIds = await io.sampleIds(q.sampleSoql)
      } catch {
        // the count is the finding; a failed sample is not worth an error
      }
    }
    result.findings.push({
      kind: q.kind,
      objectApiName: q.objectApiName,
      refObject: q.refObject,
      refField: q.refField,
      count,
      sampleIds
    })
  }
  return result
}

/** One-line roll-ups for the job log / terminal summary. */
export function describeFindings(findings: ReadonlyArray<AuditFinding>): string {
  return findings
    .map((f) =>
      f.kind === 'pre_run_unkeyed'
        ? `${f.objectApiName} (${f.count} under keyed ${f.refObject} via ${f.refField})`
        : `${f.objectApiName} (${f.count})`
    )
    .join(', ')
}
