/**
 * S57 (B4) — which objects can never carry the seeder's upsert key.
 *
 * Dep 36 on sb1-915-git (2026-09-18): CampaignMemberStatus went red on Readiness,
 * Provision could not add `Data_Deployment_External_Id__c` to it, and the row
 * could never turn green — Salesforce does not allow custom fields on that
 * entity at all (its describe has twelve standard fields and no `__c`). Jack
 * had to work out for himself that deselecting it was the only way past the
 * L1 hard stop. The wizard should say so.
 *
 * Two sources of truth, both consulted:
 *  - this REGISTRY of standard entities known to refuse custom fields (instant
 *    verdict at Readiness and in the object picker); evidence-based — add an
 *    object only once the platform has refused it;
 *  - the Metadata API's own refusal text at Provision time (`isUnprovisionableError`),
 *    for the long tail the registry does not know yet.
 * Shared (renderer + main), dependency-free.
 */

/** Standard entities that do not support custom fields — the seeder cannot key them. */
export const CANNOT_HOST_CUSTOM_FIELDS: ReadonlySet<string> = new Set(['CampaignMemberStatus'])

export function canHostExtIdField(objectName: string): boolean {
  return !CANNOT_HOST_CUSTOM_FIELDS.has(objectName)
}

const UNPROVISIONABLE = new RegExp(
  [
    'custom fields? (?:is|are) not (?:allowed|supported|permitted)',
    'cannot (?:create|add)(?: a)? custom field',
    'does not support custom fields',
    'not customizable',
    'entity (?:is not|isn\'t) customizable'
  ].join('|'),
  'i'
)

/** Does a Metadata-API create failure say the ENTITY refuses custom fields (vs. a transient error)? */
export function isUnprovisionableError(message: string): boolean {
  return UNPROVISIONABLE.test(message)
}

/** The operator-facing explanation, one wording for the Readiness row, the gate and the picker. */
export function cannotHostExplanation(objectName: string): string {
  return (
    `${objectName} can't carry a custom field, so this tool has no way to key it — ` +
    `deselect it. (Its rows are not needed for the objects that reference it to deploy.)`
  )
}
