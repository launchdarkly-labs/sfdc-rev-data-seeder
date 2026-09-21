/**
 * E4A.2 — Validation Rule + Flow toggle engine. Port of the Apex N3 composite
 * batching machinery in `AutomationManagementService.cls` (AMS):
 *
 *  - postToolingComposite            (AMS:536-553)
 *  - setValidationRulesActiveComposite / toggleVrChunkComposite (AMS:559-626)
 *  - updateValidationRuleActive      (AMS:746-783)
 *  - setFlowsActiveComposite / toggleFlowChunkComposite (AMS:632-741)
 *  - deactivateFlow / reactivateFlow / setFlowActiveVersionFull (AMS:785-851)
 *  - toolingQuery (non-strict)       (AMS:1041-1054)
 *
 * The load-bearing semantics, each verified against the Apex source:
 *  - Chunks of COMPOSITE_MAX=25: one composite of GETs reads the CURRENT full
 *    Metadata, the flag is flipped in memory, one composite of PATCHes writes
 *    the ENTIRE Metadata object back (Tooling rejects partial VR payloads with
 *    "Required field is missing: errorConditionFormula", AMS:747-749).
 *  - ANY chunk anomaly (overall composite failure, subresponse count mismatch,
 *    non-200 GET, missing Metadata, unresolvable flow, missing restore
 *    version) returns null → the WHOLE chunk re-runs on the proven per-item
 *    path. Worst case is exactly the pre-N3 behavior — never a broken restore.
 *  - Idempotent short-circuits: an item already in the target state is counted
 *    done without a PATCH (and per-item re-runs of a fallen-back chunk
 *    re-confirm them the same way).
 *  - REVIEW-FIX #9 (AMS:615-624, 735-741): a non-2xx PATCH subrequest in an
 *    allOrNone=false composite is retried per-item, never silently dropped.
 *  - REVIEW-FIX #3 (AMS:655-668, 689-692): the per-item flow fallback is
 *    SELF-RESOLVING (deactivateFlow/reactivateFlow run their own Flow→
 *    DefinitionId query), so it recovers even when the batch resolution query
 *    failed and flowToDef is empty. The non-strict toolingQuery returns [] on
 *    HTTP failure (AMS:1046-1049) — it must NOT throw, or the fallback never
 *    gets its chance.
 *  - Flow restore prefers the version captured AT DISABLE time
 *    (`restoreVersionNumber`) over the current org version
 *    (effectiveRestoreVersion, AMS:675-680 — wrong-version-on-restore race).
 *    Disable always targets activeVersionNumber = 0.
 *  - The composite subrequest `url`s are PAYLOAD bytes (inside the POST body),
 *    so the `/services/data/v66.0/...` prefix is hardcoded exactly as the
 *    Apex string literals are — not derived from the app-wide API_VERSION.
 *  - toolingQuery reads only the FIRST response page (no queryMore), exactly
 *    like the Apex helper — unresolved tail items degrade to the per-item
 *    fallback, same as Apex.
 *
 * Documented micro-deviations (all unobservable against real Salesforce
 * responses; each degrades toward the fallback/false path where Apex would
 * throw an uncaught cast exception on a malformed body shape):
 *  - non-Map/records CONTAINER shapes → treated as anomaly (fallback / false /
 *    []), where an Apex (Map<String,Object>)/(List<Object>) cast would throw.
 *    Scalar LEAVES keep the Apex throw exactly: a non-Boolean/non-String
 *    Metadata.active (apexBoolean ≙ Boolean.valueOf, AMS:602/767) and a
 *    non-number Flow.VersionNumber in reactivateFlow (≙ the raw (Integer)
 *    cast, AMS:802) throw — uncaught in the chunk path, caught + item-excluded
 *    by the per-item fallback callers, matching Apex in both directions.
 *  - The query URL is encodeURIComponent-encoded ('+ ' for spaces to match
 *    EncodingUtil.urlEncode); residual char-level differences (e.g. `'`, `(`)
 *    are transport-cosmetic — Salesforce decodes both identically.
 *
 * ENGINE-PURE: no jsforce/better-sqlite3 — all IO through AutomationToggleIo.
 * The live adapter (services/automationToggleIo.ts) gates EVERY callout with
 * GuardedOrg.assertWritable: toggles only ever run against the TARGET org.
 */
import type { AutomationItem } from '../../shared/types'

/** Apex COMPOSITE_MAX (AMS:523). */
export const COMPOSITE_MAX = 25

const TOOLING = '/services/data/v66.0/tooling'
/** Apex TOOLING_QUERY (AMS:8). */
const TOOLING_QUERY = `${TOOLING}/query/?q=`

/** Mirror of `OrgConnectionService.CalloutResult` as the toggles consume it. */
export interface ToggleCalloutResult {
  success: boolean
  statusCode: number
  /** Response body JSON (may be absent/empty on failure or 204). */
  body?: string | null
  errorMessage?: string | null
}

export type ToggleHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/**
 * The injected IO seam — one method, shaped like the Apex
 * `OrgConnectionService.makeCallout(path, method, body)` every toggle path
 * runs through. MUST resolve (success:false) on HTTP/network errors, never
 * reject — the null→fallback ladders depend on it. (The live adapter still
 * THROWS on a write-gate violation: that is a structural bug, not a fallback
 * case.)
 */
export interface AutomationToggleIo {
  callout(path: string, method: ToggleHttpMethod, body: string | null): Promise<ToggleCalloutResult>
  /** System.debug parity channel — warnings on fallback/skip paths. */
  log?(level: 'warn' | 'error', message: string): void
}

// ─────────────────────────────── pure helpers ────────────────────────────────

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Codebase-standard SOQL quote escaping (matches automationDiscovery). */
const escapeSingleQuotes = (s: string): string => s.replace(/'/g, "\\'")

/** EncodingUtil.urlEncode parity for the common case (spaces → '+').
 *  Exported for the sibling trigger-body toggle engine (E4A.3). */
export const urlEncode = (s: string): string => encodeURIComponent(s).replace(/%20/g, '+')

/**
 * Apex Boolean.valueOf(Object): Boolean → itself, String → ci-'true'; any
 * OTHER type throws (System.TypeException) — uncaught in the chunk path
 * (aborts the whole set* call, AMS:602), caught + item-excluded by the
 * per-item fallback callers (AMS:767 via :569/:621). Success-counting a
 * malformed leaf would diverge from the frozen Apex.
 */
function apexBoolean(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v.toLowerCase() === 'true'
  throw new TypeError(`Invalid boolean: ${String(v)}`)
}

/** Apex Integer.valueOf(Object) for JSON numbers; null when unconvertible. */
function apexInteger(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v.trim(), 10)
  return null
}

/** Apex subStatus (AMS:525-528): missing/unreadable → 0 (≠200 → anomaly). */
function subStatus(sub: unknown): number {
  const sc = asRecord(sub)?.httpStatusCode
  return apexInteger(sc) ?? 0
}

/** Apex subBody (AMS:529-531). */
function subBody(sub: unknown): Record<string, unknown> | null {
  return asRecord(asRecord(sub)?.body)
}

// ─────────────────────────── composite + query core ──────────────────────────

/**
 * POST /tooling/composite with allOrNone=false (AMS:536-553). Returns the
 * ordered compositeResponse list (one entry per subrequest), or null if the
 * overall POST failed or the body couldn't be parsed — the caller falls back
 * to per-item.
 */
export async function postToolingComposite(
  io: AutomationToggleIo,
  subrequests: ReadonlyArray<Record<string, unknown>>
): Promise<unknown[] | null> {
  if (subrequests.length === 0) return []
  const body = JSON.stringify({ allOrNone: false, compositeRequest: subrequests })
  const res = await io.callout(`${TOOLING}/composite`, 'POST', body)
  if (!(res.success || res.statusCode === 200)) return null
  try {
    const parsed = asRecord(JSON.parse(res.body ?? ''))
    const cr = parsed?.compositeResponse
    return Array.isArray(cr) ? cr : null
  } catch {
    return null
  }
}

/**
 * Non-strict Tooling query (AMS:1041-1054): [] on HTTP failure (WARN log),
 * never throws on failure — the self-resolving flow fallback depends on it.
 * First response page only, like Apex.
 */
async function toolingQuery(io: AutomationToggleIo, soql: string): Promise<unknown[]> {
  const result = await io.callout(TOOLING_QUERY + urlEncode(soql), 'GET', null)
  if (!result.success) {
    io.log?.('warn', `Tooling query failed: ${result.errorMessage ?? null}`)
    return []
  }
  const response = asRecord(JSON.parse(result.body ?? ''))
  const records = response?.records
  return Array.isArray(records) ? records : []
}

// ─────────────────────────────── Validation Rules ────────────────────────────

/**
 * Batched VR active-flip (AMS:559-577). Returns the items confirmed toggled
 * (or already in state). A chunk that can't complete via composite falls back
 * to per-item.
 */
export async function setValidationRulesActiveComposite(
  io: AutomationToggleIo,
  vrs: ReadonlyArray<AutomationItem>,
  active: boolean
): Promise<AutomationItem[]> {
  const done: AutomationItem[] = []
  for (let start = 0; start < vrs.length; start += COMPOSITE_MAX) {
    const chunk = vrs.slice(start, start + COMPOSITE_MAX)
    const r = await toggleVrChunkComposite(io, chunk, active)
    if (r === null) {
      for (const vr of chunk) {
        try {
          if (await updateValidationRuleActive(io, vr.id, active)) done.push(vr)
        } catch (e) {
          io.log?.('warn', `VR composite fallback failed: ${errText(e)}`)
        }
      }
    } else {
      done.push(...r)
    }
  }
  return done
}

/** Returns the toggled items on full success, or null → "fall back to per-item" (AMS:580-626). */
async function toggleVrChunkComposite(
  io: AutomationToggleIo,
  chunk: ReadonlyArray<AutomationItem>,
  active: boolean
): Promise<AutomationItem[] | null> {
  const gets = chunk.map((vr, i) => ({
    method: 'GET',
    url: `${TOOLING}/sobjects/ValidationRule/${vr.id}`,
    referenceId: `g${i}`
  }))
  const getResp = await postToolingComposite(io, gets)
  if (getResp === null || getResp.length !== chunk.length) return null

  const localDone: AutomationItem[] = []
  const patches: Array<Record<string, unknown>> = []
  const patchItems: AutomationItem[] = []
  for (let i = 0; i < chunk.length; i++) {
    if (subStatus(getResp[i]) !== 200) return null
    const recBody = subBody(getResp[i])
    const metadata = recBody === null ? null : asRecord(recBody.Metadata)
    if (metadata === null) return null
    const cur = metadata.active
    if (cur != null && apexBoolean(cur) === active) {
      localDone.push(chunk[i]!)
      continue
    }
    metadata.active = active
    patches.push({
      method: 'PATCH',
      url: `${TOOLING}/sobjects/ValidationRule/${chunk[i]!.id}`,
      referenceId: `p${patchItems.length}`,
      body: { Metadata: metadata }
    })
    patchItems.push(chunk[i]!)
  }
  if (patches.length === 0) return localDone
  const patchResp = await postToolingComposite(io, patches)
  if (patchResp === null || patchResp.length !== patchItems.length) return null
  for (let i = 0; i < patchItems.length; i++) {
    const sc = subStatus(patchResp[i])
    if (sc === 200 || sc === 204) {
      localDone.push(patchItems[i]!)
      continue
    }
    // REVIEW-FIX #9: a dropped subrequest retries on the proven per-item path.
    try {
      if (await updateValidationRuleActive(io, patchItems[i]!.id, active)) {
        localDone.push(patchItems[i]!)
      }
    } catch (e) {
      io.log?.('warn', `VR subrequest retry failed: ${errText(e)}`)
    }
  }
  return localDone
}

/**
 * Per-item VR toggle (AMS:746-783): GET the whole record, flip Metadata.active
 * in memory, PATCH (via the `?_HttpMethod=PATCH` POST override, verbatim) the
 * ENTIRE Metadata back. Short-circuits to true when already in state.
 */
export async function updateValidationRuleActive(
  io: AutomationToggleIo,
  ruleId: string,
  active: boolean
): Promise<boolean> {
  const getResult = await io.callout(`${TOOLING}/sobjects/ValidationRule/${ruleId}`, 'GET', null)
  if (!getResult.success) {
    io.log?.('warn', `VR GET failed for ${ruleId}: ${getResult.errorMessage ?? null}`)
    return false
  }
  const rec = asRecord(JSON.parse(getResult.body ?? ''))
  const metadata = rec === null ? null : asRecord(rec.Metadata)
  if (metadata === null) {
    io.log?.('warn', `VR ${ruleId} has no Metadata block`)
    return false
  }
  const currentActive = metadata.active
  if (currentActive != null && apexBoolean(currentActive) === active) return true
  metadata.active = active
  const result = await io.callout(
    `${TOOLING}/sobjects/ValidationRule/${ruleId}?_HttpMethod=PATCH`,
    'POST',
    JSON.stringify({ Metadata: metadata })
  )
  if (!(result.statusCode === 204 || result.statusCode === 200 || result.success)) {
    io.log?.('warn', `VR PATCH failed for ${ruleId}: ${result.errorMessage ?? null}`)
    return false
  }
  return true
}

// ─────────────────────────────────── Flows ───────────────────────────────────

/**
 * Batched flow activate/deactivate via FlowDefinition.Metadata.activeVersionNumber
 * (AMS:632-673). `disable=true` targets version 0; restore targets the
 * disable-time captured version (fallback: the current version resolved here).
 * NOTE the Apex polarity difference vs the VR API: this takes `disable`, not
 * `active` — kept verbatim.
 */
export async function setFlowsActiveComposite(
  io: AutomationToggleIo,
  flows: ReadonlyArray<AutomationItem>,
  disable: boolean
): Promise<AutomationItem[]> {
  const done: AutomationItem[] = []
  if (flows.length === 0) return done

  // Resolve Flow(301) → DefinitionId (+ current VersionNumber as a restore
  // fallback). One unchunked query, first page only — exactly Apex; anything
  // unresolved lands on the self-resolving per-item fallback.
  const flowToDef = new Map<string, string>()
  const flowToVer = new Map<string, number>()
  const quoted = flows.map((f) => `'${escapeSingleQuotes(f.id)}'`)
  for (const rec of await toolingQuery(
    io,
    `SELECT Id, DefinitionId, VersionNumber FROM Flow WHERE Id IN (${quoted.join(',')})`
  )) {
    const m = asRecord(rec)
    const id = typeof m?.Id === 'string' ? m.Id : null
    if (id === null) continue
    if (typeof m!.DefinitionId === 'string') flowToDef.set(id, m!.DefinitionId as string)
    const ver = m!.VersionNumber == null ? null : apexInteger(m!.VersionNumber)
    if (ver !== null) flowToVer.set(id, ver)
  }

  for (let start = 0; start < flows.length; start += COMPOSITE_MAX) {
    const chunk = flows.slice(start, start + COMPOSITE_MAX)
    const r = await toggleFlowChunkComposite(io, chunk, disable, flowToDef, flowToVer)
    if (r === null) {
      for (const f of chunk) {
        // REVIEW-FIX #3: SELF-RESOLVING per-item fallback — deactivateFlow /
        // reactivateFlow run their OWN Flow→DefinitionId query, so they recover
        // even when the batch resolution above failed and flowToDef is empty.
        try {
          const okItem = disable ? await deactivateFlow(io, f.id) : await reactivateFlow(io, f.id)
          if (okItem) done.push(f)
        } catch (e) {
          io.log?.('warn', `Flow composite fallback failed: ${errText(e)}`)
        }
      }
    } else {
      done.push(...r)
    }
  }
  return done
}

/** Disable-time version preferred over the current org version (AMS:675-680). */
function effectiveRestoreVersion(f: AutomationItem, flowToVer: Map<string, number>): number | null {
  if (f.restoreVersionNumber != null) return f.restoreVersionNumber
  return flowToVer.get(f.id) ?? null
}

/** Returns toggled items on full success, or null → per-item fallback (AMS:682-741). */
async function toggleFlowChunkComposite(
  io: AutomationToggleIo,
  chunk: ReadonlyArray<AutomationItem>,
  disable: boolean,
  flowToDef: Map<string, string>,
  flowToVer: Map<string, number>
): Promise<AutomationItem[] | null> {
  const gets: Array<Record<string, unknown>> = []
  const getItems: AutomationItem[] = []
  for (const f of chunk) {
    const defId = flowToDef.get(f.id)
    // REVIEW-FIX #3: ANY unresolvable item bails the whole chunk to the
    // self-resolving per-item fallback rather than silently dropping it.
    if (defId == null) return null
    gets.push({
      method: 'GET',
      url: `${TOOLING}/sobjects/FlowDefinition/${defId}`,
      referenceId: `g${getItems.length}`
    })
    getItems.push(f)
  }
  if (gets.length === 0) return []
  const getResp = await postToolingComposite(io, gets)
  if (getResp === null || getResp.length !== getItems.length) return null

  const localDone: AutomationItem[] = []
  const patches: Array<Record<string, unknown>> = []
  const patchItems: AutomationItem[] = []
  for (let i = 0; i < getItems.length; i++) {
    if (subStatus(getResp[i]) !== 200) return null
    const recBody = subBody(getResp[i])
    const metadata = recBody === null ? null : asRecord(recBody.Metadata)
    if (metadata === null) return null
    const f = getItems[i]!
    const target = disable ? 0 : effectiveRestoreVersion(f, flowToVer)
    if (target === null) return null // can't restore without a version → fall back
    const cur = metadata.activeVersionNumber
    const curInt = cur == null ? null : apexInteger(cur)
    if (curInt !== null && curInt === target) {
      localDone.push(f)
      continue
    }
    metadata.activeVersionNumber = target
    patches.push({
      method: 'PATCH',
      url: `${TOOLING}/sobjects/FlowDefinition/${flowToDef.get(f.id)}`,
      referenceId: `p${patchItems.length}`,
      body: { Metadata: metadata }
    })
    patchItems.push(f)
  }
  if (patches.length === 0) return localDone
  const patchResp = await postToolingComposite(io, patches)
  if (patchResp === null || patchResp.length !== patchItems.length) return null
  for (let i = 0; i < patchItems.length; i++) {
    const sc = subStatus(patchResp[i])
    if (sc === 200 || sc === 204) {
      localDone.push(patchItems[i]!)
      continue
    }
    // REVIEW-FIX #9: retry a dropped subrequest on the self-resolving per-item path.
    try {
      const f = patchItems[i]!
      const okItem = disable ? await deactivateFlow(io, f.id) : await reactivateFlow(io, f.id)
      if (okItem) localDone.push(f)
    } catch (e) {
      io.log?.('warn', `Flow subrequest retry failed: ${errText(e)}`)
    }
  }
  return localDone
}

/** Per-item flow disable — self-resolving Flow(301)→DefinitionId (AMS:785-792). */
export async function deactivateFlow(io: AutomationToggleIo, flowId: string): Promise<boolean> {
  const records = await toolingQuery(
    io,
    `SELECT DefinitionId FROM Flow WHERE Id = '${escapeSingleQuotes(flowId)}'`
  )
  if (records.length === 0) return false
  const defId = asRecord(records[0])?.DefinitionId
  if (typeof defId !== 'string') return false
  return setFlowActiveVersionFull(io, defId, 0)
}

/**
 * Per-item flow restore (AMS:794-806). Restores to the queried Flow(301)
 * record's OWN VersionNumber — the 301 id pins the exact version that was
 * active at discovery, so this equals the captured restore version.
 */
export async function reactivateFlow(io: AutomationToggleIo, flowId: string): Promise<boolean> {
  const records = await toolingQuery(
    io,
    `SELECT DefinitionId, VersionNumber FROM Flow WHERE Id = '${escapeSingleQuotes(flowId)}'`
  )
  if (records.length === 0) return false
  const flowRec = asRecord(records[0])
  const defId = typeof flowRec?.DefinitionId === 'string' ? flowRec.DefinitionId : null
  // Apex used a raw `(Integer)` cast here (AMS:802), NOT Integer.valueOf: null
  // passes through, a number converts, but a STRING throws — and the callers
  // catch + exclude the flow. Every other version read in this module uses
  // Integer.valueOf (string-coercing apexInteger); only this site is strict.
  const vnRaw = flowRec?.VersionNumber
  if (vnRaw != null && typeof vnRaw !== 'number') {
    throw new TypeError(`Invalid integer: ${String(vnRaw)}`)
  }
  const versionNumber = vnRaw == null ? null : Math.trunc(vnRaw)
  if (defId === null || versionNumber === null) return false
  return setFlowActiveVersionFull(io, defId, versionNumber)
}

/**
 * GET-then-PATCH-full on FlowDefinition.Metadata (AMS:819-851) — the full-object
 * pattern mirrors updateValidationRuleActive (future-proof against Tooling
 * schema enforcement; preserves non-null sibling values). Short-circuits to
 * true when already at the target activeVersionNumber, so restore re-runs are
 * no-ops.
 */
export async function setFlowActiveVersionFull(
  io: AutomationToggleIo,
  defId: string,
  targetVersion: number
): Promise<boolean> {
  const getResult = await io.callout(`${TOOLING}/sobjects/FlowDefinition/${defId}`, 'GET', null)
  if (!getResult.success) {
    io.log?.('warn', `FlowDef GET failed for ${defId}: ${getResult.errorMessage ?? null}`)
    return false
  }
  const rec = asRecord(JSON.parse(getResult.body ?? ''))
  const metadata = rec === null ? null : asRecord(rec.Metadata)
  if (metadata === null) {
    io.log?.('warn', `FlowDef ${defId} has no Metadata block`)
    return false
  }
  const currentVer = metadata.activeVersionNumber
  const currentVerInt = currentVer == null ? null : apexInteger(currentVer)
  if (currentVerInt !== null && currentVerInt === targetVersion) return true
  metadata.activeVersionNumber = targetVersion
  const result = await io.callout(
    `${TOOLING}/sobjects/FlowDefinition/${defId}?_HttpMethod=PATCH`,
    'POST',
    JSON.stringify({ Metadata: metadata })
  )
  if (!(result.statusCode === 204 || result.statusCode === 200 || result.success)) {
    io.log?.('warn', `FlowDef PATCH failed for ${defId}: ${result.errorMessage ?? null}`)
    return false
  }
  return true
}
