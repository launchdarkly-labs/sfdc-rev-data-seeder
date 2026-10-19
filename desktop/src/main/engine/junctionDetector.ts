/**
 * Port of force-app/main/default/classes/JunctionDetector.cls (+ the synthetic
 * field-describe builder from DeploymentAnalysisQueueable.injectDetectedJunctions).
 *
 * Detects junction objects that bridge two parents already in deployment scope.
 *
 * v1: registry-based — only standard SF junctions whose parents the user might
 * realistically pick. OpportunityContactRole is the canonical case. To add a
 * junction, add an entry to KNOWN_JUNCTIONS below.
 *
 * Detection is pure lookup against the constant — no callouts. Used by the
 * analysis pipeline after the user finalizes object scope.
 *
 * Junction deploy semantics differ from the standard pipeline:
 *  - No Data_Deployment_External_Id__c field on the junction (platform-blocked on
 *    OCR; FIELD_INTEGRITY_EXCEPTION on IsUnique/IsExternalIdentifier).
 *  - Insert-only with target-side dedupe via composite parent ExtIds.
 *  - Parent FK resolution via standard REST relationship traversal (the same
 *    "Opportunity": { "Data_Deployment_External_Id__c": "<ext>" } pattern other
 *    objects already use).
 *
 * DELIBERATE DEVIATIONS from the Apex source:
 *  - KNOWN_JUNCTIONS was `@TestVisible private` in Apex; here it is exported so
 *    tests can pin the registry contents directly.
 *  - `detect` accepts `null | undefined` scope (Apex accepted a null Set) and a
 *    ReadonlySet; like Apex, membership checks are case-SENSITIVE (Apex
 *    Set<String>.contains and Map keys are case-sensitive), and — matching the
 *    Apex quirk — the returned JunctionInfo objects are the SHARED registry
 *    instances, not clones. Callers must not mutate them.
 *  - `buildSyntheticParentFieldInfos` is ported from
 *    DeploymentAnalysisQueueable.injectDetectedJunctions (lines building the
 *    List<SchemaService.FieldInfo> `synth`) because that synthetic describe is
 *    part of the junction contract the analysis expects. Field mapping:
 *      Apex SchemaService.FieldInfo.dataType  -> shared FieldInfo.type
 *    Apex left label / relationshipName / isRestrictedPicklist / picklistValues
 *    unset (null). The shared TS FieldInfo requires concrete values, so:
 *      label               = apiName  (Apex: null; apiName chosen so any UI
 *                                      rendering the synthetic field stays legible)
 *      isUpdateable        = false    (field absent on Apex SchemaService.FieldInfo)
 *      isRestrictedPicklist= false    (Apex: null — falsy, so parity-safe)
 *      picklistValues      = []       (Apex: null — never consulted for references)
 *      length              = null     (field absent on the Apex synthetic describe)
 *    relationshipName has no counterpart on the shared FieldInfo type and is
 *    dropped (Apex set it to null anyway).
 *  - `isKnownJunction` reproduces Apex String.isBlank semantics: null,
 *    undefined, empty, and whitespace-only inputs return false.
 */
import type { FieldInfo } from '../../shared/types'

export interface JunctionInfo {
  objectName: string
  /**
   * Parent object API names. Parent order MUST match parentFields order — both
   * are used positionally when building the relationship-traversal payload.
   */
  parents: string[]
  /** FK fields on the junction, positionally aligned with `parents`. */
  parentFields: string[]
}

function infoOf(objectName: string, parents: string[], parentFields: string[]): JunctionInfo {
  return { objectName, parents, parentFields }
}

function buildRegistry(): Map<string, JunctionInfo> {
  const m = new Map<string, JunctionInfo>()
  m.set(
    'OpportunityContactRole',
    infoOf('OpportunityContactRole', ['Opportunity', 'Contact'], ['OpportunityId', 'ContactId'])
  )
  // Future candidates (verify Tooling/REST insert behavior before adding):
  //   AccountContactRelation  -> Account + Contact
  //   OpportunityTeamMember   -> Opportunity + User
  //   AccountTeamMember       -> Account + User
  //   CaseTeamMember          -> Case + User (note: needs CaseTeamMember + CaseTeamRole)
  return m
}

/**
 * Registry of known junction objects.
 * Key = junction API name; value = { parents (object API names), parentFields (FK fields on the junction) }.
 * Exported for tests (Apex: @TestVisible private). Treat as immutable.
 */
export const KNOWN_JUNCTIONS: Map<string, JunctionInfo> = buildRegistry()

/**
 * Returns junctions whose ALL parents are present in the supplied scope.
 * Does NOT call out. Callers should already have the user's selected objects
 * available as a Set of API names.
 *
 * NOTE (parity with Apex): a junction that is itself already in scope is still
 * returned — the "user picked it manually, leave it alone" skip lives in the
 * analysis pipeline (see DeploymentAnalysisQueueable.injectDetectedJunctions),
 * not here.
 */
export function detect(scopeObjectNames: ReadonlySet<string> | null | undefined): JunctionInfo[] {
  const out: JunctionInfo[] = []
  if (!scopeObjectNames || scopeObjectNames.size === 0) {
    return out
  }
  for (const j of KNOWN_JUNCTIONS.values()) {
    if (allInScope(j.parents, scopeObjectNames)) {
      out.push(j)
    }
  }
  return out
}

function allInScope(parents: string[], scope: ReadonlySet<string>): boolean {
  for (const p of parents) {
    if (!scope.has(p)) return false
  }
  return true
}

/**
 * Returns true if the given object API name is a known junction in the registry.
 * Used by the External ID Manager + ExternalIdService to skip the
 * unsupported-object guard for junctions (they never get a Data_Deployment_External_Id__c
 * field — their deploy path doesn't need one).
 */
export function isKnownJunction(objectApiName: string | null | undefined): boolean {
  if (objectApiName == null || objectApiName.trim() === '') return false
  return KNOWN_JUNCTIONS.has(objectApiName)
}

/**
 * Builds the synthetic field describe the analysis pipeline caches for an
 * auto-injected junction (ported from DeploymentAnalysisQueueable.
 * injectDetectedJunctions). Only the parent FK fields matter for dependency
 * edges; isNillable=false makes them hard deps so the dependency resolver
 * sorts the junction AFTER its parents.
 *
 * Positional pairing quirk preserved from Apex: iteration is bounded by
 * parentFields.length; a registry entry with more parents than parentFields
 * would silently ignore the extra parents, and one with fewer would throw here
 * (Apex: List index out of bounds) — the registry constant keeps them aligned.
 */
export function buildSyntheticParentFieldInfos(j: JunctionInfo): FieldInfo[] {
  const synth: FieldInfo[] = []
  for (let i = 0; i < j.parentFields.length; i++) {
    const apiName = j.parentFields[i]
    const parent = j.parents[i]
    if (apiName === undefined || parent === undefined) {
      throw new Error(
        `JunctionDetector: parents/parentFields misaligned for ${j.objectName} at index ${i}`
      )
    }
    synth.push({
      apiName,
      label: apiName,
      type: 'reference',
      isReference: true,
      referenceTo: [parent],
      isCreateable: true,
      isUpdateable: false,
      isNillable: false,
      isExternalId: false,
      isAutoNumber: false,
      isCalculated: false,
      isRestrictedPicklist: false,
      picklistValues: [],
      length: null
    })
  }
  return synth
}
