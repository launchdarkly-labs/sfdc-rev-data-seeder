/**
 * Describe service — global + per-object describes with SQLite caching.
 * Mirrors what SchemaService + the Phase-0 describe hops did in Apex,
 * minus the callout budget and the Cached_Field_Describe__c plumbing.
 */
import type { DescribeGlobalResult, DescribeSObjectResult } from '@jsforce/jsforce-node'
import type { FieldInfo, ObjectInfo } from '../../shared/types'
import type { GuardedOrg } from './salesforce'
import type { Store } from './store'

/** Describe cache TTL — schemas move slowly; refresh is explicit in the UI. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * The same UNSUPPORTED filters SchemaService applies: history/share/feed/
 * changeevent tables and non-queryable objects never enter the object list.
 */
const UNSUPPORTED_SUFFIXES = ['History', 'Share', 'Feed', 'ChangeEvent', 'Tag'] as const

function isSupportedObject(name: string, queryable: boolean): boolean {
  if (!queryable) return false
  return !UNSUPPORTED_SUFFIXES.some((s) => name.endsWith(s) || name.endsWith(`__${s}`))
}

export async function describeGlobal(
  org: GuardedOrg,
  store: Store,
  force = false
): Promise<ObjectInfo[]> {
  const cached = force ? null : store.getCachedDescribe(org.orgId, '')
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return JSON.parse(cached.payload) as ObjectInfo[]
  }
  const res: DescribeGlobalResult = await org.conn.describeGlobal()
  const objects: ObjectInfo[] = res.sobjects
    .filter((o) => isSupportedObject(o.name, o.queryable ?? false))
    .map((o) => ({
      apiName: o.name,
      label: o.label ?? o.name,
      custom: o.custom ?? false,
      queryable: o.queryable ?? false,
      createable: o.createable ?? false,
      keyPrefix: o.keyPrefix ?? null
    }))
  store.putCachedDescribe(org.orgId, '', JSON.stringify(objects))
  return objects
}

export async function describeObject(
  org: GuardedOrg,
  store: Store,
  objectApiName: string,
  force = false
): Promise<FieldInfo[]> {
  const cached = force ? null : store.getCachedDescribe(org.orgId, objectApiName)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return JSON.parse(cached.payload) as FieldInfo[]
  }
  const res: DescribeSObjectResult = await org.conn.describe(objectApiName)
  const fields: FieldInfo[] = res.fields.map((f) => ({
    apiName: f.name,
    label: f.label ?? f.name,
    type: f.type ?? 'string',
    isReference: (f.referenceTo?.length ?? 0) > 0,
    referenceTo: (f.referenceTo ?? []).filter((r): r is string => !!r),
    isCreateable: f.createable ?? false,
    isUpdateable: f.updateable ?? false,
    isNillable: f.nillable ?? true,
    isExternalId: f.externalId ?? false,
    isAutoNumber: f.autoNumber ?? false,
    isCalculated: f.calculated ?? false,
    isRestrictedPicklist: f.restrictedPicklist ?? false,
    // S50 (BUG-14): enforced lookup filter. jsforce types filteredLookupInfo as
    // a bare `object`, so read the one property we need defensively.
    hasEnforcedLookupFilter:
      f.filteredLookupInfo != null &&
      (f.filteredLookupInfo as { optionalFilter?: boolean }).optionalFilter !== true,
    picklistValues: (f.picklistValues ?? [])
      .filter((pv) => pv.active !== false)
      .map((pv) => pv.value)
      .filter((v): v is string => v !== null && v !== undefined),
    length: typeof f.length === 'number' ? f.length : null
  }))
  store.putCachedDescribe(org.orgId, objectApiName, JSON.stringify(fields))
  return fields
}
