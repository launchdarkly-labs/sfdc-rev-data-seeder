/**
 * E4X.7 — Contract activation companion (the Draft-override's other half).
 *
 * Contract records are transformed to `Status='Draft'` on insert (stage 1,
 * DDS L1016) and activated afterward. This module ports two pieces:
 *
 *  1. RE-RUN IDEMPOTENCY GUARD (DDQ L1906-1933 + queryActivatedContractExtIds
 *     L2755-2783): a target Contract already `Status='Activated'` from a prior
 *     run can't be re-upserted as Draft (Salesforce rejects it, logged as a
 *     FALSE failure — the 2/167 on RDS-DEP-0007). Drop those from the batch and
 *     COUNT THEM AS DEPLOYED. FAIL-OPEN — a query error yields an empty set, so
 *     the fresh-target path is byte-for-byte unchanged.
 *
 *  2. RUN-SCOPED ACTIVATION for teardown (DDQ PostDeploymentQueueable
 *     `doContractActivationCallouts` L195-252): query target Draft Contracts and
 *     PATCH them to Activated. **DELIBERATE IMPROVEMENT over the frozen Apex**
 *     (deployDesign §7 E4X.7 AC — "activation query provably scoped to run
 *     ExtIds"): the Apex query is ORG-WIDE (`Status='Draft' AND ExtId != null`),
 *     which would activate Draft Contracts belonging to OTHER runs/sources. The
 *     desktop scopes activation to THIS run's ExtIds (`ExtId IN (runExtIds)`).
 *     This is unit-verified (not golden-matched) precisely because it diverges.
 *
 * ENGINE-PURE: the partition + query/patch builders are pure; the fail-open fetch
 * runs over an injected `ContractsIo`. Callout sequencing is the E4E teardown's job.
 */

import { escapeSingleQuotes } from './apexSemantics'
import { EXTERNAL_ID_FIELD } from './sfid'

/** IN-clause chunk (matches the parent-strip / PBE 200-Id boundary). */
const CHUNK = 200

export interface ContractsIo {
  /** Execute a Contract query; return the found `EXTERNAL_ID_FIELD` values
   *  (fully paginated). REJECTS on failure (the idempotency fetch wraps it). */
  queryExtIds(soql: string): Promise<string[]>
}

function chunk200<T>(all: ReadonlyArray<T>): T[][] {
  const out: T[][] = []
  for (let i = 0; i < all.length; i += CHUNK) out.push(all.slice(i, Math.min(i + CHUNK, all.length)))
  return out
}

const quoteIn = (values: ReadonlyArray<string>): string =>
  values.map((v) => "'" + escapeSingleQuotes(v) + "'").join(',')

/**
 * Run-scoped query for already-Activated target Contracts among `extIdChunk`.
 * (Run-scoped `IN` — the improvement over Apex's org-wide `!= null`.)
 */
export function buildActivatedContractQuery(extIdChunk: ReadonlyArray<string>): string {
  return (
    `SELECT ${EXTERNAL_ID_FIELD} FROM Contract ` +
    `WHERE Status = 'Activated' AND ${EXTERNAL_ID_FIELD} IN (${quoteIn(extIdChunk)})`
  )
}

/**
 * Run-scoped query for the Draft target Contracts to activate (only THIS run's
 * ExtIds — not every Draft Contract on the org). Selects Id + Status for the PATCH.
 */
export function buildDraftActivationQuery(extIdChunk: ReadonlyArray<string>): string {
  return (
    `SELECT Id, Status FROM Contract ` +
    `WHERE Status = 'Draft' AND ${EXTERNAL_ID_FIELD} IN (${quoteIn(extIdChunk)})`
  )
}

/** The activation PATCH payload records (DDQ PostDeployment L216-222). */
export function buildActivationPatchRecords(draftIds: ReadonlyArray<string>): Array<Record<string, unknown>> {
  return draftIds.map((id) => ({
    attributes: { type: 'Contract' },
    Id: id,
    Status: 'Activated'
  }))
}

export interface IdempotencyPartition {
  /** Records still to upsert (not already Activated on target). */
  remaining: Array<Record<string, unknown>>
  /** Count of records skipped because they're already Activated — count AS DEPLOYED. */
  alreadyActivated: number
}

/**
 * PURE idempotency partition (DDQ L1917-1926): split the batch into records to
 * upsert vs. those whose ExtId is already Activated on target (skip + count as
 * deployed). An empty `activatedExtIds` leaves the batch untouched.
 */
export function partitionActivatedContracts(
  records: ReadonlyArray<Record<string, unknown>>,
  activatedExtIds: ReadonlySet<string>
): IdempotencyPartition {
  const remaining: Array<Record<string, unknown>> = []
  let alreadyActivated = 0
  for (const rec of records) {
    const eid = rec[EXTERNAL_ID_FIELD]
    if (eid != null && activatedExtIds.has(String(eid))) {
      alreadyActivated++
    } else {
      remaining.push(rec)
    }
  }
  return { remaining, alreadyActivated }
}

/**
 * FAIL-OPEN fetch of already-Activated Contract ExtIds among `runExtIds`
 * (queryActivatedContractExtIds L2755-2783). Any query error → the set built so
 * far (empty on the first chunk) → the upsert proceeds unchanged. Run-scoped.
 */
export async function fetchActivatedContractExtIds(
  io: ContractsIo,
  runExtIds: ReadonlyArray<string>
): Promise<Set<string>> {
  const out = new Set<string>()
  if (runExtIds.length === 0) return out
  try {
    for (const chunk of chunk200(runExtIds)) {
      const found = await io.queryExtIds(buildActivatedContractQuery(chunk))
      for (const e of found) if (e != null) out.add(String(e))
    }
  } catch {
    // FAIL-OPEN — proceed with whatever we accumulated.
  }
  return out
}

/**
 * The full re-run guard: fetch the already-Activated ExtIds (fail-open) then
 * partition the batch. Only meaningful for `Contract`; the caller gates on that.
 *
 * The idempotency scope is DERIVED from the batch records' own ExtIds — NOT a
 * caller-supplied run list. That's the correct scope (we only care whether
 * THESE records are already Activated) AND it's safe by construction: a batch
 * record can never be missing from the query scope, so an already-Activated
 * Contract in the batch can't slip through and get re-written to Draft (the
 * false-failure this guard exists to prevent). The teardown activation query
 * (`buildDraftActivationQuery`) is the separate run-wide-scoped concern.
 */
export async function applyContractIdempotency(
  io: ContractsIo,
  records: ReadonlyArray<Record<string, unknown>>
): Promise<IdempotencyPartition> {
  const batchExtIds: string[] = []
  for (const rec of records) {
    const eid = rec[EXTERNAL_ID_FIELD]
    if (eid != null) batchExtIds.push(String(eid))
  }
  const activated = await fetchActivatedContractExtIds(io, batchExtIds)
  return partitionActivatedContracts(records, activated)
}
