/**
 * External-Id field provisioning (5B.4). Creates the seeder's upsert-key field
 * (`Data_Deployment_External_Id__c`) on a TARGET object via the Metadata API,
 * then does a write-through describe-cache invalidation + verify poll (G16) so
 * the UI immediately reflects the new field.
 *
 * WRITE path: gated by GuardedOrg.assertWritable (target-only; prod refuses).
 * The metadata.create call + poll are the only non-pure parts; the metadata
 * shape is a pure, unit-tested builder. FLS grant to the running user is a
 * deploy-time concern (Epic 4) — creating the field is what readiness needs.
 */
import type { GuardedOrg } from './salesforce'
import type { Store } from './store'
import { describeObject } from './describe'
import { assessObject, EXT_ID_FIELD, type ObjectReadiness } from '../engine/readiness'
import { isKnownJunction } from '../engine/junctionDetector'

/** CustomField metadata for the External Id text key. Pure + unit-tested. */
export function buildExtIdFieldMetadata(objectName: string): {
  fullName: string
  label: string
  type: 'Text'
  length: number
  externalId: boolean
  unique: boolean
  required: boolean
} {
  return {
    fullName: `${objectName}.${EXT_ID_FIELD}`,
    label: 'Data Deployment External Id',
    type: 'Text',
    length: 255,
    externalId: true,
    unique: false,
    required: false
  }
}

export interface CreateExtIdDeps {
  sleep?: (ms: number) => Promise<void>
  /** Poll attempts after create before giving up (field can lag a beat). */
  maxAttempts?: number
  pollIntervalMs?: number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface SaveResultLike {
  success: boolean
  fullName?: string
  errors?: unknown
}

/**
 * Create the ExtId field on `objectName` in the target org, then invalidate the
 * describe cache (force re-describe) and poll until the field is visible.
 * Returns the fresh ObjectReadiness. Throws if creation fails or never appears.
 */
export async function createExtIdField(
  org: GuardedOrg,
  store: Store,
  objectName: string,
  deps: CreateExtIdDeps = {}
): Promise<ObjectReadiness> {
  org.assertWritable(`create External Id field on ${objectName}`)
  const sleep = deps.sleep ?? defaultSleep
  const maxAttempts = deps.maxAttempts ?? 5
  const pollIntervalMs = deps.pollIntervalMs ?? 2000

  // Metadata.create accepts one-or-many; normalize to a single SaveResult.
  const raw = (await (
    org.conn.metadata as unknown as {
      create(type: string, md: unknown): Promise<SaveResultLike | SaveResultLike[]>
    }
  ).create('CustomField', buildExtIdFieldMetadata(objectName))) as SaveResultLike | SaveResultLike[]
  const result = Array.isArray(raw) ? raw[0] : raw
  if (!result || !result.success) {
    const detail =
      result && result.errors ? JSON.stringify(result.errors) : 'metadata create returned no success'
    throw new Error(`Could not create ${EXT_ID_FIELD} on ${objectName}: ${detail}`)
  }

  // Write-through invalidation (G16): force a fresh describe (overwrites cache)
  // and poll — a just-created field can take a moment to surface.
  const isJunction = isKnownJunction(objectName)
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const fields = await describeObject(org, store, objectName, /* force */ true)
    const readiness = assessObject({ objectName, fields, isJunction })
    if (!readiness.needsExtIdField) return readiness
    if (attempt < maxAttempts - 1) await sleep(pollIntervalMs)
  }
  throw new Error(
    `${EXT_ID_FIELD} was created on ${objectName} but did not become visible in time — retry the readiness check.`
  )
}
