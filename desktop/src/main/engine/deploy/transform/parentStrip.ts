/**
 * E4X.7 — parent-strip gates. Byte-faithful port of Apex
 * `DataDeploymentQueueable.stripMissingParentRefs` (DDQ L2490-2589) and its
 * companion `stripMissingDirectIdRefs` (DDQ L2602-2691).
 *
 * Both run AFTER stage-1 transform, BEFORE the upsert: they drop reference
 * fields whose parent doesn't exist on target so the row still deploys (minus
 * that link) instead of failing whole with "Foreign key external ID not found"
 * / INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY. Two paths, two failure modes:
 *
 *   - NESTED externalId refs (`{ Rel: { ExtId } }`, in-scope parents): query
 *     target by ExtId; a query failure THROWS — FAIL-LOUD → bounded object retry.
 *     Self-references are excluded (the deferred second pass handles them).
 *   - FLAT directId refs (`apiName: rawId`, CPQ catalog): query target by Id;
 *     a query failure marks that object unqueryable and leaves its fields alone —
 *     FAIL-OPEN (directId links are best-effort). User + self refs are excluded
 *     (User is handled by the inactive-owner substitution).
 *
 * Both MUTATE the payloads in place and contribute "rel/field → Object (n)"
 * fragments to one combined Warning line (byte-exact — E4X.7 GF AC).
 *
 * ENGINE-PURE over an injected `ParentStripIo` (SOQL assembly + escapeSingleQuotes
 * + the 200-Id IN chunking's URL handling live in the E4E adapter; the engine
 * owns the 200-value chunk boundary to match Apex). Trap 18: a nested ref is a
 * plain object; a directId ref is a `typeof === 'string'`.
 */

import { ciEquals, isBlank } from './apexSemantics'
import { EXTERNAL_ID_FIELD } from './sfid'
import type { GoldenFieldInfo } from '../golden/fixture'

/** Apex's per-IN-clause chunk (DDQ L2526/L2639) — ~URL-safe Id count. */
const CHUNK = 200

/**
 * S49 (BUG-10): one reference this pass removed because its parent was not on
 * target. Recorded so the failure classifier can tell a CASCADE (the parent
 * failed in this very run) from a ROOT problem — a stripped REQUIRED lookup
 * comes back from the API as `REQUIRED_FIELD_MISSING`, which names the field
 * but says nothing about the parent, so without this the classifier had no way
 * to connect the two and defaulted every one of them to 'root'.
 */
export interface StrippedRef {
  /** The relationship key removed from the payload, e.g. `Opportunity`. */
  relationshipName: string
  /** The object it pointed at, e.g. `Opportunity`. */
  refObject: string
  /** The parent's external Id — reverse() gives the parent's SOURCE id. */
  parentExtId: string
  /** The underlying lookup field, e.g. `AccountId` for relationship `Account`. */
  fieldName: string
  /**
   * S50 (A5): was the lookup NILLABLE?
   *
   * This is the whole distinction between the two outcomes of a strip:
   *   - REQUIRED  -> the row fails loudly (REQUIRED_FIELD_MISSING), lands in
   *     failed_records, and the retry drain re-runs it against live target
   *     state, so it self-heals once the parent arrives. Working as designed.
   *   - NILLABLE  -> the row DEPLOYS with a null FK and nothing ever re-links
   *     it (the second pass only revisits DEFERRED fields). A silent orphan.
   * Only the nillable ones are worth recording.
   */
  nillable: boolean
}

export interface StripOptions {
  /**
   * S49 (BUG-10), out-parameter: payload object identity → the refs removed
   * from it. Omitted ⇒ byte-identical behaviour to pre-S49.
   */
  strippedOut?: Map<Record<string, unknown>, StrippedRef[]>
  /**
   * S49 (BUG-11): also strip SELF-references.
   *
   * The first pass deliberately leaves self-refs alone — the deferred second
   * pass owns them, and stripping them in pass 1 would defeat the whole
   * two-pass design. But the second pass calls this same function, so with
   * self-refs excluded on BOTH sides they were never checked ANYWHERE: a
   * deferred self-reference to a record that is not on target went straight to
   * the API as `INVALID_FIELD: Foreign key external ID … in entity <self>`.
   *
   * Live cases: run 5 Account `0011K0000266X9aQAE` (a `ParentId` to an
   * out-of-scope account) and run 6 Opportunities `006TR00000bkf7kYAA` /
   * `006TR00000bkzSzYAI`, both pointing at `006TR00000XIwc0YAD` — the very
   * Opportunity that BUG-9 had just failed. Same defect class as BUG-2, which
   * S49 fixed only for the junction path.
   *
   * Deferred self-refs are nillable by construction (a required self-lookup
   * could never be inserted in pass 1), so dropping the link is safe.
   */
  includeSelfRefs?: boolean
  /**
   * S53 (A1 at N>1 — "skip the subtree", Jack 2026-09-12): the lookup field by
   * which THIS object was scoped off its parent (`scope.lookupField` of a
   * parentIn / parentSubquery scope, e.g. `AccountId` on Contact). A record
   * whose SCOPE parent is not on target is a member of a detached subtree —
   * it belongs to an account (or opportunity, or quote) that did not deploy —
   * and must NOT be written with the link blanked: that is precisely the
   * "orphaned children of a failed root" shape S50's A1 gate only catches
   * when the root deployed ZERO. When set, a missing scope parent is NOT
   * stripped; the record is reported through `withheldOut` and the caller
   * withholds it from the upsert as a FAILED (retryable) record. Every other
   * lookup keeps today's strip-and-deploy behaviour — a cross-account
   * Primary_Contact__c pointing outside the scope is still just a blank link.
   */
  scopeParentField?: string | null
  /**
   * Out-parameter for `scopeParentField`: payload identity → the unresolved
   * scope-parent reference. A payload appears here at most once.
   */
  withheldOut?: Map<Record<string, unknown>, StrippedRef>
}

export interface ParentStripIo {
  /**
   * `SELECT {field} FROM {refObj} WHERE {field} IN ({chunk})` — one existence
   * probe. `chunk` holds ≤ {@link CHUNK} values. Returns the `{field}` values
   * present on target. REJECTS on failure (caller decides LOUD vs OPEN).
   */
  queryExisting(refObj: string, field: string, chunk: string[]): Promise<string[]>
}

/** Trap 18 — a nested externalId ref is a plain object (not array/string/null). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function chunk200<T>(all: ReadonlyArray<T>): T[][] {
  const out: T[][] = []
  for (let i = 0; i < all.length; i += CHUNK)
    out.push(all.slice(i, Math.min(i + CHUNK, all.length)))
  return out
}

/**
 * FAIL-OPEN companion (DDQ L2602-2691). Flat directId refs (raw Id copied into
 * the field) — drop the field when the Id doesn't resolve on target. User + self
 * refs excluded. Mutates `payloads`; returns "field → Object (n, directId not on
 * target)" fragments.
 */
export async function stripMissingDirectIdRefs(
  io: ParentStripIo,
  objectName: string,
  fields: ReadonlyArray<GoldenFieldInfo>,
  payloads: Array<Record<string, unknown>>,
  opts?: Pick<StripOptions, 'scopeParentField' | 'withheldOut'>
): Promise<string[]> {
  const parts: string[] = []

  // apiName → refObj, for reference fields, excluding self + User refs.
  const fieldToRefObj = new Map<string, string>()
  const relByField = new Map<string, string | null>()
  for (const fi of fields) {
    if (fi.isReference !== true) continue
    const ref0 = fi.referenceTo?.[0]
    if (ref0 == null) continue
    if (ciEquals(ref0, objectName) || ciEquals(ref0, 'User')) continue
    fieldToRefObj.set(fi.apiName, ref0)
    relByField.set(fi.apiName, fi.relationshipName ?? null)
  }
  if (fieldToRefObj.size === 0) return parts

  // Collect flat raw Ids per refObj (string values only — nested maps aren't strings).
  const rawIdsByObj = new Map<string, Set<string>>()
  for (const rec of payloads) {
    for (const [apiName, refObj] of fieldToRefObj) {
      const v = rec[apiName]
      if (typeof v !== 'string') continue
      let ids = rawIdsByObj.get(refObj)
      if (ids == null) {
        ids = new Set<string>()
        rawIdsByObj.set(refObj, ids)
      }
      ids.add(v)
    }
  }
  if (rawIdsByObj.size === 0) return parts

  // Query target per object; FAIL-OPEN — a query error marks the object
  // unqueryable and leaves its fields untouched.
  const foundByObj = new Map<string, Set<string>>()
  const unqueryable = new Set<string>()
  for (const [refObj, idSet] of rawIdsByObj) {
    const found = new Set<string>()
    foundByObj.set(refObj, found)
    try {
      for (const chunk of chunk200([...idSet])) {
        const present = await io.queryExisting(refObj, 'Id', chunk)
        for (const idv of present) {
          if (isBlank(idv)) continue
          found.add(idv)
          if (idv.length === 18) found.add(idv.substring(0, 15)) // dual-form
        }
      }
    } catch {
      unqueryable.add(refObj) // best-effort — leave this object's fields alone
    }
  }

  // Strip fields whose directId target is missing (skip unqueryable objects).
  const droppedByField = new Map<string, number>()
  for (const rec of payloads) {
    for (const [apiName, refObj] of fieldToRefObj) {
      if (unqueryable.has(refObj)) continue
      const v = rec[apiName]
      if (typeof v !== 'string') continue
      const found = foundByObj.get(refObj)!
      if (found.has(v) || (v.length === 18 && found.has(v.substring(0, 15)))) continue
      // S53: the SCOPE parent is missing — withhold the record, keep the link.
      if (isScopeParent(opts?.scopeParentField, apiName)) {
        withhold(opts?.withheldOut, rec, {
          relationshipName: relByField.get(apiName) ?? apiName,
          refObject: refObj,
          parentExtId: v,
          fieldName: apiName,
          nillable: fields.find((f) => f.apiName === apiName)?.isNillable !== false
        })
        continue
      }
      delete rec[apiName]
      droppedByField.set(apiName, (droppedByField.get(apiName) ?? 0) + 1)
    }
  }

  for (const [apiName, count] of droppedByField) {
    parts.push(`${apiName} → ${fieldToRefObj.get(apiName)} (${count}, directId not on target)`)
  }
  return parts
}

/**
 * FAIL-LOUD nested-externalId strip + the flat directId strip, combined into one
 * Warning line (DDQ L2490-2589). Mutates `payloads`; returns the combined warning
 * or `null` when nothing was dropped.
 */
export async function stripMissingParentRefs(
  io: ParentStripIo,
  objectName: string,
  fields: ReadonlyArray<GoldenFieldInfo>,
  payloads: Array<Record<string, unknown>>,
  opts?: StripOptions
): Promise<string | null> {
  if (payloads == null || payloads.length === 0) return null

  // relationshipName → refObj (skip self-refs — deferred second pass owns them).
  const relToRefObj = new Map<string, { refObj: string; fieldName: string; nillable: boolean }>()
  for (const fi of fields) {
    if (fi.isReference !== true) continue
    const rel = fi.relationshipName
    if (isBlank(rel)) continue
    const ref0 = fi.referenceTo?.[0]
    if (ref0 == null) continue
    // Self-refs: excluded in pass 1 (the deferred pass owns them), included in
    // pass 2 (which is where they are actually written) — see StripOptions.
    if (opts?.includeSelfRefs !== true && ciEquals(ref0, objectName)) continue
    relToRefObj.set(rel, {
      refObj: ref0,
      fieldName: fi.apiName,
      nillable: fi.isNillable !== false
    })
  }
  if (relToRefObj.size === 0) return null

  // Collect referenced ExtIds per object from the nested `{ Rel: { ExtId } }`.
  const refExtIdsByObj = new Map<string, Set<string>>()
  for (const rec of payloads) {
    for (const [relName, meta] of relToRefObj) {
      const refObj = meta.refObj
      const v = rec[relName]
      if (!isPlainObject(v)) continue
      const extId = v[EXTERNAL_ID_FIELD]
      if (extId == null) continue
      let ids = refExtIdsByObj.get(refObj)
      if (ids == null) {
        ids = new Set<string>()
        refExtIdsByObj.set(refObj, ids)
      }
      ids.add(String(extId))
    }
  }
  // FROZEN-APEX PARITY (DDQ L2518): when no nested externalId refs were
  // collected, Apex returns null BEFORE the directId second pass — so the flat
  // directId strip runs ONLY when at least one nested ref exists in the batch.
  // (Callers wanting the directId-only pass invoke stripMissingDirectIdRefs
  // directly.) Do NOT "helpfully" run it here — that diverges from the oracle.
  if (refExtIdsByObj.size === 0) return null

  // Query target per referenced object for which ExtIds exist. FAIL-LOUD — a
  // query rejection propagates (→ bounded whole-object retry).
  const foundByObj = new Map<string, Set<string>>()
  for (const [refObj, idSet] of refExtIdsByObj) {
    const found = new Set<string>()
    foundByObj.set(refObj, found)
    for (const chunk of chunk200([...idSet])) {
      const present = await io.queryExisting(refObj, EXTERNAL_ID_FIELD, chunk)
      for (const e of present) if (!isBlank(e)) found.add(e)
    }
  }

  // Strip refs whose parent is missing; count per relationship.
  const droppedByRel = new Map<string, number>()
  for (const rec of payloads) {
    for (const [relName, meta] of relToRefObj) {
      const refObj = meta.refObj
      const v = rec[relName]
      if (!isPlainObject(v)) continue
      const extId = v[EXTERNAL_ID_FIELD]
      if (extId == null) continue
      if (foundByObj.get(refObj)!.has(String(extId))) continue
      // S53: the SCOPE parent is missing — withhold the record, keep the link
      // (see StripOptions.scopeParentField). Not counted as a drop: nothing
      // was dropped, and the combined Warning line stays byte-exact for the
      // records that ARE written.
      if (isScopeParent(opts?.scopeParentField, meta.fieldName)) {
        withhold(opts?.withheldOut, rec, {
          relationshipName: relName,
          refObject: refObj,
          parentExtId: String(extId),
          fieldName: meta.fieldName,
          nillable: meta.nillable
        })
        continue
      }
      delete rec[relName]
      droppedByRel.set(relName, (droppedByRel.get(relName) ?? 0) + 1)
      if (opts?.strippedOut != null) {
        const strippedOut = opts.strippedOut
        let refs = strippedOut.get(rec)
        if (refs == null) {
          refs = []
          strippedOut.set(rec, refs)
        }
        refs.push({
          relationshipName: relName,
          refObject: refObj,
          parentExtId: String(extId),
          fieldName: meta.fieldName,
          nillable: meta.nillable
        })
      }
    }
  }

  const parts: string[] = []
  for (const [relName, count] of droppedByRel) {
    parts.push(`${relName} → ${relToRefObj.get(relName)?.refObj} (${count})`)
  }

  // Flat directId catalog refs (fail-open) append to the same combined warning.
  parts.push(...(await stripMissingDirectIdRefs(io, objectName, fields, payloads, opts)))

  return parts.length === 0 ? null : combined(objectName, parts)
}

/** S53: is `fieldName` the lookup this object was scoped by? (case-insensitive, like every field compare here) */
function isScopeParent(scopeParentField: string | null | undefined, fieldName: string): boolean {
  return !isBlank(scopeParentField) && ciEquals(scopeParentField as string, fieldName)
}

/** S53: record a withheld payload once (first unresolved scope-parent ref wins). */
function withhold(
  out: Map<Record<string, unknown>, StrippedRef> | undefined,
  rec: Record<string, unknown>,
  ref: StrippedRef
): void {
  if (out == null || out.has(rec)) return
  out.set(rec, ref)
}

/** The combined Warning-line format (DDQ L2586-2588) — byte-exact. */
function combined(objectName: string, parts: string[]): string {
  return (
    'Dropped unresolvable reference(s) on ' +
    objectName +
    ' — referenced record(s) not on target; field left empty instead of ' +
    'failing the row: ' +
    parts.join(', ')
  )
}
