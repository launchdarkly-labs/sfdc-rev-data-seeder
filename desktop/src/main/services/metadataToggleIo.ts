/**
 * E4A.4 — live MetadataToggleIo adapter: binds the pure Metadata-API toggle
 * engine (engine/metadataToggle.ts) to a GuardedOrg's jsforce Metadata client.
 *
 * EVERY call — reads included — is gated by `assertWritable`: these toggles
 * only ever run against the TARGET org, so an IO handed a source/prod
 * connection must refuse before any request leaves the machine. The gate
 * THROWS (ReadOnlyOrgError) rather than resolving success:false — a role
 * violation is a structural bug that must surface loudly.
 *
 * Failure classes are split to match the frozen Apex exactly (REVIEW-FIX #1):
 * - A failure response Salesforce RETURNED (SOAP fault, non-200) resolves
 *   success:false — the engine's silent-zero semantics (a failed batch
 *   contributes count 0, callers treat count>0 as the outcome) depend on it,
 *   mirroring DuplicateRuleService's `getStatusCode() != 200` log-and-continue
 *   branches (DRS:95-98, 106-110).
 * - A NO-RESPONSE transport failure (DNS, refused connection, timeout, socket
 *   reset — the Apex CalloutException class) RETHROWS: DRS.callSoap is a raw
 *   `new Http().send()` with no try/catch (DRS:214-222), so in Apex that
 *   class aborted the remaining batches and escaped the org-wide entry point
 *   loudly (DataSeederController:2691-2693). Resolving it success:false would
 *   silently continue through doomed batches the Apex never attempted.
 *
 * jsforce normalization: metadata.list/read/update return one-or-many (a
 * single component comes back bare, not in an array) — everything is
 * normalized to arrays of records here so the engine sees one shape.
 */
import type { GuardedOrg } from './salesforce'
import { API_VERSION } from './salesforce'
import type { MetadataIoResult, MetadataToggleIo } from '../engine/metadataToggle'

interface JsforceMetadataClient {
  list(queries: { type: string }, apiVersion?: string): Promise<unknown>
  read(type: string, fullNames: string | string[]): Promise<unknown>
  update(type: string, metadata: unknown): Promise<unknown>
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** One-or-many → array of records; null/undefined (empty org) → []. */
function toRecords(v: unknown): Array<Record<string, unknown>> {
  if (v == null) return []
  const items = Array.isArray(v) ? v : [v]
  const records: Array<Record<string, unknown>> = []
  for (const item of items) {
    const rec = asRecord(item)
    if (rec !== null) records.push(rec)
  }
  return records
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The Apex-CalloutException class: the request never got a Salesforce
 * response. Node/undici surface these as syscall-coded errors (ECONNREFUSED,
 * ETIMEDOUT, ENOTFOUND, …), abort/timeout errors, or a generic
 * `TypeError: fetch failed` wrapping the real cause. jsforce API/SOAP-fault
 * errors carry no such code and DON'T match — they took a response.
 */
export function isNoResponseTransportError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const code = (e as { code?: unknown }).code
  if (typeof code === 'string' && /^(E[A-Z0-9]+|UND_ERR_[A-Z_]+)$/.test(code)) return true
  if (e.name === 'AbortError' || e.name === 'FetchError' || e.name === 'TimeoutError') return true
  if (e.message === 'fetch failed') return true
  const cause = (e as { cause?: unknown }).cause
  return cause !== undefined && cause !== e && isNoResponseTransportError(cause)
}

export function makeMetadataToggleIo(
  target: GuardedOrg,
  log?: (level: 'warn' | 'error', message: string) => void
): MetadataToggleIo {
  const client = target.conn.metadata as unknown as JsforceMetadataClient

  // The gate runs OUTSIDE the try: ReadOnlyOrgError must propagate, never
  // degrade into the engine's silent-zero path.
  async function guarded(
    operation: string,
    call: () => Promise<unknown>
  ): Promise<MetadataIoResult<Array<Record<string, unknown>>>> {
    target.assertWritable(operation)
    try {
      return { success: true, result: toRecords(await call()) }
    } catch (e) {
      if (isNoResponseTransportError(e)) throw e // CalloutException parity
      return { success: false, errorMessage: errText(e) }
    }
  }

  return {
    list(type) {
      return guarded(`metadata toggle: listMetadata ${type}`, () =>
        client.list({ type }, API_VERSION)
      )
    },
    read(type, fullNames) {
      return guarded(`metadata toggle: readMetadata ${type} (${fullNames.length})`, () =>
        client.read(type, [...fullNames])
      )
    },
    update(type, records) {
      return guarded(`metadata toggle: updateMetadata ${type} (${records.length})`, () =>
        client.update(type, [...records])
      )
    },
    log
  }
}
