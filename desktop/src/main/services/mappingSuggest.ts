/**
 * Mapping "Suggest" pathway — Id-overlap probes that decide directId vs nameMatch
 * for stable/catalog reference objects. Verbatim port of the Apex
 * `NameMatchResolver.sampleIdOverlap` (L271-298) + `DataSeederController.generateMappingSuggestions`
 * (L2488-2537). Read-only: samples up to 5 source Ids per probe object and checks
 * how many exist on the target — sibling/prod-refreshed sandboxes share Ids
 * (directId safe), divergent orgs need nameMatch.
 *
 * Query execution is injected so this is unit-testable without a live org.
 */

import type { IdOverlap, MappingSuggestions, SuggestedStrategy } from '../../shared/types'

export type { IdOverlap, MappingSuggestions, SuggestedStrategy }

/** Probe objects whose verdicts drive the ORG-WIDE directId/nameMatch recommendation. */
export const STABLE_PROBES = ['User', 'RecordType', 'Product2'] as const

/**
 * CPQ catalog objects that get a PER-OBJECT verdict only. They are deliberately NOT
 * folded into the org-wide recommendation: a single divergent catalog object must not
 * flip every stable ref (User/RecordType) to nameMatch and regress their linkage.
 * Must match mappingPolicy.DIRECT_ID_DEFAULT_REFS's catalog entries exactly.
 */
export const CATALOG_PROBES = [
  'SBQQ__ProductOption__c',
  'SBQQ__Dimension__c',
  'SBQQ__BlockPrice__c',
  'SBQQ__DiscountSchedule__c',
  'SBQQ__DiscountTier__c',
  'SBQQ__ContractedPrice__c',
  'SBQQ__Cost__c'
] as const

/** Minimal query result shape (jsforce QueryResult subset). */
export interface QueryLike {
  records?: Array<{ Id?: string | null }>
  totalSize?: number
}
export type QueryFn = (soql: string) => Promise<QueryLike>

/**
 * Sample up to `sampleSize` source Ids for `objectName` and count how many exist on
 * the target. Fail-soft: a source-query failure/empty → sampled 0 (probe omitted);
 * a target-query failure → found 0 (treated as divergent). Mirrors the Apex fallbacks.
 */
export async function sampleIdOverlap(
  querySource: QueryFn,
  queryTarget: QueryFn,
  objectName: string,
  sampleSize = 5
): Promise<IdOverlap> {
  const limitN = sampleSize > 0 ? sampleSize : 5
  const srcWhere = objectName === 'User' ? ' WHERE IsActive = true' : ''
  const srcSoql = `SELECT Id FROM ${objectName}${srcWhere} LIMIT ${limitN}`
  let src: QueryLike
  try {
    src = await querySource(srcSoql)
  } catch {
    return { sampled: 0, found: 0 }
  }
  const ids = (src.records ?? [])
    .map((r) => r.Id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (ids.length === 0) return { sampled: 0, found: 0 }
  const quoted = ids.map((id) => `'${id}'`).join(',')
  const tgtSoql = `SELECT COUNT() FROM ${objectName} WHERE Id IN (${quoted})`
  try {
    const tgt = await queryTarget(tgtSoql)
    return { sampled: ids.length, found: tgt.totalSize ?? 0 }
  } catch {
    return { sampled: ids.length, found: 0 }
  }
}

/** Run all stable + catalog probes and assemble the recommendation (port of generateMappingSuggestions). */
export async function suggestMappings(
  querySource: QueryFn,
  queryTarget: QueryFn
): Promise<MappingSuggestions> {
  const checked: Record<string, IdOverlap> = {}
  const recommendationByObject: Record<string, SuggestedStrategy> = {}
  let idsMatch = true
  let anySampled = false

  // Stable probes → org-wide verdict + per-object entry.
  for (const probe of STABLE_PROBES) {
    const r = await sampleIdOverlap(querySource, queryTarget, probe, 5)
    checked[probe] = r
    if (r.sampled > 0) {
      anySampled = true
      if (r.found < r.sampled) idsMatch = false
      recommendationByObject[probe] = r.found === r.sampled ? 'directId' : 'nameMatch'
    }
  }

  // Catalog probes → per-object verdict only (never folded into the org-wide verdict).
  for (const probe of CATALOG_PROBES) {
    const r = await sampleIdOverlap(querySource, queryTarget, probe, 5)
    checked[probe] = r
    if (r.sampled > 0) {
      recommendationByObject[probe] = r.found === r.sampled ? 'directId' : 'nameMatch'
    }
  }

  return {
    idsMatch: anySampled && idsMatch,
    recommendation: anySampled && idsMatch ? 'directId' : 'nameMatch',
    recommendationByObject,
    checked
  }
}
