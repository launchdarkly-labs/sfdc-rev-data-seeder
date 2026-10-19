/**
 * The seed WRITER (plan §4.4): `allOrNone=false` collections calls in batches
 * of the tier's batch size, with the reference tool's retry ladder:
 *
 *   1. Rows that hit a TRANSIENT error (row lock, CPU time, timeouts,
 *      concurrency) are retried in SMALLER batches: size → 50 → 10. Managed
 *      triggers can run out of CPU on 200 rows and succeed on 10.
 *   2. Rows that end the ladder still failing, or that fail with the BULK-ONLY
 *      class (CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY / UNKNOWN_EXCEPTION — a
 *      trigger exception that only happens when rows activate together), get
 *      ONE single-record attempt each, capped at 300 rows per call.
 *   3. Validation errors are never retried: the row would fail again.
 *
 * NO CPQ tripwire here — a config seed produces exactly the `SBQQ.` error
 * strings the deploy's tripwire throws on (plan §4.2); here they are per-row
 * failures the tally records and the report shows.
 *
 * A whole-call HTTP failure comes back from OrgWriter.collections as every row
 * failed with the transport message; it is NEVER resent (a write may have
 * landed) — unless it is itself a transient-class message during the ladder,
 * in which case the rows move to the smaller batch exactly like the reference.
 */
import type { RowResult, TemplateIo } from '../io'

export const TRANSIENT_ERROR_PATTERNS = [
  'UNABLE_TO_LOCK_ROW',
  'CPU time',
  'Request timed out',
  'QUERY_TIMEOUT',
  'concurrent',
  'timed out'
] as const

export const SINGLE_RETRY_PATTERNS = [
  'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
  'UNKNOWN_EXCEPTION',
  'still failing after smaller-batch retries'
] as const

export const SINGLE_RETRY_CAP = 300
export const STILL_FAILING = 'still failing after smaller-batch retries'

export function isTransient(error: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some((p) => error.includes(p))
}
export function isBulkOnlyClass(error: string): boolean {
  return SINGLE_RETRY_PATTERNS.some((p) => error.includes(p))
}

export interface WriteOutcome {
  /** Aligned with the submitted records. */
  results: RowResult[]
  /** Rows that failed in bulk and saved on their single-record retry (D4 evidence). */
  savedOnSingleRetry: number
  /** Rows that failed with the bulk-only class and did not save even singly. */
  bulkOnlyFailures: number
}

export class SeedCancelledError extends Error {
  constructor() {
    super('Template run cancelled')
    this.name = 'SeedCancelledError'
  }
}

export async function writeRows(
  io: TemplateIo,
  method: 'POST' | 'PATCH',
  object: string,
  records: ReadonlyArray<Record<string, unknown>>,
  batchSize: number
): Promise<WriteOutcome> {
  const results: Array<RowResult | null> = new Array<RowResult | null>(records.length).fill(null)
  if (records.length === 0) return { results: [], savedOnSingleRetry: 0, bulkOnlyFailures: 0 }
  const size = Math.max(1, Math.min(200, Math.trunc(batchSize) || 200))
  const sizes = [...new Set([size, 50, 10].filter((s) => s <= size))].sort((a, b) => b - a)
  let pending = records.map((_, i) => i)

  for (let si = 0; si < sizes.length; si++) {
    const sz = sizes[si]!
    const last = si === sizes.length - 1
    const retry: number[] = []
    for (let i0 = 0; i0 < pending.length; i0 += sz) {
      if (io.cancelled()) throw new SeedCancelledError()
      const idx = pending.slice(i0, i0 + sz)
      const res = await io.target.collections(method, object, idx.map((i) => records[i]!))
      idx.forEach((i, k) => {
        const r = res[k] ?? { success: false, id: null, error: 'no result returned for this row', statusCode: null }
        if (r.success) {
          results[i] = r
          return
        }
        if (isTransient(r.error)) {
          // Smaller batch next; at the smallest size a still-transient row is
          // marked "still failing" so the single-record retry below gets it.
          if (!last) retry.push(i)
          else results[i] = { ...r, error: `${STILL_FAILING}: ${r.error}` }
        } else results[i] = r
      })
    }
    pending = retry
    if (pending.length === 0) break
  }

  let savedOnSingleRetry = 0
  let bulkOnlyFailures = 0
  const again = records
    .map((_, i) => i)
    .filter((i) => !results[i]!.success && isBulkOnlyClass(results[i]!.error))
  if (size > 1 && again.length > 0 && again.length <= SINGLE_RETRY_CAP) {
    for (const i of again) {
      if (io.cancelled()) throw new SeedCancelledError()
      const res = await io.target.collections(method, object, [records[i]!])
      const r = res[0] ?? { success: false, id: null, error: 'no result returned for this row', statusCode: null }
      results[i] = r
      if (r.success) savedOnSingleRetry++
      else bulkOnlyFailures++
    }
  } else {
    bulkOnlyFailures = again.length
  }
  return { results: results.map((r) => r!), savedOnSingleRetry, bulkOnlyFailures }
}

/** `DELETE` in chunks of 200; results aligned with `ids`. */
export async function deleteRows(io: TemplateIo, ids: ReadonlyArray<string>): Promise<RowResult[]> {
  const out: RowResult[] = []
  for (let i = 0; i < ids.length; i += 200) {
    if (io.cancelled()) throw new SeedCancelledError()
    out.push(...(await io.target.deleteIds(ids.slice(i, i + 200))))
  }
  return out
}
