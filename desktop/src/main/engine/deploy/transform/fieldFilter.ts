/**
 * E4X.6 — field intersection filter. Byte-faithful port of the source∩target
 * field-drop loop in `DataDeploymentQueueable.executeNormalModeV2`
 * (DataDeploymentService line-cite DDQ L1335-1410).
 *
 * Produces the `fields` list the transform iterates (SOURCE describe entries that
 * survive) + the `targetByName` lookup synthesis uses + a byte-exact drop log.
 * Drop precedence (order is load-bearing — first matching reason wins):
 *   1. user-excluded (Org-Settings exclusion set) — SILENT (no log line)
 *   2. SYSTEM_MANAGED_FIELDS — SILENT
 *   3. not present on target                              → "(not on target)"
 *   4. read-only on target (createable=false/formula/auto)→ "(read-only on target: …)"
 *   5. foreign external-Id field (not OUR ExtId)          → "(foreign external Id; …)"
 *   6. user-excluded ExtId on source                      → "(user-excluded on source …)"
 *   7. user-excluded ExtId on target                      → "(user-excluded on target …)"
 * Everything else is kept (the SOURCE FieldInfo is pushed).
 *
 * PARITY-FIRST: `ciEquals` for the two literal `==`/`!=` compares
 * (`IsPersonAccount`, the ExtId-field name); exclusion / SYSTEM_MANAGED / target
 * lookups stay case-SENSITIVE (Apex Set/Map). Log strings are byte-exact.
 *
 * Pure: no jsforce, no better-sqlite3.
 */

import { ciEquals } from './apexSemantics'
import { EXTERNAL_ID_FIELD } from './sfid'
import { SYSTEM_MANAGED_FIELDS } from '../../../../shared/fieldPolicy'
import type { GoldenFieldInfo } from '../golden/fixture'

/**
 * The describe projection the deploy engine reads: everything the transform needs
 * (`GoldenFieldInfo`) plus the picklist values the prefetch's restricted-picklist
 * map needs (captured separately into the transform context, so they're absent
 * from `GoldenFieldInfo` itself). The live describe adapter (E4E) produces these.
 */
export interface DescribeField extends GoldenFieldInfo {
  picklistValues: string[] | null
  /**
   * S49 (BUG-9): the CONTROLLING field of a dependent picklist, straight from
   * `describe`. The UI-API picklist endpoint reports controller VALUES but
   * never names the controlling field, so this is the only way to know which
   * payload key holds it. Optional — synthetic describes (junctionDetector)
   * and older fixtures omit it, which reads as "not dependent".
   */
  controllerName?: string | null
}

export interface FieldFilterInput {
  /** Full SOURCE describe (`allFields`). */
  sourceFields: ReadonlyArray<DescribeField>
  /** Full TARGET describe (`targetAllFields`). */
  targetFields: ReadonlyArray<DescribeField>
  /** User-excluded fields (Deployment_Object__c excluded list) — silent drop. */
  excludedFieldSet?: Iterable<string>
  /** Per-org user-excluded ExtId fields (Org Settings), source side. */
  sourceUserExcludedExtIds?: Iterable<string>
  /** Per-org user-excluded ExtId fields (Org Settings), target side. */
  targetUserExcludedExtIds?: Iterable<string>
}

export interface FieldFilterResult {
  /** The kept SOURCE fields, in source order — feeds the transform's `fields`. */
  fields: DescribeField[]
  /** Target describe keyed by API name — feeds `targetFieldsByName` (synthesis). */
  targetByName: Record<string, DescribeField>
  /** Byte-exact drop reasons, in source order — the observability log. */
  droppedFieldNames: string[]
  /** Whether the FULL source describe has `IsPersonAccount` (drives the PA filter). */
  sourceHasIsPersonAccount: boolean
}

export function filterFields(input: FieldFilterInput): FieldFilterResult {
  // Null-prototype so a source field named like an Object.prototype member
  // ('toString', 'constructor', …) resolves to `undefined` — matching Apex
  // `Map.get` for ALL keys (a plain `{}` would leak inherited members and
  // misclassify such a field's drop reason). SF API names can't actually be
  // these, but parity-faithful lookup shouldn't depend on that.
  const targetByName: Record<string, DescribeField> = Object.create(null)
  for (const tfi of input.targetFields) targetByName[tfi.apiName] = tfi // last-wins (Apex Map.put)

  // IsPersonAccount detection runs against the FULL source describe (the field is
  // non-createable, so the intersection below would drop it — DDQ L1329-1341).
  let sourceHasIsPersonAccount = false
  for (const fi of input.sourceFields) {
    if (ciEquals(fi.apiName, 'IsPersonAccount')) {
      sourceHasIsPersonAccount = true
      break
    }
  }

  const excluded = new Set(input.excludedFieldSet ?? [])
  const srcExcl = new Set(input.sourceUserExcludedExtIds ?? [])
  const tgtExcl = new Set(input.targetUserExcludedExtIds ?? [])

  const fields: DescribeField[] = []
  const droppedFieldNames: string[] = []

  for (const fi of input.sourceFields) {
    if (excluded.has(fi.apiName)) continue // silent — user-excluded
    if (SYSTEM_MANAGED_FIELDS.has(fi.apiName)) continue // silent — Id/audit/etc.

    const tfi = targetByName[fi.apiName]
    if (tfi == null) {
      droppedFieldNames.push(fi.apiName + ' (not on target)')
      continue
    }
    if (!tfi.isCreateable || tfi.isCalculated || tfi.isAutoNumber) {
      const reason = tfi.isCalculated
        ? 'formula/rollup'
        : tfi.isAutoNumber
          ? 'auto-number'
          : 'createable=false'
      droppedFieldNames.push(fi.apiName + ' (read-only on target: ' + reason + ')')
      continue
    }
    // Foreign external-Id fields (Gearset etc.) would DUPLICATE_VALUE on re-deploy;
    // our own ExtId is the upsert key and is allowed through.
    if (tfi.isExternalId && !ciEquals(fi.apiName, EXTERNAL_ID_FIELD)) {
      droppedFieldNames.push(fi.apiName + ' (foreign external Id; would collide on re-deploy)')
      continue
    }
    if (srcExcl.has(fi.apiName)) {
      droppedFieldNames.push(fi.apiName + ' (user-excluded on source via Org Settings)')
      continue
    }
    if (tgtExcl.has(fi.apiName)) {
      droppedFieldNames.push(fi.apiName + ' (user-excluded on target via Org Settings)')
      continue
    }
    fields.push(fi)
  }

  return { fields, targetByName, droppedFieldNames, sourceHasIsPersonAccount }
}
