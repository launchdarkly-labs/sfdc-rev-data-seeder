/**
 * E4E.3 — root/cascade failure classification. Byte-faithful port of
 * `DataDeploymentQueueable.classifyFailures` (DDQ L2202-2312):
 *
 *   ROOT    — failure caused by something on this record/object (picklist,
 *             validation rule, missing required field, …). Real things to fix.
 *   CASCADE — failure caused by an upstream parent we already counted:
 *     (a) `INVALID_FIELD: Foreign key external ID: X … in entity Y` where Y is
 *         one of our deployment objects AND reverse(X) (the parent SOURCE id)
 *         is in that object's already-failed set (dual 15/18 forms).
 *     (b) `NOT_FOUND` on a SECOND-pass update whose own extId's source id is
 *         in THIS object's already-failed set (the record never got inserted
 *         in pass 1, so updateOnly correctly no-ops — don't double count).
 *
 * "The split lets the UI tell the user: you have 12 root issues, the rest is
 * downstream noise that'll clear once you fix the 12."
 *
 * Classification is per ERROR-DETAIL LINE in the legacy format
 * (`extId → CODE: message[ fields=[…]]; `) — the parsing is deliberately
 * byte-anchored to that format (indexOf markers, Apex split/trim semantics).
 * The desktop stamps a classification per failed RECORD into
 * failed_records.classification (Root+Cascade ≡ Failed by construction, the
 * migration-005 view contract). Apex counted LINES — for a whole-sub-batch
 * HTTP failure it bucketed the single 'Batch HTTP error: …' line as 1 root
 * while Records_Failed counted every record. That accumulator drift is a
 * bug class the per-record model deliberately kills (E2.5 design-authorized
 * divergence: Root+Cascade always reconciles with Failed).
 *
 * THE FAILED-SET SOURCE: Apex read every Deployment_Object__c's
 * `Persistent_Failed_Source_Ids__c` — the failure accumulator OVERWRITTEN on
 * every batch write (DDQ L1997-2003, read at L2235-2263). The desktop mirror
 * (DeployRunStore.currentFailures) reproduces the overwrite structurally:
 * per object, the failed_records rows at the LATEST (object_attempt,
 * retry_pass) — so records absent from the latest pass (healed, skipped, or
 * deleted on source mid-run) drop out exactly like the Apex accumulator, and
 * mid-drain a chunk sees only the chunks re-failed so far (E4E.3 review: an
 * earlier current-truth reading kept deleted-source parents 'failed' forever
 * and cascade-classified what the frozen Apex called root). Read fresh per
 * batch BEFORE the batch's own failures are recorded — same visibility as the
 * Apex per-batch SOQL (same-batch sibling failures never classify against
 * themselves). Residual gap documented on the store reader (fully-healed
 * passes; unreachable for FK errors).
 *
 * Pure: no jsforce, no better-sqlite3, no IO.
 */

import { apexTrim, isBlank, splitRegex } from './transform/apexSemantics'
import { reverse } from './transform/sfid'
import type { StrippedRef } from './transform/parentStrip'
import type { GoldenFieldInfo } from './golden/fixture'

const FK_MARKER = 'Foreign key external ID:'
const ENTITY_MARKER = 'in entity '

/**
 * The Apex failedByObject map (DDQ L2244-2263): EVERY deployment object gets a
 * key (containsKey gates pattern (a) — an entity outside the deployment is
 * always root); failed source ids are stored in both 15- and 18-char forms so
 * reverse(extId) matches regardless. Blank ids skipped.
 */
export function buildFailedByObject(
  allObjectNames: ReadonlyArray<string>,
  failedRows: ReadonlyArray<{ objectApiName: string; sourceId: string }>
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const name of allObjectNames) out.set(name, new Set<string>())
  for (const row of failedRows) {
    let ids = out.get(row.objectApiName)
    if (ids == null) {
      // A failed row for an object outside the provided list still keys an
      // entry (the Apex query returned every Deployment_Object__c row).
      ids = new Set<string>()
      out.set(row.objectApiName, ids)
    }
    const sid = row.sourceId
    if (sid == null || isBlank(sid)) continue
    ids.add(sid)
    if (sid.length === 18) ids.add(sid.substring(0, 15))
  }
  return out
}

/**
 * Classify ONE error-detail line (the loop body of DDQ L2266-2309).
 * `line` is the legacy `extId → CODE: message…` string; a blank line is the
 * caller's concern (Apex `continue`d it — it lands in NEITHER bucket).
 */
export function classifyFailureLine(
  line: string,
  objectName: string,
  isSecondPassContext: boolean,
  failedByObject: ReadonlyMap<string, ReadonlySet<string>>
): 'root' | 'cascade' {
  // Pattern (a): INVALID_FIELD foreign-key, parent in our deployment.
  const fkIdx = line.indexOf(FK_MARKER)
  const entIdx = line.indexOf(ENTITY_MARKER)
  if (fkIdx >= 0 && entIdx > fkIdx) {
    const afterFk = apexTrim(line.substring(fkIdx + FK_MARKER.length))
    // Apex: afterFk.split(' ')[0].replace(',', '').trim() — regex split on a
    // single space; String.replace removes ALL literal commas.
    const failedExtId = apexTrim((splitRegex(afterFk, ' ')[0] ?? '').replaceAll(',', ''))
    const afterEnt = line.substring(entIdx + ENTITY_MARKER.length)
    const entity = apexTrim(splitRegex(afterEnt, ';')[0] ?? '')
    const parentFailedIds = failedByObject.get(entity) // case-SENSITIVE key (Apex Map)
    if (parentFailedIds != null) {
      const parentSourceId = reverse(failedExtId)
      const pid15 = parentSourceId.length === 18 ? parentSourceId.substring(0, 15) : parentSourceId
      if (parentFailedIds.has(parentSourceId) || parentFailedIds.has(pid15)) {
        return 'cascade'
      }
    }
  }

  // Pattern (b): NOT_FOUND on a second-pass update, own record already failed.
  if (isSecondPassContext === true && line.includes('NOT_FOUND')) {
    const arrow = line.indexOf('→')
    if (arrow > 0) {
      const selfExtId = apexTrim(line.substring(0, arrow))
      const selfSourceId = reverse(selfExtId)
      const sid15 = selfSourceId.length === 18 ? selfSourceId.substring(0, 15) : selfSourceId
      const ownFailedIds = failedByObject.get(objectName)
      if (ownFailedIds != null && (ownFailedIds.has(selfSourceId) || ownFailedIds.has(sid15))) {
        return 'cascade'
      }
    }
  }

  return 'root'
}


/**
 * S49 (BUG-10) — pattern (c): REQUIRED_FIELD_MISSING caused by a parent that
 * failed in this same run.
 *
 * THE GAP. Patterns (a) and (b) only recognise a cascade when the API echoes
 * the parent's external Id back (`Foreign key external ID: X … in entity Y`) or
 * when a second-pass update 404s. But when the missing parent's lookup is
 * REQUIRED, `stripMissingParentRefs` removes the reference before the write —
 * that is the whole point of the strip, it keeps the row deployable — and the
 * API then answers `REQUIRED_FIELD_MISSING: Required fields are missing:
 * [OpportunityId]`. That message names the FIELD and nothing else: no ext id,
 * no entity, nothing for patterns (a)/(b) to match. Every one of them fell
 * through to the 'root' default.
 *
 * Live cost (run 6): ONE Opportunity failed on a bad picklist
 * value (BUG-9) and took 9 OpportunityLineItems + 1 OpportunityTeamMember with
 * it. `v_run_counters` reported `records_failed_root = 11, cascade = 0` when
 * the truth was 1 root and 10 cascades — the split exists precisely to say
 * "you have ONE thing to fix", and it said eleven.
 *
 * The strip is the missing link: it knows which parent it removed and why, so
 * a required field that is missing BECAUSE we stripped it, whose parent is in
 * this run's failed set, is a cascade by construction.
 *
 * Conservative on purpose — a stripped parent that is NOT in the failed set
 * (out of scope, or never queried) stays 'root'. Those are real problems the
 * user has to decide about, not noise that clears itself.
 */
export function isCascadeFromStrippedParent(
  errorFields: ReadonlyArray<string>,
  strippedRefs: ReadonlyArray<StrippedRef> | undefined,
  keptFields: ReadonlyArray<GoldenFieldInfo>,
  failedByObject: ReadonlyMap<string, ReadonlySet<string>>
): boolean {
  if (strippedRefs == null || strippedRefs.length === 0) return false
  if (errorFields.length === 0) return false

  for (const fieldName of errorFields) {
    if (fieldName == null || isBlank(fieldName)) continue
    // `OpportunityId` → relationshipName `Opportunity`, via the live describe.
    let rel: string | null = null
    for (const kf of keptFields) {
      if (kf.apiName === fieldName) {
        rel = kf.relationshipName ?? null
        break
      }
    }
    if (rel == null) continue

    for (const ref of strippedRefs) {
      if (ref.relationshipName !== rel) continue
      const parentSourceId = reverse(ref.parentExtId)
      if (isBlank(parentSourceId)) continue
      const pid15 =
        parentSourceId.length === 18 ? parentSourceId.substring(0, 15) : parentSourceId
      const failed = failedByObject.get(ref.refObject)
      if (failed != null && (failed.has(parentSourceId) || failed.has(pid15))) return true
    }
  }
  return false
}

/**
 * The bucket-counting form (the Apex method's exact signature semantics —
 * golden-fixture comparison surface). Blank lines are skipped and contribute
 * to NEITHER bucket (root + cascade == non-blank line count).
 */
export function classifyFailures(
  errorDetails: ReadonlyArray<string> | null | undefined,
  objectName: string,
  isSecondPassContext: boolean,
  failedByObject: ReadonlyMap<string, ReadonlySet<string>>
): { root: number; cascade: number } {
  const out = { root: 0, cascade: 0 }
  if (errorDetails == null || errorDetails.length === 0) return out
  for (const line of errorDetails) {
    if (line == null || isBlank(line)) continue
    out[classifyFailureLine(line, objectName, isSecondPassContext, failedByObject)]++
  }
  return out
}
