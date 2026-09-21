/**
 * S54 (F1 / L4): why did a Scope-step filter match ZERO records? PURE.
 *
 * Two real cases from the second sb3 pass (2026-09-13), both rendered as a
 * green "✓ 0 records" because the SOQL was valid:
 *   1. `WHERE Id = '006TR00000gALnoYAG'` on the ACCOUNT filter — `006` is an
 *      Opportunity key prefix. The query cannot match anything, ever.
 *   2. `WHERE Id = '001iY000000oCEBQA2'` on Account — a record that exists on
 *      the TARGET (the target's copy of the account). Filters run on the SOURCE, where that
 *      Id does not exist. Detected by probing the target (ipc.ts), worded here.
 * Zero rows on a ROOT filter means the whole deployment is empty (every child
 * is scoped by its parent), so the wording says that too.
 *
 * Key prefixes: the standard objects are a fixed table; everything else (custom,
 * managed — SBQQ objects are `a0…`) comes from the org's global describe, which
 * carries `keyPrefix` per object (ObjectInfo.keyPrefix since S54). Describe
 * overrides the table when both know the prefix.
 */

/** Standard-object key prefixes — fixed across every Salesforce org. */
export const STANDARD_KEY_PREFIXES: Readonly<Record<string, string>> = {
  '001': 'Account',
  '003': 'Contact',
  '005': 'User',
  '006': 'Opportunity',
  '00k': 'OpportunityLineItem',
  '00K': 'OpportunityContactRole',
  '00q': 'OpportunityTeamMember',
  '00Q': 'Lead',
  '00T': 'Task',
  '00U': 'Event',
  '01s': 'Pricebook2',
  '01t': 'Product2',
  '01u': 'PricebookEntry',
  '02i': 'Asset',
  '0Q0': 'Quote',
  '500': 'Case',
  '701': 'Campaign',
  '800': 'Contract',
  '801': 'Order',
  '802': 'OrderItem'
}

const LITERAL_ID = /'([a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})'/g

/** Quoted 15/18-char alphanumeric literals in a clause — record Ids, de-duplicated, in order. */
export function extractLiteralIds(clause: string): string[] {
  const out: string[] = []
  for (const m of (clause ?? '').matchAll(LITERAL_ID)) {
    const id = m[1]!
    if (!out.includes(id)) out.push(id)
  }
  return out
}

export function keyPrefixOf(id: string): string {
  return id.slice(0, 3)
}

export interface PrefixIndex {
  /** key prefix → object API name */
  byPrefix: Map<string, string>
  /** object API name → key prefix */
  byObject: Map<string, string>
}

/** Fixed table first, then the org's global describe (which wins on conflict and adds customs). */
export function buildPrefixIndex(
  objects: ReadonlyArray<{ apiName: string; keyPrefix?: string | null }> = []
): PrefixIndex {
  const byPrefix = new Map<string, string>()
  const byObject = new Map<string, string>()
  const put = (prefix: string, obj: string): void => {
    byPrefix.set(prefix, obj)
    byObject.set(obj, prefix)
  }
  for (const [p, o] of Object.entries(STANDARD_KEY_PREFIXES)) put(p, o)
  for (const o of objects) {
    if (typeof o.keyPrefix === 'string' && o.keyPrefix.length === 3) put(o.keyPrefix, o.apiName)
  }
  return { byPrefix, byObject }
}

/** The Ids whose prefix could belong to `objectName` (unknown prefix ⇒ could). */
export function idsPlausibleFor(objectName: string, ids: string[], index: PrefixIndex): string[] {
  const expected = index.byObject.get(objectName)
  if (!expected) return ids
  return ids.filter((id) => keyPrefixOf(id) === expected)
}

/**
 * First literal Id whose key prefix belongs to a DIFFERENT object than the
 * filtered one → one sentence. Null when every Id is plausible or the filtered
 * object's prefix is unknown (no describe, no table entry).
 */
export function prefixMismatchHint(
  objectName: string,
  ids: string[],
  index: PrefixIndex
): string | null {
  const expected = index.byObject.get(objectName)
  if (!expected) return null
  for (const id of ids) {
    const prefix = keyPrefixOf(id)
    if (prefix === expected) continue
    const owner = index.byPrefix.get(prefix)
    const what = owner
      ? `is ${indefiniteArticle(owner)} ${owner} Id`
      : `has key prefix ${prefix}, which is not ${objectName} (${expected})`
    return `${id} ${what} — this filter is on ${objectName}, so it can never match.`
  }
  return null
}

/** The Id exists on the target org, not the source — the filter runs on the source. */
export function wrongOrgHint(
  objectName: string,
  ids: string[],
  sourceAlias: string,
  targetAlias: string
): string {
  // S57 (FB-9): "an Account", "an Opportunity", "a Contact" — the article
  // follows the object name; the plural form takes none.
  const subject =
    ids.length === 1
      ? `${ids[0]} is ${indefiniteArticle(objectName)} ${objectName} record`
      : `${ids.join(', ')} are ${objectName} records`
  return (
    `${subject} on ${targetAlias} (the target). ` +
    `Filters run against the source, ${sourceAlias} — use the source Id.`
  )
}

/** "an" before a vowel sound (API names start with a letter), "a" otherwise. */
export function indefiniteArticle(word: string): 'a' | 'an' {
  return /^[AEIOU]/i.test(word) ? 'an' : 'a'
}

/** Operator-facing line for a valid clause that matched nothing. */
export function zeroMatchMessage(objectName: string): string {
  return `0 records — nothing will deploy for ${objectName}, or for anything scoped under it.`
}
