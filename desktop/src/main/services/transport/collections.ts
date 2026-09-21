/**
 * E4T.1 — REST sObject Collections client. Byte-faithful port of Apex
 * `DataDeploymentService.upsertToTarget` (DataDeploymentService.cls:540-633) plus
 * a POST-insert variant for the junction path (executeJunctionDeploy).
 *
 * Default deploy transport: `PATCH /composite/sobjects/{obj}/{ExtIdField}` for
 * upsert-by-external-Id, `POST /composite/sobjects/` for junction insert, both
 * `allOrNone:false` with the duplicate-rule bypass header, batched at
 * `min(playbookBatch, 200)`. Per-record results are parsed into TYPED
 * `UpsertError`s AND a rendered legacy error string (`"<extId> → CODE: msg
 * fields=[..]; "`) kept BYTE-EXACT for golden-file comparison (E4T.1 GF AC). A
 * whole-batch HTTP failure counts every record in the batch as failed. After
 * each batch, the CPQ tripwire scans the rendered errors for `SBQQ.`/`blng.`
 * signatures and THROWS before the next batch (managed CPQ triggers firing means
 * "Triggers Disabled" is unchecked — every further batch spawns more automation).
 *
 * This module is a SERVICES-tier binding but keeps a PURE core (batching, payload
 * + endpoint building, result parsing, error rendering, tripwire) over an injected
 * `CollectionsTransport`. The transport executes the composite callout through
 * GuardedOrg (writes gated to role==='target') + the token provider, which owns
 * 401→refresh→retry-once (A5) — so it isn't re-implemented here.
 */

import { API_VERSION } from '../salesforce'
import { EXTERNAL_ID_FIELD } from '../../engine/deploy/transform/sfid'
import { isBlank } from '../../engine/deploy/transform/apexSemantics'
import {
  CpqTriggersActiveError,
  findCpqTriggerErrorSignature
} from '../../engine/deploy/cpqTripwire'

// Re-exported for existing consumers/tests — the definitions moved to the pure
// engine tripwire module (E4A.5 slice) so the E4E.5 junction path can throw the
// same error without importing services code into engine/.
export { CpqTriggersActiveError, findCpqTriggerErrorSignature }

/** Apex `OrgConnectionService.DUPLICATE_RULE_BYPASS_HEADERS`. */
export const DUPLICATE_RULE_BYPASS_HEADER: Readonly<Record<string, string>> = {
  'Sforce-Duplicate-Rule-Header': 'allowSave=true'
}

/** The composite/sobjects endpoint cap (hard Salesforce limit). */
export const MAX_COMPOSITE_BATCH = 200

const SOBJECTS_BASE = `/services/data/v${API_VERSION}/composite/sobjects/`

export type CompositeMethod = 'PATCH' | 'POST'

export interface CollectionsHttpResult {
  success: boolean
  /** Response body — a JSON array of per-record composite results on success.
   *  May be absent on a whole-batch HTTP failure (only read on success). */
  body?: string
  errorMessage?: string
}

/**
 * The injected transport seam. `request` issues ONE composite/sobjects call with
 * the duplicate-rule bypass header applied and 401→refresh→retry handled beneath.
 */
export interface CollectionsTransport {
  request(method: CompositeMethod, endpoint: string, body: string): Promise<CollectionsHttpResult>
}

/** One typed per-record failure (richer than the legacy string; feeds failed_records). */
export interface UpsertError {
  extId: string
  statusCode: string
  message: string
  fields: string[]
}

export interface CollectionsResult {
  successCount: number
  failureCount: number
  /** Rendered legacy strings, byte-exact with Apex (golden-compared). */
  errorDetails: string[]
  /** ExtIds of failed records — reversed to source Ids for retry by the caller. */
  failedExternalIds: string[]
  /** Structured per-record failures (composite `errors[]`). */
  typedErrors: UpsertError[]
  /** S49 (BUG-1): target ids of the successful records, keyed by submitted ExtId. */
  successIds?: Array<{ extId: string; id: string }>
}

export interface UpsertOptions {
  /** `?updateOnly=true` — second pass only (no auto-insert on unmatched ExtId). */
  updateOnly?: boolean
  /** Playbook batch size; clamped to [1, 200]. Null/≤0 → 200. */
  batchSize?: number | null
}

// ─────────────────────────────── pure helpers ────────────────────────────────

/** Apex clamp: `min(n,200)`; null/≤0 → 200 (DDS L543). */
export function clampBatchSize(n: number | null | undefined): number {
  return n != null && n > 0 ? Math.min(n, MAX_COMPOSITE_BATCH) : MAX_COMPOSITE_BATCH
}

function chunk<T>(records: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < records.length; i += size) out.push(records.slice(i, i + size))
  return out
}

/** `/composite/sobjects/{obj}/{ExtIdField}[?updateOnly=true]` (DDS L566-570). */
export function buildUpsertEndpoint(objectName: string, updateOnly: boolean): string {
  const base = SOBJECTS_BASE + objectName + '/' + EXTERNAL_ID_FIELD
  return updateOnly ? base + '?updateOnly=true' : base
}

/**
 * Render one composite `errors[]` array into the legacy `errMsg` (DDS L596-606):
 * each error → `"CODE: message[ fields=[..]]; "`, concatenated. `fields=` uses
 * `JSON.stringify` exactly where Apex used `JSON.serialize` (both `["a","b"]`).
 */
function renderErrMsg(errors: ReadonlyArray<unknown>): string {
  let errMsg = ''
  for (const e of errors) {
    const eMap = (e ?? {}) as Record<string, unknown>
    // Apex casts a MISSING key to null, and null-concat renders the literal
    // 'null'. JS would render a missing key as 'undefined' — coalesce so an
    // absent statusCode/message matches Apex byte-for-byte. (A JSON-null VALUE
    // already renders 'null' via JS null-coercion, same as Apex.)
    const code = (eMap.statusCode as string | null | undefined) ?? 'null'
    const msg = (eMap.message as string | null | undefined) ?? 'null'
    const flds = eMap.fields as unknown[] | undefined
    const fieldStr = flds != null && flds.length > 0 ? ' fields=' + JSON.stringify(flds) : ''
    errMsg += code + ': ' + msg + fieldStr + '; '
  }
  return errMsg
}

// ──────────────────────────────── the client ─────────────────────────────────

function emptyResult(): CollectionsResult {
  return {
    successCount: 0,
    failureCount: 0,
    errorDetails: [],
    failedExternalIds: [],
    typedErrors: [],
    successIds: []
  }
}

/**
 * Applies one batch's HTTP result to the accumulator (DDS L579-619). On success,
 * parses the per-record composite array; on a whole-batch HTTP failure, marks
 * every record failed. Mutates `result`.
 */
function applyBatchResult(
  result: CollectionsResult,
  http: CollectionsHttpResult,
  batch: ReadonlyArray<Record<string, unknown>>
): void {
  if (http.success) {
    const parsed = JSON.parse(http.body ?? '[]') as Array<Record<string, unknown>>
    for (let i = 0; i < parsed.length; i++) {
      const rMap = parsed[i]!
      if (rMap.success === true) {
        result.successCount++
        // S49 (BUG-1): keep the target id instead of discarding it.
        const sid = rMap.id
        const seid = batch[i]?.[EXTERNAL_ID_FIELD]
        if (sid != null && seid != null) {
          ;(result.successIds ??= []).push({ extId: String(seid), id: String(sid) })
        }
        continue
      }
      result.failureCount++
      // Apex two-tier default (DDS L588-592): extId starts '' and only becomes
      // '(unknown)' for an IN-BOUNDS record with a null ExtId — an out-of-bounds
      // result index (response longer than the batch) keeps the '' initializer.
      let extId = ''
      if (i < batch.length) {
        const eid = batch[i]![EXTERNAL_ID_FIELD]
        extId = eid != null ? String(eid) : '(unknown)'
      }
      // isNotBlank guard (whitespace-only counts as blank, unlike a raw !== '').
      if (!isBlank(extId) && extId !== '(unknown)') result.failedExternalIds.push(extId)
      const errors = Array.isArray(rMap.errors) ? (rMap.errors as unknown[]) : []
      result.errorDetails.push(extId + ' → ' + renderErrMsg(errors))
      for (const e of errors) {
        const eMap = (e ?? {}) as Record<string, unknown>
        result.typedErrors.push({
          extId,
          statusCode: (eMap.statusCode as string) ?? '',
          message: (eMap.message as string) ?? '',
          fields: Array.isArray(eMap.fields) ? (eMap.fields as string[]) : []
        })
      }
    }
  } else {
    // Whole-batch HTTP failure — every record in the batch failed (DDS L611-618).
    result.failureCount += batch.length
    for (const rec of batch) {
      const eid = rec[EXTERNAL_ID_FIELD]
      if (eid != null) result.failedExternalIds.push(String(eid))
    }
    result.errorDetails.push('Batch HTTP error: ' + (http.errorMessage ?? ''))
  }
}

async function runBatches(
  transport: CollectionsTransport,
  method: CompositeMethod,
  endpoint: string,
  objectName: string,
  records: ReadonlyArray<Record<string, unknown>>,
  cap: number
): Promise<CollectionsResult> {
  const result = emptyResult()
  for (const batch of chunk(records, cap)) {
    const payload = JSON.stringify({ allOrNone: false, records: batch })
    const http = await transport.request(method, endpoint, payload)
    applyBatchResult(result, http, batch)
    // Tripwire: stop BEFORE the next batch if managed CPQ triggers fired.
    const sig = findCpqTriggerErrorSignature(result.errorDetails)
    if (sig != null) throw new CpqTriggersActiveError(objectName, sig)
  }
  return result
}

/**
 * PATCH upsert-by-external-Id (the default deploy path). Batches at
 * `min(batchSize,200)`; second-pass callers pass `updateOnly:true`.
 */
export async function upsertByExtId(
  transport: CollectionsTransport,
  objectName: string,
  records: ReadonlyArray<Record<string, unknown>>,
  opts: UpsertOptions = {}
): Promise<CollectionsResult> {
  const endpoint = buildUpsertEndpoint(objectName, opts.updateOnly === true)
  return runBatches(transport, 'PATCH', endpoint, objectName, records, clampBatchSize(opts.batchSize))
}

/**
 * POST insert (generic collections insert — records without an ExtId upsert key).
 * Records carry their own `attributes.type`; posted to the base collections endpoint.
 * NOTE: the junction deploy (E4E.5) does NOT use this — the frozen Apex junction
 * path rendered its own error format and did its own batching/tripwire
 * (DDQ L943-993), so it consumes `insertBatchRaw` instead.
 */
export async function insertRecords(
  transport: CollectionsTransport,
  objectName: string,
  records: ReadonlyArray<Record<string, unknown>>,
  opts: { batchSize?: number | null } = {}
): Promise<CollectionsResult> {
  return runBatches(transport, 'POST', SOBJECTS_BASE, objectName, records, clampBatchSize(opts.batchSize))
}

/** One raw composite result row, by submitted-record index (E4E.5 seam). */
export interface RawInsertRecordResult {
  success: boolean
  id: string | null
  errors: Array<{ statusCode: string | null; message: string | null; fields: string[] }>
}

export type RawInsertResult =
  | { ok: true; results: RawInsertRecordResult[] }
  | { ok: false; errorMessage: string | null }

/**
 * ONE raw composite/sobjects POST — no chunking, no error rendering, no
 * tripwire: the junction engine module owns all three (byte-faithful to the
 * Apex inline loop, DDQ L943-993). Results keep submission order so the caller
 * can attribute each outcome to its source row. A whole-batch HTTP failure
 * resolves { ok: false } rather than throwing (the Apex counted the batch
 * failed and moved on to the next batch).
 */
export async function insertBatchRaw(
  transport: CollectionsTransport,
  records: ReadonlyArray<Record<string, unknown>>
): Promise<RawInsertResult> {
  const payload = JSON.stringify({ allOrNone: false, records })
  const http = await transport.request('POST', SOBJECTS_BASE, payload)
  if (!http.success) return { ok: false, errorMessage: http.errorMessage ?? null }
  const parsed = JSON.parse(http.body ?? '[]') as Array<Record<string, unknown>>
  return {
    ok: true,
    results: parsed.map((r) => ({
      success: r.success === true,
      id: r.id != null ? String(r.id) : null,
      errors: (Array.isArray(r.errors) ? (r.errors as unknown[]) : []).map((e) => {
        const eMap = (e ?? {}) as Record<string, unknown>
        return {
          statusCode: eMap.statusCode != null ? String(eMap.statusCode) : null,
          message: eMap.message != null ? String(eMap.message) : null,
          fields: Array.isArray(eMap.fields) ? (eMap.fields as string[]) : []
        }
      })
    }))
  }
}
