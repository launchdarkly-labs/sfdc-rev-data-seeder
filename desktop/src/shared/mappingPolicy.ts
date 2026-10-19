/**
 * Field-mapping strategy policy — the SINGLE SOURCE OF TRUTH for the 6 strategies'
 * defaults and lock rules. Dependency-free (shared by main, preload, renderer) so
 * the wizard UI and the deploy/analysis engine resolve defaults from ONE place and
 * never re-derive them (ROADMAP 5B.5; port item P25 in transformMap.md).
 *
 * Ported verbatim from the Apex LWC `deploymentMappings.js` (L10–87 policy tables,
 * L356–394 resolution + lock logic). The Apex `objectPolicy.ts` twin governs REST/Bulk
 * *throughput* only — a different concern — so mapping-strategy defaults live here.
 *
 * Faithfulness notes:
 *  - Object API names compared here are always describe-canonical (SF returns
 *    canonical casing), so plain `Set.has` / `Array.includes` matches the Apex
 *    `Set<String>.contains` behavior for these keys. No case-folding needed.
 *  - Ordering matters: DIRECT_ID_DEFAULT_REFS is checked BEFORE NAME_MATCH_OBJECTS,
 *    so an object in both sets (RecordType, Pricebook2, Product2, User, Group,
 *    UserRole) defaults to directId — matching the LWC.
 */

import type { FieldMapping, MappingStrategy } from './wizard'

/** Hardcoded ExtId upsert-key field (matches ExternalIdService.FIELD_NAME). */
export const EXT_ID_FIELD = 'Data_Deployment_External_Id__c'

/**
 * Objects whose strategy dropdown is NOT hard-locked even when the referenced
 * object isn't in the deployment scope — stable configuration objects with
 * documented name-match strategies. (LWC `NAME_MATCH_OBJECTS`.)
 */
export const NAME_MATCH_OBJECTS: ReadonlySet<string> = new Set([
  'User',
  'RecordType',
  'Profile',
  'UserRole',
  'Group',
  'BusinessHours',
  'Organization',
  'Pricebook2',
  'Product2'
])

/**
 * Reference targets that DEFAULT to directId when no mapping is configured.
 * Sibling sandboxes refreshed from the same prod share the same Ids on these
 * objects, so directId works without any name-match callout. The user can still
 * override to nameMatch / customId / skip in the wizard.
 *
 * Product2 is included because CPQ QuoteLine + Subscription HAVE to reference
 * Product2 — leaving it on skip silently breaks every CPQ deploy. PricebookEntry
 * is included because OpportunityLineItem.PricebookEntryId is REQUIRED on insert.
 * The 7 SBQQ catalog objects are referenced by QuoteLine/Subscription lookups;
 * leaving them on skip silently drops option/dimension/block-price/discount
 * linkage on every CPQ deploy. (LWC `DIRECT_ID_DEFAULT_REFS`.)
 */
export const DIRECT_ID_DEFAULT_REFS: ReadonlySet<string> = new Set([
  'RecordType',
  'Pricebook2',
  'Product2',
  'PricebookEntry',
  'User',
  'Group',
  'UserRole',
  'SBQQ__ProductOption__c',
  'SBQQ__Dimension__c',
  'SBQQ__BlockPrice__c',
  'SBQQ__DiscountSchedule__c',
  'SBQQ__DiscountTier__c',
  'SBQQ__ContractedPrice__c',
  'SBQQ__Cost__c'
])

/** Default nameMatch key per object; anything else falls back to 'Name'. (LWC `DEFAULT_MATCH_FIELDS`.) */
export const DEFAULT_MATCH_FIELDS: Readonly<Record<string, string>> = {
  RecordType: 'DeveloperName',
  User: 'Username',
  Pricebook2: 'Name',
  Product2: 'ProductCode',
  Profile: 'Name',
  UserRole: 'DeveloperName',
  Group: 'DeveloperName'
}

export interface StrategyOption {
  label: string
  value: MappingStrategy
}

/** Base strategies offered on every reference field. (LWC `BASE_STRATEGY_OPTIONS`.) */
export const BASE_STRATEGY_OPTIONS: readonly StrategyOption[] = [
  { label: 'External ID (computed)', value: 'externalId' },
  { label: 'Name Match', value: 'nameMatch' },
  { label: 'Skip', value: 'skip' },
  { label: 'Direct ID', value: 'directId' },
  { label: 'Custom', value: 'customId' }
]

/** User refs also offer "Set to Me" (target connected user). (LWC `USER_STRATEGY_OPTIONS`.) */
export const USER_STRATEGY_OPTIONS: readonly StrategyOption[] = [
  ...BASE_STRATEGY_OPTIONS,
  { label: 'Set to Me', value: 'setToMe' }
]

/** setToMe is only meaningful (and only offered) for User references. */
export function strategyOptionsFor(
  refTo: string | undefined,
  outOfScopeByTargetKey = false
): readonly StrategyOption[] {
  if (outOfScopeByTargetKey) return OUT_OF_SCOPE_KEYED_OPTIONS
  return refTo === 'User' ? USER_STRATEGY_OPTIONS : BASE_STRATEGY_OPTIONS
}

const STRATEGY_LABELS: Readonly<Record<MappingStrategy, string>> = {
  externalId: 'External ID (computed)',
  nameMatch: 'Name Match',
  skip: 'Skip',
  directId: 'Direct ID',
  customId: 'Custom',
  setToMe: 'Set to Me'
}

export function strategyLabel(strategy: MappingStrategy): string {
  return STRATEGY_LABELS[strategy] ?? strategy
}

/** Default nameMatch field for a referenced object (LWC `DEFAULT_MATCH_FIELDS[refTo] || 'Name'`). */
export function defaultMatchField(refTo: string | undefined): string {
  if (!refTo) return 'Name'
  return DEFAULT_MATCH_FIELDS[refTo] ?? 'Name'
}

/**
 * The computed default strategy for a reference field. Verbatim port of the LWC
 * `getDefaultStrategy` (deploymentMappings.js L356–370). `refTo` = the field's
 * first `referenceTo` target; `selectedObjects` = the deployment scope.
 */
export function getDefaultStrategy(
  refTo: string | undefined,
  currentObject: string,
  selectedObjects: readonly string[],
  targetKeys?: TargetKeyInfo
): MappingStrategy {
  if (!refTo) return 'skip'
  if (refTo === currentObject) return 'skip'
  if (DIRECT_ID_DEFAULT_REFS.has(refTo)) return 'directId'
  if (NAME_MATCH_OBJECTS.has(refTo)) return 'nameMatch'
  if (selectedObjects.includes(refTo)) return 'externalId'
  // S57 (B1, Jack's D1): the parent is outside the scope but the target ALREADY
  // holds RDS-keyed rows of it (an earlier deployment) — resolve against them.
  // The transform writes `{ Rel: { ExtId } }` exactly as for an in-scope parent
  // and the parent-strip probe (fail-loud, by ExtId) blanks or fails the
  // reference when that particular parent is missing, as it does today.
  if (targetKeys?.keyedRows.has(refTo)) return 'externalId'
  return 'skip'
}

/**
 * True when the user must NOT be able to choose a non-skip strategy. Verbatim
 * port of the LWC `_isStrategyLocked` (L379–389):
 *   - self-reference (parent record might not be in scope), or
 *   - the referenced object isn't in this deployment AND isn't a stable
 *     name-match / directId-default object.
 * Children referencing these would upsert with unresolvable refs.
 */
export function isStrategyLocked(
  refTo: string | undefined,
  currentObject: string,
  selectedObjects: readonly string[],
  targetKeys?: TargetKeyInfo
): boolean {
  if (!refTo) return false
  if (refTo === currentObject) return true
  if (NAME_MATCH_OBJECTS.has(refTo)) return false
  if (DIRECT_ID_DEFAULT_REFS.has(refTo)) return false
  if (selectedObjects.includes(refTo)) return false
  // S57 (B1): the target carries the ExtId field on this object, so an
  // externalId reference CAN resolve there — unlock (options: External ID / Skip).
  if (targetKeys?.hasField.has(refTo)) return false
  return true
}

/**
 * S57 (B1): what the TARGET org knows about objects that are NOT in the
 * deployment scope. Built by `rds:target.keyedObjects` (renderer) and by the
 * deploy handler for the plan freeze — the same two sets, so the Mappings step,
 * the Fields step and the frozen plan agree.
 */
export interface TargetKeyInfo {
  /** Target objects carrying `Data_Deployment_External_Id__c` (org-wide Tooling oracle). */
  hasField: ReadonlySet<string>
  /** Target objects with at least one RDS-keyed row (`ExtId != null`, probed with LIMIT 1). */
  keyedRows: ReadonlySet<string>
}

/** "The target knows nothing" — the pre-S57 behaviour (every out-of-scope ref locked). */
export const NO_TARGET_KEYS: TargetKeyInfo = { hasField: new Set(), keyedRows: new Set() }

/** How an out-of-scope referenced object stands on the target (drives badge + default). */
export type OutOfScopeKeyState = 'inScope' | 'keyedRows' | 'fieldOnly' | 'none'

export function outOfScopeKeyState(
  refTo: string,
  selectedObjects: readonly string[],
  targetKeys?: TargetKeyInfo
): OutOfScopeKeyState {
  if (selectedObjects.includes(refTo)) return 'inScope'
  if (targetKeys?.keyedRows.has(refTo)) return 'keyedRows'
  if (targetKeys?.hasField.has(refTo)) return 'fieldOnly'
  return 'none'
}

/** Human-readable reason a field is locked — or, S57, why an out-of-scope ref is NOT (LWC `_lockBadge`). */
export function lockBadge(
  refTo: string | undefined,
  currentObject: string,
  targetKeys?: TargetKeyInfo
): string {
  if (refTo === currentObject) return 'Self-reference (auto-skip)'
  if (refTo == null) return 'Ref → (unknown) (not in deployment)'
  switch (outOfScopeKeyState(refTo, [], targetKeys)) {
    case 'keyedRows':
      return `Ref → ${refTo} (not in deployment — resolves against RDS-keyed ${refTo} rows already on the target)`
    case 'fieldOnly':
      return `Ref → ${refTo} (not in deployment — the target has the key field but no keyed ${refTo} rows yet; External ID would blank every reference)`
    default:
      return `Ref → ${refTo} (not in deployment)`
  }
}

/**
 * S57 (B1): the ONE place the effective strategy of a reference field is
 * decided — Mappings row, Fields-step lock, plan freeze and the required-ref
 * warning all call this, so they can never disagree.
 *   locked (self / out-of-scope with nothing on the target)  → 'skip'
 *   out-of-scope but the target can key it                   → override if it is
 *     External ID / Skip, else the policy default (a stale nameMatch/directId
 *     override from when the object WAS in scope is not honoured — the only
 *     way to resolve a parent that is not in the plan is by its RDS key)
 *   otherwise                                                 → override ?? default
 */
export function effectiveStrategy(
  refTo: string,
  currentObject: string,
  selectedObjects: readonly string[],
  override: MappingStrategy | undefined,
  targetKeys?: TargetKeyInfo
): MappingStrategy {
  if (isStrategyLocked(refTo, currentObject, selectedObjects, targetKeys)) return 'skip'
  if (isUnlockedByTargetKey(refTo, selectedObjects, targetKeys)) {
    if (override === 'externalId' || override === 'skip') return override
    return getDefaultStrategy(refTo, currentObject, selectedObjects, targetKeys)
  }
  return override ?? getDefaultStrategy(refTo, currentObject, selectedObjects, targetKeys)
}

/** True for a reference that is out of scope AND unlocked only because the target can key it. */
export function isUnlockedByTargetKey(
  refTo: string,
  selectedObjects: readonly string[],
  targetKeys?: TargetKeyInfo
): boolean {
  if (NAME_MATCH_OBJECTS.has(refTo) || DIRECT_ID_DEFAULT_REFS.has(refTo)) return false
  const state = outOfScopeKeyState(refTo, selectedObjects, targetKeys)
  return state === 'keyedRows' || state === 'fieldOnly'
}

/**
 * S57 (B1): the out-of-scope objects worth asking the target about — referenced
 * by the given fields, not selected, not self, not a stable name-match /
 * directId-default object. Deduped, in first-seen order.
 */
export function targetKeyProbeCandidates(
  refTos: Iterable<string | undefined | null>,
  currentObject: string,
  selectedObjects: readonly string[]
): string[] {
  const out: string[] = []
  for (const refTo of refTos) {
    if (!refTo || refTo === currentObject) continue
    if (selectedObjects.includes(refTo)) continue
    if (NAME_MATCH_OBJECTS.has(refTo) || DIRECT_ID_DEFAULT_REFS.has(refTo)) continue
    if (!out.includes(refTo)) out.push(refTo)
  }
  return out
}

/** S57 (B1): the only two choices for an out-of-scope ref unlocked by the target's key field. */
export const OUT_OF_SCOPE_KEYED_OPTIONS: readonly StrategyOption[] = [
  { label: 'External ID (computed)', value: 'externalId' },
  { label: 'Skip', value: 'skip' }
]

/**
 * RecordTypeId is intentionally hidden from the mapping table: the engine always
 * force-resolves it via nameMatch-by-DeveloperName (target IsActive=true), so
 * there's no user-configurable choice to surface. (LWC loadObjectMappings L306–312.)
 */
export function isHiddenRefField(fieldApiName: string, refTo: string | undefined): boolean {
  return fieldApiName === 'RecordTypeId' && refTo === 'RecordType'
}

/** A deployable reference field paired with its (first) referenced object. */
export interface RefFieldRef {
  fieldName: string
  refTo: string
}

export interface TemplateReconcileResult {
  /** The overrides safe to apply (sparse; locked/undeployable entries removed). */
  mappings: Record<string, Record<string, FieldMapping>>
  /** In-scope entries dropped because their reference is now locked (self/out-of-scope). */
  corrected: number
}

/**
 * Reconcile a saved mappings template against the current scope before applying it
 * (mirrors the Apex LWC applyMappings scope re-validation, deploymentMappings.js
 * L201–244). Only in-scope objects are considered; within them, a template entry
 * whose reference is now locked is DROPPED (never stored — the lock is always
 * derived) and counted as a correction. Entries for fields that are no longer
 * deployable references (schema drift) are silently ignored.
 */
export function reconcileTemplateMappings(
  template: Record<string, Record<string, FieldMapping>>,
  refFieldsByObject: Record<string, RefFieldRef[]>,
  selectedObjects: readonly string[],
  targetKeys?: TargetKeyInfo
): TemplateReconcileResult {
  const mappings: Record<string, Record<string, FieldMapping>> = {}
  let corrected = 0
  for (const obj of Object.keys(template)) {
    if (!selectedObjects.includes(obj)) continue
    const entries = template[obj]
    if (!entries) continue
    const refByName = new Map((refFieldsByObject[obj] ?? []).map((r) => [r.fieldName, r.refTo]))
    const objMap: Record<string, FieldMapping> = {}
    for (const [field, mapping] of Object.entries(entries)) {
      const refTo = refByName.get(field)
      if (refTo === undefined) continue
      if (isStrategyLocked(refTo, obj, selectedObjects, targetKeys)) {
        corrected++
        continue
      }
      objMap[field] = mapping
    }
    if (Object.keys(objMap).length > 0) mappings[obj] = objMap
  }
  return { mappings, corrected }
}
