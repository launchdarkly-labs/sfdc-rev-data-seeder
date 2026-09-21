/**
 * E2.6 — plan freeze (deployDesign §1.2). At "Start Deploy" this consumes the
 * persisted analysis result + the wizard config and produces ONE immutable
 * `DeployPlan`. The orchestrator reads ONLY the frozen plan; wizard edits after
 * freeze require a re-freeze (new version, new hash — persisted via
 * DeployStore.savePlan).
 *
 * Everything the frozen Apex engine recomputed PER OBJECT AT DEPLOY TIME inside
 * `executeNormalModeV2` happens HERE, ONCE (transformMap items, with DDQ cites):
 *   A5  field intersection filter (L1367-1410)          → filterFields (E4X.6)
 *   A7  OLI PricebookEntryId null/skip → directId       (L1425-1439)
 *   A9  skip → externalId promotion for in-deployment refs w/ target ExtId
 *       (stale-template repair; excludes RecordTypeId; EXPLICIT skip only)
 *       (L1470-1487)
 *   A10 externalId → skip downgrade when the referenced object lacks the ExtId
 *       field on target (L1490-1504)
 *   A12 deploy-time deferred-field recompute: forward/self in-deployment refs
 *       under externalId/directId/null get deferred; Has_Circular_References
 *       forced true when anything was added (L1534-1583); deferred fields
 *       mapped 'skip' are pruned first (L1509-1517)
 * Repair ORDER is load-bearing: A7 → A9 → A10 (A9 may promote to externalId
 * what A10 must then re-skip when the target lacks the ExtId field).
 *
 * DESIGN-AUTHORIZED DIVERGENCES from the frozen Apex (deployDesign §1.2):
 *   - Each repair becomes a PLAN-LEVEL WARNING instead of a runtime Info log
 *     (A10 was fully silent in Apex — here it warns).
 *   - A consistency validation runs after the repairs and REFUSES to freeze
 *     (PlanFreezeError) instead of failing later at deploy time: duplicate
 *     sort orders, and deferred fields the analysis carried that the CURRENT
 *     source describe no longer supports (not a reference / no longer exists
 *     — a STALE plan; re-running analysis is the honest remedy for those).
 *   - EXCLUDED DEFERRED LOOKUPS (S46, deployDesign §1.2 amendment — "mode A"):
 *     analysis computes the deferred set over the RAW describe and never sees
 *     the Fields-step exclusions (`analysis.ts` — parity with DAQ, which read
 *     no exclusions either), so a deferred lookup can legitimately be outside
 *     the A5 intersection: excluded by namespace / by the user / unpopulated,
 *     or dropped because the target lacks it. The frozen Apex second pass
 *     read the FULL describe and would have PATCHed such a field anyway
 *     (executeSecondPassV2 :535-536, :559-568, :643-652) — writing a field
 *     the user excluded. The desktop HONORS THE EXCLUSION instead: the field
 *     is dropped from the frozen deferred set with a plan-level warning that
 *     names the reason and the two remedies (un-exclude on Fields / Skip on
 *     Mappings). `hasCircularReference` is left as analysis set it (the
 *     second pass over an empty deferred set is a no-op, DDQ L364-368).
 *     Deferred fields whose EFFECTIVE strategy resolves 'skip' are still
 *     pruned SILENTLY first (Apex pruned those too — see the prune comment).
 *     E4V.2's deferred-set diff needs an allowlist entry for this class.
 *
 * Mapping resolution: the desktop wizard stores SPARSE overrides
 * (config.mappings) — defaults + locks are derived from shared/mappingPolicy
 * (the single source; never re-derive elsewhere). The Apex-era LWC saved every
 * strategy explicitly into Field_Mappings__c, so resolving
 * `locked ? 'skip' : (override ?? default)` here reproduces exactly what the
 * Apex parseMappings saw. Consequence worth naming: a SELF-reference resolves
 * to the locked default 'skip', A9 then promotes it to externalId (self is
 * in-deployment), and A12 defers it — the engine's "self-refs are DEFERRED,
 * not skipped" behavior falls out of the same repair chain the Apex ran.
 *
 * In-deployment membership: policy defaults use config.selectedObjects (the
 * wizard's scope — mirrors StepMappings); A9/A12's sortOrderByObject uses ALL
 * plan objects including auto-injected junctions (Apex built it from every
 * Deployment_Object__c row). They can diverge only for refs to junction-only
 * objects (none in practice).
 *
 * Junction objects (isJunction) bypass A5–A12 entirely — the Apex junction
 * path (`executeJunctionDeploy`) never ran the normal-mode context build.
 *
 * Pure: no jsforce, no better-sqlite3, no clock. Hashing lives with the caller
 * (services) — this module only provides the deterministic serialization.
 */

import type { PlannedObject } from '../analysis'
import type { WizardConfig } from '../../../shared/wizard'
import {
  defaultMatchField,
  isHiddenRefField,
  effectiveStrategy,
  type TargetKeyInfo
} from '../../../shared/mappingPolicy'
import { fieldExclusion, fieldNamespace } from '../../../shared/fieldPolicy'
import { requiredReferenceWarnings } from '../../../shared/scopeAdvisor'
import { ciEquals } from './transform/apexSemantics'
import { filterFields, type DescribeField } from './transform/fieldFilter'
import { EXTERNAL_ID_FIELD } from './transform/sfid'
import { isKnownJunction } from '../junctionDetector'
import { EXT_ID_REFUSAL_MARKER } from '../../../shared/recoveryCopy'

/** Resolved mapping — shape-compatible with the transform's GoldenMapping. */
export interface FrozenMapping {
  strategy: string
  matchField: string | null
  customValue: string | null
}

export interface FreezeObjectInput {
  planned: PlannedObject
  /** FULL source describe (pre-intersection). */
  sourceFields: DescribeField[]
  /** FULL target describe. */
  targetFields: DescribeField[]
  /** Fields found populated in the source sample (populated-only support);
   *  null/omitted = probe not run — populated-only then excludes nothing,
   *  matching fieldExclusion's own null semantics. */
  populatedFields?: string[] | null
}

export interface FreezeInput {
  objects: FreezeObjectInput[]
  config: WizardConfig
  /**
   * ORG-WIDE set of target objects carrying the ExtId field — the Apex oracle
   * (SchemaService.batchCheckRdsField, one Tooling CustomField query with NO
   * object filter). NOT the readiness/5B.4 in-scope subset: A10 consults this
   * for externalId refs pointing at OUT-of-deployment objects too (a user can
   * legitimately choose externalId for a NAME_MATCH/DIRECT_ID-default object),
   * and a scope-limited set would over-downgrade those to skip. The Start
   * Deploy binding must fetch it org-wide (E2.6 review finding).
   */
  targetHasExtId: ReadonlySet<string>
  /**
   * S57 (B1): target objects OUTSIDE the plan that already hold at least one
   * RDS-keyed row (probed by the deploy handler with `probeKeyedRows`). With
   * `targetHasExtId` this is the `TargetKeyInfo` the Mappings step resolved
   * against, so the frozen strategy equals what the operator saw. Optional —
   * absent means "nothing known" (the pre-S57 lock on every out-of-scope ref).
   */
  targetKeyedRows?: ReadonlySet<string>
  /** Per-org user-excluded ExtId fields (Org Settings), source/target side. */
  sourceUserExcludedExtIds?: Iterable<string>
  targetUserExcludedExtIds?: Iterable<string>
}

export interface FrozenObjectPlan {
  objectName: string
  sortOrder: number
  hasCircularReference: boolean
  /** Frozen deferred set: (analysis ∪ A12 recompute) minus skip-mapped. */
  deferredFields: string[]
  scope: PlannedObject['scope']
  scopedFilterDisplay: string | null
  recordCount: number
  apiStrategy: string
  gatingTier: string | null
  requiresTriggerBypass: boolean
  requiresAutomationDisable: boolean
  restPageSize: number | null
  recommendedBatchSize: number
  isJunction: boolean
  junctionParents: string[] | null
  junctionParentFields: string[] | null
  /** Kept field API names (A5 survivors), source describe order. */
  fields: string[]
  /** Byte-exact A5 drop reasons (observability; the plan records WHY). */
  droppedFields: string[]
  /** Resolved reference mappings post A7/A9/A10 (RecordTypeId stays hidden —
   *  the transform force-resolves it via nameMatch regardless). */
  mappings: Record<string, FrozenMapping>
}

export interface DeployPlan {
  /** sortOrder ascending — the deploy walk order. */
  objects: FrozenObjectPlan[]
  /** Repair + recompute warnings (A7/A9/A10/A12), in processing order. */
  warnings: string[]
  totalObjects: number
  totalRecords: number
}

/** Freeze refused — the plan is inconsistent and deploying it would misbehave. */
export class PlanFreezeError extends Error {
  readonly errors: string[]
  constructor(errors: string[]) {
    super(`Plan freeze refused: ${errors.join('; ')}`)
    this.name = 'PlanFreezeError'
    this.errors = errors
  }
}

export function freezePlan(input: FreezeInput): DeployPlan {
  const { config, targetHasExtId } = input
  const warnings: string[] = []
  const errors: string[] = []
  // S57 (B1): the same two facts the wizard resolved against.
  const targetKeys: TargetKeyInfo = {
    hasField: targetHasExtId,
    keyedRows: input.targetKeyedRows ?? new Set<string>()
  }

  // Apex 2b: Sort_Order for EVERY object in the deployment (junctions included).
  const sortOrderByObject = new Map<string, number>()
  for (const o of input.objects) {
    sortOrderByObject.set(o.planned.objectName, o.planned.sortOrder)
  }

  // Process in deploy order so warnings read in walk order.
  const ordered = [...input.objects].sort((a, b) => a.planned.sortOrder - b.planned.sortOrder)

  const frozenObjects: FrozenObjectPlan[] = []
  for (const obj of ordered) {
    const p = obj.planned
    const objectName = p.objectName

    if (p.isJunction) {
      // Junction path: no mappings, no deferred handling — the junction executor
      // resolves both parents by relationship traversal, so reference mappings
      // are meaningless here.
      //
      // S49 FIX (BUG-7): `fields` used to be hardcoded EMPTY, which forced
      // junction.ts onto a hardcoded `Role, IsPrimary` list and silently
      // dropped everything else — one account's 366 OCRs carried 329
      // `NektarActions__c` values on the source and 0 on the target. Junctions
      // still bypass A6-A12, but they DO get the A5 field filter now
      // (fieldPolicy exclusions + source∩target intersection), so the executor
      // knows the real writable field set. Parent FKs and Id are excluded by
      // the executor itself, which handles them via traversal.
      const junctionExcluded: string[] = []
      const junctionPopulated = obj.populatedFields != null ? new Set(obj.populatedFields) : null
      for (const fi of obj.sourceFields) {
        if (fieldExclusion(fi.apiName, objectName, config, junctionPopulated).excluded) {
          junctionExcluded.push(fi.apiName)
        }
      }
      const junctionFiltered = filterFields({
        sourceFields: obj.sourceFields,
        targetFields: obj.targetFields,
        excludedFieldSet: junctionExcluded,
        sourceUserExcludedExtIds: input.sourceUserExcludedExtIds,
        targetUserExcludedExtIds: input.targetUserExcludedExtIds
      })
      frozenObjects.push({
        ...carryPlanned(p),
        fields: junctionFiltered.fields.map((f) => f.apiName),
        droppedFields: junctionFiltered.droppedFieldNames,
        mappings: {}
      })
      continue
    }

    // ── S53 (item 3): the object's OWN upsert key must be usable on target ──
    // Every non-junction record is written by `PATCH …/{object}/{ExtId}`, so an
    // object whose target describe has no usable ExtId field fails 100% of its
    // records with "Field name provided, Data_Deployment_External_Id__c does not
    // match an External ID for …" — one refusal here beats a whole-object
    // wipeout there. The Readiness step only WARNED ("you can continue, but the
    // deploy will require them"), and `targetHasExtId` was consulted solely for
    // REFERENCE mappings (A9/A10), never for the object's own key.
    //
    // The DESCRIBE is the truth for the running user: a field created through the
    // Metadata API is invisible to describe until FLS is granted, and the upsert
    // fails the same way. The org-wide Tooling set (`targetHasExtId`) only words
    // the message — it sees the field regardless of FLS, so "Tooling yes,
    // describe no" is exactly the FLS case (S46: RDS_Deployment_Access).
    const ownKeyRefusal = missingOwnExtIdError(objectName, obj.targetFields, targetHasExtId)
    if (ownKeyRefusal != null) errors.push(ownKeyRefusal)

    // ── A5: effective exclusions (single source: fieldPolicy) + intersection ──
    // fieldExclusion is called WITHOUT ref context: skippedRef is a mapping-layer
    // outcome (the transform strips by strategy), not a field exclusion — the
    // Apex Excluded_Fields__c never carried strategy-skips either.
    const populated = obj.populatedFields != null ? new Set(obj.populatedFields) : null
    const excludedFieldSet: string[] = []
    for (const fi of obj.sourceFields) {
      if (fieldExclusion(fi.apiName, objectName, config, populated).excluded) {
        excludedFieldSet.push(fi.apiName)
      }
    }
    const filtered = filterFields({
      sourceFields: obj.sourceFields,
      targetFields: obj.targetFields,
      excludedFieldSet,
      sourceUserExcludedExtIds: input.sourceUserExcludedExtIds,
      targetUserExcludedExtIds: input.targetUserExcludedExtIds
    })
    const fields = filtered.fields

    // ── Resolve the full effective mapping set (what Apex parseMappings saw) ──
    const mappings: Record<string, FrozenMapping> = {}
    for (const fi of fields) {
      if (!fi.isReference || fi.referenceTo.length === 0) continue
      const refTo = fi.referenceTo[0]!
      if (isHiddenRefField(fi.apiName, refTo)) continue // RecordTypeId — engine force-nameMatches
      const override = config.mappings[objectName]?.[fi.apiName]
      // S57 (B1): one policy call — identical to the Mappings row and the Fields step.
      const strategy = effectiveStrategy(
        refTo,
        objectName,
        config.selectedObjects,
        override?.strategy,
        targetKeys
      )
      mappings[fi.apiName] = {
        strategy,
        matchField: ciEquals(strategy, 'nameMatch')
          ? (override?.matchField ?? defaultMatchField(refTo))
          : null,
        customValue: ciEquals(strategy, 'customId') ? (override?.customValue ?? null) : null
      }
    }

    // ── A7: OLI.PricebookEntryId null/skip → directId (DDQ L1425-1439) ──
    if (ciEquals(objectName, 'OpportunityLineItem')) {
      const pbeMap = mappings['PricebookEntryId']
      const prev = pbeMap == null ? '(none)' : pbeMap.strategy
      if (pbeMap == null || pbeMap.strategy == null || ciEquals(pbeMap.strategy, 'skip')) {
        mappings['PricebookEntryId'] = {
          strategy: 'directId',
          matchField: null,
          customValue: null
        }
        warnings.push(
          'OLI.PricebookEntryId mapping promoted ' +
            prev +
            " → directId (field is required on insert and upsert PATCH validates the target's " +
            'existing PBE — skip silently fails). The inactive-PBE gate will substitute ' +
            'or skip rows whose source PBE has no active equivalent on target.'
        )
      }
    }

    // ── A9: skip → externalId promotion (DDQ L1470-1487) ──
    const promotedRefs: string[] = []
    for (const fi of fields) {
      if (!fi.isReference || fi.referenceTo.length === 0) continue
      if (ciEquals(fi.apiName, 'RecordTypeId')) continue
      const refObj = fi.referenceTo[0]!
      if (!sortOrderByObject.has(refObj)) continue // not in this deployment
      if (!targetHasExtId.has(refObj)) continue // can't upsert-by-ExtId on target
      const cfg = mappings[fi.apiName]
      if (cfg != null && ciEquals(cfg.strategy, 'skip')) {
        cfg.strategy = 'externalId'
        cfg.matchField = null
        promotedRefs.push(fi.apiName + ' → ' + refObj)
      }
    }
    if (promotedRefs.length > 0) {
      warnings.push(
        'Auto-promoted ' +
          promotedRefs.length +
          ' reference field(s) from skip → externalId on ' +
          objectName +
          ' (referenced object is in this deployment and has the External ID field on target; ' +
          'a stale template left them on skip): ' +
          promotedRefs.join(', ') +
          '. Forward/self references resolve in the second pass.'
      )
    }

    // ── A10: externalId → skip downgrade (DDQ L1490-1504; silent in Apex) ──
    for (const fieldName of Object.keys(mappings)) {
      const cfg = mappings[fieldName]
      if (cfg == null || !ciEquals(cfg.strategy, 'externalId')) continue
      for (const fi of fields) {
        if (ciEquals(fi.apiName, fieldName) && fi.isReference && fi.referenceTo.length > 0) {
          const refObj = fi.referenceTo[0]!
          if (!targetHasExtId.has(refObj)) {
            cfg.strategy = 'skip'
            warnings.push(
              objectName +
                '.' +
                fieldName +
                ' mapping downgraded externalId → skip (referenced object ' +
                refObj +
                ' lacks the External ID field on target).'
            )
          }
          break
        }
      }
    }

    // ── S57 (FB-3): a REQUIRED reference that resolves to skip fails every row ──
    // Said here (job log) and at analysis (Plan step) from the same helper, so
    // the two never disagree. Run 24: CampaignMember.CampaignId, 228/228.
    warnings.push(
      ...requiredReferenceWarnings({
        objectName,
        sourceFields: obj.sourceFields,
        targetFields: obj.targetFields,
        selectedObjects: config.selectedObjects,
        overrides: config.mappings[objectName],
        targetKeys
      })
    )

    // ── Deferred set: prune skip-mapped (DDQ L1509-1517), then A12 recompute ──
    // The Apex prune consulted parseMappings, whose DOMAIN was every reference
    // field the LWC saw (the raw intersection describe) — INDEPENDENT of the
    // A5 exclusion filter. A deferred field that A5 dropped here (excluded /
    // unpopulated / not-on-target) therefore still resolved its saved strategy
    // in Apex — locked self-refs and out-of-scope refs resolved 'skip' and
    // were PRUNED, and the deploy ran cleanly with the field simply not
    // copied. So when the resolved `mappings` (A5 survivors only) has no
    // entry, resolve the effective strategy from the FULL source describe
    // before deciding to keep (E2.6 review finding — without this, freeze
    // refused plans Apex deployed: e.g. populated-only dropping the deferred
    // Account.ParentId self-ref was a non-recoverable dead-end).
    const sourceByName = new Map(obj.sourceFields.map((f) => [f.apiName, f]))
    const analysisDeferred = new Set(p.deferredFields)
    const deferred = new Set<string>()
    for (const df of analysisDeferred) {
      const cfg = mappings[df]
      let strategy: string | null = cfg?.strategy ?? null
      if (cfg == null) {
        const fi = sourceByName.get(df)
        if (fi != null && fi.isReference && fi.referenceTo.length > 0) {
          const refTo = fi.referenceTo[0]!
          strategy = effectiveStrategy(
            refTo,
            objectName,
            config.selectedObjects,
            config.mappings[objectName]?.[df]?.strategy,
            targetKeys
          )
        }
      }
      if (strategy == null || !ciEquals(strategy, 'skip')) deferred.add(df)
    }

    let hasCircularReference = p.hasCircularReference
    const currentSortOrder = sortOrderByObject.get(objectName)
    if (currentSortOrder != null) {
      const dynamicDeferred = new Set<string>()
      for (const fi of fields) {
        if (!fi.isReference || fi.referenceTo.length === 0) continue
        const refTo = fi.referenceTo[0]!
        if (!sortOrderByObject.has(refTo)) continue
        const refSortOrder = sortOrderByObject.get(refTo)!
        const strat = mappings[fi.apiName]?.strategy ?? null
        // Defer for externalId (parent ExtId must exist on target) and directId
        // (a forward in-deployment target row won't exist yet); null defaults to
        // externalId in the transform, so it defers too (DDQ L1552-1560).
        if (strat != null && !ciEquals(strat, 'externalId') && !ciEquals(strat, 'directId')) {
          continue
        }
        const isForward = refSortOrder > currentSortOrder
        const isSelfRef = ciEquals(refTo, objectName)
        if (isForward || isSelfRef) dynamicDeferred.add(fi.apiName)
      }
      if (dynamicDeferred.size > 0) {
        const beforeSize = deferred.size
        for (const f of dynamicDeferred) deferred.add(f)
        if (deferred.size > beforeSize) {
          const newlyDeferred = [...dynamicDeferred].filter((f) => !analysisDeferred.has(f))
          hasCircularReference = true
          warnings.push(
            'Deferred-field recompute added ' +
              newlyDeferred.length +
              ' field(s) to ' +
              objectName +
              ' (forward/self refs missed by analysis): ' +
              newlyDeferred.join(', ')
          )
        }
      }
    }

    // ── Consistency validation (design-authorized refusal, §1.2 point 3 +
    //    the S46 mode-A amendment). Four-way classification per deferred field:
    //      kept + reference            → keep (the normal case)
    //      kept + NOT a reference      → refuse (stale plan; re-run analysis)
    //      not kept, on source, ref    → DROP + warn (excluded / not deployable)
    //      not on the source describe  → refuse (stale plan; re-run analysis)
    const keptByName = new Map(fields.map((f) => [f.apiName, f]))
    for (const df of [...deferred]) {
      const kept = keptByName.get(df)
      if (kept != null) {
        if (!kept.isReference) {
          errors.push(
            `${objectName}: deferred field ${df} is not a reference field on the current source ` +
              'describe (stale plan) — re-run analysis before deploying'
          )
        }
        continue
      }
      const onSource = sourceByName.get(df)
      if (onSource == null || !onSource.isReference) {
        errors.push(
          `${objectName}: deferred field ${df} ` +
            (onSource == null
              ? 'no longer exists on the source object'
              : 'is not a reference field on the current source describe') +
            ' (stale plan) — re-run analysis before deploying'
        )
        continue
      }
      // Mode A: honor the exclusion. Reason precedence mirrors A5 itself —
      // a policy exclusion (fieldPolicy) first, else the filterFields drop.
      deferred.delete(df)
      warnings.push(
        excludedDeferredWarning(objectName, df, config, populated, filtered.droppedFieldNames)
      )
    }

    frozenObjects.push({
      ...carryPlanned(p),
      hasCircularReference,
      deferredFields: [...deferred].sort(),
      fields: fields.map((f) => f.apiName),
      droppedFields: filtered.droppedFieldNames,
      mappings
    })
  }

  // ── Cross-object validation ──
  //
  // S49 GUARD (BUG-4): a known junction MUST be planned as a junction. A
  // junction cannot host Data_Deployment_External_Id__c, so planning one as an
  // ordinary object routes it to the ExtId-upsert path where 100% of its
  // records fail ('Field name provided, Data_Deployment_External_Id__c does not
  // match an External ID for OpportunityContactRole' — all 366 rows of
  // deployment 7). Catching it here converts a whole-object silent-ish wipeout
  // into one refusal before anything is written.
  for (const o of frozenObjects) {
    if (isKnownJunction(o.objectName) && !o.isJunction) {
      errors.push(
        `${o.objectName} is a known junction object but was planned as a non-junction — it cannot ` +
          `host ${EXTERNAL_ID_FIELD} and every record would fail on upsert; re-run analysis`
      )
    }
  }

  const seenOrders = new Map<number, string>()
  for (const o of frozenObjects) {
    const prior = seenOrders.get(o.sortOrder)
    if (prior !== undefined) {
      errors.push(
        `duplicate sort order ${o.sortOrder} (${prior}, ${o.objectName}) — the deploy walk order is ambiguous`
      )
    }
    seenOrders.set(o.sortOrder, o.objectName)
  }

  if (errors.length > 0) throw new PlanFreezeError(errors)

  return {
    objects: frozenObjects,
    warnings,
    totalObjects: frozenObjects.length,
    totalRecords: frozenObjects.reduce((sum, o) => sum + o.recordCount, 0)
  }
}

/**
 * The mode-A warning for a deferred lookup outside the deployable intersection
 * (S46). Names WHY it is not deployable and, when the user can change that,
 * the two real remedies. Text is conditional on the reason so a target-side
 * drop ("not on target") never tells the user to un-exclude something.
 */
function excludedDeferredWarning(
  objectName: string,
  fieldName: string,
  config: WizardConfig,
  populated: ReadonlySet<string> | null,
  droppedFieldNames: readonly string[]
): string {
  const exclusion = fieldExclusion(fieldName, objectName, config, populated)
  let why: string
  let remedy: string
  if (exclusion.excluded) {
    switch (exclusion.reason) {
      case 'namespace':
        why = `excluded with the ${fieldNamespace(fieldName) ?? '(none)'} namespace on the Fields step`
        break
      case 'unpopulated':
        why = 'excluded as unpopulated in the source sample (populated-only)'
        break
      default:
        why = 'excluded on the Fields step'
    }
    remedy =
      'To copy it, un-exclude it on the Fields step; to silence this warning, set it to Skip on the Mappings step.'
  } else {
    const dropped = droppedFieldNames.find((d) => d.startsWith(fieldName + ' ('))
    const reason = dropped == null ? null : dropped.slice(fieldName.length + 2, -1)
    why = reason == null ? 'not in the deployable field intersection' : reason
    remedy = 'Nothing to change — the field cannot be written on the target.'
  }
  return (
    `${objectName}.${fieldName}: analysis deferred this lookup to the second pass but it is ${why} ` +
    '— dropped from the second pass, so the reference stays empty on the target. ' +
    remedy
  )
}

/**
 * S53 (item 3) — the refusal text for a non-junction object whose target
 * describe does not expose a usable upsert key, or null when it does. Exported
 * so the renderer's pre-run banner can recognise the class by its wording
 * (`EXT_ID_REFUSAL_MARKER`) and link to the Readiness step.
 */
export { EXT_ID_REFUSAL_MARKER }

export function missingOwnExtIdError(
  objectName: string,
  targetFields: ReadonlyArray<DescribeField>,
  targetHasExtId: ReadonlySet<string>
): string | null {
  const field = targetFields.find((f) => ciEquals(f.apiName, EXTERNAL_ID_FIELD))
  if (field != null && field.isExternalId) return null
  const why =
    field != null
      ? 'the field exists but is not flagged External ID'
      : targetHasExtId.has(objectName)
        ? 'the field exists on the org but is hidden from the connected user by field-level ' +
          'security (assign the RDS_Deployment_Access permission set, or re-run Provision on ' +
          'the Readiness step)'
        : 'the field does not exist on the target object (create it on the Readiness step)'
  return (
    `${objectName} ${EXT_ID_REFUSAL_MARKER} field on the target — every record would fail on ` +
    `upsert. ${why}.`
  )
}

function carryPlanned(
  p: PlannedObject
): Omit<FrozenObjectPlan, 'fields' | 'droppedFields' | 'mappings'> {
  return {
    objectName: p.objectName,
    sortOrder: p.sortOrder,
    hasCircularReference: p.hasCircularReference,
    deferredFields: [...p.deferredFields],
    scope: p.scope,
    scopedFilterDisplay: p.scopedFilterDisplay,
    recordCount: p.recordCount,
    apiStrategy: p.apiStrategy,
    gatingTier: p.gatingTier,
    requiresTriggerBypass: p.requiresTriggerBypass,
    requiresAutomationDisable: p.requiresAutomationDisable,
    restPageSize: p.restPageSize,
    recommendedBatchSize: p.recommendedBatchSize,
    isJunction: p.isJunction,
    junctionParents: p.junctionParents == null ? null : [...p.junctionParents],
    junctionParentFields: p.junctionParentFields == null ? null : [...p.junctionParentFields]
  }
}

/**
 * Deterministic serialization for hashing + persistence: recursively key-sorted
 * JSON so the same logical plan always produces the same bytes (and the same
 * content hash at DeployStore.savePlan). Arrays keep their order — field order,
 * walk order, and warning order are all meaningful.
 */
export function canonicalPlanJson(plan: DeployPlan): string {
  return JSON.stringify(sortKeys(plan))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}
