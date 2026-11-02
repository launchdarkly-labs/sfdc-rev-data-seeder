/**
 * S70 (UAT U-4): the per-org External-Id footprint shown on the Org Connections
 * detail page. Two READ-ONLY questions about one org:
 *
 *  1. Which objects carry the seeder's upsert-key field? — answered by the
 *     existing org-wide Tooling probe (`targetHasExtIdOrgWide`), which is
 *     FLS-independent and already handles managed-object entity Ids. Works on
 *     any role, prod-pinned included: nothing here calls assertWritable.
 *  2. How many rows on one object have the field populated? — one COUNT()
 *     query, run on demand per object (never for the whole list at once).
 *
 * The object name reaches a SOQL string, so it is whitelisted to the API-name
 * grammar first; the renderer only ever sends names the probe returned, but
 * the handler must not rely on that.
 */
import type { GuardedOrg } from './salesforce'
import type { OrgExtIdFootprint } from '../../shared/types'
import { EXT_ID_FIELD } from '../engine/readiness'
import { isKnownJunction } from '../engine/junctionDetector'
import { targetHasExtIdOrgWide } from './targetSchemaProbe'

/** Salesforce API names: letters, digits, underscores; namespaces and `__c`/`__mdt` suffixes included. */
const API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,99}$/

export function isSafeObjectName(name: string): boolean {
  return API_NAME.test(name)
}

/** Pure: the COUNT() query for populated upsert keys on one object. Throws on a name outside the grammar. */
export function buildExtIdCountSoql(objectName: string): string {
  if (!isSafeObjectName(objectName)) throw new Error(`Not a Salesforce object API name: ${objectName}`)
  return `SELECT COUNT() FROM ${objectName} WHERE ${EXT_ID_FIELD} != null`
}

export async function orgExtIdFootprint(org: GuardedOrg): Promise<OrgExtIdFootprint> {
  const names = await targetHasExtIdOrgWide(org)
  const objects = [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((objectName) => ({ objectName, isJunction: isKnownJunction(objectName) }))
  return { fieldName: EXT_ID_FIELD, objects, checkedAt: Date.now() }
}

export async function orgExtIdPopulatedCount(org: GuardedOrg, objectName: string): Promise<number> {
  const res = (await org.conn.query(buildExtIdCountSoql(objectName))) as { totalSize?: number }
  return res.totalSize ?? 0
}
