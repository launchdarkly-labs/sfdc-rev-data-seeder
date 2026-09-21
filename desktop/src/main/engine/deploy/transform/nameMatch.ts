/**
 * E4X.5 — NameMatchResolver port (`transform/nameMatch.ts`). Byte-faithful port
 * of the frozen Apex `NameMatchResolver.resolve` (NameMatchResolver.cls:64-121,
 * queryNameMap L304-351) plus the A13/A14 map-building loop from
 * `DataDeploymentQueueable.executeNormalModeV2` (L1586-1614) that produces the
 * exact `ctx.nameMatchMaps` the transform pipeline consumes.
 *
 * The resolver maps source Ids → target Ids by matching on a shared name field,
 * for referenced objects NOT in the deployment set (RecordType, User, Pricebook2,
 * …). Key asymmetries the port must preserve (transformMap P7/P8, §4.3/§4.4):
 *   - the SOURCE query includes INACTIVE rows (source records may still carry an
 *     inactive RT's / user's Id — RDS-DEP-0049); the TARGET query adds
 *     `IsActive=true` for RecordType ONLY (inactive target RTs must NOT resolve,
 *     so the field drops and Salesforce assigns the running user's default RT);
 *   - duplicate match values → LAST one wins (Map overwrite);
 *   - RecordTypeId is ALWAYS force-resolved by DeveloperName regardless of any
 *     saved mapping (A14 — the stage-1 strategy force is E4X.3; this supplies the
 *     DeveloperName default + the active/SObjectType-context asymmetry).
 *
 * ENGINE-PURE: no jsforce, no better-sqlite3, no SOQL string building. The org
 * reads go through an injected `NameMatchIo` (the SOQL assembly + escapeSingleQuotes
 * + pagination live in the E4X.6 services adapter, honoring E4X.1's deferral of
 * `escapeSingleQuotes`). The IO returns FULLY-paginated record arrays.
 *
 * PARITY-FIRST: `ciEquals` for every Apex `==` (object/strategy/field literals);
 * match-value Map keys stay case-SENSITIVE (Apex Map<String,String> — NOT the
 * lowercasing used only by the drift-check method); `String.valueOf(matchField)`
 * → `apexStringValueOf` (null→null, checked after — NameMatchResolver L322).
 */

import { ciEquals, isBlank, apexStringValueOf } from './apexSemantics'
import type { GoldenFieldInfo, GoldenMapping } from '../golden/fixture'

/**
 * The RESOLVER's default match fields (NameMatchResolver.cls:15-25). This is a
 * DISTINCT table from the UI's `shared/mappingPolicy.ts` `DEFAULT_MATCH_FIELDS`:
 *   - it carries `BusinessHours`/`Organization` (the UI table omits them), and
 *   - `getResolverMatchField` returns `null` for an unknown object (Apex
 *     `Map.get` → null), whereas the UI helper falls back to `'Name'`.
 * The null is load-bearing: `resolveNameMatch` returns an EMPTY map when the
 * effective match field is null (NameMatchResolver L70-73), so an unknown object
 * with a blank mapping resolves nothing rather than matching on `Name`. Do NOT
 * "single-source" these two tables — they intentionally differ.
 */
export const RESOLVER_DEFAULT_MATCH_FIELDS: Readonly<Record<string, string>> = {
  RecordType: 'DeveloperName',
  User: 'Username',
  Pricebook2: 'Name',
  Product2: 'ProductCode',
  Profile: 'Name',
  UserRole: 'DeveloperName',
  Group: 'DeveloperName',
  BusinessHours: 'Name',
  Organization: 'Name'
}

/** NameMatchResolver.getDefaultMatchField — the conventional field, or null. */
export function getResolverMatchField(objectName: string): string | null {
  return RESOLVER_DEFAULT_MATCH_FIELDS[objectName] ?? null
}

/**
 * The effective match field for a resolve: a caller-provided field wins; a blank
 * one falls back to the default table; null when neither yields one (→ caller
 * returns an empty map). NameMatchResolver.cls L70-73.
 */
export function effectiveMatchField(
  objectName: string,
  matchField: string | null | undefined
): string | null {
  if (!isBlank(matchField)) return matchField
  return getResolverMatchField(objectName)
}

/** Options for one side of a match query — the asymmetry lives here. */
export interface NameMatchQueryOpts {
  /** RecordType SObjectType filter (both sides); null = no filter. */
  sObjectType: string | null
  /** Add `IsActive = true` — target RecordType only (NameMatchResolver L96-102). */
  activeOnly: boolean
}

/**
 * The injected read seam. Implemented by the E4X.6 services adapter (which builds
 * the SOQL — `SELECT Id, {matchField} FROM {objectName} [WHERE …]` — with
 * escapeSingleQuotes, the SObjectType / IsActive filters, and nextRecordsUrl
 * pagination). Returns the fully-paginated record array as jsforce yields it.
 */
export interface NameMatchIo {
  queryNames(
    role: 'source' | 'target',
    objectName: string,
    matchField: string,
    opts: NameMatchQueryOpts
  ): Promise<Array<Record<string, unknown>>>
}

/**
 * Port of `queryNameMap` (NameMatchResolver L304-351), minus the callout +
 * pagination (the IO delivers all pages). Builds `matchValue → recordId`;
 * duplicate match values → LAST one wins (Map.set overwrites, mirroring
 * Apex `Map.put`). Skips rows with a null Id or a null match value.
 */
export function buildNameToId(
  records: ReadonlyArray<Record<string, unknown>>,
  matchField: string
): Map<string, string> {
  const nameToId = new Map<string, string>()
  for (const rec of records) {
    const rawId = rec['Id']
    if (rawId == null) continue
    const nameVal = apexStringValueOf(rec[matchField])
    if (nameVal == null) continue
    nameToId.set(nameVal, String(rawId)) // last-wins
  }
  return nameToId
}

/**
 * The resolve() reduction (NameMatchResolver L107-115): for each source match
 * value, if the target has the same value, map its sourceId → targetId. A source
 * value with no target match is simply absent (→ the caller drops the field).
 */
export function resolveNameToTargetMap(
  sourceNameToId: ReadonlyMap<string, string>,
  targetNameToId: ReadonlyMap<string, string>
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, sourceId] of sourceNameToId) {
    const targetId = targetNameToId.get(name)
    if (targetId != null) result[sourceId] = targetId
  }
  return result
}

/**
 * Port of `NameMatchResolver.resolve` (L64-121). Reads source (incl. inactive)
 * and target (RecordType → active-only) via the injected IO, matches on the
 * effective match field, and returns `sourceId → targetId`. Empty map when there
 * is no effective match field (L70-73) — the caller then resolves nothing.
 *
 * `objectContext` is the SObjectType filter for RecordType resolves (the object
 * that owns the record types); ignored for every other object (Apex L78-80).
 */
export async function resolveNameMatch(
  io: NameMatchIo,
  objectName: string,
  matchField: string | null | undefined,
  objectContext: string | null = null
): Promise<Record<string, string>> {
  const field = effectiveMatchField(objectName, matchField)
  if (field == null) return {}

  const isRecordType = ciEquals(objectName, 'RecordType')
  // SObjectType filter applies to BOTH sides, RecordType only (L78-80, L96).
  const sObjectType = isRecordType && !isBlank(objectContext) ? objectContext : null

  const sourceRecords = await io.queryNames('source', objectName, field, {
    sObjectType,
    activeOnly: false
  })
  // Target RecordType is active-only; every other object matches source (L96-102).
  const targetRecords = await io.queryNames('target', objectName, field, {
    sObjectType,
    activeOnly: isRecordType
  })

  return resolveNameToTargetMap(
    buildNameToId(sourceRecords, field),
    buildNameToId(targetRecords, field)
  )
}

/**
 * Port of the A13/A14 nameMatch-map building loop
 * (DataDeploymentQueueable.executeNormalModeV2 L1586-1614). For each reference
 * field with a `nameMatch` mapping, resolve its referenced object once (dedup by
 * refObj); then — A14 — if the object has a `RecordTypeId` reference, ALWAYS
 * force a RecordType resolve by DeveloperName (SObjectType = this object),
 * regardless of any saved mapping. Produces the `refObj → (sourceId → targetId)`
 * bundle that becomes `ctx.nameMatchMaps` for `transformRecordV3`.
 */
export async function buildNameMatchMaps(
  io: NameMatchIo,
  objectName: string,
  fields: ReadonlyArray<GoldenFieldInfo>,
  mappings: Record<string, GoldenMapping>
): Promise<Record<string, Record<string, string>>> {
  const maps: Record<string, Record<string, string>> = {}
  let objectHasRecordTypeId = false

  for (const fi of fields) {
    if (!fi.isReference) continue
    const refObj = fi.referenceTo?.[0]
    if (refObj == null) continue

    // Detect RecordTypeId for the A14 force — BEFORE the mapping-strategy filter,
    // since RecordTypeId typically carries no saved mapping (L1590-1592).
    if (ciEquals(fi.apiName, 'RecordTypeId') && ciEquals(refObj, 'RecordType')) {
      objectHasRecordTypeId = true
    }

    const cfg = mappings != null ? mappings[fi.apiName] : undefined
    if (cfg == null || !ciEquals(cfg.strategy, 'nameMatch')) continue
    if (Object.prototype.hasOwnProperty.call(maps, refObj)) continue // already resolved

    const objContext = ciEquals(refObj, 'RecordType') ? objectName : null
    maps[refObj] = await resolveNameMatch(io, refObj, cfg.matchField, objContext)
  }

  // A14 — RecordTypeId is always resolved by DeveloperName, even with no mapping.
  if (objectHasRecordTypeId && !Object.prototype.hasOwnProperty.call(maps, 'RecordType')) {
    maps['RecordType'] = await resolveNameMatch(io, 'RecordType', 'DeveloperName', objectName)
  }

  return maps
}
