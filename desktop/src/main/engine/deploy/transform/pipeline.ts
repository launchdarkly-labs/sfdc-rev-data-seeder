/**
 * The per-record transform pipeline — `transformRecordV3`, a byte-faithful port
 * of DataDeploymentService.cls:1120-1208. Composes the E4X.3 + E4X.4 units in
 * the exact Apex order:
 *
 *   Stage 1 (transformRecordV2): `transformStage1` core dispatch  (E4X.3)
 *                              → `synthesizeRequiredFields`        (E4X.4)
 *   Stage 2: `applyPicklistGate` — restricted-picklist allowed-value gate
 *   Stage 2b: `applyRecordTypePicklistGate` — record-type-scoped +
 *             dependent-picklist gate (S49 BUG-9; no Apex counterpart)
 *   Stage 3: `applyPbeGate`      — inactive-PBE gate (OLI only; may skip)
 *
 * Returns a `GoldenOutcome` (never null — Apex `TransformOutcome`); a skipped
 * record has `payload === null`, `skipped === true`, and a `skipReason`. This is
 * the function the golden replay suite (E4X.8) drives against captured fixtures.
 *
 * NameMatch resolution is dispatched inside stage 1 against the PRE-BUILT
 * `ctx.nameMatchMaps` (the resolver that builds them is E4X.5, a prefetch
 * concern — not part of the per-record transform). Parent-strip / contract
 * activation (E4X.7) are batch-level, applied outside this function.
 *
 * Pure: no jsforce, no better-sqlite3. `clock` (date/datetime sentinels) is the
 * only injected non-determinism; the golden comparator tolerates it.
 */

import { transformStage1 } from './stage1'
import { synthesizeRequiredFields, defaultSynthClock, type SynthClock } from './synthesis'
import { applyPicklistGate } from './picklistGate'
import { applyRecordTypePicklistGate } from './recordTypePicklistGate'
import { applyPbeGate } from './pbeGate'
import type { GoldenContext, GoldenOutcome } from '../golden/fixture'

export function transformRecordV3(
  sourceRecord: Record<string, unknown>,
  ctx: GoldenContext,
  clock: SynthClock = defaultSynthClock
): GoldenOutcome {
  // ─── Stage 1: mapping resolution + required-field synthesis ───
  // S50 (BUG-14): fields dropped rather than substituted because the target
  // lookup enforces a filter — surfaced so the drop is never silent.
  const droppedFilteredLookups: string[] = []
  const payload = transformStage1(sourceRecord, ctx, droppedFilteredLookups)
  // Same source Id the self-ExtId used (DDS computes it once in transformRecordV2).
  const rawSourceId = sourceRecord['Id']
  const sourceId = rawSourceId == null ? null : String(rawSourceId)
  synthesizeRequiredFields(payload, ctx, sourceId, clock)

  const outcome: GoldenOutcome = {
    payload,
    skipped: false,
    skipReason: null,
    droppedPicklistValues: {},
    ...(droppedFilteredLookups.length > 0 ? { droppedFilteredLookups } : {})
  }

  // ─── Stage 2: restricted-picklist allowed-value gate ───
  // Walks the post-synthesis payload; mutates it + accumulates dropped samples.
  applyPicklistGate(payload, ctx, outcome.droppedPicklistValues)

  // ─── Stage 2b: record-type-scoped + dependent picklist gate (S49 BUG-9) ───
  // Stage 2 only knows the field's FULL active value set; the platform enforces
  // a narrower one per record type and per controlling value. Fail-open.
  applyRecordTypePicklistGate(payload, ctx, outcome.droppedPicklistValues)

  // ─── Stage 3: inactive-PBE gate (OLI only) — may skip the whole record ───
  applyPbeGate(outcome, ctx)

  return outcome
}

export { defaultSynthClock, type SynthClock } from './synthesis'
