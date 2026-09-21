/**
 * E4X.6 — source-query builder. Byte-faithful port of Apex
 * `DataDeploymentService.buildSourceQueryV2` (DataDeploymentService.cls:750-813)
 * plus the two call-site variants in `DataDeploymentQueueable.executeNormalModeV2`
 * (L1721-1742): the PricebookEntry `ORDER BY` and the retry `Id IN (…)` append.
 *
 * The rendered SOQL must byte-match the Apex output (E4X.6 GF AC), so the SELECT
 * field ORDER matters: Apex builds it in a `Set<String>` seeded with `'Id'` then
 * the createable fields in `fields` order. Apex `Set<String>` iterates in
 * INSERTION order (officially unspecified — §5 trap 3 — but empirically stable),
 * so the port uses a JS `Set` (insertion-ordered, deduping) to match. If a
 * captured golden ever shows a different SELECT order, revisit this assumption.
 *
 * PARITY-FIRST: `ciEquals` for every Apex `==` (object/field literals);
 * `apexTrim` for `filterClause.trim()` (Java-exact whitespace); `escapeSingleQuotes`
 * for the object name and each retry Id (SOQL-injection guard, matching Apex).
 *
 * Pure: no jsforce, no better-sqlite3.
 */

import { ciEquals, isBlank, apexTrim, escapeSingleQuotes } from './apexSemantics'
import type { GoldenFieldInfo } from '../golden/fixture'

/**
 * Port of `buildSourceQueryV2` (DDS L750-813). `sourceHasIsPersonAccountOverride`
 * is TRI-STATE (matching the Apex overload): `true`/`false` force the Contact
 * Person-Account filter on/off; `null` falls back to scanning `fields` for
 * `IsPersonAccount` (the legacy autodetect — but note the intersection filter
 * usually drops that non-createable field, so the caller passes the value
 * computed from the FULL source describe). The `mappings` param the Apex method
 * takes is DEAD (never read in its body), so it is intentionally omitted here.
 */
export function buildSourceQueryV2(
  objectName: string,
  fields: ReadonlyArray<GoldenFieldInfo>,
  filterClause: string | null,
  sourceHasIsPersonAccountOverride: boolean | null = null
): string {
  const selectFields = new Set<string>(['Id']) // insertion-ordered, deduping
  let sourceHasIsPersonAccount =
    sourceHasIsPersonAccountOverride != null ? sourceHasIsPersonAccountOverride : false

  for (const fi of fields) {
    if (sourceHasIsPersonAccountOverride == null && ciEquals(fi.apiName, 'IsPersonAccount')) {
      sourceHasIsPersonAccount = true
    }
    if (!fi.isCreateable) continue
    if (fi.isAutoNumber) continue
    if (fi.isCalculated) continue
    if (ciEquals(fi.apiName, 'Id')) continue
    // For reference fields, the raw lookup Id column is selected (ExtId refs are
    // computed at transform time) — same as any other createable field.
    selectFields.add(fi.apiName)
  }

  let soql = 'SELECT ' + [...selectFields].join(', ') + ' FROM ' + escapeSingleQuotes(objectName)

  // Person-Account shadow Contacts fail REQUIRED_FIELD_MISSING [LastName] on
  // upsert — filter them out (DDS L784-786). Only when the source has PA enabled.
  let pAFilter: string | null =
    ciEquals(objectName, 'Contact') && sourceHasIsPersonAccount ? 'IsPersonAccount = false' : null

  if (!isBlank(filterClause)) {
    let fc = apexTrim(filterClause)
    const up = fc.toUpperCase()
    if (up.startsWith('WHERE ') || up.startsWith('LIMIT ') || up.startsWith('ORDER ')) {
      // Inject the PA filter into an existing WHERE; else append the clause as-is.
      if (pAFilter != null && up.startsWith('WHERE ')) {
        fc = 'WHERE ' + pAFilter + ' AND ' + fc.substring(6)
        pAFilter = null
      }
      soql += ' ' + fc
    } else {
      const combined = pAFilter == null ? fc : pAFilter + ' AND ' + fc
      soql += ' WHERE ' + combined
      pAFilter = null
    }
  }

  // No user filter consumed the PA filter — append it on its own.
  if (pAFilter != null) soql += ' WHERE ' + pAFilter

  return soql
}

/**
 * The normal-path source query (DataDeploymentQueueable L1738-1742): the base
 * query plus, for PricebookEntry, `ORDER BY Pricebook2.IsStandard DESC` (standard
 * pricebook entries first, so directId-defaulted PBE refs resolve deterministically).
 */
export function buildNormalSourceQuery(
  objectName: string,
  fields: ReadonlyArray<GoldenFieldInfo>,
  filterClause: string | null,
  sourceHasIsPersonAccountOverride: boolean | null = null
): string {
  let soql = buildSourceQueryV2(objectName, fields, filterClause, sourceHasIsPersonAccountOverride)
  if (ciEquals(objectName, 'PricebookEntry')) {
    soql += ' ORDER BY Pricebook2.IsStandard DESC'
  }
  return soql
}

/**
 * The retry-pass source query (DataDeploymentQueueable L1721-1730): the base
 * query with NO user filter, then the failed source Ids `AND`-ed (or `WHERE`-d)
 * on as `Id IN (…)`. The PA filter is still applied (via the base query) so a
 * retry can't re-pull PA shadow Contacts the first pass filtered out.
 */
export function buildRetrySourceQuery(
  objectName: string,
  fields: ReadonlyArray<GoldenFieldInfo>,
  retryIds: ReadonlyArray<string>,
  sourceHasIsPersonAccountOverride: boolean | null = null
): string {
  let soql = buildSourceQueryV2(objectName, fields, '', sourceHasIsPersonAccountOverride)
  const quoted = retryIds.map((id) => "'" + escapeSingleQuotes(id) + "'")
  const idIn = 'Id IN (' + quoted.join(',') + ')'
  // A base query that already carries a WHERE (the PA filter) gets AND; else WHERE.
  soql += soql.toUpperCase().includes(' WHERE ') ? ' AND ' + idIn : ' WHERE ' + idIn
  return soql
}
