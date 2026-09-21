/**
 * Filter → COUNT() query builder for the Step-2 filter editor (5B.3), PURE.
 *
 * The wizard validates a user's per-object WHERE clause by running a
 * `SELECT COUNT() FROM <obj> WHERE <clause>` against the SOURCE org. Two SOQL
 * facts drive this builder:
 *   1. The `COUNT()` aggregate form forbids trailing `ORDER BY`, and a trailing
 *      `LIMIT`/`OFFSET` would silently CAP the count (`min(actual, n)`) — a wrong
 *      number with no error. So any top-level trailing clause must be removed
 *      before counting.
 *   2. Per the uiDesign AC, we **surface** what was removed (`strippedClause`)
 *      rather than silently dropping it — the user sees "trailing clause ignored
 *      for the count" instead of a confusing error or a wrong number.
 *
 * Only a TOP-LEVEL trailing clause is stripped: an ORDER BY/LIMIT/OFFSET inside a
 * subquery/semi-join (paren depth > 0) or a string literal is left untouched. A
 * leading `WHERE` the user may have typed is also stripped so we never emit
 * `WHERE WHERE`. Word boundaries (`\b`, and `)` as a delimiter) keep us from
 * matching inside field names (`Where__c`, `LimitField__c`) or abutting a
 * subquery's close paren without a space.
 */

export interface CountQuery {
  /** The COUNT() SOQL to run (trailing ORDER BY/LIMIT/OFFSET stripped). */
  soql: string
  /** The top-level trailing clause that was removed (surfaced to the user), or null. */
  strippedClause: string | null
}

interface StripResult {
  where: string
  strippedClause: string | null
}

/** A top-level trailing clause invalid/unsafe inside a COUNT(): ORDER BY, LIMIT, OFFSET. */
const TRAILING_CLAUSE = /^(order\s+by\b|limit\b|offset\b)/i

/**
 * Strip a leading `WHERE` and the first TOP-LEVEL trailing ORDER BY/LIMIT/OFFSET
 * from a clause. Skips parenthesized subqueries and single-quoted string literals.
 */
function stripClause(raw: string): StripResult {
  // `\b` (not `\s+`) so `WHERE(...)` strips but `Where__c` / `WhereUsed__c` don't.
  const clause = raw.replace(/^\s*where\b\s*/i, '').trim()
  let depth = 0
  let inString = false

  for (let i = 0; i < clause.length; i++) {
    const c = clause[i]

    if (inString) {
      if (c === '\\') {
        i++ // skip the escaped character
      } else if (c === "'") {
        inString = false
      }
      continue
    }

    if (c === "'") {
      inString = true
    } else if (c === '(') {
      depth++
    } else if (c === ')') {
      if (depth > 0) depth--
    } else if (depth === 0) {
      // A trailing clause starts a token: at index 0, or right after whitespace,
      // or right after a subquery close paren (')' is always a SOQL delimiter).
      const atWordStart = i === 0 || /[\s)]/.test(clause.charAt(i - 1))
      if (atWordStart && TRAILING_CLAUSE.test(clause.slice(i))) {
        return {
          where: clause.slice(0, i).trim(),
          strippedClause: clause.slice(i).trim()
        }
      }
    }
  }

  return { where: clause, strippedClause: null }
}

/** Build a `SELECT COUNT() FROM <obj> [WHERE <clause>]`, trailing clause stripped + surfaced. */
export function buildCountQuery(objectName: string, filterClause: string): CountQuery {
  const { where, strippedClause } = stripClause(filterClause ?? '')
  const soql = where
    ? `SELECT COUNT() FROM ${objectName} WHERE ${where}`
    : `SELECT COUNT() FROM ${objectName}`
  return { soql, strippedClause }
}
