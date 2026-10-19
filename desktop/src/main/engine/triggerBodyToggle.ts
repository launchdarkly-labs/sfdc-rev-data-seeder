/**
 * E4A.3 — Apex Trigger body-comment toggle engine. Port of
 * `ApexTriggerBodyToggleService.cls` (ATBTS, 528 ln) in full:
 *
 *  - commentOutBody / uncommentBody   (ATBTS:287-332 — THE fidelity-critical pair)
 *  - isGuardTriggerName               (ATBTS:130-132)
 *  - fetchBodies                      (ATBTS:253-277, strict — throws)
 *  - toggleTriggersDetailed           (ATBTS:197-227, BatchToggleResult)
 *  - setTriggerBypassedDetailed / setTriggerBypassed (ATBTS:145-178)
 *  - disableTriggers / restoreTriggers / toggleTriggers (ATBTS:46-55, 231-251)
 *  - deployBodiesWithFallback / deployContainer / pollUntilDone /
 *    extractFailureReason             (ATBTS:338-527)
 *  - restoreAllOrphanedTriggers       (ATBTS:85-126 — the E4A.7 core, ported here
 *    because it is this file's function; E4A.7 adds only the UI button + the
 *    not-while-deploying interlock at the call site)
 *
 * WHY body-commenting (ATBTS header): direct PATCH on ApexTrigger.Status/
 * Metadata is blocked in sandboxes (INVALID_TYPE), Metadata SOAP doesn't
 * support ApexTrigger — the MetadataContainer + ApexTriggerMember +
 * ContainerAsyncRequest pipeline is the only path, and it skips test runs.
 * The wrapped body preserves the original BYTE-PERFECTLY inside the sentinel
 * comment, so restore needs no external snapshot (the orphan scan recovers
 * ANY wrapped trigger with no prior record). Trigger Status stays 'Active'
 * while wrapped — the only truth is the Body marker.
 *
 * Byte-fidelity notes (each a real porting trap, pinned by golden tests):
 *  - Apex String.replace(target, replacement) replaces ALL literal occurrences
 *    → JS replaceAll, NOT replace (which does first-only for string args).
 *  - Apex String `==` is case-INSENSITIVE → ciEquals for every body/state
 *    comparison (`transformed == original`, verify `actual == expected`,
 *    poll state checks). startsWith/endsWith/contains stay case-SENSITIVE.
 *  - Order inside commentOutBody is load-bearing: brace check → idempotency
 *    (BEGIN_MARKER within the brace substring) → escape-token refusal →
 *    escape → wrap. An already-wrapped body containing the escape token
 *    returns unchanged (no throw) because the idempotency check fires first.
 *  - extractFailureReason renders Apex null-concat: missing fullName/problem/
 *    lineNumber render the literal 'null'; the ErrorMsg fallback is
 *    String.valueOf (null → 'null').
 *  - The container name is 'RDS_Bypass_' + epoch millis (io.now), and the
 *    containerId parse sits OUTSIDE the try/finally exactly like Apex — a
 *    malformed create body leaks the container (bug-compatible).
 *  - A failed ApexTriggerMember add WARNs and still submits the
 *    ContainerAsyncRequest (Apex behavior — the container deploys the members
 *    that did attach).
 *
 * DESIGN-AUTHORIZED DIVERGENCES (automationMap P5 + ROADMAP E4A.3 —
 * "deterministic confirm, no optimistic count"; the Apex shape existed only
 * because 60 in-transaction callouts ≈ 30s was the whole poll budget):
 *  1. DETERMINISTIC CONFIRM: Apex optimistically counted Timeout/Unknown as
 *     succeeded (the sb1 19-trigger stuck-wrap incident: verify fired too
 *     early, so trust-the-async-deploy was the lesser evil). The desktop
 *     polls with REAL sleep (POLL_INTERVAL_MS × MAX_POLL_ATTEMPTS ≈ 3 min),
 *     then applies the Apex Failed-branch verify-by-refetch to EVERY
 *     non-Completed outcome (Timeout/Unknown/Failed/Aborted/Invalidated).
 *     NO optimistic count. Under-confirmation is safe because callers record
 *     restore intent from changedIds (attempted), not succeededIds.
 *  2. The live-callout-budget guard in deployBodiesWithFallback
 *     (perContainerBudget / skipped, ATBTS:360-373) DIES — every unconfirmed
 *     member is retried individually; nothing is "left for the watchdog".
 *  3. pollUntilDone paces with io.sleep between attempts (Apex paced by
 *     callout latency alone). A failed poll callout still returns 'Unknown'
 *     immediately, verbatim — the verify pass now owns the truth anyway.
 *
 * ENGINE-PURE: all IO through TriggerToggleIo (the E4A.2 callout seam plus
 * sleep/now). The live adapter gates every callout with assertWritable.
 */
import { urlEncode, type AutomationToggleIo } from './automationToggle'
import { ciEquals, escapeSingleQuotes } from './deploy/transform/apexSemantics'

// Sentinel markers that surround the original body once it's wrapped (ATBTS:31-36).
export const BEGIN_MARKER = '/*<<RDS_BYPASS_BEGIN>>'
export const END_MARKER = '<<RDS_BYPASS_END>>*/'
// Apex disallows nested /* */ — any '*/' inside the body would close the
// wrapper early; escaped to this token and reversed on restore.
export const ESCAPED_CLOSE = '*<<RDS_ESC>>/'

const TOOLING_BASE = '/services/data/v66.0/tooling/sobjects/'
const TOOLING_QUERY = '/services/data/v66.0/tooling/query/?q='

/** Apex MAX_POLL_ATTEMPTS was 60 paced by callout latency (~12-30s). The
 *  desktop paces with real sleep — 90 × 2s ≈ 3 minutes of patience. */
export const MAX_POLL_ATTEMPTS = 90
export const POLL_INTERVAL_MS = 2000

/** Analog of ApexTriggerBodyToggleException. */
export class TriggerBodyToggleError extends Error {}

/** The E4A.2 callout seam + deterministic-poll pacing + container naming. */
export interface TriggerToggleIo extends AutomationToggleIo {
  sleep(ms: number): Promise<void>
  now(): Date
}

// ─────────────────────────── body transformation ─────────────────────────────

/**
 * Wraps the trigger body (between the first '{' and last '}') in one block
 * comment bounded by the sentinels (ATBTS:287-312). Escapes nested
 * close-comment tokens (star-slash); idempotent when BEGIN_MARKER is already
 * present; refuses a body that already contains the escape token.
 */
export function commentOutBody(original: string): string {
  const firstBrace = original.indexOf('{')
  const lastBrace = original.lastIndexOf('}')
  if (firstBrace < 0 || lastBrace < 0 || lastBrace <= firstBrace) {
    throw new TriggerBodyToggleError('Could not locate trigger body braces')
  }

  const bodyContent = original.substring(firstBrace + 1, lastBrace)

  // Already disabled? Bail out idempotently.
  if (bodyContent.includes(BEGIN_MARKER)) return original

  // Safety: refuse if the original already contains our escape token.
  if (bodyContent.includes(ESCAPED_CLOSE)) {
    throw new TriggerBodyToggleError(
      'Trigger body already contains RDS escape token — refusing to wrap to avoid corruption.'
    )
  }

  // Apex String.replace replaces ALL occurrences → replaceAll.
  const escaped = bodyContent.replaceAll('*/', ESCAPED_CLOSE)

  return (
    original.substring(0, firstBrace + 1) + BEGIN_MARKER + escaped + END_MARKER + original.substring(lastBrace)
  )
}

/**
 * Reverses commentOutBody (ATBTS:319-332): strips the marker pair and
 * un-escapes nested close-comments. Input returned unchanged when the
 * markers aren't present (or are out of order).
 */
export function uncommentBody(modified: string): string {
  const beginIdx = modified.indexOf(BEGIN_MARKER)
  const endIdx = modified.indexOf(END_MARKER)
  if (beginIdx < 0 || endIdx < 0 || endIdx <= beginIdx) return modified

  const before = modified.substring(0, beginIdx)
  const wrapped = modified.substring(beginIdx + BEGIN_MARKER.length, endIdx)
  const after = modified.substring(endIdx + END_MARKER.length)

  const restored = wrapped.replaceAll(ESCAPED_CLOSE, '*/')

  return before + restored + after
}

/** Guard exclusion (ATBTS:130-132) — startsWith/endsWith are case-SENSITIVE. */
export function isGuardTriggerName(name: string | null | undefined): boolean {
  return name != null && name.startsWith('RDS_') && name.endsWith('_CpqGuard')
}

// ─────────────────────────────── body fetch ──────────────────────────────────

/** STRICT body fetch (ATBTS:253-277) — throws on query failure. */
export async function fetchBodies(
  io: TriggerToggleIo,
  triggerIds: ReadonlyArray<string>
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>()
  const quoted = triggerIds.map((id) => `'${escapeSingleQuotes(id)}'`)
  const soql = `SELECT Id, Body FROM ApexTrigger WHERE Id IN (${quoted.join(',')})`
  const queryResult = await io.callout(TOOLING_QUERY + urlEncode(soql), 'GET', null)
  if (!queryResult.success) {
    throw new TriggerBodyToggleError(
      `Failed to fetch trigger bodies: ${queryResult.errorMessage ?? null}`
    )
  }
  const response = JSON.parse(queryResult.body ?? '') as { records?: unknown }
  const records = Array.isArray(response.records) ? response.records : null
  if (records !== null) {
    for (const rec of records) {
      const r = (rec ?? {}) as Record<string, unknown>
      if (typeof r.Id === 'string') {
        result.set(r.Id, typeof r.Body === 'string' ? r.Body : null)
      }
    }
  }
  return result
}

// ─────────────────────────────── public API ──────────────────────────────────

/** Port of ATBTS.ToggleResult (single-trigger path for the toggle batch driver). */
export interface ToggleResult {
  success: boolean
  /** true if no change was needed (don't track for restore). */
  alreadyInState: boolean
  /** populated on failure. */
  errorReason: string | null
}

/**
 * Single-trigger toggle (ATBTS:145-173). Distinguishes already-in-state
 * (success, don't track) from actually-toggled (track for restore).
 */
export async function setTriggerBypassedDetailed(
  io: TriggerToggleIo,
  triggerId: string,
  bypassed: boolean
): Promise<ToggleResult> {
  let bodies: Map<string, string | null>
  try {
    bodies = await fetchBodies(io, [triggerId])
  } catch (e) {
    return {
      success: false,
      alreadyInState: false,
      errorReason: `Could not fetch trigger body: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  const original = bodies.get(triggerId)
  if (original == null) {
    return { success: false, alreadyInState: false, errorReason: 'Trigger body not found' }
  }
  const transformed = bypassed ? commentOutBody(original) : uncommentBody(original)
  if (ciEquals(transformed, original)) {
    // Body already in desired state. Don't deploy. Don't track for restore.
    return { success: true, alreadyInState: true, errorReason: null }
  }
  const count = (await deployBodiesWithFallback(io, new Map([[triggerId, transformed]]))).size
  return {
    success: count > 0,
    alreadyInState: false,
    errorReason: count > 0 ? null : 'MetadataContainer deploy did not complete in poll budget'
  }
}

/** Boolean wrapper (ATBTS:176-178). */
export async function setTriggerBypassed(
  io: TriggerToggleIo,
  triggerId: string,
  bypassed: boolean
): Promise<boolean> {
  return (await setTriggerBypassedDetailed(io, triggerId, bypassed)).success
}

/**
 * Port of ATBTS.BatchToggleResult (:190-195). `changedIds` is ATTEMPTED, not
 * confirmed — the restore ledger records from it (over-recording is safe
 * because restore/unwrap is idempotent; under-recording strands triggers).
 */
export interface BatchToggleResult {
  changedIds: Set<string>
  succeededIds: Set<string>
  alreadyInStateIds: Set<string>
  failReasons: Map<string, string>
}

/**
 * N3 batched toggle through ONE MetadataContainer (ATBTS:197-227): fetch all
 * bodies in one query, transform, deploy the changed ones together, report
 * per-trigger.
 */
export async function toggleTriggersDetailed(
  io: TriggerToggleIo,
  triggerIds: ReadonlyArray<string>,
  bypassed: boolean
): Promise<BatchToggleResult> {
  const res: BatchToggleResult = {
    changedIds: new Set(),
    succeededIds: new Set(),
    alreadyInStateIds: new Set(),
    failReasons: new Map()
  }
  if (triggerIds.length === 0) return res

  let idToBody: Map<string, string | null>
  try {
    idToBody = await fetchBodies(io, triggerIds)
  } catch (e) {
    for (const tid of triggerIds) {
      res.failReasons.set(tid, `body fetch failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    return res
  }

  const idToNewBody = new Map<string, string>()
  for (const tid of triggerIds) {
    const original = idToBody.get(tid)
    if (original == null) {
      res.failReasons.set(tid, 'trigger body not found')
      continue
    }
    const transformed = bypassed ? commentOutBody(original) : uncommentBody(original)
    if (ciEquals(transformed, original)) {
      res.alreadyInStateIds.add(tid)
      continue
    }
    res.changedIds.add(tid)
    idToNewBody.set(tid, transformed)
  }
  if (idToNewBody.size === 0) return res

  const ok = await deployBodiesWithFallback(io, idToNewBody)
  for (const tid of ok) res.succeededIds.add(tid)
  for (const tid of idToNewBody.keys()) {
    if (!ok.has(tid)) res.failReasons.set(tid, 'MetadataContainer deploy did not confirm')
  }
  return res
}

/** Count-returning disable (ATBTS:46-48). */
export async function disableTriggers(
  io: TriggerToggleIo,
  triggerIds: ReadonlyArray<string>
): Promise<number> {
  return toggleTriggers(io, triggerIds, true)
}

/** Count-returning restore (ATBTS:53-55). */
export async function restoreTriggers(
  io: TriggerToggleIo,
  triggerIds: ReadonlyArray<string>
): Promise<number> {
  return toggleTriggers(io, triggerIds, false)
}

/** Core count toggle (ATBTS:231-251). fetchBodies failures THROW here. */
async function toggleTriggers(
  io: TriggerToggleIo,
  triggerIds: ReadonlyArray<string>,
  doDisable: boolean
): Promise<number> {
  if (triggerIds.length === 0) return 0
  const idToBody = await fetchBodies(io, triggerIds)
  const idToNewBody = new Map<string, string>()
  for (const tid of triggerIds) {
    const original = idToBody.get(tid)
    if (original == null) continue
    const transformed = doDisable ? commentOutBody(original) : uncommentBody(original)
    if (ciEquals(transformed, original)) continue // skip if no change — saves a deploy slot
    idToNewBody.set(tid, transformed)
  }
  if (idToNewBody.size === 0) return 0
  return (await deployBodiesWithFallback(io, idToNewBody)).size
}

// ───────────────────────────── orphan scan/restore ───────────────────────────

/** Port of ATBTS.OrphanRestoreResult (:58-65). */
export interface OrphanRestoreResult {
  scanned: number
  orphaned: number
  restored: number
  restoredNames: string[]
  skippedGuards: string[]
  error: string | null
}

/**
 * Record-independent safety net (ATBTS:85-126): scans ALL unmanaged triggers
 * for the RDS_BYPASS wrapper and un-wraps every orphan EXCEPT the app's own
 * RDS_*_CpqGuard triggers. CONCURRENCY (ATBTS:80-84): must NOT run while a
 * deployment is mid-flight on the same target (it would re-arm triggers that
 * deployment deliberately disabled) — the E4A.7 call site owns that interlock.
 */
export async function restoreAllOrphanedTriggers(io: TriggerToggleIo): Promise<OrphanRestoreResult> {
  const res: OrphanRestoreResult = {
    scanned: 0,
    orphaned: 0,
    restored: 0,
    restoredNames: [],
    skippedGuards: [],
    error: null
  }
  const idToCleanBody = new Map<string, string>()
  try {
    // Tooling SOQL can't reliably filter on Body LIKE — pull all unmanaged
    // trigger bodies and filter for the wrapper client-side (ATBTS:89-91).
    const soql = 'SELECT Id, Name, Body FROM ApexTrigger WHERE NamespacePrefix = null'
    const qr = await io.callout(TOOLING_QUERY + urlEncode(soql), 'GET', null)
    if (!qr.success) {
      res.error = `Orphan scan query failed: ${qr.errorMessage ?? null}`
      return res
    }
    const response = JSON.parse(qr.body ?? '') as { records?: unknown }
    const records = Array.isArray(response.records) ? response.records : null
    if (records === null) return res
    for (const o of records) {
      const rec = (o ?? {}) as Record<string, unknown>
      res.scanned++
      const name = typeof rec.Name === 'string' ? rec.Name : null
      const body = typeof rec.Body === 'string' ? rec.Body : null
      if (body === null || !body.includes(BEGIN_MARKER)) continue // not wrapped
      res.orphaned++
      if (isGuardTriggerName(name)) {
        res.skippedGuards.push(name!)
        continue
      }
      const clean = uncommentBody(body)
      if (!ciEquals(clean, body)) {
        if (typeof rec.Id === 'string') idToCleanBody.set(rec.Id, clean)
        res.restoredNames.push(name ?? 'null')
      }
    }
    if (idToCleanBody.size > 0) {
      res.restored = (await deployBodiesWithFallback(io, idToCleanBody)).size
    }
  } catch (e) {
    res.error = `Orphan restore error: ${e instanceof Error ? e.message : String(e)}`
  }
  return res
}

// ─────────────────────────── MetadataContainer deploy ────────────────────────

/**
 * Deploy N trigger bodies in ONE MetadataContainer; retry unconfirmed members
 * INDIVIDUALLY to isolate the good ones (ATBTS:349-375). DIVERGENCE #2: the
 * Apex live-callout-budget guard dies — every unconfirmed member is retried.
 */
export async function deployBodiesWithFallback(
  io: TriggerToggleIo,
  idToNewBody: Map<string, string>
): Promise<Set<string>> {
  const ok = await deployContainer(io, idToNewBody)
  if (ok.size === idToNewBody.size) return ok
  for (const tid of idToNewBody.keys()) {
    if (ok.has(tid)) continue
    const retried = await deployContainer(io, new Map([[tid, idToNewBody.get(tid)!]]))
    for (const id of retried) ok.add(id)
  }
  return ok
}

/** One MetadataContainer of N members (ATBTS:378-467); returns confirmed Ids. */
async function deployContainer(
  io: TriggerToggleIo,
  idToNewBody: Map<string, string>
): Promise<Set<string>> {
  const succeededIds = new Set<string>()
  if (idToNewBody.size === 0) return succeededIds

  // 1. Create MetadataContainer. (Apex checked statusCode != 201; the adapter
  // resolves success ⇔ HTTP 2xx and these endpoints only 201 on success —
  // same accept set.)
  const containerName = `RDS_Bypass_${io.now().getTime()}`
  const create = await io.callout(
    `${TOOLING_BASE}MetadataContainer/`,
    'POST',
    JSON.stringify({ Name: containerName })
  )
  if (!create.success) {
    io.log?.('warn', `MetadataContainer create failed: ${create.errorMessage ?? create.body ?? null}`)
    return succeededIds
  }
  // Parsed OUTSIDE the try, exactly like Apex — a malformed create body throws
  // before the finally exists (bug-compatible container leak). A missing id is
  // a real null (Apex `(String) parsed.get('id')`), rendered 'null' by the
  // template literals below exactly like Apex null-concat.
  const createParsed = JSON.parse(create.body ?? '') as Record<string, unknown>
  const containerId = typeof createParsed.id === 'string' ? createParsed.id : null

  try {
    // 2. Add an ApexTriggerMember per trigger. A failed add WARNs and the
    // container still submits (Apex behavior — deploys the members that attached).
    for (const [triggerId, newBody] of idToNewBody) {
      const addResult = await io.callout(
        `${TOOLING_BASE}ApexTriggerMember/`,
        'POST',
        JSON.stringify({
          MetadataContainerId: containerId,
          ContentEntityId: triggerId,
          Body: newBody
        })
      )
      if (!addResult.success) {
        io.log?.(
          'warn',
          `ApexTriggerMember add failed for ${triggerId}: ${addResult.errorMessage ?? addResult.body ?? null}`
        )
      }
    }

    // 3. Compile + save via ContainerAsyncRequest.
    const req = await io.callout(
      `${TOOLING_BASE}ContainerAsyncRequest/`,
      'POST',
      JSON.stringify({ MetadataContainerId: containerId, IsCheckOnly: false })
    )
    if (!req.success) {
      io.log?.('warn', `ContainerAsyncRequest create failed: ${req.errorMessage ?? req.body ?? null}`)
      return succeededIds
    }
    const reqParsed = JSON.parse(req.body ?? '') as Record<string, unknown>
    const reqId = typeof reqParsed.id === 'string' ? reqParsed.id : null

    // 4. Poll until terminal state, then DIVERGENCE #1 — deterministic confirm:
    // Completed counts everything; EVERY other outcome (Failed/Aborted/
    // Invalidated/Timeout/Unknown) takes the Apex Failed-branch verify-by-
    // refetch. NO optimistic count on Timeout/Unknown.
    const state = await pollUntilDone(io, reqId)
    if (ciEquals(state, 'Completed')) {
      for (const tid of idToNewBody.keys()) succeededIds.add(tid)
    } else {
      io.log?.('warn', `ContainerAsyncRequest ${reqId} ended in state: ${state} — verifying by refetch`)
      const verifyBodies = await fetchBodies(io, [...idToNewBody.keys()])
      for (const [tid, expected] of idToNewBody) {
        const actual = verifyBodies.get(tid)
        if (actual != null && ciEquals(actual, expected)) succeededIds.add(tid)
      }
    }
  } finally {
    // 5. Always delete the container (cleanup).
    await io.callout(`${TOOLING_BASE}MetadataContainer/${containerId}`, 'DELETE', null)
  }
  return succeededIds
}

/**
 * Polls the ContainerAsyncRequest to a terminal state (ATBTS:475-502), paced
 * by io.sleep (DIVERGENCE #3 — Apex had no sleep and relied on callout
 * latency). A failed poll callout or a missing record returns 'Unknown'
 * immediately, verbatim — the caller's verify pass owns the truth.
 */
async function pollUntilDone(io: TriggerToggleIo, reqId: string | null): Promise<string> {
  let attempts = 0
  while (attempts < MAX_POLL_ATTEMPTS) {
    // A null reqId renders 'null' (Apex would NPE here — unreachable live);
    // the Id match then finds nothing → 'Unknown' → the verify pass decides.
    const soql = `SELECT State, ErrorMsg, DeployDetails FROM ContainerAsyncRequest WHERE Id = '${escapeSingleQuotes(String(reqId))}'`
    const result = await io.callout(TOOLING_QUERY + urlEncode(soql), 'GET', null)
    if (!result.success) {
      io.log?.('warn', `Poll failed: ${result.errorMessage ?? null}`)
      return 'Unknown'
    }
    const response = JSON.parse(result.body ?? '') as { records?: unknown }
    const records = Array.isArray(response.records) ? response.records : null
    if (records === null || records.length === 0) return 'Unknown'
    const rec = (records[0] ?? {}) as Record<string, unknown>
    const state = typeof rec.State === 'string' ? rec.State : null
    if (
      ciEquals(state, 'Completed') ||
      ciEquals(state, 'Failed') ||
      ciEquals(state, 'Aborted') ||
      ciEquals(state, 'Invalidated')
    ) {
      if (!ciEquals(state, 'Completed')) {
        io.log?.(
          'warn',
          `ContainerAsyncRequest ${reqId} state=${state} err=${extractFailureReason(rec)}`
        )
      }
      return state!
    }
    attempts++
    await io.sleep(POLL_INTERVAL_MS)
  }
  return 'Timeout'
}

/**
 * Human-readable error from the ContainerAsyncRequest record (ATBTS:509-527):
 * DeployDetails.componentFailures[].problem first (compile errors), fallback
 * String.valueOf(ErrorMsg). Null leaves render the literal 'null' (Apex
 * null-concat).
 */
function extractFailureReason(rec: Record<string, unknown>): string {
  const dd = rec.DeployDetails
  if (dd != null && typeof dd === 'object' && !Array.isArray(dd)) {
    const failures = (dd as Record<string, unknown>).componentFailures
    if (Array.isArray(failures) && failures.length > 0) {
      const messages: string[] = []
      for (const f of failures) {
        const failure = (f ?? {}) as Record<string, unknown>
        const name = failure.fullName ?? null
        const problem = failure.problem ?? null
        const lineNum = failure.lineNumber ?? null
        messages.push(`${name} line ${lineNum}: ${problem}`)
      }
      return messages.join(' | ')
    }
  }
  return String(rec.ErrorMsg ?? null)
}
