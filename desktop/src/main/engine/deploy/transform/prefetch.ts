/**
 * E4X.6 — target-state prefetch bundle. Byte-faithful port of the Phase-A
 * context prefetch in `DataDeploymentQueueable.executeNormalModeV2`:
 *   - `needsTargetUser` + target user Id       (DDQ L1621-1639)
 *   - `fetchInactiveTargetUserIds`  — fail-LOUD (DDQ L1646-1649, L2425-2474)
 *   - restricted-picklist allowed values       (DDQ L1658-1665) — pure, from describe
 *   - `fetchInactivePbeSubstitutes` — fail-OPEN (DDQ L1675-1679, L2314-2401)
 *
 * These populate the transform context's `targetUserId` / `inactiveUserIds` /
 * `targetPicklistAllowedValues` / `inactivePbeIds` / `pbeSubstitutes`.
 *
 * THE FAIL-LOUD vs FAIL-OPEN SPLIT IS LOAD-BEARING (E4X.6 AC):
 *   - inactive-user fetch THROWS on query failure — an empty/partial set silently
 *     disables inactive-owner substitution and every inactive-User ref then fails
 *     INACTIVE_OWNER_OR_USER; the throw drives a bounded whole-object retry.
 *   - PBE-substitute fetch swallows errors — if it can't prefetch, the deploy
 *     proceeds and any inactive PBE surfaces as FIELD_INTEGRITY_EXCEPTION at upsert.
 *
 * ENGINE-PURE over an injected `PrefetchIo` (the SOQL here is fixed / Id-based —
 * no user input, so no `escapeSingleQuotes` needed; pagination is the IO's job).
 *
 * PARITY-FIRST: `ciEquals` for object/strategy literals; dual-form 15/18 Id
 * storage matches Apex; the `product|pricebook` pair key coerces null → 'null'
 * exactly as Apex string concatenation does.
 */

import { ciEquals, escapeSingleQuotes, isBlank } from './apexSemantics'
import type { GoldenFieldInfo, GoldenMapping } from '../golden/fixture'
import type { DescribeField } from './fieldFilter'
import {
  MASTER_RECORD_TYPE_ID,
  type RecordTypePicklists,
  type RtPicklistField
} from './recordTypePicklistGate'

export interface PrefetchIo {
  /** Connected/integration user Id on the TARGET org (getOrgUserId). */
  getTargetUserId(): Promise<string | null>
  /** Fully-paginated query against the TARGET org. REJECTS on failure — the
   *  caller decides fail-LOUD (propagate) vs fail-OPEN (wrap in try/catch). */
  queryTarget(soql: string): Promise<Array<Record<string, unknown>>>
  /**
   * S49 (BUG-9): one raw GET against the TARGET org's REST API, for the UI-API
   * record-type picklist endpoint (the only source of record-type-scoped and
   * dependent-picklist truth — none of it is in `describe`). REJECTS on
   * failure; `fetchRecordTypePicklists` is fail-OPEN around it.
   */
  restGetTarget(path: string): Promise<unknown>
}

/** The context slice this module produces (feeds the TransformContext). */
export interface PrefetchBundle {
  targetUserId: string | null
  inactiveUserIds: string[]
  targetPicklistAllowedValues: Record<string, string[]>
  inactivePbeIds: string[]
  pbeSubstitutes: Record<string, string | null>
  /** S49 (BUG-6): PBE Ids that exist on target (18- and 15-char). Empty = check off. */
  knownPbeIds: string[]
  /** S49 (BUG-9): record-type-scoped + dependent picklist values. Empty = check off. */
  recordTypePicklists: RecordTypePicklists
  /**
   * S50 (BUG-12): the record type the TARGET applies when a payload carries no
   * `RecordTypeId`. Null = unknown ⇒ the gate keeps failing open.
   */
  recordTypeDefaultId: string | null
  /**
   * S50 (BUG-12 hardening): how many ACTIVE record types the object has on
   * target, excluding Master. The default is only worth acting on when this is
   * <= 1 — see `resolveRtFields`.
   */
  recordTypeCandidateCount: number
}

const strOrNull = (v: unknown): string | null => (v == null ? null : String(v))

/** Apex `chunk(list, size)` (DDQ L2403-2415) — splits into fixed-size groups. */
function chunkArray<T>(input: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = []
  let current: T[] = []
  for (const s of input) {
    current.push(s)
    if (current.length === size) {
      out.push(current)
      current = []
    }
  }
  if (current.length > 0) out.push(current)
  return out
}

/**
 * A target user Id is needed when any field references User (for the inactive-
 * owner directId substitution) OR any mapping is `setToMe` (DDQ L1621-1635).
 */
export function needsTargetUser(
  fields: ReadonlyArray<GoldenFieldInfo>,
  mappings: Record<string, GoldenMapping> | null | undefined
): boolean {
  for (const fi of fields) {
    if (
      fi.isReference &&
      fi.referenceTo != null &&
      fi.referenceTo.length > 0 &&
      ciEquals(fi.referenceTo[0], 'User')
    ) {
      return true
    }
  }
  if (mappings != null) {
    for (const cfg of Object.values(mappings)) {
      if (cfg != null && ciEquals(cfg.strategy, 'setToMe')) return true
    }
  }
  return false
}

/**
 * FAIL-LOUD (DDQ L2425-2474): the full inactive-User Id set on target, stored in
 * both the raw form AND the 15-char form (source refs come back 18-char from
 * REST; the caller compares raw). Propagates the IO rejection — a partial/empty
 * set is as dangerous as none.
 */
export async function fetchInactiveTargetUserIds(io: PrefetchIo): Promise<Set<string>> {
  const recs = await io.queryTarget('SELECT Id FROM User WHERE IsActive = false')
  const result = new Set<string>()
  for (const rm of recs) {
    const uid = strOrNull(rm['Id'])
    if (uid == null || isBlank(uid)) continue
    result.add(uid)
    if (uid.length === 18) result.add(uid.substring(0, 15))
  }
  return result
}

/** Restricted-picklist allowed values from the TARGET describe (DDQ L1658-1665). */
export function buildTargetPicklistAllowedValues(
  targetFields: ReadonlyArray<DescribeField>
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const tfi of targetFields) {
    if (tfi.isRestrictedPicklist !== true) continue
    if (tfi.picklistValues == null) continue
    out[tfi.apiName] = [...tfi.picklistValues]
  }
  return out
}

/**
 * FAIL-OPEN (DDQ L2314-2401): prefetch inactive PBEs on target and, for each,
 * the active substitute sharing its (Product2, Pricebook2) pair. Ids stored in
 * both 18- and 15-char forms; a substitute of `null` means "no active PBE for
 * this pair → the caller skips the OLI". Any error → return whatever accumulated.
 */
export async function fetchInactivePbeSubstitutes(
  io: PrefetchIo
): Promise<{ inactivePbeIds: Set<string>; pbeSubstitutes: Record<string, string | null> }> {
  const inactivePbeIds = new Set<string>()
  const pbeSubstitutes: Record<string, string | null> = {}
  try {
    const inactiveRecs = await io.queryTarget(
      'SELECT Id, Product2Id, Pricebook2Id FROM PricebookEntry WHERE IsActive = false'
    )
    const inactives: Array<{ id: string; product: string | null; pricebook: string | null }> = []
    for (const rm of inactiveRecs) {
      const pid = strOrNull(rm['Id'])
      if (pid == null || isBlank(pid)) continue
      inactivePbeIds.add(pid)
      if (pid.length === 18) inactivePbeIds.add(pid.substring(0, 15))
      inactives.push({ id: pid, product: strOrNull(rm['Product2Id']), pricebook: strOrNull(rm['Pricebook2Id']) })
    }
    if (inactives.length === 0) return { inactivePbeIds, pbeSubstitutes }

    const products = new Set<string>()
    const pricebooks = new Set<string>()
    for (const inact of inactives) {
      if (inact.product != null) products.add(inact.product)
      if (inact.pricebook != null) pricebooks.add(inact.pricebook)
    }
    if (products.size === 0 || pricebooks.size === 0) return { inactivePbeIds, pbeSubstitutes }

    const prodList = [...products].map((p) => "'" + p + "'")
    const pbList = [...pricebooks].map((p) => "'" + p + "'")

    // (product, pricebook) → active PBE Id, one bulk query per ≤150-product chunk.
    const pairToActiveId = new Map<string, string>()
    for (const chunk of chunkArray(prodList, 150)) {
      const activeSoql =
        'SELECT Id, Product2Id, Pricebook2Id FROM PricebookEntry ' +
        'WHERE IsActive = true AND Product2Id IN (' +
        chunk.join(',') +
        ') AND Pricebook2Id IN (' +
        pbList.join(',') +
        ')'
      const arecs = await io.queryTarget(activeSoql)
      for (const rm of arecs) {
        const key = `${strOrNull(rm['Product2Id'])}|${strOrNull(rm['Pricebook2Id'])}`
        const activeId = strOrNull(rm['Id'])
        if (activeId != null) pairToActiveId.set(key, activeId)
      }
    }

    for (const inact of inactives) {
      const pair = `${inact.product}|${inact.pricebook}` // null → 'null' (Apex concat parity)
      const activeId = pairToActiveId.get(pair) ?? null // may be null → caller skips the OLI
      pbeSubstitutes[inact.id] = activeId
      if (inact.id.length === 18) pbeSubstitutes[inact.id.substring(0, 15)] = activeId
    }
  } catch {
    // FAIL-OPEN — proceed with whatever we accumulated.
  }
  return { inactivePbeIds, pbeSubstitutes }
}

/**
 * S49 FIX (BUG-6): every PricebookEntry Id that EXISTS on target, in both 18-
 * and 15-char forms.
 *
 * `fetchInactivePbeSubstitutes` only knows about PBEs that are INACTIVE on
 * target, so a PBE that is missing from the target entirely sailed through the
 * gate and was rejected by the API as
 * `FIELD_INTEGRITY_EXCEPTION: PricebookEntryId, unknown` /
 * `NOT_FOUND: The requested resource does not exist`. Live case: OLIs pointing
 * at `01uTH000007mejtYAA` ("Vega (Premium Agent)"), ACTIVE on darkb_829 and
 * absent from sb1_830, failed on runs 2 and 3 — where run 1 had cleanly SKIPPED
 * the equivalent class as `inactive_pbe_no_substitute`.
 *
 * An absent PBE cannot be substituted (its target (Product2, Pricebook2) pair is
 * unknowable from the payload, which carries only the Id), so the gate skips the
 * OLI with a distinct reason instead. Fail-OPEN: an error yields an EMPTY set,
 * which disables the new check entirely and preserves pre-S49 behaviour rather
 * than skipping every OLI.
 */
export async function fetchKnownPbeIds(io: PrefetchIo): Promise<Set<string>> {
  const known = new Set<string>()
  try {
    const recs = await io.queryTarget('SELECT Id FROM PricebookEntry')
    for (const rm of recs) {
      const pid = strOrNull(rm['Id'])
      if (pid == null || isBlank(pid)) continue
      known.add(pid)
      if (pid.length === 18) known.add(pid.substring(0, 15))
    }
  } catch {
    return new Set<string>()
  }
  return known
}

/**
 * The UI-API version the record-type picklist endpoint is called at. Pinned to
 * the same v66.0 the rest of the app uses (services/salesforce.ts API_VERSION);
 * kept local so the pure engine keeps its no-services import rule.
 */
const UI_API_VERSION = '66.0'

/**
 * Refuse to fan out beyond this many record types for one object. Each record
 * type costs one UI-API round trip; an object with a pathological record-type
 * count would stall the pass for a check that is an optimisation, not a
 * correctness requirement. Opportunity on sb1_830 has 11.
 */
const MAX_RECORD_TYPES = 40

/**
 * S49 (BUG-9): prefetch the record-type-scoped + dependent-picklist value sets
 * for `objectName` on TARGET.
 *
 * `describe.picklistValues` is the field's FULL active value set; the platform
 * enforces a narrower one per record (record-type assignment, and the
 * controlling-field `validFor` bitmap for dependent picklists). Neither is in
 * describe. The UI API's picklist-values-by-record-type endpoint returns BOTH
 * in one call per record type, with `validFor` already decoded to indices — so
 * one round trip per record type covers the whole object.
 *
 * FAIL-OPEN at every level: no restricted picklist on the object (the common
 * case) short-circuits before any IO; a failed RecordType query, a failed or
 * unparseable UI-API response, or a blown record-type budget yields whatever
 * accumulated (possibly nothing), which disables the gate rather than dropping
 * good values on a guess.
 */
export async function fetchRecordTypePicklists(
  io: PrefetchIo,
  objectName: string,
  targetFields: ReadonlyArray<DescribeField>,
  /**
   * S50 (BUG-12) out-parameter: receives the object's DEFAULT record type id.
   * See `fetchDefaultRecordTypeId` for why this is load-bearing.
   */
  defaultOut?: { id: string | null; candidateCount: number }
): Promise<RecordTypePicklists> {
  const out: RecordTypePicklists = {}

  // Record-type scoping and validFor are only ENFORCED on restricted
  // picklists — an unrestricted one accepts any value regardless. So an object
  // without one needs no round trips at all.
  let hasRestricted = false
  const controllerByField: Record<string, string> = {}
  for (const tfi of targetFields) {
    if (tfi.isRestrictedPicklist === true) hasRestricted = true
    const ctrl = tfi.controllerName
    if (ctrl != null && !isBlank(ctrl)) controllerByField[tfi.apiName] = ctrl
  }
  if (!hasRestricted) return out

  try {
    const rtIds: string[] = [MASTER_RECORD_TYPE_ID]
    const rtRows = await io.queryTarget(
      "SELECT Id FROM RecordType WHERE IsActive = true AND SobjectType = '" +
        escapeSingleQuotes(objectName) +
        "'"
    )
    for (const rm of rtRows) {
      const rid = strOrNull(rm['Id'])
      if (rid == null || isBlank(rid)) continue
      rtIds.push(rid)
    }
    if (rtIds.length > MAX_RECORD_TYPES) return out

    // S50 (BUG-12): learn the DEFAULT record type before reading value sets.
    // rtIds[0] is always MASTER, so the remainder is the ACTIVE record-type
    // count — what decides whether the default is unambiguous.
    if (defaultOut != null) {
      defaultOut.candidateCount = Math.max(0, rtIds.length - 1)
      defaultOut.id = await fetchDefaultRecordTypeId(io, objectName)
    }

    for (const rtId of rtIds) {
      let body: unknown
      try {
        body = await io.restGetTarget(
          '/services/data/v' +
            UI_API_VERSION +
            '/ui-api/object-info/' +
            encodeURIComponent(objectName) +
            '/picklist-values/' +
            encodeURIComponent(rtId)
        )
      } catch {
        // One unreadable record type must not void the others (a record type
        // the integration user cannot see is normal).
        continue
      }
      const parsed = parseUiApiPicklistValues(body, controllerByField)
      if (parsed == null) continue
      out[rtId] = parsed
      // Store both Id widths so a 15-char RecordTypeId on the payload resolves.
      if (rtId.length === 18) out[rtId.substring(0, 15)] = parsed
    }
  } catch {
    return {}
  }
  return out
}

/**
 * The UI API HTML-escapes picklist values; `describe` and the record data do
 * NOT. Live proof: `Opportunity.Value_Drivers__c` comes back from the UI API as
 * `Maximize Speed &amp; Efficiency of Safe Software Delivery` while the source
 * record holds `Maximize Speed & Efficiency of Safe Software Delivery`. Compared
 * raw, the gate would drop a PERFECTLY VALID value — the exact data loss it
 * exists to prevent. Unescape on the way in so every comparison downstream is
 * against the same literal form the payload carries.
 */
function unescapeHtmlEntities(v: string): string {
  if (!v.includes('&')) return v
  return v
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&') // LAST — otherwise '&amp;lt;' double-decodes
}

/**
 * S50 (BUG-12) — the record type the platform applies when an insert carries NO
 * `RecordTypeId`.
 *
 * WHY THIS EXISTS. The S49 gate skipped the record-type check whenever the
 * payload had no `RecordTypeId`, reasoning that "we cannot know which default
 * the target profile will apply". That reasoning was WRONG, and it cost a whole
 * live run: express scripts (run 9, 2026-09-07). `Account.Account_Category__c`
 * is restricted with the full active set {Strategic Account, Key Account,
 * General}, so stage 2 passed `Key Account`. But Account has ONE active record
 * type, `CSM`, which is the DEFAULT — and CSM allows only {Strategic Account,
 * General}. The source Account carried `RecordTypeId = null`, the platform
 * applied CSM, and the root record died on
 * INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST. One field took down the whole
 * deployment (see BUG-13 for the blast radius).
 *
 * The default IS knowable: the UI-API object-info payload names it outright,
 * both as a top-level `defaultRecordTypeId` and via
 * `recordTypeInfos[…].defaultRecordTypeMapping`. Read both, prefer the explicit
 * field. (Verified identical on darkb_829 and sb1_830 — this was NOT org drift;
 * the source org would reject the same insert.)
 *
 * FAIL-OPEN: any error, or an unreadable response, yields null and the gate
 * keeps its pre-S50 skip-when-unknown behaviour.
 */
export async function fetchDefaultRecordTypeId(
  io: PrefetchIo,
  objectName: string
): Promise<string | null> {
  try {
    const body = await io.restGetTarget(
      '/services/data/v' + UI_API_VERSION + '/ui-api/object-info/' + encodeURIComponent(objectName)
    )
    if (body == null || typeof body !== 'object') return null
    const rec = body as Record<string, unknown>
    const explicit = rec['defaultRecordTypeId']
    if (typeof explicit === 'string' && explicit.length > 0) return explicit
    const infos = rec['recordTypeInfos']
    if (infos != null && typeof infos === 'object') {
      for (const [rtId, raw] of Object.entries(infos as Record<string, unknown>)) {
        if (raw == null || typeof raw !== 'object') continue
        if ((raw as Record<string, unknown>)['defaultRecordTypeMapping'] === true) return rtId
      }
    }
    return null
  } catch {
    return null
  }
}

/** Shape-tolerant reader for the UI-API `picklistFieldValues` response. */
function parseUiApiPicklistValues(
  body: unknown,
  controllerByField: Record<string, string>
): Record<string, RtPicklistField> | null {
  if (body == null || typeof body !== 'object') return null
  const fieldValues = (body as Record<string, unknown>)['picklistFieldValues']
  if (fieldValues == null || typeof fieldValues !== 'object') return null

  const out: Record<string, RtPicklistField> = {}
  for (const [fieldName, rawField] of Object.entries(fieldValues as Record<string, unknown>)) {
    if (rawField == null || typeof rawField !== 'object') continue
    const f = rawField as Record<string, unknown>

    const controllerValues: Record<string, number> = {}
    const rawCtrl = f['controllerValues']
    if (rawCtrl != null && typeof rawCtrl === 'object') {
      for (const [cv, idx] of Object.entries(rawCtrl as Record<string, unknown>)) {
        // Controller keys are the controlling field's picklist values, escaped
        // the same way — unescape so they match the payload's literal form.
        if (typeof idx === 'number') controllerValues[unescapeHtmlEntities(cv)] = idx
      }
    }

    const values: string[] = []
    const validFor: Record<string, number[]> = {}
    const rawValues = f['values']
    if (!Array.isArray(rawValues)) continue
    for (const rv of rawValues) {
      if (rv == null || typeof rv !== 'object') continue
      const rawV = (rv as Record<string, unknown>)['value']
      if (typeof rawV !== 'string') continue
      const v = unescapeHtmlEntities(rawV)
      values.push(v)
      const vf = (rv as Record<string, unknown>)['validFor']
      validFor[v] = Array.isArray(vf) ? vf.filter((n): n is number => typeof n === 'number') : []
    }

    // Only a field the describe says is dependent gets controller treatment;
    // `controllerValues` is empty for independent picklists anyway, but the
    // describe is what tells us WHICH payload key holds the controlling value.
    const controllerName =
      Object.keys(controllerValues).length > 0 ? (controllerByField[fieldName] ?? null) : null

    out[fieldName] = { values, controllerName, controllerValues, validFor }
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Assembles the full prefetch bundle in the Apex order (user → inactive users →
 * picklists → PBE). Inactive-user fetch is fail-LOUD (a rejection propagates);
 * PBE fetch is fail-OPEN. PBE prefetch runs for OpportunityLineItem only.
 */
export async function buildPrefetchContext(
  io: PrefetchIo,
  objectName: string,
  fields: ReadonlyArray<GoldenFieldInfo>,
  mappings: Record<string, GoldenMapping>,
  targetFields: ReadonlyArray<DescribeField>
): Promise<PrefetchBundle> {
  const needUser = needsTargetUser(fields, mappings)
  const targetUserId = needUser ? await io.getTargetUserId() : null
  const inactiveUserIds = needUser ? [...(await fetchInactiveTargetUserIds(io))] : []
  const targetPicklistAllowedValues = buildTargetPicklistAllowedValues(targetFields)
  // S49 (BUG-9) / S50 (BUG-12) — fail-OPEN; short-circuits with no IO when the
  // object has no restricted picklist.
  const rtDefault = { id: null as string | null, candidateCount: 0 }
  const recordTypePicklists = await fetchRecordTypePicklists(
    io,
    objectName,
    targetFields,
    rtDefault
  )

  let inactivePbeIds: string[] = []
  let pbeSubstitutes: Record<string, string | null> = {}
  let knownPbeIds: string[] = []
  if (ciEquals(objectName, 'OpportunityLineItem')) {
    const pbe = await fetchInactivePbeSubstitutes(io)
    inactivePbeIds = [...pbe.inactivePbeIds]
    pbeSubstitutes = pbe.pbeSubstitutes
    knownPbeIds = [...(await fetchKnownPbeIds(io))]
  }

  return {
    targetUserId,
    inactiveUserIds,
    targetPicklistAllowedValues,
    inactivePbeIds,
    pbeSubstitutes,
    knownPbeIds,
    recordTypePicklists,
    recordTypeDefaultId: rtDefault.id,
    recordTypeCandidateCount: rtDefault.candidateCount
  }
}
