/**
 * E4X.3 — Stage 1 of the transform pipeline: a byte-faithful port of the Apex
 * `transformRecordV2` CORE (DataDeploymentService.cls:876-1022), i.e. everything
 * `transformRecordV2` does EXCEPT the two tail blocks that later tasks own:
 *
 *   - required-field synthesis (DDS L1044-1088)          → E4X.4 `synthesis.ts`
 *   - the restricted-picklist / inactive-PBE gates        → E4X.4 `picklistGate.ts` / `pbeGate.ts`
 *   - building the NameMatch / RecordType maps            → E4X.5 `nameMatch.ts`
 *
 * The one tail block that IS stage-1's own — OpportunityLineItem
 * `UnitPrice`/`TotalPrice` mutual-exclusion (DDS L1030-1034) — is kept here
 * because it operates purely on the stage-1 payload with no org I/O and the task
 * spec (deployDesign §7 E4X.3) lists it explicitly.
 *
 * `transformStage1` returns the initial upsert payload — the same map Apex
 * `transformRecordV2` returns before synthesis. `transformRecordV3` (a later
 * task, `pipeline.ts`) will thread this through synthesis → picklist gate → PBE
 * gate. NameMatch resolution is *dispatched* here (reading the pre-built
 * `nameMatchMaps` captured in the context) even though the resolver that BUILDS
 * those maps is E4X.5 — the maps are an input, not a stage-1 responsibility.
 *
 * PARITY-FIRST (transformMap §5): Apex `String ==` is case-INSENSITIVE, so every
 * strategy / object / field-name / status comparison goes through `ciEquals`.
 * Set / Map membership and key lookups stay case-SENSITIVE (Apex `Set.contains`
 * / `Map.get` are case-sensitive, and all keys are canonical describe/API names)
 * — do NOT "fix" that. Source JSON values are copied through untouched (never
 * re-formatted — trap 8); a "more correct" JS-idiomatic rewrite is a bug.
 *
 * Pure: no jsforce, no better-sqlite3. Consumes only the injected context.
 */

import { ciEquals, isBlank, apexStringValueOf } from './apexSemantics'
import { generateExternalId, reverse, EXTERNAL_ID_FIELD } from './sfid'
import { SYSTEM_MANAGED_FIELDS } from '../../../../shared/fieldPolicy'
import type { GoldenContext } from '../golden/fixture'

/**
 * The slice of the captured `TransformContext` (DDS L679-702) that stage 1
 * actually reads. `useBulkFormat` is intentionally absent — the Apex
 * `transformRecordV2` receives it but never reads it (the externalId branch
 * always emits Bulk-CSV dot-notation regardless), so it has no effect on the
 * payload and porting it would imply a behavior it doesn't have.
 * `targetFieldsByName` / `targetPicklistAllowedValues` / `inactivePbeIds` /
 * `pbeSubstitutes` belong to later stages and are excluded here.
 *
 * `GoldenContext` satisfies this structurally, so the golden replay suite
 * (E4X.8) and the eventual live pipeline pass their context straight through.
 */
export type Stage1Context = Pick<
  GoldenContext,
  | 'fields'
  | 'objectName'
  | 'deferredFields'
  | 'mappings'
  | 'nameMatchMaps'
  | 'targetUserId'
  | 'inactiveUserIds'
  // S50 (BUG-14): needed to see the target field's enforced lookup filter.
  | 'targetFieldsByName'
>

/**
 * Port of `transformRecordV2` core (DDS L876-1034, minus synthesis L1044-1088).
 *
 * @param sourceRecord the raw source record as jsforce returns it (keys are the
 *   exact API names from the SELECT; `Id` is capital-I; may carry `attributes`).
 * @param ctx          the captured transform context (source∩target fields,
 *   mappings, pre-built nameMatch maps, target user, inactive users, deferred set).
 * @returns the initial upsert payload map (relationship-shaped `{ Rel: { ExtId } }`
 *   entries for externalId refs). Never null — stage-1 has no skip path.
 */
export function transformStage1(
  sourceRecord: Record<string, unknown>,
  ctx: Stage1Context,
  /** S50 (BUG-14) out-parameter: field names dropped rather than substituted
   *  because the target lookup carries an ENFORCED filter. */
  droppedFilteredLookups: string[] = []
): Record<string, unknown> {
  const target: Record<string, unknown> = {}

  // Case-sensitive membership sets (Apex Set semantics; keys are canonical).
  const deferred = new Set(ctx.deferredFields ?? [])
  const inactiveUsers = new Set(ctx.inactiveUserIds ?? [])

  // Compute this record's own External Id from its source Id (DDS L890-894).
  // Apex guards `sourceId != null` — a null/absent Id yields no ExtId key.
  const rawSourceId = sourceRecord['Id']
  const sourceId = rawSourceId == null ? null : String(rawSourceId)
  if (sourceId != null) {
    target[EXTERNAL_ID_FIELD] = generateExternalId(sourceId)
  }

  for (const fi of ctx.fields) {
    // ─── Field guards (DDS L897-908) ───
    if (!fi.isCreateable) continue
    if (fi.isAutoNumber) continue
    if (fi.isCalculated) continue // formulas + rollup summaries
    if (ciEquals(fi.apiName, 'Id')) continue
    if (ciEquals(fi.apiName, EXTERNAL_ID_FIELD)) continue
    // Belt-and-suspenders (Apex L905): catches CreatedDate/CreatedById/… on orgs
    // where "Set Audit Fields" makes them createable=true. Case-SENSITIVE, like
    // the Apex Set — apiNames are canonical here.
    if (SYSTEM_MANAGED_FIELDS.has(fi.apiName)) continue
    // Deferred fields → skip on the first pass (circular refs, second pass).
    if (deferred.has(fi.apiName)) continue

    // ─── Reference fields → mapping-strategy dispatch (DDS L911-1007) ───
    if (fi.isReference) {
      const refObj = fi.referenceTo != null && fi.referenceTo.length > 0 ? fi.referenceTo[0] : null
      const mapping = ctx.mappings != null ? ctx.mappings[fi.apiName] : undefined

      // Strategy resolution order is load-bearing (DDS L917-933):
      //   RecordTypeId is ALWAYS nameMatch (the mapping UI no longer exposes it —
      //   any saved mapping is ignored); then an explicit mapping; then a
      //   self-lookup falls to skip; then the unmapped default is skip.
      let strategy: string | null
      if (ciEquals(fi.apiName, 'RecordTypeId') && ciEquals(refObj, 'RecordType')) {
        strategy = 'nameMatch'
      } else if (mapping != null) {
        strategy = mapping.strategy
      } else if (ciEquals(refObj, ctx.objectName)) {
        strategy = 'skip' // self-lookup → skip to avoid a circular reference
      } else {
        strategy = 'skip' // default to skip for unmapped fields
      }

      // Source-INDEPENDENT strategies — emit a fixed value regardless of source
      // (the user picked these to OVERRIDE the source value / fill a blank).
      if (ciEquals(strategy, 'customId')) {
        if (mapping != null && !isBlank(mapping.customValue)) {
          target[fi.apiName] = mapping.customValue
        }
        continue
      }
      if (ciEquals(strategy, 'setToMe')) {
        // Resolves to the TARGET org's connected user Id. If unresolved, omit
        // the field rather than baking in the wrong user (DDS L947-949).
        if (!isBlank(ctx.targetUserId)) {
          target[fi.apiName] = ctx.targetUserId
        }
        continue
      }

      // Source-DEPENDENT strategies — need a non-null / non-blank source value.
      const rawLookupId = sourceRecord[fi.apiName]
      if (rawLookupId == null) continue
      const sourceLookupId = apexStringValueOf(rawLookupId)
      if (isBlank(sourceLookupId)) continue

      if (ciEquals(strategy, 'externalId')) {
        // Need a relationship name to build the ExtId reference (DDS L961).
        if (isBlank(fi.relationshipName)) continue
        // Parent ExtId from the raw lookup Id; blank → fall back to reversing it
        // (DDS L965-968). `generateExternalId` never returns blank for a non-null
        // input, so the fallback is defensive parity, not a live path.
        let parentExtId = generateExternalId(sourceLookupId)
        if (isBlank(parentExtId)) {
          parentExtId = reverse(sourceLookupId)
        }
        // relationshipName is non-blank here (guarded above).
        target[fi.relationshipName as string] = { [EXTERNAL_ID_FIELD]: parentExtId }
      } else if (ciEquals(strategy, 'nameMatch')) {
        // Look up the target Id via the pre-built name-match map (DDS L974-985).
        // A no-match DROPS the field: for RecordTypeId this lets Salesforce
        // auto-assign the user's default RT instead of failing on an invalid Id.
        if (refObj != null && ctx.nameMatchMaps != null && ctx.nameMatchMaps[refObj] != null) {
          const targetId = ctx.nameMatchMaps[refObj][sourceLookupId]
          if (targetId != null) {
            target[fi.apiName] = targetId
          }
        }
      } else if (ciEquals(strategy, 'directId')) {
        // Inactive-owner substitution (DDS L996-1003): a directId to a User who
        // is inactive on target → swap in the connected user so the row doesn't
        // fail INACTIVE_OWNER_OR_USER; otherwise send the raw value verbatim.
        if (
          ciEquals(refObj, 'User') &&
          inactiveUsers.has(sourceLookupId) &&
          !isBlank(ctx.targetUserId)
        ) {
          // S50 (BUG-14): NOT into a lookup the platform filters on write.
          //
          // Live: run 11 (express scripts) died on its ROOT Account with
          // `FIELD_FILTER_VALIDATION_EXCEPTION: The Technical Account Manager
          // is not the correct type of User for this field`. The source TAM is
          // inactive, so this branch swapped in the connected user — who does
          // not satisfy that field's enforced lookup filter. The substitution
          // exists to avoid one hard failure and manufactured another, on the
          // root record, taking the whole deployment with it.
          //
          // Dropping is right rather than merely safe: the substitute is
          // FALSE DATA either way ("Jack is the TAM" is not true), so a blank
          // field is strictly more honest than a wrong one. Only ENFORCED
          // filters are dropped — `optionalFilter` ones are UI-only and the
          // API accepts anything, so those keep substituting as before.
          // Measured on sb1_830: exactly 2 enforced filtered User lookups
          // exist across all 11 deployed objects (Account.Executive_Sponsor__c
          // and Account.Technical_Account_Manager__c), and both currently HARD
          // FAIL — so this can only improve on the status quo.
          if (ctx.targetFieldsByName?.[fi.apiName]?.hasEnforcedLookupFilter === true) {
            droppedFilteredLookups.push(fi.apiName)
          } else {
            target[fi.apiName] = ctx.targetUserId
          }
        } else {
          target[fi.apiName] = sourceLookupId
        }
      }
      // 'skip' (and any unknown strategy) → do nothing.
      continue
    }

    // ─── Regular field → copy iff non-null and non-blank (DDS L1010-1021) ───
    const val = sourceRecord[fi.apiName]
    if (val == null) continue
    if (typeof val === 'string' && isBlank(val)) continue

    // Contract Status override — must insert as Draft, activate later (L1016).
    if (ciEquals(ctx.objectName, 'Contract') && ciEquals(fi.apiName, 'Status')) {
      target['Status'] = 'Draft'
      continue
    }

    target[fi.apiName] = val
  }

  // OpportunityLineItem: `UnitPrice` and `TotalPrice` are mutually exclusive on
  // insert/upsert (FIELD_INTEGRITY_EXCEPTION). Prefer UnitPrice; drop TotalPrice
  // when both are present (DDS L1030-1034). Case-SENSITIVE key checks, matching
  // Apex `Map.containsKey` — the keys were written as the canonical field names.
  if (
    ciEquals(ctx.objectName, 'OpportunityLineItem') &&
    Object.prototype.hasOwnProperty.call(target, 'UnitPrice') &&
    Object.prototype.hasOwnProperty.call(target, 'TotalPrice')
  ) {
    delete target['TotalPrice']
  }

  return target
}

// Re-export the context/field schema so callers (tests, the eventual pipeline)
// have one import surface for stage-1's inputs.
export type { GoldenContext, GoldenFieldInfo } from '../golden/fixture'
