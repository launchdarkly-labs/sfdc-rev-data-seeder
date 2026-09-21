/**
 * E4X.4 — stage 2 of `transformRecordV3`: the restricted-picklist allowed-value
 * gate. Byte-faithful port of DataDeploymentService.cls:1138-1174.
 *
 * For every payload field that is a restricted picklist on TARGET, if the source
 * value isn't in the target's active allowed set, DROP the field from the
 * payload (the record still deploys — that field is just null on target) and
 * record the dropped value under `droppedPicklistValues[field]` so the queueable
 * can emit one aggregated log line. Multi-select picklists are `;`-delimited: the
 * WHOLE upsert fails if ANY token is disallowed, so the field is dropped unless
 * EVERY token is allowed.
 *
 * PARITY-FIRST (transformMap §5):
 *   - `String.split(';')` is a Java REGEX split that DROPS trailing empties →
 *     `splitRegex` (trap 10); a raw JS `split` would keep them and mis-drop
 *     `'a;b;'`-shaped values.
 *   - `token.trim()` is Java-exact `apexTrim` (trap; NBSP is NOT whitespace).
 *   - allowed-value membership is case-SENSITIVE (Apex `Set.contains`).
 *   - `String.valueOf(val)` → `apexStringValueOf` (trap 19).
 *
 * Mutates `payload` (deletes disallowed keys) and `droppedPicklistValues`
 * (accumulates samples) in place. Pure otherwise.
 */

import { apexStringValueOf, apexTrim, splitRegex } from './apexSemantics'
import type { GoldenContext } from '../golden/fixture'

type PicklistContext = Pick<GoldenContext, 'targetPicklistAllowedValues'>

export function applyPicklistGate(
  payload: Record<string, unknown>,
  ctx: PicklistContext,
  droppedPicklistValues: Record<string, string[]>
): void {
  const allowedMap = ctx.targetPicklistAllowedValues
  // No target picklist map → don't validate (ctx not fully populated). DDS L1142.
  if (allowedMap == null || Object.keys(allowedMap).length === 0) return

  // Snapshot the keys — we mutate the payload as we go (DDS L1145).
  for (const fieldName of Object.keys(payload)) {
    const allowedArr = allowedMap[fieldName]
    if (allowedArr == null) continue // not a restricted picklist
    const val = payload[fieldName]
    if (val == null) continue
    const sval = apexStringValueOf(val)
    if (sval == null) continue // defensive; val is non-null so sval is non-null

    const allowed = new Set(allowedArr) // case-sensitive membership (Apex Set)
    const isMulti = sval.includes(';')
    const tokens = isMulti ? splitRegex(sval, ';').map((t) => apexTrim(t)) : [sval]

    const kept: string[] = []
    const dropped: string[] = []
    for (const token of tokens) (allowed.has(token) ? kept : dropped).push(token)
    if (dropped.length === 0) continue

    // S49 DIVERGENCE FROM THE APEX PORT: a multi-select now drops only the
    // OFFENDING TOKENS instead of the whole field. The Apex behaviour ("the
    // WHOLE upsert fails if ANY token is disallowed, so drop the field unless
    // EVERY token is allowed") threw away good values to protect against one
    // bad one. Standing rule 9 (2026-09-06) made the frozen Apex advisory
    // rather than a parity contract, and stage 2b (BUG-9) had to make exactly
    // this choice for record-type-scoped values — leaving the two stages
    // inconsistent would be worse than diverging from a frozen reference.
    for (const d of dropped) {
      let sample = droppedPicklistValues[fieldName]
      if (sample == null) {
        sample = []
        droppedPicklistValues[fieldName] = sample
      }
      if (!sample.includes(d)) sample.push(d)
    }
    if (kept.length === 0) delete payload[fieldName]
    else payload[fieldName] = kept.join(';')
  }
}
