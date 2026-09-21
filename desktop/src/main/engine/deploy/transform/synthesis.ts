/**
 * E4X.4 — required-field synthesis: a byte-faithful port of the Apex
 * `transformRecordV2` synthesis tail (DataDeploymentService.cls:1044-1088).
 *
 * Walks the TARGET-side describe and, for any field that is non-nillable +
 * createable on target but MISSING from the stage-1 payload, fills in a typed
 * sentinel value. This covers schema drift where a field is required on target
 * but optional/absent on source — without it every row fails
 * REQUIRED_FIELD_MISSING. Sentinels are deliberately obvious (`rds-a1b2c3d4`)
 * so they're spottable in target data later.
 *
 * The transform is deterministic EXCEPT for `date`/`datetime` sentinels, which
 * Apex fills from the wall clock (`Date.today()` / `DateTime.now().formatGmt`).
 * Those are injected via `clock` so tests are deterministic (deployDesign §3.3)
 * and the golden comparator (fixture.ts) tolerates them on replay.
 *
 * Mutates `target` in place (matching the Apex `target.put(...)` loop). Runs as
 * the tail of stage 1, BEFORE the picklist / PBE gates.
 *
 * PARITY-FIRST: `ciEquals` for the ExtId-field name compare (Apex `==`, CI);
 * Set / Map membership stays case-SENSITIVE; dataType is lowercased then matched
 * against the fixed synthesizable set exactly as Apex does.
 *
 * Pure: no jsforce, no better-sqlite3. `clock` is the only injected I/O.
 */

import { ciEquals, isBlank } from './apexSemantics'
import { EXTERNAL_ID_FIELD } from './sfid'
import { SYSTEM_MANAGED_FIELDS } from '../../../../shared/fieldPolicy'
import type { GoldenContext } from '../golden/fixture'

/**
 * Injected wall clock for the `date`/`datetime` sentinels. `today()` mirrors
 * Apex `String.valueOf(Date.today())` → `'yyyy-MM-dd'`; `nowGmt()` mirrors
 * `DateTime.now().formatGmt('yyyy-MM-dd\'T\'HH:mm:ss.SSS\'Z\'')`.
 */
export interface SynthClock {
  today(): string
  nowGmt(): string
}

/** The exact set Apex synthesizes for (DDS L1045-1049), lowercase. */
const SYNTHESIZABLE: ReadonlySet<string> = new Set([
  'string',
  'textarea',
  'email',
  'phone',
  'url',
  'int',
  'double',
  'currency',
  'percent',
  'date',
  'datetime',
  'boolean'
])

/** The context slice synthesis reads — target describe + the deferred set. */
type SynthesisContext = Pick<GoldenContext, 'targetFieldsByName' | 'deferredFields'>

/**
 * Port of DDS L1044-1088. Caller passes `targetFieldsByName=null/{}` (Apex null)
 * to disable synthesis — e.g. the second pass sends intentionally partial
 * payloads. `sourceId` is the record's source Id (for the `rds-<id8>` sentinels;
 * `'x'` when absent — DDS L1077/L1084).
 */
export function synthesizeRequiredFields(
  target: Record<string, unknown>,
  ctx: SynthesisContext,
  sourceId: string | null,
  clock: SynthClock = defaultSynthClock
): void {
  const tfbn = ctx.targetFieldsByName
  if (tfbn == null || Object.keys(tfbn).length === 0) return
  const deferred = new Set(ctx.deferredFields ?? [])

  // Iterate the target describe by VALUE (Apex `targetFieldsByName.values()`) —
  // order is unspecified but each field writes a distinct key, so the resulting
  // payload is order-independent.
  for (const tfi of Object.values(tfbn)) {
    if (tfi.isNillable) continue
    if (!tfi.isCreateable) continue
    if (tfi.isAutoNumber) continue
    if (tfi.isCalculated) continue
    if (SYSTEM_MANAGED_FIELDS.has(tfi.apiName)) continue
    if (ciEquals(tfi.apiName, EXTERNAL_ID_FIELD)) continue
    if (deferred.has(tfi.apiName)) continue
    if (Object.prototype.hasOwnProperty.call(target, tfi.apiName)) continue
    // Don't synthesize when the field's relationship shape is already present
    // (e.g. `Account: { RDS }` in the payload → skip `AccountId`). DDS L1060-1061.
    const rel = tfi.relationshipName
    if (!isBlank(rel) && Object.prototype.hasOwnProperty.call(target, rel)) continue
    // Can't fabricate a valid Salesforce Id → never synthesize references.
    if (tfi.isReference) continue
    const t = (tfi.dataType ?? '').toLowerCase()
    if (!SYNTHESIZABLE.has(t)) continue

    target[tfi.apiName] = synthValue(t, sourceId, clock, tfi.length ?? null)
  }
}

/**
 * The record-distinguishing part of a source Id — its TAIL, lowercased.
 *
 * S49 FIX (BUG-5): this used to be `leftTruncate(sourceId, 8)`, i.e. the HEAD.
 * The first 8 characters of a Salesforce Id are the 3-char key prefix + pod +
 * reserved zeros, which are IDENTICAL for every record of an object in an org —
 * so every synthesized record got the same sentinel. On a UNIQUE required field
 * that means only the FIRST record can ever deploy: the first account's
 * LaunchDarkly_Account__c wrote `LD_Account_ID__c = 'rds-a5r1k000'`, and
 * the second account's (source `a5r1K000000ioPjQAI`, same 8-char head) then failed with
 * DUPLICATE_VALUE against it on every run. The tail is the part that varies.
 *
 * `budget` is the target field's length when known, so a short field still gets
 * a value that fits — trimmed from the left, keeping the distinguishing tail.
 */
function idTail(sourceId: string | null, budget: number | null): string {
  if (sourceId == null || sourceId === '') return 'x'
  const full = sourceId.toLowerCase()
  if (budget == null || budget <= 0 || full.length <= budget) return full
  return full.slice(full.length - budget)
}

/** The typed sentinel table (DDS L1067-1085). `t` is already lowercased. */
function synthValue(
  t: string,
  sourceId: string | null,
  clock: SynthClock,
  maxLength: number | null
): unknown {
  switch (t) {
    case 'boolean':
      return false
    case 'int':
    case 'double':
    case 'currency':
    case 'percent':
      return 0
    case 'date':
      return clock.today()
    case 'datetime':
      return clock.nowGmt()
    case 'email':
      // 'rds-' (4) + '@example.invalid' (16) = 20 chars of fixed overhead
      return `rds-${idTail(sourceId, maxLength != null ? maxLength - 20 : null)}@example.invalid`
    case 'url':
      return 'https://example.invalid/rds'
    case 'phone':
      return '5555550100'
    default:
      // string / textarea / anything else under the synthesizable umbrella.
      return `rds-${idTail(sourceId, maxLength != null ? maxLength - 4 : null)}`
  }
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0')

/**
 * Default clock — reads the real wall clock in GMT, formatted to match Apex.
 * The live pipeline injects `DeployIo.now()` (deployDesign §3.3); this default
 * keeps ad-hoc callers working. Its output is clock-tolerant on golden replay.
 */
export const defaultSynthClock: SynthClock = {
  today(): string {
    const d = new Date()
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`
  },
  nowGmt(): string {
    const d = new Date()
    return (
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}` +
      `T${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}` +
      `.${pad(d.getUTCMilliseconds(), 3)}Z`
    )
  }
}
