/**
 * E4E.2 — the first-pass batch loop (REST). Port of the per-page deploy hop in
 * `DataDeploymentQueueable.executeNormalModeV2` (DDQ L1318-2056), REST path
 * only (Bulk = E4T.3):
 *
 *   source query pages (the Apex batch == the REST query page; the fresh first
 *   page is batch 0 — DDQ L259-264 appendMode gate; continuation pages carry
 *   batchNumber+1, L2043-2044)
 *   → transformRecordV3 per record, skip + picklist-drop aggregation (L1827-1859)
 *   → stripMissingParentRefs (L1900-1901) → attributes stamp (L1902-1904)
 *   → Contract idempotency guard (L1913-1933)
 *   → collections upsert (L1935-1936, batch size = restBatchSizeFor L1311-1316
 *     via the frozen plan's recommendedBatchSize; the client clamps to 200)
 *   → typed per-record rows into record_results / failed_records — the Apex
 *     counter accumulators (L1968-2013) are REPLACED by rows the migration-005
 *     views recompute the sextet from
 *   → the Apex log lines, byte-exact, in source-code emission order
 *     (L1927-2041): contract-idempotency → strategy(+dropped detail) →
 *     picklist(Warning) → skip(Info) → parent-drop(Warning) → batch result.
 *
 * WHAT DOES NOT HAPPEN HERE (vs the Apex method): A5/A7/A9/A10/A12 + API
 * strategy selection (frozen at plan time, E2.6 — their log lines are plan
 * warnings now); Bulk path; retry drain (E4E.3); second pass (E4E.4);
 * junction (E4E.5).
 *
 * ROW-WRITING CONTRACT (the counter views' input — coordinates come ONLY from
 * ObjectPassContext, never invented): every source record of a page gets
 * EXACTLY ONE record_results row at (pass=1, ctx.retryPass, ctx.objectAttempt):
 *   'skipped'  transform skip (reason in errorMessage; retryPass-0 rows are
 *              what the views count — DDQ L1989-1996 first-pass-only rule),
 *   'success'  upsert success OR already-Activated Contract (Apex counted
 *              those as deployed, DDQ L1937-1940),
 *   'failed'   upsert failure — ALSO gets a failed_records row (extId, code,
 *              message, fields; classification stamped by the E4E.3
 *              classifier: root, or cascade when the legacy detail line's
 *              foreign-key parent is in an in-deployment object's
 *              current-truth failed set — DDQ classifyFailures L2202-2312).
 * Records_Queried = all rows of a fresh page (recordCount + batchSkipCount,
 * DDQ L1992) falls out of "one row per source record" by construction.
 *
 * TRIPWIRE: CpqTriggersActiveError propagates out of io.upsertBatch before the
 * next sub-batch (E4T.1) and out of this loop before the next page — the
 * orchestrator fails the whole run (no bounded retry).
 *
 * CANCEL: between pages a set store-cancel flag stops dispatching further
 * batches and returns cleanly; the orchestrator's boundary checks (including
 * its pre-teardown check) route the run to cancelled teardown.
 *
 * EMPTY PAGES (DDQ L1755-1767 — the Apex guard ran EVERY hop): an empty page
 * logs 'Skipped {obj} — no records on source' and completes the object,
 * including an empty CONTINUATION page (further pages abandoned; Apex parity).
 * Exception: an empty FIRST page of one chunk of a multi-chunk scope just
 * advances to the next chunk (deviation domain, see effectiveFilters).
 *
 * OVER-CAP SCOPES: a multi-chunk parentIn scope — reachable only via the
 * analysis' over-cap deviation, never in-org — walks one REAL query per id
 * chunk (effectiveFilters); its display summary string is never sent as SOQL.
 *
 * DESKTOP-ONLY OBSERVABILITY (not in the Apex, flagged in-line): a Warning
 * when the plan's API strategy isn't REST (E4T.3 pending), and a Warning when
 * composite failures can't be attributed to source records (blank/unknown
 * ExtId — Apex only counted those, it never attributed them).
 *
 * Pure over DeployIo: no jsforce, no better-sqlite3, no clock.
 */

import { transformRecordV3 } from './transform/pipeline'
import { uniqueConstraintFor, uniqueKeyOf, UNIQUE_COLLISION_REASON } from './uniqueConstraints'
import { stripMissingParentRefs, type StrippedRef } from './transform/parentStrip'
import { applyContractIdempotency } from './transform/contracts'
import { buildNormalSourceQuery } from './transform/queryBuild'
import { ciEquals, leftTruncate } from './transform/apexSemantics'
import { EXTERNAL_ID_FIELD, reverse } from './transform/sfid'
import { buildInClause, chunkIds, maxIdsForSoql } from '../scoping'
import {
  buildObjectContext,
  contractsIoFor,
  parentStripIoFor,
  type ObjectDeployContext
} from './objectContext'
import { buildFailedByObject, classifyFailureLine, isCascadeFromStrippedParent } from './classify'
import type { DeployPlan, FrozenObjectPlan } from './planFreeze'
import type {
  DeployIo,
  FailedRecordInput,
  StrippedRefInput,
  ObjectPassContext,
  QueryPage,
  RecordResultInput,
  UpsertBatchResult
} from './types'

/** One transformed record awaiting upsert — sourceId ↔ extId ↔ payload. */
interface TransformedRecord {
  sourceId: string | null
  extId: string | null
  payload: Record<string, unknown>
}

/** The PassExecutors.firstPass implementation, closed over the frozen plan. */
export function makeFirstPass(plan: DeployPlan): (ctx: ObjectPassContext) => Promise<void> {
  return (ctx) => runFirstPass(plan, ctx)
}

export async function runFirstPass(plan: DeployPlan, ctx: ObjectPassContext): Promise<void> {
  const objectName = ctx.object.objectName
  const objPlan = plan.objects.find((o) => o.objectName === objectName)
  if (objPlan == null) {
    throw new Error(`No frozen plan object for ${objectName}`)
  }
  if (objPlan.isJunction) {
    throw new Error(`${objectName} is a junction object — routed to junctionPass, not firstPass`)
  }
  const io = ctx.io

  if (!ciEquals(objPlan.apiStrategy, 'REST')) {
    // Desktop-only line: the playbook chose Bulk but E4T.3 hasn't landed.
    log(
      io,
      ctx.runId,
      'Warning',
      `${objectName} plan strategy '${objPlan.apiStrategy}' is not implemented in the desktop engine yet — using REST (E4T.3)`
    )
  }

  const octx = await buildObjectContext(objPlan, io)

  let batchNumber = 0
  let sawRecords = false
  // S50 (B2): the frozen plan's idChunks were sized for `SELECT Id`; this
  // object's real SELECT may not leave room for 4,000 of them. Budget from the
  // actual query (built once with a null filter) and sub-split if needed. The
  // FROZEN chunks are never mutated — only how we iterate them.
  const idBudget = maxIdsForSoql(
    buildNormalSourceQuery(objectName, octx.keptFields, null, octx.sourceHasIsPersonAccount).length
  )
  for (const filter of effectiveFilters(objPlan, idBudget)) {
    const soql = buildNormalSourceQuery(
      objectName,
      octx.keptFields,
      filter,
      octx.sourceHasIsPersonAccount
    )
    let chunkPage = 0
    for await (const page of io.querySourcePages(soql)) {
      // Between-batches cancel: stop dispatching; the orchestrator's boundary
      // checks convert the set flag into cancelled teardown.
      if (batchNumber > 0 && io.store.isCancelRequested(ctx.runId)) return
      if (page.records.length === 0) {
        // An empty CHUNK first page just advances to the next chunk (an empty
        // 4,000-parent slice is normal in the over-cap deviation domain; the
        // object-level skip line fires below only when EVERY chunk was empty).
        if (chunkPage === 0) break
        // Apex ran the empty-records guard on EVERY hop (DDQ L1755-1767): an
        // empty CONTINUATION page logs the skip line, completes the object,
        // and abandons any further pages (E4E.2 review finding — the guard
        // was batch-0-only). In the multi-chunk domain this also abandons
        // later chunks: a mid-cursor empty page is a pathological platform
        // state (rows deleted mid-walk) and the Apex semantics win.
        log(io, ctx.runId, 'Info', `Skipped ${objectName} — no records on source`)
        return
      }
      sawRecords = true
      await processPage(objPlan, octx, ctx, page, batchNumber, allObjectNames(plan))
      batchNumber++
      chunkPage++
    }
  }
  if (!sawRecords) {
    // DDQ L1755-1767 — nothing on source: log + complete the object.
    log(io, ctx.runId, 'Info', `Skipped ${objectName} — no records on source`)
  }
}

/**
 * Effective source filters (DDQ L1736-1737: Scoped_Filter__c, else
 * Filter_Clause__c). Usually ONE — the frozen scopedFilterDisplay, byte-
 * identical to the Apex Scoped_Filter__c. The exception (E4E.2 review HIGH):
 * a multi-chunk parentIn scope — produced only by the desktop analysis'
 * over-cap deviation ("Proceeding with N chunked queries"; unreachable in-org,
 * where analysis threw at MATERIALIZED_ID_CAP=1000) — renders its DISPLAY
 * string as a summary, not valid SOQL. That scope walks one REAL query per id
 * chunk; chunks partition the parent ids, so per-chunk results are disjoint
 * and union without dedupe.
 */
function effectiveFilters(objPlan: FrozenObjectPlan, idBudget: number): Array<string | null> {
  const scope = objPlan.scope
  if (scope == null || scope.kind !== 'parentIn') return [objPlan.scopedFilterDisplay]

  // S50 (B2): also take this path for a SINGLE chunk that exceeds the budget —
  // otherwise a one-chunk scope goes out via `scopedFilterDisplay` (real SOQL
  // when there is only one chunk) and overflows the statement ceiling. The
  // condition is deliberately narrow so a within-budget single chunk keeps
  // emitting the display string byte-for-byte, as before.
  const needsSubSplit = scope.idChunks.some((c) => c.length > idBudget)
  if (scope.idChunks.length > 1 || needsSubSplit) {
    const out: string[] = []
    for (const chunk of scope.idChunks) {
      for (const sub of chunkIds(chunk, idBudget)) {
        out.push(`WHERE ${scope.lookupField} IN (${buildInClause(sub)})`)
      }
    }
    return out
  }
  return [objPlan.scopedFilterDisplay]
}

/** The classifier's deployment-object universe (every plan object gets a key). */
export function allObjectNames(plan: DeployPlan): string[] {
  return plan.objects.map((o) => o.objectName)
}

/**
 * S53 — the `error_code` of a record withheld because its scope parent is not
 * on target. Grep-able in failed_records; the retry drain treats it like any
 * other failure.
 */
export const SCOPE_PARENT_MISSING_CODE = 'SCOPE_PARENT_NOT_ON_TARGET'

/**
 * S53 — the lookup this object was scoped by, or null for the root / an
 * unscoped object. `scope.lookupField` is exactly the FK the analysis used in
 * `WHERE <lookupField> IN (<parent ids>)`, so "its value is not on target"
 * means "this record's whole subtree membership is unresolved".
 */
export function scopeParentFieldOf(objPlan: FrozenObjectPlan): string | null {
  const scope = objPlan.scope
  if (scope == null) return null
  if (scope.kind === 'parentIn' || scope.kind === 'parentSubquery') return scope.lookupField
  return null
}

/**
 * One page's transform → strip → contract-guard → upsert → rows → logs — the
 * DDQ L1794-2041 hop body. SHARED with the retry drain (E4E.3 retry.ts): the
 * Apex retry pass ran this exact code with `retryInputIds` set; the only
 * differences live in the caller (query source + chunk loop + coordinates,
 * which arrive via `ctx`). Exported for that reuse only.
 */
export async function processPage(
  objPlan: FrozenObjectPlan,
  octx: ObjectDeployContext,
  ctx: ObjectPassContext,
  page: QueryPage,
  batchNumber: number,
  runObjectNames: ReadonlyArray<string>
): Promise<void> {
  const io = ctx.io
  const runId = ctx.runId
  const objectName = objPlan.objectName

  // ── Transform loop (DDQ L1827-1859) ──
  const uniqueFields = uniqueConstraintFor(objectName)
  const transformed: TransformedRecord[] = []
  const skippedRows: { sourceId: string; reason: string }[] = []
  const skipReasonCounts = new Map<string, number>()
  const aggregatedDroppedPicklist = new Map<string, Set<string>>()
  /** S50 (BUG-14): field → count of records whose User lookup was left empty. */
  const aggregatedFilteredLookupDrops = new Map<string, number>()
  let batchSkipCount = 0

  for (const rec of page.records) {
    const outcome = transformRecordV3(rec, octx.tctx)
    const rawId = rec['Id']
    const sourceId = rawId == null ? null : String(rawId)

    if (outcome.skipped === true) {
      batchSkipCount++
      const reason = outcome.skipReason == null ? 'unknown' : outcome.skipReason
      skipReasonCounts.set(reason, (skipReasonCounts.get(reason) ?? 0) + 1)
      if (sourceId != null) skippedRows.push({ sourceId, reason })
      continue
    }

    // S50 (BUG-14): a User lookup dropped instead of substituted, because the
    // target field enforces a lookup filter. Aggregated so the drop is visible
    // — an unexplained blank TAM is exactly the kind of silent difference this
    // session has been eliminating.
    for (const f of outcome.droppedFilteredLookups ?? []) {
      aggregatedFilteredLookupDrops.set(f, (aggregatedFilteredLookupDrops.get(f) ?? 0) + 1)
    }
    for (const [fld, vals] of Object.entries(outcome.droppedPicklistValues)) {
      if (vals.length === 0) continue
      let agg = aggregatedDroppedPicklist.get(fld)
      if (agg == null) {
        agg = new Set<string>()
        aggregatedDroppedPicklist.set(fld, agg)
      }
      for (const v of vals) agg.add(v)
    }

    // DDQ L1857 (`payload.remove('attributes')`) — stage1 builds the payload
    // fresh so the key can't exist; kept for parity clarity.
    const payload = outcome.payload as Record<string, unknown>
    delete payload['attributes']

    // S49 FIX (BUG-1 pt2): platform unique-constraint collision guard. Owner
    // substitution can map several distinct source records onto the SAME target
    // user, and the resulting upsert lands on the row a previous record created
    // — OVERWRITING it while reporting success (OTM: 27 source rows → 25 target
    // rows, both 'BDR' roles replaced by 'Opportunity Owner'). Skip the LATER
    // record deterministically so the first source row keeps the target row.
    if (uniqueFields != null) {
      const key = uniqueKeyOf(payload, uniqueFields)
      if (key != null) {
        const firstOwner = octx.uniqueKeySeen.get(key)
        if (firstOwner != null) {
          batchSkipCount++
          skipReasonCounts.set(
            UNIQUE_COLLISION_REASON,
            (skipReasonCounts.get(UNIQUE_COLLISION_REASON) ?? 0) + 1
          )
          if (sourceId != null) {
            skippedRows.push({
              sourceId,
              reason: `${UNIQUE_COLLISION_REASON} (${uniqueFields.join('+')} already claimed by ${firstOwner})`
            })
          }
          continue
        }
        octx.uniqueKeySeen.set(key, sourceId ?? '(unknown)')
      }
    }

    const eid = payload[EXTERNAL_ID_FIELD]
    transformed.push({ sourceId, extId: eid == null ? null : String(eid), payload })
  }

  // ── Per-batch picklist-drop line (DDQ L1861-1877) ──
  const picklistDropLines: string[] = []
  for (const [fld, agg] of aggregatedDroppedPicklist) {
    const sampleList = [...agg]
    const sampleStr =
      sampleList.length <= 5
        ? sampleList.join(', ')
        : [
            sampleList[0],
            sampleList[1],
            sampleList[2],
            sampleList[3],
            sampleList[4],
            `… (${sampleList.length - 5} more)`
          ].join(', ')
    picklistDropLines.push(`${fld} — sample values not allowed on target: ${sampleStr}`)
  }
  const pendingFilteredLookupLog =
    aggregatedFilteredLookupDrops.size === 0
      ? null
      : `${objectName} batch ${batchNumber}: left ` +
        [...aggregatedFilteredLookupDrops].map(([f, n]) => `${f} (${n})`).join(', ') +
        ' EMPTY — the source user is inactive on target and the field enforces a lookup ' +
        'filter the substitute user does not satisfy.'

  const pendingPicklistLog =
    picklistDropLines.length === 0
      ? null
      : `Picklist drop summary for ${objectName} batch ${batchNumber}: ` +
        picklistDropLines.join('; ')

  // ── Per-batch skip line (DDQ L1879-1888) ──
  let pendingSkipLog: string | null = null
  if (batchSkipCount > 0) {
    const skipParts: string[] = []
    for (const [reason, count] of skipReasonCounts) skipParts.push(`${reason}=${count}`)
    pendingSkipLog =
      `${batchSkipCount} record(s) skipped on ${objectName} batch ${batchNumber} ` +
      `(${skipParts.join(', ')})`
  }

  // Captured BEFORE the Contract partition (DDQ L1891) — with batchSkipCount it
  // reconstructs Records_Queried; here it feeds the batch log event.
  const recordCount = transformed.length

  // ── REST path (DDQ L1894-2041) ──
  const payloads = transformed.map((t) => t.payload)
  // S49 (BUG-10): capture WHAT was stripped, keyed by payload identity, so a
  // REQUIRED_FIELD_MISSING further down can be tied back to the parent that
  // caused it and classified as a cascade rather than a fresh root problem.
  const strippedByPayload = new Map<Record<string, unknown>, StrippedRef[]>()
  // S53 (A1 at N>1 — "skip the subtree"): records whose SCOPE parent is not on
  // target are WITHHELD from the upsert instead of written with the link
  // blanked. See scopeParentFieldOf + StripOptions.scopeParentField.
  const withheldByPayload = new Map<Record<string, unknown>, StrippedRef>()
  const pendingParentDropLog = await stripMissingParentRefs(
    parentStripIoFor(io),
    objectName,
    octx.keptFields,
    payloads,
    {
      strippedOut: strippedByPayload,
      scopeParentField: scopeParentFieldOf(objPlan),
      withheldOut: withheldByPayload
    }
  )
  for (const p of payloads) p['attributes'] = { type: objectName }

  // Contract re-run idempotency (DDQ L1913-1933): already-Activated targets are
  // dropped from the upsert and counted as deployed.
  let remaining = transformed
  let alreadyActivatedRows: TransformedRecord[] = []
  // S53: partition the withheld rows out BEFORE the Contract guard and the
  // upsert — they are never sent. Recorded below as FAILED (not skipped) so
  // the retry drain re-runs them: a parent that heals in a later retry round
  // relinks its subtree within the same run, whereas a skip is terminal.
  const withheldRows = transformed.filter((t) => withheldByPayload.has(t.payload))
  if (withheldRows.length > 0) {
    const keep = new Set(withheldRows)
    remaining = remaining.filter((t) => !keep.has(t))
  }
  let contractLog: string | null = null
  if (ciEquals(objectName, 'Contract') && transformed.length > 0) {
    const partition = await applyContractIdempotency(contractsIoFor(io), payloads)
    if (partition.alreadyActivated > 0) {
      const keep = new Set(partition.remaining) // same payload object refs
      remaining = transformed.filter((t) => keep.has(t.payload))
      alreadyActivatedRows = transformed.filter((t) => !keep.has(t.payload))
      contractLog =
        `${partition.alreadyActivated} Contract(s) already Activated on target — ` +
        'skipped Draft re-write (idempotent re-run).'
    }
  }

  const restResult = await io.upsertBatch(
    objectName,
    remaining.map((t) => t.payload),
    { updateOnly: false, batchSize: objPlan.recommendedBatchSize }
  )
  const successes = restResult.successCount + alreadyActivatedRows.length
  const failures = restResult.failureCount

  // ── Per-record rows (replaces the Apex counter accumulators) ──
  const coords = { pass: 1 as const, retryPass: ctx.retryPass, objectAttempt: ctx.objectAttempt }
  const resultRows: RecordResultInput[] = []
  const failureRows: FailedRecordInput[] = []

  for (const s of skippedRows) {
    resultRows.push({
      objectApiName: objectName,
      sourceId: s.sourceId,
      ...coords,
      outcome: 'skipped',
      errorMessage: s.reason
    })
  }
  for (const t of alreadyActivatedRows) {
    if (t.sourceId == null) continue
    resultRows.push({
      objectApiName: objectName,
      sourceId: t.sourceId,
      ...coords,
      outcome: 'success'
    })
  }

  const failedExtIds = new Set(restResult.failedExternalIds)
  const errsByExtId = groupTypedErrors(restResult)
  // S49 (BUG-1): the target id per submitted ExtId. Recording it is what makes
  // an upsert collapse detectable — two source rows whose owner substitution
  // maps them onto the same target record share one id here, so a later
  // reconcile can compare deployed-count vs DISTINCT target ids instead of
  // trusting the API's per-record success.
  const targetIdByExtId = new Map<string, string>()
  for (const si of restResult.successIds ?? []) targetIdByExtId.set(si.extId, si.id)
  // Failure-text sources for records WITHOUT typed errors:
  //  - a composite failure whose errors[] was empty still rendered an
  //    'extId → ' detail line — index those by extId;
  //  - a whole-sub-batch HTTP failure rendered ONE 'Batch HTTP error: …' line
  //    per failed sub-batch, in dispatch order (DDS L611-618 shape). Attribute
  //    each such record to ITS sub-batch's line via its position and the
  //    clamped sub-batch size (DDS L543: min(batchSize,200), null/≤0 → 200 —
  //    the transport chunks `remaining` sequentially at exactly this size).
  //    The E4E.2 review caught the first-line-for-everyone shortcut stamping
  //    sub-batch 1's HTTP error onto sub-batch 2's records.
  const compositeDetailByExtId = new Map<string, string>()
  const httpLines: string[] = []
  for (const d of restResult.errorDetails) {
    if (d.startsWith('Batch HTTP error: ')) {
      httpLines.push(d)
      continue
    }
    const sep = d.indexOf(' → ')
    if (sep >= 0) compositeDetailByExtId.set(d.slice(0, sep), d)
  }
  const clampedBatch =
    objPlan.recommendedBatchSize > 0 ? Math.min(objPlan.recommendedBatchSize, 200) : 200
  const httpLineBySubBatch = new Map<number, string>()
  {
    const subs: number[] = []
    for (let i = 0; i < remaining.length; i++) {
      const t = remaining[i]!
      if (
        t.extId != null &&
        failedExtIds.has(t.extId) &&
        errsByExtId.get(t.extId) == null &&
        !compositeDetailByExtId.has(t.extId)
      ) {
        const sub = Math.floor(i / clampedBatch)
        if (!subs.includes(sub)) subs.push(sub)
      }
    }
    subs.sort((a, b) => a - b)
    subs.forEach((sub, rank) => {
      const line = httpLines[rank] ?? httpLines[0]
      if (line != null) httpLineBySubBatch.set(sub, line)
    })
  }

  // Classification context (E4E.3, DDQ L2244-2263): the run's current-truth
  // failed set, read fresh per batch BEFORE this batch's failures are recorded
  // — the Apex classifier's per-hop SOQL had the same visibility (same-batch
  // failures never classify against themselves). Skipped when the batch had
  // no failures (the Apex empty-errorDetails early return, L2233). S53: also
  // read when rows were withheld — their cascade/root split needs it.
  const failedByObject =
    failures > 0 || withheldRows.length > 0
      ? buildFailedByObject(runObjectNames, io.store.currentFailures(runId))
      : new Map<string, Set<string>>()

  // S53: the withheld rows — FAILED at these coordinates, message names the
  // parent, classification cascade when that parent is in the run's failed
  // set (the common case: the root failed) and root otherwise (the parent was
  // skipped, or never queried — a real decision for the user).
  const withheldByParent = new Map<string, number>()
  for (const t of withheldRows) {
    if (t.sourceId == null) continue
    const ref = withheldByPayload.get(t.payload)!
    const parentSourceId = reverse(ref.parentExtId)
    const pid15 = parentSourceId.length === 18 ? parentSourceId.substring(0, 15) : parentSourceId
    const parentFailed = failedByObject.get(ref.refObject)
    const classification =
      parentFailed != null && (parentFailed.has(parentSourceId) || parentFailed.has(pid15))
        ? 'cascade'
        : 'root'
    const msg =
      `${SCOPE_PARENT_MISSING_CODE}: ${ref.refObject} ${parentSourceId} (via ${ref.fieldName}) ` +
      'is not on target — record withheld rather than written detached from its parent; ' +
      'it is retried once the parent deploys, or re-run after fixing the parent.'
    resultRows.push({
      objectApiName: objectName,
      sourceId: t.sourceId,
      ...coords,
      outcome: 'failed',
      errorCode: SCOPE_PARENT_MISSING_CODE,
      errorMessage: msg
    })
    failureRows.push({
      objectApiName: objectName,
      ...coords,
      sourceId: t.sourceId,
      extId: t.extId,
      errorCode: SCOPE_PARENT_MISSING_CODE,
      errorMessage: msg,
      fieldsJson: JSON.stringify([ref.fieldName]),
      classification
    })
    withheldByParent.set(ref.refObject, (withheldByParent.get(ref.refObject) ?? 0) + 1)
  }

  let attributedFailures = 0
  let unattributableRecords = 0
  for (let i = 0; i < remaining.length; i++) {
    const t = remaining[i]!
    if (t.sourceId == null) {
      unattributableRecords++
      continue
    }
    if (t.extId != null && failedExtIds.has(t.extId)) {
      attributedFailures++
      const errs = errsByExtId.get(t.extId)
      const code = errs != null && errs.length > 0 ? errs[0]!.statusCode : null
      const msg =
        errs != null && errs.length > 0
          ? errs.map((e) => `${e.statusCode}: ${e.message}`).join('; ')
          : (compositeDetailByExtId.get(t.extId) ??
            httpLineBySubBatch.get(Math.floor(i / clampedBatch)) ??
            null)
      // The classifier parses the LEGACY detail line (extId → CODE: …) — its
      // patterns are byte-anchored to that format (DDQ L2266-2309). The
      // first-pass family is never the second-pass NOT_FOUND context.
      const legacyLine =
        compositeDetailByExtId.get(t.extId) ??
        httpLineBySubBatch.get(Math.floor(i / clampedBatch)) ??
        ''
      let classification = classifyFailureLine(legacyLine, objectName, false, failedByObject)
      const fieldSet = errs == null ? [] : [...new Set(errs.flatMap((e) => e.fields))]
      // S49 (BUG-10) pattern (c): the line-based patterns cannot see a
      // REQUIRED_FIELD_MISSING whose field we ourselves stripped because its
      // parent failed. Only upgrade root→cascade; never the reverse.
      if (
        classification === 'root' &&
        isCascadeFromStrippedParent(
          fieldSet,
          strippedByPayload.get(t.payload),
          octx.keptFields,
          failedByObject
        )
      ) {
        classification = 'cascade'
      }
      resultRows.push({
        objectApiName: objectName,
        sourceId: t.sourceId,
        ...coords,
        outcome: 'failed',
        errorCode: code,
        errorMessage: msg
      })
      failureRows.push({
        objectApiName: objectName,
        ...coords,
        sourceId: t.sourceId,
        extId: t.extId,
        errorCode: code,
        errorMessage: msg,
        fieldsJson: fieldSet.length > 0 ? JSON.stringify(fieldSet) : null,
        classification
      })
    } else {
      // targetId is OMITTED (not null) when the transport gave us no id, so
      // rows stay byte-identical to pre-S49 behaviour for every caller/fixture
      // that doesn't surface successIds.
      const tid = t.extId != null ? targetIdByExtId.get(t.extId) : undefined
      resultRows.push({
        objectApiName: objectName,
        sourceId: t.sourceId,
        ...coords,
        outcome: 'success',
        ...(tid != null ? { targetId: tid } : {})
      })
    }
  }

  // ── S50 (A5): the stripped-reference ledger ──────────────────────────────
  // Record NILLABLE lookups we dropped. A required one is NOT recorded: it
  // fails loudly as REQUIRED_FIELD_MISSING, lands in failed_records, and the
  // retry drain re-runs it against live target state so it self-heals once the
  // parent arrives. A nillable one deploys with a null FK and NOTHING ever
  // re-links it — the second pass only revisits DEFERRED fields — so it is a
  // silent orphan and the only class worth a ledger.
  const strippedRows: StrippedRefInput[] = []
  for (const t of transformed) {
    if (t.sourceId == null) continue
    const refs = strippedByPayload.get(t.payload)
    if (refs == null) continue
    for (const ref of refs) {
      if (!ref.nillable) continue
      strippedRows.push({
        objectApiName: objectName,
        sourceId: t.sourceId,
        fieldName: ref.fieldName,
        relationshipName: ref.relationshipName,
        refObject: ref.refObject,
        parentExtId: ref.parentExtId,
        parentSourceId: reverse(ref.parentExtId),
        ...coords
      })
    }
  }
  if (strippedRows.length > 0) io.store.recordStrippedRefs(runId, strippedRows)

  io.store.recordResults(runId, resultRows)
  if (failureRows.length > 0) io.store.recordFailures(runId, failureRows)

  // ── Log lines, Apex emission order (L1927-2041) ──
  if (contractLog != null) log(io, runId, 'Info', contractLog)

  // Strategy line per hop (built L1784-1789, logged L2016). Dropped-field count
  // + detail come from the FROZEN plan (A5 ran at freeze).
  const droppedCount = objPlan.droppedFields.length
  const strategyLog =
    `${objectName} v2 strategy: REST (${page.totalSize} records` +
    (droppedCount > 0 ? `, ${droppedCount} fields dropped (not writable on target)` : '') +
    ')'
  const droppedDetail =
    droppedCount === 0 ? null : leftTruncate(objPlan.droppedFields.join('\n'), 32760)
  log(io, runId, 'Info', strategyLog, droppedDetail)

  if (pendingPicklistLog != null) log(io, runId, 'Warning', pendingPicklistLog)
  if (pendingFilteredLookupLog != null) log(io, runId, 'Warning', pendingFilteredLookupLog)
  if (pendingSkipLog != null) log(io, runId, 'Info', pendingSkipLog)
  if (pendingParentDropLog != null) log(io, runId, 'Warning', pendingParentDropLog)
  if (withheldRows.length > 0) {
    // Desktop-only line (S53): no Apex analog — the frozen engine wrote these
    // rows detached (nillable) or let the API fail them (required).
    const parts = [...withheldByParent].map(([obj, n]) => `${obj} (${n})`)
    log(
      io,
      runId,
      'Warning',
      `${withheldRows.length} ${objectName} record(s) withheld on batch ${batchNumber} — their ` +
        `scope parent is not on target: ${parts.join(', ')}. Counted as failed (cascade when the ` +
        'parent failed in this run) and retried with the parent; nothing detached was written.'
    )
  }

  // Desktop-only observability: failures the composite response left
  // unattributable to source records (blank '' / '(unknown)' ExtIds — the Apex
  // only counted these; per-record rows can't be written for them).
  if (attributedFailures !== failures || unattributableRecords > 0) {
    log(
      io,
      runId,
      'Warning',
      `${objectName} batch ${batchNumber}: ${failures - attributedFailures} failure(s) ` +
        'could not be attributed to source records (blank/unknown ExternalId in the ' +
        'composite response) — counters may undercount vs the legacy engine'
    )
  }

  const errDetail = restResult.errorDetails.length > 0 ? restResult.errorDetails.join('\n') : null
  log(
    io,
    runId,
    failures > 0 ? 'Warning' : 'Info',
    `REST upsert batch ${batchNumber}: ${successes} succeeded, ${failures} failed for ${objectName}`,
    errDetail,
    { batchNumber, recordCount, successes, failures }
  )
}

function groupTypedErrors(
  result: UpsertBatchResult
): Map<string, UpsertBatchResult['typedErrors']> {
  const out = new Map<string, UpsertBatchResult['typedErrors']>()
  for (const te of result.typedErrors) {
    const arr = out.get(te.extId)
    if (arr == null) out.set(te.extId, [te])
    else arr.push(te)
  }
  return out
}

function log(
  io: DeployIo,
  runId: number,
  level: 'Info' | 'Warning' | 'Error',
  message: string,
  detail: string | null = null,
  extra: Record<string, unknown> = {}
): void {
  io.emit({
    kind: 'log',
    data: { runId, level, message, ...(detail != null ? { detail } : {}), ...extra }
  })
}
