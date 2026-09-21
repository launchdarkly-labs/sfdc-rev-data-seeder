/**
 * E4E.4 — the deferred-field second pass: `PassExecutors.secondPass`. Port of
 * `DataDeploymentQueueable.executeSecondPassV2` (DDQ L522-737) — the pass that
 * resolves forward/self circular references AFTER every first pass completed:
 *
 *   frozen deferred set → nameMatch maps for deferred nameMatch refs
 *   → source query: Id + deferred fields WHERE (df1 != null OR …) scoped to
 *     the run's own materialized first-pass scope
 *   → per-record patch payloads carrying ONLY the self-ExtId + deferred fields
 *     (strategy dispatch: externalId / nameMatch / directId / customId / skip)
 *   → stripMissingParentRefs → attributes stamp
 *   → REST upsert with `?updateOnly=true` — ALWAYS REST, never Bulk (Apex
 *     L690-703: payloads are tiny, and Bulk has no updateOnly — an unmatched
 *     ExtId would auto-insert a fragment missing every required field;
 *     updateOnly makes unmatched rows no-op silently, observed RDS-DEP-0049)
 *   → pass-2 record_results rows (audit only — the counter views ignore
 *     pass=2; the Apex second pass never touched counters, DDQ L3025-3034)
 *   → the Apex log lines byte-exact: parent-drop Warning ('Second pass: …')
 *     then the batch line ('V2 second pass REST batch N (updateOnly=true): …').
 *
 * WHAT THE FREEZE ALREADY DID (E2.6 — do NOT redo here):
 *   - The skip-mapped prune (DDQ L350-362): `objPlan.deferredFields` is the
 *     post-prune set; a field mapped 'skip' never appears in it.
 *   - The runtime targetHasExtId downgrade (DDQ L634-641): A10 ran at freeze
 *     with the ORG-WIDE set, and its skip downgrades were then pruned — by
 *     construction every frozen deferred externalId ref points at an object
 *     with the ExtId field on target. (A target losing the field mid-run
 *     surfaces as per-record upsert failures — acceptable under the immutable
 *     frozen-plan contract; the Apex re-fetched batchCheckRdsField per hop.)
 *
 * DESIGN-AUTHORIZED DIVERGENCES (deployDesign E4E.4, flagged in-line):
 *   - SCOPE: the Apex re-embedded Scoped_Filter__c / re-materialized LIMIT
 *     filters into the source query per hop (DDQ L570-590). Here the scope is
 *     the run's OWN materialized first-pass scope from SQLite
 *     (store.queriedSourceIds — every record the fresh page walk queried),
 *     appended as `Id IN (…)` in ≤4,000-id chunks. No filter re-derivation;
 *     identical record set by construction (the first pass queried exactly the
 *     frozen scope); works past the 4,000-id materialization ceiling.
 *   - Because of that (and the freeze's sorted deferred set), the second-pass
 *     QUERY STRING is not byte-identical to the Apex one — E4V.2's Layer-2
 *     diff compares second-pass PAYLOADS, not this query.
 *
 * BUG-COMPATIBLE QUIRK kept (DDQ L684-688): a page whose records ALL resolve
 * to no-update (hasUpdate never set) ends the object immediately —
 * `markObjectComplete` + chain — ABANDONING any remaining pages and chunks.
 * Faithfully ported: return.
 *
 * EMPTY PAGES (DDQ L604-608): an empty page — first or continuation — ends the
 * object SILENTLY (no 'Skipped …' line; that guard text is first-pass-only).
 * Chunk exception (same deviation domain as firstPass): an empty FIRST page of
 * one id chunk just advances to the next chunk.
 *
 * failed_records is NEVER written here — it is a first-pass-family relation
 * (orchestrator contract; the Apex tracked second-pass failures in the
 * activity log only).
 *
 * Pure over DeployIo: no jsforce, no better-sqlite3, no clock.
 */

import { stripMissingParentRefs } from './transform/parentStrip'
import { resolveNameMatch } from './transform/nameMatch'
import {
  apexStringValueOf,
  ciEquals,
  isBlank
} from './transform/apexSemantics'
import { EXTERNAL_ID_FIELD, generateExternalId, reverse } from './transform/sfid'
import { buildInClause, chunkIds, maxIdsForSoql } from '../scoping'
import { nameMatchIoFor, parentStripIoFor } from './objectContext'
import type { DescribeField } from './transform/fieldFilter'
import type { DeployPlan, FrozenObjectPlan } from './planFreeze'
import type {
  DeployIo,
  ObjectPassContext,
  RecordResultInput,
  UpsertBatchResult
} from './types'

/** The PassExecutors.secondPass implementation, closed over the frozen plan. */
export function makeSecondPass(plan: DeployPlan): (ctx: ObjectPassContext) => Promise<void> {
  return (ctx) => runSecondPass(plan, ctx)
}

export async function runSecondPass(plan: DeployPlan, ctx: ObjectPassContext): Promise<void> {
  const objectName = ctx.object.objectName
  const objPlan = plan.objects.find((o) => o.objectName === objectName)
  if (objPlan == null) {
    throw new Error(`No frozen plan object for ${objectName}`)
  }
  if (objPlan.isJunction) {
    throw new Error(`${objectName} is a junction object — junctions have no second pass`)
  }
  const io = ctx.io

  // Frozen post-prune deferred set (see header). Apex: empty → markObjectComplete,
  // no log (DDQ L364-368).
  const deferredList = objPlan.deferredFields
  if (deferredList.length === 0) return
  const deferredSet = new Set(deferredList) // case-SENSITIVE (Apex Set<String>)

  // FULL live source describe (DDQ L535-536) — the transform iterates every
  // field, not the A5 survivors (executeSecondPassV2 read the full describe).
  const fields = await io.describeSource(objectName)

  // ── nameMatch maps for deferred nameMatch refs (DDQ L541-554) ──
  const mappings = objPlan.mappings
  const nameMatchMaps: Record<string, Record<string, string>> = {}
  for (const fi of fields) {
    if (!deferredSet.has(fi.apiName)) continue
    if (!fi.isReference || fi.referenceTo.length === 0) continue
    const cfg = mappings[fi.apiName]
    if (cfg == null || !ciEquals(cfg.strategy, 'nameMatch')) continue
    const refObj = fi.referenceTo[0]!
    if (Object.prototype.hasOwnProperty.call(nameMatchMaps, refObj)) continue
    const objContext = ciEquals(refObj, 'RecordType') ? objectName : null
    nameMatchMaps[refObj] = await resolveNameMatch(
      nameMatchIoFor(io),
      refObj,
      cfg.matchField,
      objContext
    )
  }

  // ── Source query (DDQ L556-568 + the scope divergence, see header) ──
  // SELECT order: 'Id' then the frozen deferred set's order (Apex iterated its
  // Set<String> in insertion order; the freeze sorts the set — divergence
  // documented in the header, payloads unaffected).
  const selectFields = new Set<string>(['Id'])
  for (const df of deferredList) selectFields.add(df)
  const conditions = deferredList.map((df) => `${df} != null`)
  const baseSoql =
    'SELECT ' +
    [...selectFields].join(', ') +
    ' FROM ' +
    objectName +
    ' WHERE (' +
    conditions.join(' OR ') +
    ')'

  // S49 (BUG-8): scope pass 2 to records that pass 1 actually DEPLOYED, not to
  // everything it queried. A record that pass 1 skipped or failed was never
  // inserted, so an updateOnly patch against it can only ever answer
  // `NOT_FOUND: The requested resource does not exist`. Run 4 logged one such
  // row (an OLI correctly skipped as `pbe_missing_on_target`) and run 6 added
  // ten more (9 OLI + 1 Opportunity that had already FAILED in pass 1). The
  // counter views ignore pass=2 so totals were never wrong, but the rows are
  // pure noise in `record_results` and read as real errors.
  const scopeIds = io.store.deployedSourceIds(ctx.runId, objectName)
  if (scopeIds.length === 0) return // nothing landed in the first pass

  // S50 (B2): chunk against the SOQL STATEMENT ceiling, not the fixed 4,000.
  // `chunkIds`' default is calibrated for `SELECT Id`; this query selects the
  // object's whole deferred field list, and Opportunity's real plan leaves only
  // 7 ids of headroom at 4,000. Over the ceiling it fails org-side as
  // MALFORMED_QUERY, which says nothing about length.
  let batchNumber = 0
  for (const chunk of chunkIds(scopeIds, maxIdsForSoql(baseSoql.length))) {
    const soql = baseSoql + ' AND Id IN (' + buildInClause(chunk) + ')'
    let chunkPage = 0
    for await (const page of io.querySourcePages(soql)) {
      // Between-batches cancel (same boundary as firstPass): stop dispatching;
      // the orchestrator's checks route the run to cancelled teardown.
      if (batchNumber > 0 && io.store.isCancelRequested(ctx.runId)) return
      if (page.records.length === 0) {
        // Empty FIRST page of one chunk → next chunk (deviation domain);
        // any other empty page ends the object SILENTLY (DDQ L604-608).
        if (chunkPage === 0) break
        return
      }
      const done = await processSecondPassPage(objPlan, fields, deferredList, deferredSet, nameMatchMaps, ctx, page.records, batchNumber)
      if (done) return
      batchNumber++
      chunkPage++
    }
  }
}

/**
 * One page's transform → strip → updateOnly upsert → pass-2 rows → logs
 * (DDQ L610-736). Returns true when the object is DONE early (the Apex
 * empty-patchRecords markObjectComplete, L684-688 — abandons the walk).
 */
async function processSecondPassPage(
  objPlan: FrozenObjectPlan,
  fields: ReadonlyArray<DescribeField>,
  deferredList: ReadonlyArray<string>,
  deferredSet: ReadonlySet<string>,
  nameMatchMaps: Record<string, Record<string, string>>,
  ctx: ObjectPassContext,
  records: ReadonlyArray<Record<string, unknown>>,
  batchNumber: number
): Promise<boolean> {
  const io = ctx.io
  const objectName = objPlan.objectName
  const mappings = objPlan.mappings

  // ── Transform (DDQ L610-682) ──
  const patchRecords: Array<Record<string, unknown>> = []
  const sourceIdByPayload = new Map<Record<string, unknown>, string>()
  for (const rec of records) {
    const rawId = rec['Id']
    if (rawId == null) continue // Apex L617-618
    const sourceId = String(rawId)

    const patch: Record<string, unknown> = {}
    // Self ExtId — computed from the source Id (L619; no blank fallback here,
    // unlike the parent branch).
    patch[EXTERNAL_ID_FIELD] = generateExternalId(sourceId)

    let hasUpdate = false
    for (const fi of fields) {
      if (!deferredSet.has(fi.apiName)) continue
      if (!fi.isReference) continue // L624

      const rawLookupId = rec[fi.apiName]
      if (rawLookupId == null) continue
      const sourceLookupId = apexStringValueOf(rawLookupId)
      if (sourceLookupId == null || isBlank(sourceLookupId)) continue

      const cfg = mappings[fi.apiName]
      const strategy = cfg != null ? cfg.strategy : 'externalId' // L632
      // The Apex runtime targetHasExtId downgrade (L634-641) is freeze-handled
      // — see the module header.

      if (ciEquals(strategy, 'externalId') && !isBlank(fi.relationshipName)) {
        // Parent ExtId from the raw lookup Id (L643-652). The isBlank fallback
        // is unreachable for a non-blank input (reverse never blanks) but
        // ported for shape.
        let parentExtId = generateExternalId(sourceLookupId)
        if (isBlank(parentExtId)) parentExtId = reverse(sourceLookupId)
        patch[fi.relationshipName as string] = { [EXTERNAL_ID_FIELD]: parentExtId }
        hasUpdate = true
      } else if (ciEquals(strategy, 'nameMatch')) {
        const refObj = fi.referenceTo.length > 0 ? fi.referenceTo[0]! : null
        if (refObj != null && Object.prototype.hasOwnProperty.call(nameMatchMaps, refObj)) {
          const map = nameMatchMaps[refObj]!
          const targetId = Object.prototype.hasOwnProperty.call(map, sourceLookupId)
            ? map[sourceLookupId]!
            : null
          if (targetId != null) {
            patch[fi.apiName] = targetId
            hasUpdate = true
          }
        }
      } else if (ciEquals(strategy, 'directId')) {
        patch[fi.apiName] = sourceLookupId
        hasUpdate = true
      } else if (ciEquals(strategy, 'customId')) {
        if (cfg != null && !isBlank(cfg.customValue)) {
          patch[fi.apiName] = cfg.customValue
          hasUpdate = true
        }
      }
      // 'skip' → nothing (L676)
    }

    if (hasUpdate) {
      patchRecords.push(patch)
      sourceIdByPayload.set(patch, sourceId)
    }
  }

  if (patchRecords.length === 0) return true // DDQ L684-688 — object done, walk abandoned

  // ── Strip + attributes + upsert (DDQ L704-712) ──
  const pendingParentDropLog = await stripMissingParentRefs(
    parentStripIoFor(io),
    objectName,
    fields,
    patchRecords,
    // S49 (BUG-11): the second pass is where deferred SELF-references are
    // written, so this is the only place they can be checked against target.
    { includeSelfRefs: true }
  )
  for (const rec of patchRecords) rec['attributes'] = { type: objectName }

  const restResult = await io.upsertBatch(objectName, patchRecords, {
    updateOnly: true,
    batchSize: objPlan.recommendedBatchSize
  })
  const successes = restResult.successCount
  const failures = restResult.failureCount

  // ── Pass-2 rows (audit only — views ignore pass=2; NO failed_records) ──
  io.store.recordResults(ctx.runId, buildPass2Rows(objPlan, ctx, patchRecords, sourceIdByPayload, restResult))

  // ── Logs, Apex order (L719-728) ──
  if (pendingParentDropLog != null) {
    log(io, ctx.runId, 'Warning', `Second pass: ${pendingParentDropLog}`)
  }
  const errDetail =
    restResult.errorDetails.length > 0 ? restResult.errorDetails.join('\n') : null
  log(
    io,
    ctx.runId,
    failures > 0 ? 'Warning' : 'Info',
    `V2 second pass REST batch ${batchNumber} (updateOnly=true): ${successes} succeeded, ${failures} failed for ${objectName}`,
    errDetail,
    { batchNumber, recordCount: patchRecords.length, successes, failures }
  )
  return false
}

/**
 * Pass-2 audit rows: outcome per sent record, attributed by self-ExtId (never
 * blank — computed from a non-null source Id). Failure text: typed errors
 * first, then the record's composite detail line, then the per-sub-batch HTTP
 * line (same clamp math as the transport's chunking; audit-only simplification
 * of the firstPass attribution — pass-2 rows feed no counters, no classifier,
 * no retries).
 */
function buildPass2Rows(
  objPlan: FrozenObjectPlan,
  ctx: ObjectPassContext,
  patchRecords: ReadonlyArray<Record<string, unknown>>,
  sourceIdByPayload: ReadonlyMap<Record<string, unknown>, string>,
  restResult: UpsertBatchResult
): RecordResultInput[] {
  const coords = {
    pass: 2 as const,
    retryPass: ctx.retryPass,
    objectAttempt: ctx.objectAttempt
  }
  const failedExtIds = new Set(restResult.failedExternalIds)
  const errsByExtId = new Map<string, UpsertBatchResult['typedErrors']>()
  for (const te of restResult.typedErrors) {
    const arr = errsByExtId.get(te.extId)
    if (arr == null) errsByExtId.set(te.extId, [te])
    else arr.push(te)
  }
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

  // HTTP-line attribution: httpLines holds one line per FAILED sub-batch in
  // dispatch order — map failing sub-batch indices to lines by RANK, exactly
  // like firstPass (its E4E.2 review caught the clamped-absolute-index
  // shortcut stamping sub-batch 1's error onto sub-batch 2's records; review
  // wf_8a5828d1 caught this module reintroducing it).
  const httpLineBySubBatch = new Map<number, string>()
  {
    const subs: number[] = []
    for (let i = 0; i < patchRecords.length; i++) {
      const payload = patchRecords[i]!
      const eid = String(payload[EXTERNAL_ID_FIELD])
      if (
        failedExtIds.has(eid) &&
        errsByExtId.get(eid) == null &&
        !compositeDetailByExtId.has(eid)
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

  const rows: RecordResultInput[] = []
  for (let i = 0; i < patchRecords.length; i++) {
    const payload = patchRecords[i]!
    const sourceId = sourceIdByPayload.get(payload)
    if (sourceId == null) continue
    const extId = String(payload[EXTERNAL_ID_FIELD])
    if (failedExtIds.has(extId)) {
      const errs = errsByExtId.get(extId)
      const code = errs != null && errs.length > 0 ? errs[0]!.statusCode : null
      const msg =
        errs != null && errs.length > 0
          ? errs.map((e) => `${e.statusCode}: ${e.message}`).join('; ')
          : (compositeDetailByExtId.get(extId) ??
            httpLineBySubBatch.get(Math.floor(i / clampedBatch)) ??
            null)
      rows.push({
        objectApiName: objPlan.objectName,
        sourceId,
        ...coords,
        outcome: 'failed',
        errorCode: code,
        errorMessage: msg
      })
    } else {
      rows.push({ objectApiName: objPlan.objectName, sourceId, ...coords, outcome: 'success' })
    }
  }
  return rows
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
