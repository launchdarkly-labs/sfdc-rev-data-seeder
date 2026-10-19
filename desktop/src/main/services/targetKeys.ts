/**
 * S57 (B1) — what the TARGET knows about objects that are NOT in the plan.
 *
 * Run 24 (sb1-915-git, 2026-09-18): CampaignMember in scope, Campaign not,
 * `CampaignId` locked to Skip → 228/228 `REQUIRED_FIELD_MISSING`, although run
 * 23 had put that very Campaign on the target WITH its RDS key minutes earlier.
 * The engine could already resolve such a reference (stage-1 writes
 * `{ Rel: { ExtId } }`, parent-strip probes the target by ExtId, fail-loud);
 * only the POLICY layer refused, because it consulted `selectedObjects` alone.
 * This module supplies the two facts the policy now accepts (`TargetKeyInfo`):
 *
 *   hasField  — objects carrying `Data_Deployment_External_Id__c` on the target
 *               (the org-wide Tooling oracle `targetHasExtIdOrgWide`, cached per
 *               org for a few minutes: the wizard asks on every step render)
 *   keyedRows — objects with ≥ 1 RDS-keyed row (`SELECT Id … WHERE ExtId != null
 *               LIMIT 1`, one read-only query per candidate; a query failure
 *               fails OPEN for that object — "unknown" reads as "not keyed", which
 *               is the pre-S57 behaviour, never a false unlock).
 *
 * READ-ONLY. Never writes to any org.
 */
import type { GuardedOrg } from './salesforce'
import { targetHasExtIdOrgWide } from './targetSchemaProbe'
import { EXT_ID_FIELD, type TargetKeyInfo } from '../../shared/mappingPolicy'

const API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/
const HAS_FIELD_TTL_MS = 5 * 60_000

interface CacheEntry {
  at: number
  set: Set<string>
}
const hasFieldCache = new Map<string, CacheEntry>()

/** The org-wide "has the ExtId field" set, cached per target org id. `force` bypasses the cache. */
export async function targetHasExtIdCached(target: GuardedOrg, force = false): Promise<Set<string>> {
  const hit = hasFieldCache.get(target.orgId)
  if (!force && hit != null && Date.now() - hit.at < HAS_FIELD_TTL_MS) return hit.set
  const set = await targetHasExtIdOrgWide(target)
  hasFieldCache.set(target.orgId, { at: Date.now(), set })
  return set
}

/** Drop the cached field set for an org (call after provisioning ExtId fields on it). */
export function invalidateTargetKeysCache(orgId?: string): void {
  if (orgId == null) hasFieldCache.clear()
  else hasFieldCache.delete(orgId)
}

/** Minimal query surface — jsforce's `conn.query` returns a thenable `Query`, hence PromiseLike. */
export interface KeyedRowsQuery {
  query(soql: string): PromiseLike<{ totalSize?: number; records?: unknown[] }>
}

/**
 * Which of `candidates` (that carry the field) hold at least one keyed row on the
 * target. One `LIMIT 1` query per object; failures fail open (object omitted).
 */
export async function probeKeyedRows(
  conn: KeyedRowsQuery,
  hasField: ReadonlySet<string>,
  candidates: Iterable<string>
): Promise<Set<string>> {
  const keyed = new Set<string>()
  for (const obj of new Set(candidates)) {
    if (!API_NAME.test(obj) || !hasField.has(obj)) continue
    try {
      const res = await conn.query(`SELECT Id FROM ${obj} WHERE ${EXT_ID_FIELD} != null LIMIT 1`)
      const n = res.totalSize ?? res.records?.length ?? 0
      if (n > 0) keyed.add(obj)
    } catch {
      // fail OPEN: unknown ⇒ not keyed (the pre-S57 lock), never a false unlock
    }
  }
  return keyed
}

/** Both facts for a set of candidate objects, as the policy layer consumes them. */
export async function probeTargetKeys(
  target: GuardedOrg,
  candidates: Iterable<string>,
  opts: { force?: boolean; hasField?: ReadonlySet<string> } = {}
): Promise<TargetKeyInfo> {
  const list = [...new Set(candidates)].filter((o) => API_NAME.test(o))
  const hasFieldAll = opts.hasField ?? (await targetHasExtIdCached(target, opts.force === true))
  const hasField = new Set(list.filter((o) => hasFieldAll.has(o)))
  const keyedRows = await probeKeyedRows(target.conn, hasField, list)
  return { hasField, keyedRows }
}
