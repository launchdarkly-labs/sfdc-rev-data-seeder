/**
 * E4E.5 — the junction deploy (OCR): `PassExecutors.junctionPass`. Port of
 * `DataDeploymentQueueable.executeJunctionDeploy` (DDQ L764-1017) — the
 * INSERT-with-dedupe path for objects that cannot host an external-Id field
 * (platform-blocked on OpportunityContactRole):
 *
 *   parent scope (see divergence) → 200-parent-chunked source queries
 *   → target dedupe keys `p1Ext|p2Ext|role` (Role in, IsPrimary out)
 *   → composite INSERT payloads with relationship traversal
 *     (`OpportunityId → Opportunity`, `Foo__c → Foo__r`), 200 per batch
 *   → per-batch CPQ tripwire over the ACCUMULATED junction-format error
 *     details → counters as pass-1 rows → ONE summary logBatch line.
 *
 * SINGLE-PASS, NO RETRIES (DDQ L762): failures land in the counters and stop.
 * Junction failures are ALL root (Apex set Records_Failed_Root__c = failures)
 * and NEVER feed the targeted-retry selector or the classifier — so this
 * module writes record_results ONLY, never failed_records (the Apex junction
 * path never wrote Retry_Source_Ids/Persistent_Failed_Source_Ids either; the
 * counter views default a failed row without a failed_records match to
 * 'root', reproducing Failed_Root = failures by construction).
 *
 * DESIGN-AUTHORIZED DIVERGENCE (deployDesign E4E.5): the parent scope comes
 * from THIS RUN's successfully-written parent records
 * (store.deployedSourceIds — current-truth success rows), replacing the Apex
 * org-wide target scan (`SELECT ExtId FROM {p1} WHERE ExtId != null`,
 * getDeployedParentSourceIds L1024-1068 — the class-9 full-table walk). The
 * TARGET-side dedupe query is unchanged (live target truth), so re-runs over
 * rows a previous run — or the in-org engine — inserted still dedupe to 0.
 *
 * ERROR-PATH FIDELITY (differs per site, like the Apex):
 *  - Misconfiguration (≠2 parents): Error log, object ends, deployment
 *    continues — NO retry, NO throw (Apex L774-783 marked the object Failed
 *    without touching counters; the desktop equivalent is the log + zero rows).
 *  - Chunk FIRST-page source-query failure: THROW → the orchestrator's bounded
 *    whole-object retry (the Apex inline Retry_Count__c branch, L840-858, is
 *    the same mechanism; the retry log line is the orchestrator's).
 *  - Source CONTINUATION-page failure: Error log
 *    ('Junction source pagination failed …') + object ends WITHOUT retry
 *    (Apex L871-879 went straight to Failed).
 *  - Parent/dedupe target-query failure: THROW → bounded retry (Apex L1031-1037
 *    / L1098-1103 threw into the execute() catch).
 *  - INSERT batch HTTP failure: batch counted failed, loop CONTINUES
 *    (L962-966).
 *
 * TRIPWIRE (L984-992): after each batch, scan the accumulated junction-format
 * error details ('CODE: message' — NOT the upsert legacy string) and throw
 * CpqTriggersActiveError before dispatching the next batch. Nothing is
 * persisted on the tripwire path (the Apex wrote counters only at completion).
 *
 * CANCEL: no mid-object checks — the Apex junction ran atomically in one
 * queueable execution; the orchestrator's boundary checks cover before/after.
 *
 * Pure over DeployIo: no jsforce, no better-sqlite3, no clock.
 */

import { ciEquals, isBlank, leftTruncate } from './transform/apexSemantics'
import { EXTERNAL_ID_FIELD, reverse } from './transform/sfid'
import { buildInClause } from '../scoping'
import { CpqTriggersActiveError, findCpqTriggerErrorSignature } from './cpqTripwire'
import type { DeployPlan } from './planFreeze'
import type { DeployIo, ObjectPassContext, QueryPage, RecordResultInput } from './types'

/** Parent-Id chunk per source junction query (DDQ L822). */
const PARENT_ID_CHUNK = 200
/** Dedupe-ExtId chunk per target query (DDQ L1081). */
const DEDUPE_EXT_CHUNK = 100
/** Composite INSERT batch size — FIXED 200 (DDQ L947), not the playbook size. */
const INSERT_BATCH = 200
/** Source-row accumulation cap (DDQ L868 — mirrors materializeIds' 50k). */
const SOURCE_ROW_CAP = 50000

/** The PassExecutors.junctionPass implementation, closed over the frozen plan. */
export function makeJunctionPass(plan: DeployPlan): (ctx: ObjectPassContext) => Promise<void> {
  return (ctx) => runJunctionPass(plan, ctx)
}

/**
 * Apex `String.format` follows java.text.MessageFormat: Number arguments
 * render through the locale NumberFormat, so counts ≥1,000 carry grouping
 * separators ('queried 2,500'). The junction summary (DDQ L1007-1010) is the
 * engine's ONLY String.format-with-numbers log line — every other line
 * concatenates (String.valueOf, no grouping). en-US matches the control-org
 * locale the golden logs were captured under.
 */
function fmtNum(n: number): string {
  return n.toLocaleString('en-US')
}

/**
 * FK field → relationship name (DDQ L1126-1131): standard `FooId` → `Foo`;
 * custom `Foo__c` → `Foo__r`; anything else as-is. Case-sensitive endsWith
 * (Java semantics).
 */
export function parentRelationshipName(fkField: string | null): string | null {
  if (fkField == null) return null
  if (fkField.endsWith('Id')) return fkField.slice(0, -2)
  if (fkField.endsWith('__c')) return fkField.slice(0, -3) + '__r'
  return fkField
}

export async function runJunctionPass(plan: DeployPlan, ctx: ObjectPassContext): Promise<void> {
  const objectName = ctx.object.objectName
  const objPlan = plan.objects.find((o) => o.objectName === objectName)
  if (objPlan == null) {
    throw new Error(`No frozen plan object for ${objectName}`)
  }
  if (!objPlan.isJunction) {
    throw new Error(
      `${objectName} is not a junction object — routed to firstPass, not junctionPass`
    )
  }
  const io = ctx.io

  // ── 0. Junction metadata (DDQ L768-788) ──
  const parents = (objPlan.junctionParents ?? []).map((p) => p.trim())
  const parentFields = (objPlan.junctionParentFields ?? []).map((p) => p.trim())
  if (parents.length !== 2 || parentFields.length !== 2) {
    log(
      io,
      ctx.runId,
      'Error',
      `Junction misconfiguration for ${objectName} — v1 supports exactly 2 parents.`
    )
    return // object ends (Apex Status=Failed, no counters); the walk continues
  }
  const p1Field = parentFields[0]!
  const p2Field = parentFields[1]!
  const p1Object = parents[0]!
  const p2Object = parents[1]!

  // ── 1. Parent scope — run-scoped (design divergence, see header) ──
  const scopedParent1SourceIds = io.store.deployedSourceIds(ctx.runId, p1Object)
  if (scopedParent1SourceIds.length === 0) {
    log(
      io,
      ctx.runId,
      'Info',
      `No deployed ${p1Object} records found on target — skipping junction ${objectName}`
    )
    return
  }

  // ── 2. Source junction rows, 200-parent chunks + pagination (DDQ L809-894) ──
  //
  // S49 FIX (BUG-7): the Apex (and this port until now) hardcoded the carried
  // fields to `Role, IsPrimary` for OCR, silently dropping every other field.
  // Live proof: 26 of one account's 52 source OCRs had `NektarActions__c` populated
  // and all 51 rows written to sb1_830 had it EMPTY (a larger account would have lost
  // 329). Carry whatever the field policy already approved for this object —
  // `ctx.object.fields` is the policy-filtered createable list, so read-only /
  // formula fields are already excluded (they land in `droppedFields`).
  const parentAndId = new Set([p1Field.toLowerCase(), p2Field.toLowerCase(), 'id'])
  const carriedFields = objPlan.fields.filter((f: string) => !parentAndId.has(f.toLowerCase()))
  if (carriedFields.length === 0 && ciEquals(objectName, 'OpportunityContactRole')) {
    // Auto-injected junctions carry a parent-only synthetic describe in older
    // plans (fields: []) — keep the historical OCR pair so a stale plan still
    // behaves exactly as before rather than dropping Role/IsPrimary too.
    carriedFields.push('Role', 'IsPrimary')
  }
  const queryFields = ['Id', p1Field, p2Field, ...carriedFields]
  const sourceRows: Array<Record<string, unknown>> = []
  for (let ci = 0; ci < scopedParent1SourceIds.length; ci += PARENT_ID_CHUNK) {
    const chunkIds = scopedParent1SourceIds.slice(ci, ci + PARENT_ID_CHUNK)
    const sourceSoql =
      'SELECT ' +
      queryFields.join(', ') +
      ' FROM ' +
      objectName +
      ' WHERE ' +
      p1Field +
      ' IN (' +
      buildInClause(chunkIds) +
      ')'
    const abandoned = await collectPages(io, ctx.runId, objectName, sourceSoql, sourceRows)
    if (abandoned) return
  }
  const srcCount = sourceRows.length
  if (srcCount === 0) {
    log(io, ctx.runId, 'Info', `No source ${objectName} rows found for in-scope parents.`)
    return
  }

  // ── 3. Target dedupe keys for the same parents (DDQ L896-901) ──
  const scopedParent1Exts = scopedParent1SourceIds.map((id) => reverse(id))
  const existingTargetKeys = await queryTargetJunctionDedupeKeys(
    io,
    objectName,
    p1Object,
    p2Object,
    scopedParent1Exts
  )

  // ── 4. INSERT payloads, skipping rows already on target (DDQ L903-941) ──
  const coords = { pass: 1 as const, retryPass: ctx.retryPass, objectAttempt: ctx.objectAttempt }
  const resultRows: RecordResultInput[] = []
  const insertRecords: Array<Record<string, unknown>> = []
  const insertSourceIds: Array<string | null> = []
  let skippedAlreadyOnTarget = 0
  let skippedMissingFk = 0

  const p1Rel = parentRelationshipName(p1Field)!
  const p2Rel = parentRelationshipName(p2Field)!

  // S49 FIX (BUG-2): parent2 must also have been deployed. Rows are scoped by
  // PARENT1 only, so a junction row pointing at a parent2 outside the selected
  // scope still emitted an ExtId FK for a record that was never written —
  // `INVALID_FIELD: Foreign key external ID: … not found for field
  // Data_Deployment_External_Id__c in entity Contact` (one account's OCR for
  // a cross-account Executive Sponsor whose own account was outside the
  // scope). The referenced parent is required here, so the lookup
  // can't be dropped — the row is SKIPPED with a reason, the same shape as the
  // missing-FK skip below.
  //
  // S53 FIX (L3): the S49 version FAILED OPEN when this run wrote no parent2
  // rows at all — an empty set disabled the check, on the theory that parent2
  // was "already on target from an earlier run". Live disproof (run 16, sb3_912,
  // single-account run): Contact was in the plan and queried ZERO rows, the account's
  // one OCR pointed at a PRIVATE contact (AccountId null), the check switched
  // itself off, and the row failed at the API with the exact INVALID_FIELD the
  // S49 fix exists to prevent. "Wrote none this run" and "already on target"
  // are different facts; only the target can answer the second. So: a parent2
  // this run did NOT write is PROBED on the target by ExtId (100-id chunks, the
  // same existence probe parentStrip uses), and a row is skipped only when its
  // parent2 is neither written this run nor present on target. A parent2 that
  // IS on target from an earlier run passes, as the fail-open intended. The
  // probe costs nothing in the common case (every parent2 written this run ⇒
  // no candidates ⇒ no query); a probe failure THROWS into the bounded
  // whole-object retry, like the dedupe query (a silently skipped chunk would
  // wrongly skip every row that chunk covered).
  const deployedP2 = new Set(io.store.deployedSourceIds(ctx.runId, p2Object))
  const probeCandidates = new Set<string>()
  for (const row of sourceRows) {
    const p2Id = row[p2Field] != null ? String(row[p2Field]) : null
    if (!isBlank(p2Id) && !deployedP2.has(p2Id!)) probeCandidates.add(p2Id!)
  }
  const presentP2Exts = await queryTargetParentExtIds(
    io,
    p2Object,
    [...probeCandidates].map((id) => reverse(id))
  )
  let skippedParentOutOfScope = 0

  for (const row of sourceRows) {
    const rowId = row['Id'] != null ? String(row['Id']) : null
    const p1Id = row[p1Field] != null ? String(row[p1Field]) : null
    const p2Id = row[p2Field] != null ? String(row[p2Field]) : null
    if (isBlank(p1Id) || isBlank(p2Id)) {
      skippedMissingFk++
      if (rowId != null) {
        resultRows.push({
          objectApiName: objectName,
          sourceId: rowId,
          ...coords,
          outcome: 'skipped',
          errorMessage: 'missing FK'
        })
      }
      continue
    }
    if (!deployedP2.has(p2Id!) && !presentP2Exts.has(reverse(p2Id!))) {
      skippedParentOutOfScope++
      if (rowId != null) {
        resultRows.push({
          objectApiName: objectName,
          sourceId: rowId,
          ...coords,
          outcome: 'skipped',
          errorMessage:
            `referenced_parent_out_of_scope (${p2Object} ${p2Id!} not in this deployment ` +
            'and not on target)'
        })
      }
      continue
    }
    const p1Ext = reverse(p1Id!) // Apex reverseStr — PLAIN reverse, not generateExternalId
    const p2Ext = reverse(p2Id!)
    const role = row['Role'] != null ? String(row['Role']) : null
    const dedupeKey = p1Ext + '|' + p2Ext + '|' + (role == null ? '' : role)
    if (existingTargetKeys.has(dedupeKey)) {
      skippedAlreadyOnTarget++
      if (rowId != null) {
        resultRows.push({
          objectApiName: objectName,
          sourceId: rowId,
          ...coords,
          outcome: 'skipped',
          errorMessage: 'already on target'
        })
      }
      continue
    }

    // Payload key order matches the Apex map insertion order (GF AC):
    // attributes → parent1 → parent2 → Role → IsPrimary.
    const payload: Record<string, unknown> = {
      attributes: { type: objectName }
    }
    payload[p1Rel] = { attributes: { type: p1Object }, [EXTERNAL_ID_FIELD]: p1Ext }
    payload[p2Rel] = { attributes: { type: p2Object }, [EXTERNAL_ID_FIELD]: p2Ext }
    // S49 (BUG-7): every carried field, in plan order. For an auto-injected OCR
    // `carriedFields` is exactly ['Role','IsPrimary'], so the Apex payload key
    // order (attributes → parent1 → parent2 → Role → IsPrimary) is preserved.
    for (const f of carriedFields) {
      if (row[f] != null) payload[f] = row[f]
    }
    insertRecords.push(payload)
    insertSourceIds.push(rowId)
  }

  // ── 5. Composite INSERT, 200 per batch + tripwire (DDQ L943-993) ──
  let successes = 0
  let failures = 0
  const errorDetails: string[] = []
  let unattributableRecords = 0

  for (let i = 0; i < insertRecords.length; i += INSERT_BATCH) {
    const batch = insertRecords.slice(i, i + INSERT_BATCH)
    const batchSourceIds = insertSourceIds.slice(i, i + INSERT_BATCH)
    const res = await io.insertCompositeBatch(objectName, batch)

    if (!res.ok) {
      // Whole-batch callout failure: count + log line, then CONTINUE — the
      // Apex `continue` (L966) SKIPS the tripwire scan for this iteration, so
      // a callout-failure detail is only ever scanned by a LATER successful
      // batch's check (and never at all when it lands on the last batch).
      // Review finding (wf_8a5828d1): scanning here would tripwire the whole
      // run on an HTTP error body quoting 'SBQQ.' where the Apex just counted
      // the batch failed.
      failures += batch.length
      const detail =
        'Batch ' +
        Math.floor(i / INSERT_BATCH) +
        ' callout failed: ' +
        leftTruncate(res.errorMessage == null ? 'unknown' : res.errorMessage, 200)
      errorDetails.push(detail)
      for (const sid of batchSourceIds) {
        if (sid == null) continue
        resultRows.push({
          objectApiName: objectName,
          sourceId: sid,
          ...coords,
          outcome: 'failed',
          errorMessage: detail
        })
      }
      continue
    } else {
      for (let k = 0; k < res.results.length; k++) {
        const r = res.results[k]!
        const sid = k < batchSourceIds.length ? batchSourceIds[k] : null
        if (r.success) {
          successes++
          if (sid != null) {
            resultRows.push({
              objectApiName: objectName,
              sourceId: sid,
              ...coords,
              outcome: 'success',
              targetId: r.id
            })
          }
        } else {
          failures++
          let code: string | null = null
          let msg: string | null = null
          if (r.errors.length > 0) {
            const e0 = r.errors[0]!
            // Apex null-concat renders the literal 'null' (L978-979).
            errorDetails.push((e0.statusCode ?? 'null') + ': ' + (e0.message ?? 'null'))
            code = e0.statusCode
            msg = (e0.statusCode ?? 'null') + ': ' + (e0.message ?? 'null')
          }
          if (sid != null) {
            resultRows.push({
              objectApiName: objectName,
              sourceId: sid,
              ...coords,
              outcome: 'failed',
              errorCode: code,
              errorMessage: msg
            })
          }
        }
      }
      // Composite anomaly: a response shorter than the batch leaves trailing
      // records uncounted (Apex iterated resList only) — surfaced, not rowed.
      if (res.results.length < batch.length) {
        unattributableRecords += batch.length - res.results.length
      }
    }

    // Tripwire over the ACCUMULATED details, before the next batch (L984-992).
    const cpqSig = findCpqTriggerErrorSignature(errorDetails)
    if (cpqSig != null) {
      throw new CpqTriggersActiveError(objectName, cpqSig)
    }
  }

  // ── 6. Rows + summary (DDQ L995-1014) — single write at completion ──
  io.store.recordResults(ctx.runId, resultRows)

  if (unattributableRecords > 0) {
    // Desktop-only observability (the Apex silently under-counted these).
    log(
      io,
      ctx.runId,
      'Warning',
      `${objectName}: ${unattributableRecords} insert result(s) missing from the composite ` +
        'response — counters may undercount vs the legacy engine'
    )
  }

  const summary =
    `Junction ${objectName}: ${fmtNum(successes)} succeeded, ${fmtNum(failures)} failed ` +
    `(queried ${fmtNum(srcCount)}, ${fmtNum(skippedAlreadyOnTarget)} already on target, ` +
    `${fmtNum(skippedMissingFk)} missing FK` +
    // S49 (BUG-2): only mentioned when it actually happened, so the existing
    // summary line is byte-identical on runs with nothing out of scope.
    (skippedParentOutOfScope > 0
      ? `, ${fmtNum(skippedParentOutOfScope)} ${p2Object} out of scope`
      : '') +
    ')'
  const errDetail = errorDetails.length > 0 ? errorDetails.join('\n') : null
  log(io, ctx.runId, failures > 0 ? 'Warning' : 'Info', summary, errDetail, {
    batchNumber: 0,
    recordCount: insertRecords.length,
    successes,
    failures
  })
}

/**
 * One chunk's source query with pagination (DDQ L831-885). Appends pages into
 * `sourceRows`. Returns true when the object must be ABANDONED (continuation-
 * page failure, L871-879: Error log, no retry; or the S50 cap below); a FIRST-
 * page failure rethrows into the orchestrator's bounded whole-object retry (the
 * Apex inline retry, L840-858).
 *
 * S50 (B1) — THE CAP NO LONGER TRUNCATES SILENTLY.
 *
 * Previously the `SOURCE_ROW_CAP` check ran AFTER pushing a page and returned
 * `false`, i.e. "not abandoned", so the caller's chunk loop carried on. Three
 * things went wrong at once and none of them was visible:
 *   1. the current chunk's remaining pages were dropped;
 *   2. every LATER parent chunk still ran, each pushing one more page before
 *      tripping the check again — so the final row set was neither the whole
 *      set nor the cap, but an arbitrary function of chunk ordering;
 *   3. nothing was logged, no skip row was written, and the summary reported
 *      the truncated number as though it were the total.
 * A 50-account run is where this first becomes reachable, which is exactly the
 * direction this project is heading.
 *
 * Now: the check runs at the TOP of the loop — so the over-cap page is never
 * fetched, the boundary cannot depend on page sizes or chunk ordering, and the
 * object is ABANDONED with an Error. Abandoning writes NOTHING, which is the
 * honest outcome — a partial junction pass would report `queried N` with N a
 * truncated count, and a wrong number presented as a right one is worse than a
 * zero with an explanation. The remedy is to narrow the scope and re-run; the
 * junction path dedupes on `p1Ext|p2Ext|role`, so a re-run cannot duplicate
 * whatever a previous run did land.
 */
async function collectPages(
  io: DeployIo,
  runId: number,
  objectName: string,
  soql: string,
  sourceRows: Array<Record<string, unknown>>
): Promise<boolean> {
  const it = io.querySourcePages(soql)[Symbol.asyncIterator]()
  let pageIdx = 0
  for (;;) {
    // S50 (B1): checked at the TOP, so the over-cap page is never even
    // fetched and the boundary does not depend on page sizes or chunk order.
    if (sourceRows.length >= SOURCE_ROW_CAP) {
      log(
        io,
        runId,
        'Error',
        `Junction source rows for ${objectName} hit the ${SOURCE_ROW_CAP.toLocaleString()}-row ` +
          'cap. NOTHING was deployed for this object — a partial junction pass would report a ' +
          'truncated count as if it were the total. Narrow the scope (fewer parent records, or a ' +
          'WHERE clause on this object) and re-run; re-running cannot duplicate rows, the ' +
          'junction path dedupes on parent1+parent2+role.'
      )
      return true
    }
    let nx: IteratorResult<QueryPage>
    try {
      nx = await it.next()
    } catch (e) {
      if (pageIdx === 0) throw e // first page — bounded whole-object retry
      log(
        io,
        runId,
        'Error',
        `Junction source pagination failed for ${objectName}: ` +
          (e instanceof Error ? e.message : String(e))
      )
      return true
    }
    if (nx.done) return false
    sourceRows.push(...nx.value.records)
    pageIdx++
  }
}

/**
 * Target dedupe-key query (DDQ L1074-1120): existing junction rows for the
 * in-scope parents → `Set<p1Ext|p2Ext|role>`. ExtIds are embedded UNESCAPED
 * (Apex L1085 — reversed Ids are alphanumeric); relationship names derive from
 * `{parentObject}Id` (L1086-1087), unlike the payloads' FK-field derivation.
 * Query failures THROW (a silently dropped chunk re-inserts duplicates —
 * L1098-1103) into the orchestrator's bounded retry.
 *
 * DELIBERATE DIVERGENCE (review wf_8a5828d1, kept on purpose): this walk
 * follows nextRecordsUrl pagination; the frozen Apex read only the FIRST
 * response page per chunk (no pagination loop — in contrast to its own
 * getDeployedParentSourceIds L1049-1066 and the L863-884 source-pagination
 * BUGFIX, which show the intended pattern). Reproducing the single-page read
 * would re-INSERT junction rows already on target whenever one 100-parent
 * chunk holds >2,000 existing rows — duplicating data and breaking the E4V.3
 * idempotency proof ("re-run inserts 0"). Under-reading dedupe keys is the
 * unsafe direction; full pagination is the same fix the Apex source query
 * already received.
 */
async function queryTargetJunctionDedupeKeys(
  io: DeployIo,
  junctionObject: string,
  p1Object: string,
  p2Object: string,
  p1Exts: ReadonlyArray<string>
): Promise<Set<string>> {
  const keys = new Set<string>()
  if (p1Exts.length === 0) return keys
  const p1Rel = parentRelationshipName(p1Object + 'Id')!
  const p2Rel = parentRelationshipName(p2Object + 'Id')!
  const isOcr = ciEquals(junctionObject, 'OpportunityContactRole') // Apex L1091 ==
  for (let i = 0; i < p1Exts.length; i += DEDUPE_EXT_CHUNK) {
    const quoted = p1Exts.slice(i, i + DEDUPE_EXT_CHUNK).map((e) => "'" + e + "'")
    const soql =
      'SELECT Id, ' +
      p1Rel +
      '.' +
      EXTERNAL_ID_FIELD +
      ', ' +
      p2Rel +
      '.' +
      EXTERNAL_ID_FIELD +
      (isOcr ? ', Role' : '') +
      ' FROM ' +
      junctionObject +
      ' WHERE ' +
      p1Rel +
      '.' +
      EXTERNAL_ID_FIELD +
      ' IN (' +
      quoted.join(',') +
      ')'
    for await (const rec of io.queryTarget(soql)) {
      const pa = rec[p1Rel] as Record<string, unknown> | null | undefined
      const pb = rec[p2Rel] as Record<string, unknown> | null | undefined
      if (pa == null || pb == null) continue
      const pe1 = pa[EXTERNAL_ID_FIELD] != null ? String(pa[EXTERNAL_ID_FIELD]) : null
      const pe2 = pb[EXTERNAL_ID_FIELD] != null ? String(pb[EXTERNAL_ID_FIELD]) : null
      const role = rec['Role'] != null ? String(rec['Role']) : null
      if (isBlank(pe1) || isBlank(pe2)) continue
      keys.add(pe1! + '|' + pe2! + '|' + (role == null ? '' : role))
    }
  }
  return keys
}

/**
 * S53 (L3) — which of these parent ExtIds exist on the target?
 * `SELECT ExtId FROM {parentObject} WHERE ExtId IN (…)` in 100-value chunks
 * (the dedupe query's chunk; reversed Ids are alphanumeric so they are embedded
 * unescaped like DDQ L1085). Rejections propagate — bounded whole-object retry.
 */
async function queryTargetParentExtIds(
  io: DeployIo,
  parentObject: string,
  exts: ReadonlyArray<string>
): Promise<Set<string>> {
  const present = new Set<string>()
  if (exts.length === 0) return present
  for (let i = 0; i < exts.length; i += DEDUPE_EXT_CHUNK) {
    const quoted = exts.slice(i, i + DEDUPE_EXT_CHUNK).map((e) => "'" + e + "'")
    const soql =
      'SELECT ' +
      EXTERNAL_ID_FIELD +
      ' FROM ' +
      parentObject +
      ' WHERE ' +
      EXTERNAL_ID_FIELD +
      ' IN (' +
      quoted.join(',') +
      ')'
    for await (const rec of io.queryTarget(soql)) {
      const v = rec[EXTERNAL_ID_FIELD]
      if (v != null && !isBlank(String(v))) present.add(String(v))
    }
  }
  return present
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
