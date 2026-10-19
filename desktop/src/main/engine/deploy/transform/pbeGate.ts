/**
 * E4X.4 — stage 3 of `transformRecordV3`: the inactive-PricebookEntry gate
 * (OpportunityLineItem only). Byte-faithful port of
 * DataDeploymentService.cls:1176-1205.
 *
 * If the OLI's `PricebookEntryId` points at a PBE that's inactive on target, try
 * to swap in the resolved active substitute (same Product2 + Pricebook2). If no
 * substitute exists, SKIP the whole OLI with reason `inactive_pbe_no_substitute`
 * (payload → null).
 *
 * PARITY-FIRST (transformMap §5 trap 4 — dual-form Ids):
 *   - the inactive set is checked against BOTH the raw payload value AND its
 *     15-char form, but 15-char normalization only fires at EXACTLY length 18
 *     (Apex `pbeId.length()==18 ? substring(0,15) : pbeId`) — NOT `sfid.to15`,
 *     which truncates any length > 15;
 *   - substitute lookup tries the raw key first, then the 15-char key;
 *   - Set / Map membership is case-SENSITIVE; `String.valueOf` → `apexStringValueOf`.
 *
 * Mutates `outcome` in place (may set `skipped`/`skipReason` + null the payload).
 */

import { ciEquals, isBlank, apexStringValueOf } from './apexSemantics'
import type { GoldenContext, GoldenOutcome } from '../golden/fixture'

type PbeContext = Pick<
  GoldenContext,
  'objectName' | 'inactivePbeIds' | 'pbeSubstitutes' | 'knownPbeIds'
>

export function applyPbeGate(outcome: GoldenOutcome, ctx: PbeContext): void {
  if (!ciEquals(ctx.objectName, 'OpportunityLineItem')) return
  const inactive = ctx.inactivePbeIds
  const known = ctx.knownPbeIds
  // Nothing to check with: no inactive list AND no known-id list.
  if ((inactive == null || inactive.length === 0) && (known == null || known.length === 0)) return
  const payload = outcome.payload
  if (payload == null || !Object.prototype.hasOwnProperty.call(payload, 'PricebookEntryId')) return

  const pbeId = apexStringValueOf(payload['PricebookEntryId'])
  // Normalize to 15 for set membership ONLY at exactly 18 chars (Apex L1185).
  const pbe15 = pbeId != null && pbeId.length === 18 ? pbeId.substring(0, 15) : pbeId

  const inactiveSet = new Set(inactive ?? [])
  const isInactive =
    (pbeId != null && inactiveSet.has(pbeId)) || (pbe15 != null && inactiveSet.has(pbe15))

  if (!isInactive) {
    // S49 FIX (BUG-6): the PBE isn't inactive-on-target — but is it there AT ALL?
    // An id missing from the target used to pass straight through and come back
    // as `FIELD_INTEGRITY_EXCEPTION: PricebookEntryId, unknown` / `NOT_FOUND`.
    // It cannot be substituted (the payload carries only the Id, so the target
    // (Product2, Pricebook2) pair is unknowable), so skip the OLI with a
    // distinct reason — the same shape as the inactive-no-substitute skip.
    // `knownPbeIds` empty means the prefetch failed or didn't run → check OFF.
    if (known == null || known.length === 0) return
    const knownSet = new Set(known)
    const present =
      (pbeId != null && knownSet.has(pbeId)) || (pbe15 != null && knownSet.has(pbe15))
    if (present) return
    outcome.skipped = true
    outcome.skipReason = 'pbe_missing_on_target'
    outcome.payload = null
    return
  }

  let substitute: string | null = null
  const subs = ctx.pbeSubstitutes
  if (subs != null) {
    substitute = pbeId != null ? (subs[pbeId] ?? null) : null
    if (substitute == null && pbe15 != null) substitute = subs[pbe15] ?? null
  }

  if (!isBlank(substitute)) {
    payload['PricebookEntryId'] = substitute
  } else {
    // No active PBE for this (Product2, Pricebook2) pair on target → skip the OLI.
    outcome.skipped = true
    outcome.skipReason = 'inactive_pbe_no_substitute'
    outcome.payload = null
  }
}
