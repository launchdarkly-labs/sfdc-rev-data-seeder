/**
 * S49 BUG-9 — stage 2b of `transformRecordV3`: the RECORD-TYPE-scoped and
 * DEPENDENT picklist gate. New in S49; it has no Apex counterpart (the frozen
 * app had this defect too — standing rule 9 makes that advisory, not binding).
 *
 * WHY STAGE 2 IS NOT ENOUGH. `applyPicklistGate` compares the value against
 * `describe.picklistValues`, which is the field's FULL active value set. The
 * platform enforces a NARROWER set per record, in two ways stage 2 cannot see:
 *
 *   1. RECORD-TYPE SCOPING — a restricted picklist exposes only the values
 *      assigned to the record's RecordType. Live case (run 6):
 *      `Opportunity.Value_Drivers__c` has 7 active values, but the "Amendment"
 *      record type (`012TR000004hIFVYA2`) allows only 4, and the source record
 *      carried `Maximize Speed & Efficiency…;Fast and Safe AI Innovation`.
 *      `Fast and Safe AI Innovation` is active on BOTH orgs, so stage 2 passed
 *      it, and the API answered INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST.
 *
 *   2. DEPENDENT PICKLISTS — a value is valid only for certain values of its
 *      CONTROLLING field. Live case (run 5):
 *      `Contact.Disqualification_Reason__c = 'Duplicate'` is valid only when
 *      `Status__c = 'Disqualified'`; the three failing contacts were
 *      `Qualifying`/`Recycled`. Again active on both orgs, again passed by
 *      stage 2, again rejected by the API.
 *
 * Both live cases are SOURCE data that violates the SOURCE org's own current
 * metadata (written before the restriction existed, or via an API path that
 * doesn't enforce it). The seeder copies it faithfully and the target rejects
 * it — so the gate, not the data, is where this has to be handled.
 *
 * BLAST RADIUS is why this ranked highest: the run-6 Opportunity was ONE bad
 * value, and it took 9 OpportunityLineItems + 1 OpportunityTeamMember down with
 * it (REQUIRED_FIELD_MISSING on the parent that never landed) — 11 reported
 * failures from a single dropped token.
 *
 * DIVERGENCE FROM STAGE 2 (deliberate): a multi-select drops only the OFFENDING
 * TOKENS and keeps the rest, where the Apex port drops the whole field on any
 * bad token. Keeping `Maximize Speed & Efficiency of Safe Software Delivery`
 * while dropping `Fast and Safe AI Innovation` preserves strictly more data and
 * still deploys. `picklistGate` was brought in line with this in the same pass.
 *
 * FAIL-OPEN throughout: no prefetched map for the object, an unknown record
 * type, or a payload with no `RecordTypeId` on an object carrying SEVERAL
 * record types ⇒ the check is skipped and behaviour is exactly pre-S49. A gate
 * that guesses would drop good data, silently.
 *
 * Mutates `payload` and `droppedPicklistValues` in place, like stage 2. Pure.
 */

import { apexStringValueOf, apexTrim, splitRegex } from './apexSemantics'
import type { GoldenContext } from '../golden/fixture'

/**
 * The "Master" record type. Objects with no record types report it, and it is
 * also the key we prefetch the object-wide value set under.
 */
export const MASTER_RECORD_TYPE_ID = '012000000000000AAA'

/** One picklist field's allowed values, as scoped to a single record type. */
export interface RtPicklistField {
  /** Values the platform will accept for this field on this record type. */
  values: string[]
  /** Controlling field API name — null unless this is a dependent picklist. */
  controllerName: string | null
  /** Controlling value → the index `validFor` entries refer to. */
  controllerValues: Record<string, number>
  /**
   * Value → the controller indices it is valid for. Only meaningful when
   * `controllerName` is set; an EMPTY array there means "valid for no
   * controller value at all" (a real state — see `No Longer At Company` on
   * `Contact.Disqualification_Reason__c`).
   */
  validFor: Record<string, number[]>
}

/** recordTypeId (15- AND 18-char keys) → field API name → scoped values. */
export type RecordTypePicklists = Record<string, Record<string, RtPicklistField>>

type RtPicklistContext = Pick<
  GoldenContext,
  'recordTypePicklists' | 'recordTypeDefaultId' | 'recordTypeCandidateCount'
>

function recordDrop(
  droppedPicklistValues: Record<string, string[]>,
  fieldName: string,
  value: string
): void {
  let sample = droppedPicklistValues[fieldName]
  if (sample == null) {
    sample = []
    droppedPicklistValues[fieldName] = sample
  }
  if (!sample.includes(value)) sample.push(value)
}

/**
 * Resolve which record type's value set applies to this payload.
 * Returns null when the check must be skipped (fail-open).
 */
function resolveRtFields(
  payload: Record<string, unknown>,
  byRt: RecordTypePicklists,
  defaultRecordTypeId: string | null | undefined,
  candidateCount: number | undefined
): Record<string, RtPicklistField> | null {
  const raw = payload['RecordTypeId']
  if (raw != null) {
    const rtId = apexStringValueOf(raw)
    if (rtId != null && rtId.length > 0) {
      // Prefetch stores both Id forms, so either width resolves.
      const hit = byRt[rtId]
      if (hit != null) return hit
      // An unknown record type means the prefetch and the payload disagree —
      // guessing the Master set here would drop values the record type may
      // well allow, so skip.
      return null
    }
  }
  // ── No RecordTypeId on the payload ──
  // S50 (BUG-12). S49 gave up here, on the reasoning that the target profile's
  // default was unknowable. It is not: the UI-API object-info payload names it,
  // and it is EXACTLY the record type the platform will apply. Giving up cost
  // run 9 its root Account — `Key Account` is in Account_Category__c's full
  // value set but NOT in the default `CSM` record type's, so the gate waved
  // through a value the API was always going to reject.
  //
  // HARDENING (Jack, 2026-09-07): act on the default ONLY when the object has
  // at most ONE active record type. `defaultRecordTypeId` is the default for
  // the AUTHENTICATED USER'S PROFILE, so with several record types in play it
  // is a profile-dependent answer, and being wrong means silently dropping a
  // value the platform would have accepted — worse than the loud rejection
  // this gate removes, because nobody sees it. With <= 1 active record type
  // there is nothing to be wrong about: the answer is that record type or
  // Master, and object-info distinguishes them for the very identity that
  // performs the write.
  //
  // Measured on sb1_830 across the 11 deployed objects: 9 have ZERO active
  // record types (Master-only, handled below), Account has exactly ONE (the
  // run-9 case this fix exists for), and Opportunity has FOUR — but 0 of its
  // 236,249 source rows carry a null RecordTypeId. So the ambiguous
  // combination occurs ZERO times, and refusing to guess costs nothing.
  const unambiguous = candidateCount != null && candidateCount <= 1
  if (unambiguous && defaultRecordTypeId != null && defaultRecordTypeId.length > 0) {
    const viaDefault = byRt[defaultRecordTypeId]
    if (viaDefault != null) return viaDefault
  }

  // Default unknown (older prefetch, or object-info unreadable). Only the
  // Master-only case — an object with no record types at all — is safe to
  // check, because then Master IS what the platform applies.
  const keys = Object.keys(byRt)
  const masterOnly =
    keys.length > 0 && keys.every((k) => k === MASTER_RECORD_TYPE_ID || k === MASTER_RECORD_TYPE_ID.substring(0, 15))
  return masterOnly ? (byRt[MASTER_RECORD_TYPE_ID] ?? null) : null
}

export function applyRecordTypePicklistGate(
  payload: Record<string, unknown>,
  ctx: RtPicklistContext,
  droppedPicklistValues: Record<string, string[]>
): void {
  const byRt = ctx.recordTypePicklists
  if (byRt == null || Object.keys(byRt).length === 0) return // not prefetched → off

  const fieldsForRt = resolveRtFields(
    payload,
    byRt,
    ctx.recordTypeDefaultId,
    ctx.recordTypeCandidateCount
  )
  if (fieldsForRt == null) return

  // Snapshot the keys — the loop mutates the payload (stage 2's rule).
  for (const fieldName of Object.keys(payload)) {
    const info = fieldsForRt[fieldName]
    if (info == null) continue // not a restricted picklist we prefetched
    const val = payload[fieldName]
    if (val == null) continue
    const sval = apexStringValueOf(val)
    if (sval == null || sval.length === 0) continue

    const allowed = new Set(info.values) // case-SENSITIVE, like stage 2

    // Controlling value → index, for the dependent-picklist half.
    let controllerIdx: number | null = null
    if (info.controllerName != null) {
      const rawCtrl = payload[info.controllerName]
      const sctrl = rawCtrl == null ? null : apexStringValueOf(rawCtrl)
      if (sctrl != null) {
        const idx = info.controllerValues[sctrl]
        if (typeof idx === 'number') controllerIdx = idx
      }
    }

    const isMulti = sval.includes(';')
    const tokens = isMulti ? splitRegex(sval, ';').map((t) => apexTrim(t)) : [sval]

    const kept: string[] = []
    const dropped: string[] = []
    for (const token of tokens) {
      let ok = allowed.has(token)
      if (ok && info.controllerName != null) {
        const vf = info.validFor[token]
        // A dependent value with no controller selected can never be valid.
        ok = vf != null && controllerIdx != null && vf.includes(controllerIdx)
      }
      if (ok) kept.push(token)
      else dropped.push(token)
    }

    if (dropped.length === 0) continue
    for (const d of dropped) recordDrop(droppedPicklistValues, fieldName, d)
    if (kept.length === 0) delete payload[fieldName]
    else payload[fieldName] = kept.join(';')
  }
}
