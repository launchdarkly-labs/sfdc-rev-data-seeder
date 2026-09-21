/**
 * The CPQ tripwire predicate + error (E4A.5 slice, landed with E4E.5): a
 * managed CPQ trigger error in a batch's error details means the target's
 * "Triggers Disabled" checkbox is unchecked — every further batch would spawn
 * more managed automation, so the WHOLE deploy fails (no per-object retry, no
 * chaining; the orchestrator routes straight to teardown on the error NAME).
 *
 * Byte-faithful to the frozen Apex:
 *  - `DataDeploymentService.findCpqTriggerErrorSignature` — case-SENSITIVE
 *    `contains('SBQQ.')` / `contains('blng.')` scan over the accumulated
 *    error-detail strings (namespace-dot signatures; `SBQQ__` field tokens do
 *    NOT match).
 *  - `DataDeploymentService.CpqTriggersActiveException` — the message text is
 *    kept byte-exact (golden-compared at E4T.1).
 *
 * Lives under engine/ (pure, no imports) because BOTH transport tiers throw
 * it: the E4T.1 collections client (upsert paths) and the E4E.5 junction
 * module, which owns its own batching exactly like the Apex inline loop
 * (DDQ L984-992). services/transport/collections.ts re-exports these.
 */

/** Case-sensitive scan (DDS findCpqTriggerErrorSignature) — first hit wins. */
export function findCpqTriggerErrorSignature(
  errorDetails: ReadonlyArray<string>
): string | null {
  for (const err of errorDetails) {
    if (err != null && (err.includes('SBQQ.') || err.includes('blng.'))) return err
  }
  return null
}

/** CPQ managed triggers fired on the target — fail the whole deploy (Apex tripwire). */
export class CpqTriggersActiveError extends Error {
  constructor(
    readonly objectName: string,
    readonly signature: string
  ) {
    super(
      'CPQ managed triggers fired on the target while loading ' +
        objectName +
        ' — "Triggers Disabled" is not checked. Original error: ' +
        signature
    )
    this.name = 'CpqTriggersActiveError'
  }
}
