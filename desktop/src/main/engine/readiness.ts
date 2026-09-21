/**
 * Readiness rules (5B.4) — PURE. Given each in-scope object's target-org fields
 * (and whether it's a junction), decide whether the target is ready to receive
 * an idempotent, upsert-keyed deploy.
 *
 * The seeder upserts every non-junction object by a dedicated External Id text
 * field (`Data_Deployment_External_Id__c`, mirrors the Apex app's hardcoded
 * key). Junctions never get one (FIELD_INTEGRITY_EXCEPTION on OCR-style objects
 * — see junctionDetector); they're matched by their parent-lookup pair instead,
 * so a missing ExtId field on a junction is NOT a readiness problem.
 */
import type { FieldInfo, ObjectReadiness, ReadinessReport } from '../../shared/types'
import { canHostExtIdField } from '../../shared/extIdCapability'

export type { ObjectReadiness, ReadinessReport }

/** The upsert key field the seeder relies on (hardcoded, matches Apex). */
export const EXT_ID_FIELD = 'Data_Deployment_External_Id__c'

export interface ObjectDescribeInput {
  objectName: string
  fields: FieldInfo[]
  /** True for a known junction — exempt from the ExtId requirement. */
  isJunction: boolean
  /**
   * S57 (B4): the entity refuses custom fields (Provision said so). Omitted ⇒
   * consult the shared registry. A junction is never flagged (it needs no key).
   */
  cannotHostCustomField?: boolean
}

export function assessObject(input: ObjectDescribeInput): ObjectReadiness {
  const field = input.fields.find((f) => f.apiName === EXT_ID_FIELD)
  const hasExtIdField = !!field
  const extIdIsExternalId = !!field?.isExternalId
  const needsExtIdField = !input.isJunction && !(hasExtIdField && extIdIsExternalId)
  const cannotHost =
    !input.isJunction &&
    !hasExtIdField &&
    (input.cannotHostCustomField ?? !canHostExtIdField(input.objectName))
  return {
    objectName: input.objectName,
    isJunction: input.isJunction,
    hasExtIdField,
    extIdIsExternalId,
    needsExtIdField,
    ...(cannotHost ? { cannotHostCustomField: true } : {})
  }
}

/** Roll per-object readiness (incl. describe-error entries) into a report. */
export function rollup(objects: ObjectReadiness[]): ReadinessReport {
  const junctionCount = objects.filter((o) => o.isJunction).length
  const missingExtIdCount = objects.filter((o) => o.needsExtIdField).length
  return {
    objects,
    objectCount: objects.length,
    junctionCount,
    missingExtIdCount,
    ready: missingExtIdCount === 0
  }
}

export function assessReadiness(inputs: ObjectDescribeInput[]): ReadinessReport {
  return rollup(inputs.map(assessObject))
}
