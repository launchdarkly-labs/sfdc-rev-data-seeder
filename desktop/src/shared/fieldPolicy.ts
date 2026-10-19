/**
 * Field include/exclude policy — the single source for which source fields are
 * deployable and how a field's effective exclusion is derived from the wizard
 * config (5B.6). Dependency-free (shared by main, preload, renderer). Mirrors the
 * Apex intersection/drop rules (SchemaService deployable-field filter + the
 * Excluded_Fields__c / namespace / populated-only gates).
 */

import type { FieldInfo } from './types'
import type { MappingStrategy, WizardConfig } from './wizard'
import { effectiveStrategy, isStrategyLocked, type TargetKeyInfo } from './mappingPolicy'

/**
 * Managed-package namespaces kept by "Suggest Exclusions" (everything else managed
 * is excluded). CPQ (SBQQ) + Advanced Approvals (sbaa) are the packages this tool
 * deploys, so their fields must stay in. Case-sensitive to match SF API prefixes.
 */
export const SUGGESTED_KEEP_NAMESPACES: ReadonlySet<string> = new Set(['SBQQ', 'sbaa'])

/**
 * Salesforce system-managed fields — always dropped from the deployable set, even
 * when an org describes them as createable (e.g. audit fields become createable with
 * "Set Audit Fields upon record creation"). Verbatim from Apex
 * SchemaService.SYSTEM_MANAGED_FIELDS (SchemaService.cls:53-65).
 */
export const SYSTEM_MANAGED_FIELDS: ReadonlySet<string> = new Set([
  'Id',
  'IsDeleted',
  'CreatedDate',
  'CreatedById',
  'LastModifiedDate',
  'LastModifiedById',
  'SystemModstamp',
  'LastActivityDate',
  'LastViewedDate',
  'LastReferencedDate',
  'MasterRecordId'
])

/**
 * The managed-package namespace of a field API name, or null for a local/standard
 * field. A managed field has TWO `__` (e.g. `SBQQ__Price__c` → `SBQQ`); a plain
 * custom field has one (`Foo__c` → null); a standard field has none (`Name` → null).
 */
export function fieldNamespace(apiName: string): string | null {
  const parts = apiName.split('__')
  return parts.length >= 3 ? (parts[0] ?? null) : null
}

/**
 * A field is deployable if it can be written on insert and isn't derived/system:
 * createable, not auto-number, not calculated (formula/rollup), not system-managed.
 * Applied to BOTH orgs' describes — the caller intersects source-deployable ∩
 * target-deployable (a field read-only/formula on the TARGET must be dropped too, or
 * the deploy fails INVALID_FIELD_FOR_INSERT_UPDATE — SchemaService.cls:288-298).
 */
export function isDeployableField(f: FieldInfo): boolean {
  return (
    f.isCreateable && !f.isAutoNumber && !f.isCalculated && !SYSTEM_MANAGED_FIELDS.has(f.apiName)
  )
}

export type ExclusionReason = 'field' | 'namespace' | 'unpopulated' | 'skippedRef'

export interface FieldExclusion {
  excluded: boolean
  /** Why it's excluded. 'field' = the user's own toggle; 'namespace'/'unpopulated'/
   *  'skippedRef' are DERIVED locks. */
  reason?: ExclusionReason
}

type FieldConfigSlice = Pick<
  WizardConfig,
  'excludedFields' | 'excludedNamespaces' | 'populatedOnly'
>

/** Reference context for the skipped-ref lock (5B.6-b). */
export interface FieldRefContext {
  /** The field's (first) referenced object, or null for a non-reference field. */
  refTo: string | null
  selectedObjects: readonly string[]
  /** The user's mapping-strategy override for this field, if any
   *  (`config.mappings[obj]?.[field]?.strategy`) — a user-chosen 'skip' strips
   *  the field exactly like a policy-locked one, so it must lock here too. */
  overrideStrategy?: MappingStrategy
  /** S57 (B1): what the target knows about out-of-scope parents (unlocks refs it can key). */
  targetKeys?: TargetKeyInfo
}

/**
 * A NON-self reference field whose mapping strategy is POLICY-LOCKED to 'skip'
 * (a ref to an object outside the deployment with no stable directId/nameMatch
 * default) is stripped by the transform no matter what the Fields step says.
 * SELF-references are deliberately NOT locked: the engine DEFERS them to the
 * revisit pass (deferred-fields second pass) — they deploy, so locking them
 * as excluded would misrepresent the run. Delegates to mappingPolicy (the
 * single source for strategy locks — never re-derive them).
 */
export function isOutOfScopeRefLocked(
  refTo: string | null,
  objectName: string,
  selectedObjects: readonly string[],
  targetKeys?: TargetKeyInfo
): boolean {
  return (
    refTo !== null &&
    refTo !== objectName &&
    isStrategyLocked(refTo, objectName, selectedObjects, targetKeys)
  )
}

/**
 * The effective exclusion of a field for an object. Skipped-ref, namespace and
 * unpopulated are DERIVED locks (checked first, take precedence over an explicit
 * toggle) so the per-field checkbox for them is non-interactive; an explicit
 * `field` exclusion is the user's own choice. `populated` is the set of fields
 * found non-null in a source sample (null when populated-only is off / not yet
 * loaded). `ref` carries the field's reference target for the out-of-scope-ref
 * lock (omit for non-reference callers). `excludedSet` (S64 P5, 5.6c) is an
 * optional precomputed `Set` of `config.excludedFields[objectName]` — a caller
 * evaluating every field of an object (the Fields step) builds it once per
 * object so the explicit-exclusion lookup is O(1) instead of an O(n) array scan
 * (O(n²) per object after "Exclude all"). Without it the array path is used; the
 * two must agree (test/fieldPolicy.test.ts).
 */
export function fieldExclusion(
  fieldApiName: string,
  objectName: string,
  config: FieldConfigSlice,
  populated: ReadonlySet<string> | null,
  ref?: FieldRefContext,
  excludedSet?: ReadonlySet<string>
): FieldExclusion {
  // A ref whose EFFECTIVE mapping strategy is 'skip' is stripped by the
  // transform — the include checkbox must not promise it. Effective strategy
  // mirrors the mappings step exactly: a POLICY-LOCKED ref is 'skip' no matter
  // what a stale override says (`locked ? 'skip' : chosen`); otherwise the user
  // override, falling back to the policy default. Self-refs are carved out:
  // the engine DEFERS them (revisit pass), so they deploy. Likewise, an
  // explicit 'skip' on an UNLOCKED in-deployment ref is carved out: plan
  // freeze auto-promotes it back to externalId (the A9 stale-template repair,
  // Apex DDQ L1470-1487) so the field DEPLOYS — locking it as excluded here
  // would contradict the run (E2.6 review finding). Freeze assumes the target
  // ExtId field exists (readiness creates it; A10 re-skips the rare gap).
  if (ref && ref.refTo !== null && ref.refTo !== objectName) {
    const locked = isStrategyLocked(ref.refTo, objectName, ref.selectedObjects, ref.targetKeys)
    const effective = effectiveStrategy(
      ref.refTo,
      objectName,
      ref.selectedObjects,
      ref.overrideStrategy,
      ref.targetKeys
    )
    const promotedAtFreeze =
      !locked && effective === 'skip' && ref.selectedObjects.includes(ref.refTo)
    if (effective === 'skip' && !promotedAtFreeze) return { excluded: true, reason: 'skippedRef' }
  }
  const ns = fieldNamespace(fieldApiName)
  if (ns !== null && config.excludedNamespaces.includes(ns)) {
    return { excluded: true, reason: 'namespace' }
  }
  if (config.populatedOnly && populated !== null && !populated.has(fieldApiName)) {
    return { excluded: true, reason: 'unpopulated' }
  }
  const explicitlyExcluded = excludedSet
    ? excludedSet.has(fieldApiName)
    : (config.excludedFields[objectName] ?? []).includes(fieldApiName)
  if (explicitlyExcluded) {
    return { excluded: true, reason: 'field' }
  }
  return { excluded: false }
}

/** Only a user-owned ('field') exclusion is interactively toggleable; derived locks are not. */
export function isFieldLocked(reason: ExclusionReason | undefined): boolean {
  return reason === 'namespace' || reason === 'unpopulated' || reason === 'skippedRef'
}

/** S57 (FB-7): is a CPQ-stack object (SBQQ / sbaa) actually in the deployment? */
export function cpqObjectInScope(selectedObjects: readonly string[]): boolean {
  return selectedObjects.some((o) => /^(SBQQ|sbaa)__/.test(o))
}

/**
 * Suggest Exclusions: exclude every managed namespace present EXCEPT the ones this
 * tool deploys (SBQQ/sbaa) — and, S57 (FB-7), only keep those when a CPQ object is
 * in the scope. A Campaign/Account/Contact deployment has no reason to carry the
 * SBQQ fields on Account. Without `selectedObjects` the pre-S57 rule applies.
 * Returns the namespaces to exclude (deduped, sorted).
 */
export function suggestExcludedNamespaces(
  presentNamespaces: Iterable<string>,
  selectedObjects?: readonly string[]
): string[] {
  const keepCpq = selectedObjects == null || cpqObjectInScope(selectedObjects)
  const out = new Set<string>()
  for (const ns of presentNamespaces) {
    if (keepCpq && SUGGESTED_KEEP_NAMESPACES.has(ns)) continue
    out.add(ns)
  }
  return [...out].sort()
}

/** Payload of a saved fields template (5B.6-b, template kind 'fields'). */
export interface FieldsTemplatePayload {
  excludedFields: Record<string, string[]>
  excludedNamespaces: string[]
  populatedOnly: boolean
}

export interface FieldsTemplateReconcileResult extends FieldsTemplatePayload {
  /** Template objects dropped because they are not in the current scope. */
  droppedObjects: number
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string')

/**
 * Scope re-validation on fields-template apply (the reconcile analog of
 * `reconcileTemplateMappings`): only exclusions for objects in the CURRENT scope
 * are applied — dropped objects are counted, never silently ignored. The payload
 * comes back from the store as parsed JSON, so every branch is defensively
 * typed (a hand-edited or version-drifted template must degrade to defaults,
 * not crash the step). Field names that no longer exist on an object are left
 * in place — they are inert (exclusion is evaluated against the live describe)
 * and vanish on the user's next explicit toggle of that object.
 */
export function reconcileFieldsTemplate(
  payload: unknown,
  selectedObjects: readonly string[]
): FieldsTemplateReconcileResult {
  const p = (payload ?? {}) as Partial<Record<keyof FieldsTemplatePayload, unknown>>
  const excludedFields: Record<string, string[]> = {}
  let droppedObjects = 0
  if (p.excludedFields && typeof p.excludedFields === 'object' && !Array.isArray(p.excludedFields)) {
    for (const [obj, fields] of Object.entries(p.excludedFields as Record<string, unknown>)) {
      if (!isStringArray(fields)) continue
      if (fields.length === 0) continue // an empty entry excludes nothing — never count it as dropped
      if (!selectedObjects.includes(obj)) {
        droppedObjects++
        continue
      }
      excludedFields[obj] = [...new Set(fields)]
    }
  }
  const excludedNamespaces = isStringArray(p.excludedNamespaces)
    ? [...new Set(p.excludedNamespaces)]
    : []
  const populatedOnly = p.populatedOnly === true
  return { excludedFields, excludedNamespaces, populatedOnly, droppedObjects }
}

/* ── S63: TEXT fields that hold record Ids ───────────────────────────────────
 * The engine remaps a field only when the describe says `isReference`. CPQ also stores record
 * Ids in plain TEXT fields, and those land on the target holding SOURCE Ids (deployment 50 →
 * sb1: 103 of 127 `SBQQ__Subscription__c.SBQQ__RequiredById__c` values pointed at the source org).
 * The post-load relink pass (engine/deploy/textIdRelink.ts) rewrites EXACTLY the fields listed
 * here — never a describe-wide "18-char text" heuristic: Opportunity alone carries NetSuite,
 * GCLID, Consensus and Gearset id text that must never be touched.
 *
 *   resolve 'run'     the value is an Id of a row THIS deployment loaded (keyed: by RDS key on
 *                     the target; keyless: through the id map)
 *   resolve catalog   the value is an Id of a CONFIG row (pricebook, quote template, record
 *                     type, email template) matched on the target by name
 */
export type TextIdCatalog = 'Pricebook2' | 'SBQQ__QuoteTemplate__c' | 'RecordType' | 'EmailTemplate'

export interface TextIdField {
  object: string
  field: string
  /** The object the stored Id belongs to. */
  refObject: string
  resolve: 'run' | { catalog: TextIdCatalog; matchField: string; alsoMatch?: string[] }
}

export const TEXT_ID_FIELDS: ReadonlyArray<TextIdField> = [
  // in-run: rows the deployment itself loads
  { object: 'SBQQ__Subscription__c', field: 'SBQQ__RequiredById__c', refObject: 'SBQQ__Subscription__c', resolve: 'run' },
  { object: 'SBQQ__Subscription__c', field: 'SBQQ__RootId__c', refObject: 'SBQQ__Subscription__c', resolve: 'run' },
  { object: 'SBQQ__QuoteLine__c', field: 'SBQQ__OriginalQuoteLineId__c', refObject: 'SBQQ__QuoteLine__c', resolve: 'run' },
  { object: 'OpportunityLineItem', field: 'SBQQ__ParentID__c', refObject: 'OpportunityLineItem', resolve: 'run' },
  // catalog: config rows matched by name on the target
  { object: 'SBQQ__Quote__c', field: 'SBQQ__PricebookId__c', refObject: 'Pricebook2', resolve: { catalog: 'Pricebook2', matchField: 'Name' } },
  { object: 'Opportunity', field: 'SBQQ__QuotePricebookId__c', refObject: 'Pricebook2', resolve: { catalog: 'Pricebook2', matchField: 'Name' } },
  { object: 'Contract', field: 'SBQQ__AmendmentPricebookId__c', refObject: 'Pricebook2', resolve: { catalog: 'Pricebook2', matchField: 'Name' } },
  { object: 'Contract', field: 'SBQQ__RenewalPricebookId__c', refObject: 'Pricebook2', resolve: { catalog: 'Pricebook2', matchField: 'Name' } },
  { object: 'SBQQ__Quote__c', field: 'SBQQ__QuoteTemplateId__c', refObject: 'SBQQ__QuoteTemplate__c', resolve: { catalog: 'SBQQ__QuoteTemplate__c', matchField: 'Name' } },
  { object: 'Contract', field: 'SBQQ__AmendmentOpportunityRecordTypeId__c', refObject: 'RecordType', resolve: { catalog: 'RecordType', matchField: 'DeveloperName', alsoMatch: ['SobjectType'] } },
  { object: 'Contract', field: 'SBQQ__RenewalOpportunityRecordTypeId__c', refObject: 'RecordType', resolve: { catalog: 'RecordType', matchField: 'DeveloperName', alsoMatch: ['SobjectType'] } },
  { object: 'SBQQ__Quote__c', field: 'SBQQ__EmailTemplateId__c', refObject: 'EmailTemplate', resolve: { catalog: 'EmailTemplate', matchField: 'DeveloperName' } }
]

/** The listed text-Id fields of one object (case-insensitive object match). */
export function textIdFieldsOf(objectName: string): TextIdField[] {
  const lc = objectName.toLowerCase()
  return TEXT_ID_FIELDS.filter((t) => t.object.toLowerCase() === lc)
}

/**
 * Plan-step notice: for the objects in a plan, which text-Id fields the run will relink and
 * whether their parent object is in the plan (an in-run field whose ref object is NOT in the
 * plan can only resolve to rows a previous deployment mapped — a scope gap worth saying before
 * the run, since the goal is ONE run that links everything).
 */
export function textIdRelinkPreview(
  objectNames: readonly string[]
): Array<{ object: string; field: string; refObject: string; kind: 'run' | 'catalog'; refInPlan: boolean }> {
  const inPlan = new Set(objectNames.map((o) => o.toLowerCase()))
  const out: Array<{ object: string; field: string; refObject: string; kind: 'run' | 'catalog'; refInPlan: boolean }> = []
  for (const name of objectNames) {
    for (const t of textIdFieldsOf(name)) {
      out.push({
        object: t.object,
        field: t.field,
        refObject: t.refObject,
        kind: t.resolve === 'run' ? 'run' : 'catalog',
        refInPlan: t.resolve !== 'run' || inPlan.has(t.refObject.toLowerCase())
      })
    }
  }
  return out
}
