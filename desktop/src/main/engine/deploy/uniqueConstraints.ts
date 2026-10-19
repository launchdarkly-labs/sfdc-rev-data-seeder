/**
 * S49 FIX (BUG-1 part 2) — platform UNIQUE constraints the deploy must respect
 * BEFORE writing, because an upsert that violates one does not always fail.
 *
 * The live failure this exists for: `OpportunityTeamMember` has a unique index
 * on (OpportunityId, UserId). 23 of 34 referenced Users are inactive on the
 * target, so owner substitution maps SEVERAL distinct source members onto the
 * SAME target user — and the second upsert then lands on the row the first one
 * created, OVERWRITING its `TeamMemberRole` instead of erroring. Both records
 * are reported `success`.
 *
 *   run 1: 21 source rows → 20 on target, role 'Opportunity Owner' lost
 *   run 3: 27 source rows → 25 on target, both 'BDR' roles lost
 *
 * In every case the counters claimed a clean 21/21 and 27/27 with zero failures,
 * so the corruption was invisible: silently WRONG data, not merely missing rows.
 *
 * Detecting it here converts last-writer-wins into a deterministic, counted skip
 * of the LATER record — the first source row (source query order) keeps the
 * target row, exactly as it would if the collision had never happened.
 *
 * v1 is registry-based, like `junctionDetector`: only objects whose unique
 * constraint we have actually confirmed. Add an entry only after verifying the
 * constraint really exists on the platform.
 */
import { EXTERNAL_ID_FIELD } from './transform/sfid'

/** Object API name → the field set that must be unique together. */
export const UNIQUE_CONSTRAINTS: Map<string, string[]> = new Map([
  ['OpportunityTeamMember', ['OpportunityId', 'UserId']]
  // Candidates — confirm the constraint before adding:
  //   AccountTeamMember  -> ['AccountId', 'UserId']
  //   OpportunityContactRole is NOT here: it is a junction with its own
  //   insert+dedupe path (`junction.ts`), keyed p1Ext|p2Ext|role.
])

export const UNIQUE_COLLISION_REASON = 'unique_constraint_collision'

export function uniqueConstraintFor(objectApiName: string): string[] | null {
  return UNIQUE_CONSTRAINTS.get(objectApiName) ?? null
}

/**
 * The value a constraint field contributes to the key, read from the payload in
 * EITHER shape the transform can produce:
 *  - a direct Id            → `{ UserId: '005…' }`
 *  - relationship traversal → `{ Opportunity: { Data_Deployment_External_Id__c: '…' } }`
 *
 * Returns null when the field is absent in both shapes — the caller then treats
 * the key as unusable and leaves the record alone (never guesses).
 */
function keyPart(payload: Record<string, unknown>, field: string): string | null {
  const direct = payload[field]
  if (direct != null && direct !== '') return String(direct)
  // `OpportunityId` → `Opportunity`; `Foo__c` → `Foo__r` (junction.ts parity).
  const rel = field.endsWith('__c')
    ? field.slice(0, -3) + '__r'
    : field.endsWith('Id')
      ? field.slice(0, -2)
      : null
  if (rel == null) return null
  const nested = payload[rel]
  if (nested == null || typeof nested !== 'object') return null
  const ext = (nested as Record<string, unknown>)[EXTERNAL_ID_FIELD]
  return ext != null && ext !== '' ? String(ext) : null
}

/**
 * The composite unique key for a payload, or null when ANY part is missing —
 * a partial key could collide two records that are actually distinct, so an
 * incomplete key means "don't touch this record".
 */
export function uniqueKeyOf(
  payload: Record<string, unknown>,
  constraintFields: ReadonlyArray<string>
): string | null {
  const parts: string[] = []
  for (const f of constraintFields) {
    const v = keyPart(payload, f)
    if (v == null) return null
    parts.push(v)
  }
  return parts.join('|')
}
