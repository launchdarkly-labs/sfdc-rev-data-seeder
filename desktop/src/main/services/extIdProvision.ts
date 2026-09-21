/**
 * Bulk External-Id provisioning for the Readiness step.
 *
 * WHY THIS EXISTS (S46 field report): `createExtIdField` created the CustomField
 * and then polled describe until the field appeared — but a field created
 * through the Metadata API carries NO field-level security, and describeSObject
 * omits fields the running user cannot read. So the poll could never succeed and
 * every create surfaced as "created ... but did not become visible in time",
 * once per object. Reproduced independently on ldseed: create → NOT VISIBLE;
 * add FLS → VISIBLE. `Modify All Data` does not bypass FLS, so being a System
 * Administrator does not help.
 *
 * The fix is to grant FLS as part of provisioning, via a dedicated permission
 * set (`RDS_Deployment_Access`) assigned to the running user. Verified on
 * ldseed: `fieldPermissions` ALONE are sufficient — no `objectPermissions`
 * needed — so the permission set stays minimal and grants nothing but read/edit
 * on the seeder's own key fields.
 *
 * Ordering is load-bearing: create fields → grant FLS → assign → THEN poll.
 * Polling before the grant is the original bug.
 *
 * TWO FOLLOW-ON FIXES from the first live run against sb1_830:
 *
 *  1. CLASSIFY VIA TOOLING, NOT DESCRIBE. An existing-but-un-granted field is
 *     indistinguishable from an absent one through describe, so objects whose
 *     field came from a pre-fix run were re-created (DUPLICATE_DEVELOPER_NAME)
 *     and — being in `failures` — were then skipped by the grant. The Tooling
 *     CustomField query is FLS-independent, so it sees the truth;
 *     `targetHasExtIdOrgWide` already implements it (incl. the entity-Id →
 *     API-name resolution managed objects need).
 *
 *  2. GRANT ADDITIVELY. `metadata.upsert('PermissionSet', ...)` is DECLARATIVE:
 *     it replaces the permission set's contents, so a later deployment with a
 *     narrower scope would strip the grants an earlier one made. Grants are now
 *     individual FieldPermissions inserts, skipping rows that already exist
 *     (re-inserting one is rejected as `Duplicate row exists in
 *     FieldPermissions` — verified on ldseed).
 *
 * WRITE path: gated by GuardedOrg.assertWritable (target-only; prod refuses).
 */
import type { GuardedOrg } from './salesforce'
import type { Store } from './store'
import { RDS_PERMISSION_SET, type ObjectReadiness, type ReadinessReport } from '../../shared/types'
import { describeObject } from './describe'
import { assessObject, rollup, EXT_ID_FIELD } from '../engine/readiness'
import { isKnownJunction } from '../engine/junctionDetector'
import { buildExtIdFieldMetadata } from './extIdField'
import { targetHasExtIdOrgWide } from './targetSchemaProbe'
import {
  canHostExtIdField,
  cannotHostExplanation,
  isUnprovisionableError
} from '../../shared/extIdCapability'

/** The permission set the app owns. Created on demand, reused forever after.
 *  Single source is shared/types so the How To page names the same thing. */
export { RDS_PERMISSION_SET }
export const RDS_PERMISSION_SET_LABEL = 'RDS Deployment Access'

/** Metadata API CRUD calls cap at 10 members per request. */
export const METADATA_BATCH_SIZE = 10

export interface ProvisionFailure {
  objectName: string
  error: string
}

export interface ProvisionExtIdsResult {
  /** Objects whose field this call created. */
  created: string[]
  /** Objects that already had a usable ExtId field before this call. */
  alreadyPresent: string[]
  /** Objects covered by the permission set's field permissions. */
  granted: string[]
  /** Junctions, which are exempt by design. */
  skippedJunctions: string[]
  failures: ProvisionFailure[]
  /**
   * S57 (B4): objects whose ENTITY refuses custom fields — the key can never be
   * created there (registry, or the Metadata API said so). Also listed in
   * `failures` with the operator-facing explanation.
   */
  unprovisionable: string[]
  /** True when the permission set had to be created (first run on this org). */
  permissionSetCreated: boolean
  /** True when the running user had to be assigned the permission set. */
  assignmentCreated: boolean
  /** Fresh readiness for every requested object, after provisioning. */
  report: ReadinessReport
}

export interface ProvisionDeps {
  sleep?: (ms: number) => Promise<void>
  maxAttempts?: number
  pollIntervalMs?: number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface SaveResultLike {
  success: boolean
  fullName?: string
  errors?: unknown
}

interface MetadataApi {
  create(type: string, md: unknown): Promise<SaveResultLike | SaveResultLike[]>
  upsert(type: string, md: unknown): Promise<SaveResultLike | SaveResultLike[]>
}

/** Metadata CRUD returns one-or-many; normalize and keep input order. */
function asArray(raw: SaveResultLike | SaveResultLike[]): SaveResultLike[] {
  return Array.isArray(raw) ? raw : [raw]
}

function errorText(r: SaveResultLike | undefined): string {
  if (!r) return 'metadata call returned no result'
  if (r.errors === undefined || r.errors === null) return 'metadata call reported failure with no detail'
  return typeof r.errors === 'string' ? r.errors : JSON.stringify(r.errors)
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Create the ExtId field on many objects in one pass, grant the running user
 * FLS on all of them through the app's permission set, then poll describe until
 * they surface. Partial failure is reported per object rather than thrown — one
 * un-customizable object must not sink the other nine.
 */
export async function provisionExtIdFields(
  org: GuardedOrg,
  store: Store,
  objectNames: string[],
  deps: ProvisionDeps = {}
): Promise<ProvisionExtIdsResult> {
  org.assertWritable(`create External Id fields on ${objectNames.length} object(s)`)
  const sleep = deps.sleep ?? defaultSleep
  const maxAttempts = deps.maxAttempts ?? 5
  const pollIntervalMs = deps.pollIntervalMs ?? 2000
  const metadata = org.conn.metadata as unknown as MetadataApi

  const failures: ProvisionFailure[] = []
  const skippedJunctions: string[] = []
  const alreadyPresent: string[] = []
  const needCreate: string[] = []

  // ── 1. classify from TOOLING, not describe ────────────────────────────────
  // FLS-independent: an existing-but-un-granted field is invisible to describe,
  // and treating it as absent is what produced the DUPLICATE_DEVELOPER_NAME
  // failures on the first live run.
  let objectsWithField: Set<string>
  try {
    objectsWithField = await targetHasExtIdOrgWide(org)
  } catch (e) {
    throw new Error(
      `could not read the target's existing ${EXT_ID_FIELD} fields: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    )
  }

  const unprovisionable: string[] = []
  for (const objectName of objectNames) {
    if (isKnownJunction(objectName)) {
      skippedJunctions.push(objectName)
      continue
    }
    if (objectsWithField.has(objectName)) alreadyPresent.push(objectName)
    else if (!canHostExtIdField(objectName)) {
      // S57 (B4): known to refuse custom fields — do not even ask the platform.
      unprovisionable.push(objectName)
      failures.push({ objectName, error: cannotHostExplanation(objectName) })
    } else needCreate.push(objectName)
  }

  // ── 2. create the missing fields (batched — Metadata CRUD caps at 10) ──────
  const created: string[] = []
  for (const batch of chunk(needCreate, METADATA_BATCH_SIZE)) {
    let results: SaveResultLike[]
    try {
      results = asArray(await metadata.create('CustomField', batch.map(buildExtIdFieldMetadata)))
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      batch.forEach((objectName) => failures.push({ objectName, error }))
      continue
    }
    batch.forEach((objectName, i) => {
      const r = results[i]
      if (r?.success) created.push(objectName)
      else {
        const text = errorText(r)
        // S57 (B4): the platform said the ENTITY refuses custom fields — say that,
        // not a generic "could not create", and remember it for the report.
        if (isUnprovisionableError(text)) {
          unprovisionable.push(objectName)
          failures.push({ objectName, error: `${cannotHostExplanation(objectName)} (${text})` })
        } else {
          failures.push({ objectName, error: `could not create ${EXT_ID_FIELD}: ${text}` })
        }
      }
    })
  }

  // ── 3. grant FLS on everything that has the field ─────────────────────────
  // Both the just-created and the pre-existing ones: a field present from an
  // earlier run may still be unreadable if that run predates this fix.
  const grantTargets = [...created, ...alreadyPresent].sort()
  const granted: string[] = []
  let permissionSetCreated = false
  let assignmentCreated = false

  if (grantTargets.length > 0) {
    try {
      const permSet = await ensurePermissionSet(org)
      permissionSetCreated = permSet.created
      assignmentCreated = await ensureAssignment(org, permSet.id)
      const existing = await existingGrants(org, permSet.id)

      for (const objectName of grantTargets) {
        if (existing.has(objectName)) {
          granted.push(objectName)
          continue
        }
        try {
          await insertGrant(org, permSet.id, objectName)
          granted.push(objectName)
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          // A concurrent run (or a stale read) can race us to the same row.
          if (/duplicate/i.test(message)) granted.push(objectName)
          else failures.push({ objectName, error: `field-level security grant failed: ${message}` })
        }
      }
    } catch (e) {
      // The permission set itself is unavailable — nothing can be granted.
      const error = `field-level security grant failed: ${e instanceof Error ? e.message : String(e)}`
      grantTargets.forEach((objectName) => failures.push({ objectName, error }))
    }
  }

  // ── 4. poll until describe sees them (FLS is in place by now) ─────────────
  const failed = new Set(failures.map((f) => f.objectName))
  const pending = objectNames.filter((o) => !failed.has(o))
  let objects: ObjectReadiness[] = []
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    objects = await readinessFor(org, store, pending)
    if (objects.every((o) => !o.needsExtIdField)) break
    if (attempt < maxAttempts - 1) await sleep(pollIntervalMs)
  }
  for (const o of objects) {
    if (o.needsExtIdField && !failed.has(o.objectName)) {
      failures.push({
        objectName: o.objectName,
        error: `${EXT_ID_FIELD} is still not visible on ${o.objectName} — re-run the check in a moment.`
      })
    }
  }

  // Report on every requested object, including the ones that failed early.
  const reported = new Set(objects.map((o) => o.objectName))
  const missing = await readinessFor(
    org,
    store,
    objectNames.filter((o) => !reported.has(o))
  )

  // S57 (B4): the fresh report flags the rows that can never go green.
  const flagged = [...objects, ...missing].map((o) =>
    unprovisionable.includes(o.objectName) ? { ...o, cannotHostCustomField: true } : o
  )
  return {
    created,
    alreadyPresent,
    granted,
    skippedJunctions,
    failures,
    unprovisionable,
    permissionSetCreated,
    assignmentCreated,
    report: rollup(flagged)
  }
}

interface DataApi {
  identity(): Promise<{ user_id: string }>
  query(soql: string): Promise<{ records: Record<string, unknown>[] }>
  sobject(name: string): { create(rec: Record<string, unknown>): Promise<SaveResultLike> }
}

const dataApi = (org: GuardedOrg): DataApi => org.conn as unknown as DataApi

/**
 * Find (or create) the app's permission set. Inserted through the DATA api on
 * purpose: a metadata upsert would REPLACE its contents and strip grants made
 * by an earlier deployment with a wider scope.
 */
async function ensurePermissionSet(org: GuardedOrg): Promise<{ id: string; created: boolean }> {
  const conn = dataApi(org)
  const found = await conn.query(
    `SELECT Id FROM PermissionSet WHERE Name = '${RDS_PERMISSION_SET}' LIMIT 1`
  )
  const existingId = found.records[0]?.Id
  if (typeof existingId === 'string') return { id: existingId, created: false }

  const result = await conn.sobject('PermissionSet').create({
    Name: RDS_PERMISSION_SET,
    Label: RDS_PERMISSION_SET_LABEL,
    Description:
      'Grants the deploying user read/edit on Data Deployment External Id fields. Created and maintained by RDS Desktop.'
  })
  if (!result.success) throw new Error(`could not create ${RDS_PERMISSION_SET}: ${errorText(result)}`)
  const id = (result as { id?: string }).id
  if (id === undefined) throw new Error(`${RDS_PERMISSION_SET} was created but returned no Id`)
  return { id, created: true }
}

/** Assign the app's permission set to the running user. Returns true if newly assigned. */
async function ensureAssignment(org: GuardedOrg, permSetId: string): Promise<boolean> {
  const conn = dataApi(org)
  const identity = await conn.identity()
  const existing = await conn.query(
    `SELECT Id FROM PermissionSetAssignment WHERE PermissionSetId = '${permSetId}' AND AssigneeId = '${identity.user_id}' LIMIT 1`
  )
  if (existing.records.length > 0) return false

  const result = await conn
    .sobject('PermissionSetAssignment')
    .create({ PermissionSetId: permSetId, AssigneeId: identity.user_id })
  if (!result.success) throw new Error(`permission set assignment failed: ${errorText(result)}`)
  return true
}

/**
 * Objects already carrying an ExtId grant on this permission set (re-inserting
 * one is rejected as a duplicate row).
 *
 * `FieldPermissions.Field` is an ID-TYPED field: filtering it with LIKE fails
 * with `invalid operator on id field`, only `=`/`IN` are allowed. So the filter
 * is ParentId alone and the ExtId rows are picked out client-side — which also
 * keeps any unrelated grant on this permission set from being miscounted.
 */
async function existingGrants(org: GuardedOrg, permSetId: string): Promise<Set<string>> {
  const res = await dataApi(org).query(
    `SELECT SobjectType, Field FROM FieldPermissions WHERE ParentId = '${permSetId}'`
  )
  return new Set(
    res.records
      .filter((r) => String(r.Field ?? '').endsWith(`.${EXT_ID_FIELD}`))
      .map((r) => String(r.SobjectType ?? ''))
      .filter((name) => name.length > 0)
  )
}

async function insertGrant(org: GuardedOrg, permSetId: string, objectName: string): Promise<void> {
  const result = await dataApi(org).sobject('FieldPermissions').create({
    ParentId: permSetId,
    SobjectType: objectName,
    Field: `${objectName}.${EXT_ID_FIELD}`,
    PermissionsRead: true,
    PermissionsEdit: true
  })
  if (!result.success) throw new Error(errorText(result))
}

/** Force-describe each object and assess it; describe errors become entries, not throws. */
async function readinessFor(
  org: GuardedOrg,
  store: Store,
  objectNames: string[]
): Promise<ObjectReadiness[]> {
  const out: ObjectReadiness[] = []
  for (const objectName of objectNames) {
    const isJunction = isKnownJunction(objectName)
    try {
      const fields = await describeObject(org, store, objectName, /* force */ true)
      out.push(assessObject({ objectName, fields, isJunction }))
    } catch (e) {
      out.push({
        objectName,
        isJunction,
        hasExtIdField: false,
        extIdIsExternalId: false,
        needsExtIdField: false,
        describeError: e instanceof Error ? e.message : String(e)
      })
    }
  }
  return out
}
