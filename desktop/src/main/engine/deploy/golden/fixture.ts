/**
 * Golden-fixture schema + replay comparator (E4X.2, deployDesign §3.2 replay).
 *
 * A fixture bundles everything needed to replay ONE source record through the TS
 * transform port (E4X.3, `transformRecordV3`) and prove parity with the frozen
 * Apex `transformRecordV3`. The transform is a deterministic function of
 * `{input, context}` with ONE exception: required-field synthesis fills a
 * missing target-required `date`/`datetime` field with the wall clock
 * (`Date.today()` / `DateTime.now()`, DataDeploymentService L1073-1075), so those
 * values are NOT replay-stable. `compareOutcome` tolerates them when given the
 * fixture's `input` + `context` (it can tell which payload keys were synthesized).
 *   - `input`   — the raw source record (as jsforce returns it, incl. `attributes`);
 *   - `context` — the exact `TransformContext` snapshot the Apex outcome was
 *                 produced under, so the TS port has NO hidden inputs; and
 *   - `outcome` — the captured `TransformOutcome` (DataDeploymentService L664-673).
 *
 * The comparator encodes the §3.2 replay rule: parsed-JSON deep-equal, EXCEPT
 * every list sourced from an Apex `Set`/`Map.keySet()` iteration is compared as a
 * sorted multiset (Apex Set/keySet order is unspecified/hash-ordered — §5 traps
 * 3/20), while `skipReason` and picklist-drop field keys compare byte-exact (they
 * are data / deliberately formatted, not display).
 *
 * `serializeFixture` canonicalizes (recursively sorted object keys + sorted
 * Set-sourced lists) so re-capturing the same inputs yields byte-identical files
 * — the E4X.2 "re-capture is deterministic" acceptance criterion.
 *
 * Pure: no jsforce, no fs. The test loader / orchestrator do the I/O.
 */

/** Subset of `SchemaService.FieldInfo` the transform pipeline actually reads. */
// Type-only (erased at compile time), so the fixture <-> gate cycle is not a
// runtime cycle.
import type { RecordTypePicklists } from '../transform/recordTypePicklistGate'

export interface GoldenFieldInfo {
  apiName: string
  dataType: string | null
  isCreateable: boolean
  isNillable: boolean
  isReference: boolean
  referenceTo: string[]
  relationshipName: string | null
  isAutoNumber: boolean
  isCalculated: boolean
  isExternalId: boolean
  isRestrictedPicklist: boolean
  /**
   * S50 (BUG-14): the TARGET field has a lookup filter that the platform
   * ENFORCES on write (`filteredLookupInfo.optionalFilter === false`). Optional
   * filters are UI-only and are deliberately NOT flagged. Absent = unknown =
   * treated as unfiltered, so older fixtures behave exactly as before.
   */
  hasEnforcedLookupFilter?: boolean
  /** S49 (BUG-5): target field length, when the fixture records it — bounds the
   *  synthesized sentinel so a short field still gets a value that fits. */
  length?: number | null
}

export interface GoldenMapping {
  strategy: string | null
  matchField: string | null
  customValue: string | null
}

/**
 * The captured `TransformContext` (DataDeploymentService L679-702). Everything
 * `transformRecordV3` reads, so replay is deterministic. Set-sourced fields
 * (`deferredFields`, `inactiveUserIds`, `inactivePbeIds`, each
 * `targetPicklistAllowedValues` value) are stored sorted by `serializeFixture`.
 */
export interface GoldenContext {
  objectName: string
  fields: GoldenFieldInfo[]
  deferredFields: string[]
  mappings: Record<string, GoldenMapping>
  nameMatchMaps: Record<string, Record<string, string>>
  useBulkFormat: boolean
  targetUserId: string | null
  inactiveUserIds: string[]
  targetFieldsByName: Record<string, GoldenFieldInfo>
  targetPicklistAllowedValues: Record<string, string[]>
  inactivePbeIds: string[]
  pbeSubstitutes: Record<string, string | null>
  /** S49 (BUG-6): PBE Ids present on target; empty/absent disables the check. */
  knownPbeIds?: string[]
  /**
   * S49 (BUG-9): record-type-scoped + dependent picklist values, keyed by
   * RecordTypeId (both Id widths). Empty/absent disables the check.
   */
  recordTypePicklists?: RecordTypePicklists
  /**
   * S50 (BUG-12): the record type the target applies when a payload carries no
   * `RecordTypeId`. Absent/null ⇒ the gate falls back to its Master-only rule.
   */
  recordTypeDefaultId?: string | null
  /**
   * S50 (BUG-12 hardening): count of ACTIVE record types on target, excluding
   * Master. Absent is treated as "unknown" and the default is not applied.
   */
  recordTypeCandidateCount?: number
}

export interface GoldenOutcome {
  payload: Record<string, unknown> | null
  skipped: boolean
  skipReason: string | null
  droppedPicklistValues: Record<string, string[]>
  /**
   * S50 (BUG-14): User lookups dropped instead of substituted because the
   * target field enforces a lookup filter. Key omitted when empty, so
   * pre-S50 outcome shapes stay byte-identical.
   */
  droppedFilteredLookups?: string[]
}

export interface GoldenFixture {
  object: string
  sourceId: string
  /** Capture-run UUID — provenance only; never compared during replay. */
  captureId: string
  input: Record<string, unknown>
  context: GoldenContext
  outcome: GoldenOutcome
}

/** `[A-Za-z0-9_]`-safe relative path `<object>/<sourceId>.json` (no traversal). */
export function fixturePath(object: string, sourceId: string): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, '_')
  const obj = safe(object)
  const id = safe(sourceId)
  if (obj === '' || id === '') {
    throw new Error(`fixturePath: object and sourceId must be non-empty (${object}/${sourceId})`)
  }
  return `${obj}/${id}.json`
}

// ─────────────────────────────── comparator ──────────────────────────────────

export interface OutcomeDiff {
  path: string
  expected: unknown
  actual: unknown
  note?: string
}

export interface CompareOptions {
  /**
   * The fixture's source record + captured context. When supplied, the
   * comparator tolerates clock-synthesized required `date`/`datetime` payload
   * values (which are wall-clock dependent and thus differ between capture and
   * replay). Presence is still checked; only the value comparison is skipped for
   * a synthesized clock field.
   */
  input?: Record<string, unknown>
  context?: GoldenContext
}

/** `[...xs]` stringified and sorted — the Set-order tolerance (§5 traps 3/20). */
function sortedMultiset(xs: readonly string[]): string[] {
  return [...xs].map(String).sort()
}

/**
 * Payload keys whose value the required-field synthesis fills with the wall
 * clock: a target-required (non-nillable + createable, non-autoNumber/calculated/
 * reference) `date`/`datetime` field NOT provided by the source record. Mirrors
 * the synthesis conditions in DataDeploymentService transformRecordV2 L1044-1088.
 */
function clockTolerantKeys(opts: CompareOptions): Set<string> {
  const out = new Set<string>()
  const tfbn = opts.context?.targetFieldsByName
  if (tfbn == null) return out
  for (const [name, fi] of Object.entries(tfbn)) {
    const dt = (fi.dataType ?? '').toLowerCase()
    if (dt !== 'date' && dt !== 'datetime') continue
    if (fi.isNillable || !fi.isCreateable || fi.isAutoNumber || fi.isCalculated || fi.isReference) {
      continue
    }
    // Synthesized only when the source didn't provide a non-blank value.
    const src = opts.input?.[name]
    const providedBySource =
      src !== undefined && src !== null && !(typeof src === 'string' && src.trim() === '')
    if (!providedBySource) out.add(name)
  }
  return out
}

/** Order-INSENSITIVE for objects; order-SENSITIVE for arrays (payload lists, if any, are ordered). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == null && b == null
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const ak = Object.keys(ao)
    const bk = Object.keys(bo)
    if (ak.length !== bk.length) return false
    return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]))
  }
  return false
}

/**
 * Compare a replayed outcome against the captured golden. Returns [] on a match;
 * otherwise a list of typed diffs (empty ⇒ pass; non-empty ⇒ E4X.3 parity fail).
 * Pass `{ input, context }` to tolerate clock-synthesized `date`/`datetime`
 * required fields (recommended for replay; omit for a strict byte compare).
 */
export function compareOutcome(
  expected: GoldenOutcome,
  actual: GoldenOutcome,
  opts: CompareOptions = {}
): OutcomeDiff[] {
  const diffs: OutcomeDiff[] = []
  const clockTolerant = clockTolerantKeys(opts)

  if (expected.skipped !== actual.skipped) {
    diffs.push({ path: 'skipped', expected: expected.skipped, actual: actual.skipped })
  }

  // skipReason is data / deliberately formatted → byte-exact (null-safe).
  if ((expected.skipReason ?? null) !== (actual.skipReason ?? null)) {
    diffs.push({ path: 'skipReason', expected: expected.skipReason, actual: actual.skipReason })
  }

  // payload — parsed-JSON deep-equal (null when skipped).
  const ep = expected.payload ?? null
  const ap = actual.payload ?? null
  if (ep == null || ap == null) {
    if (ep !== ap) diffs.push({ path: 'payload', expected: ep, actual: ap })
  } else {
    for (const key of new Set([...Object.keys(ep), ...Object.keys(ap)])) {
      const inE = Object.prototype.hasOwnProperty.call(ep, key)
      const inA = Object.prototype.hasOwnProperty.call(ap, key)
      if (!inE) {
        diffs.push({ path: `payload.${key}`, expected: '(absent)', actual: ap[key] })
      } else if (!inA) {
        diffs.push({ path: `payload.${key}`, expected: ep[key], actual: '(absent)' })
      } else if (clockTolerant.has(key) && ep[key] != null && ap[key] != null) {
        // Both sides carry a wall-clock-synthesized value — tolerate (present, not equal).
      } else if (!deepEqual(ep[key], ap[key])) {
        diffs.push({ path: `payload.${key}`, expected: ep[key], actual: ap[key] })
      }
    }
  }

  // droppedPicklistValues — map keys as a set; each value list as a sorted
  // multiset (append order follows Apex payload keySet iteration → tolerate).
  const ed = expected.droppedPicklistValues ?? {}
  const adv = actual.droppedPicklistValues ?? {}
  for (const field of new Set([...Object.keys(ed), ...Object.keys(adv)])) {
    const e = sortedMultiset(ed[field] ?? [])
    const a = sortedMultiset(adv[field] ?? [])
    if (!deepEqual(e, a)) {
      diffs.push({ path: `droppedPicklistValues.${field}`, expected: e, actual: a })
    }
  }

  return diffs
}

// ───────────────────────── deterministic serialization ───────────────────────

/** Recursively sort object keys so JSON output is byte-stable across runs. */
function canonicalize(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const src = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(src).sort()) out[key] = canonicalize(src[key])
  return out
}

/**
 * Canonicalize a fixture for byte-stable output: sort every Set-sourced list so
 * Apex hash-order can't flake the file, then recursively sort object keys. Same
 * inputs ⇒ identical bytes across re-captures, EXCEPT for clock-synthesized
 * `date`/`datetime` required-field payload values (captured from the wall clock);
 * `compareOutcome` tolerates those on replay.
 */
export function serializeFixture(fixture: GoldenFixture): string {
  const ctx = fixture.context
  const stable: GoldenFixture = {
    ...fixture,
    context: {
      ...ctx,
      deferredFields: sortedMultiset(ctx.deferredFields),
      inactiveUserIds: sortedMultiset(ctx.inactiveUserIds),
      inactivePbeIds: sortedMultiset(ctx.inactivePbeIds),
      targetPicklistAllowedValues: Object.fromEntries(
        Object.entries(ctx.targetPicklistAllowedValues).map(([k, v]) => [k, sortedMultiset(v)])
      )
    },
    outcome: {
      ...fixture.outcome,
      droppedPicklistValues: Object.fromEntries(
        Object.entries(fixture.outcome.droppedPicklistValues).map(([k, v]) => [k, sortedMultiset(v)])
      )
    }
  }
  return JSON.stringify(canonicalize(stable), null, 2) + '\n'
}

/** Parse + light-validate a fixture file; throws on a malformed/corrupt fixture. */
export function parseFixture(json: string): GoldenFixture {
  const raw = JSON.parse(json) as Partial<GoldenFixture>
  if (
    raw == null ||
    typeof raw.object !== 'string' ||
    typeof raw.sourceId !== 'string' ||
    raw.input == null ||
    raw.context == null ||
    raw.outcome == null ||
    typeof raw.outcome.skipped !== 'boolean'
  ) {
    throw new Error('parseFixture: malformed golden fixture (missing object/sourceId/input/context/outcome)')
  }
  return raw as GoldenFixture
}
