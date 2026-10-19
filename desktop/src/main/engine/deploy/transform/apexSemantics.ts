/**
 * The §5-traps helper library (transformMap.md §5) — the small, ubiquitous
 * Apex language semantics the deploy port must reproduce bug-for-bug, because
 * a "helpful" JS-idiomatic version silently changes data outcomes.
 *
 * Pure: no jsforce, no better-sqlite3. `isBlank`/`apexTrim` are NOT redefined
 * here — they already live in `engine/scoping.ts` (Session-30, Apex/Java-exact
 * whitespace, parity-tested) and are re-exported so deploy code has one import
 * surface for all §5 helpers while the definition stays single-sourced.
 */

// Single source: the Apex/Java-exact whitespace helpers (scoping.ts:118-146) and
// the SOQL single-quote escaper (scoping.ts:150-153, used by the analysis engine's
// query builder). E4X.6 is the first deploy-side consumer of escapeSingleQuotes —
// re-exported here (NOT redefined) so deploy code has one import surface.
export { apexTrim, isBlank, escapeSingleQuotes } from '../../scoping'

/**
 * Trap 1 — **Apex `String ==` is case-INSENSITIVE** (ASCII/ordinal, not
 * locale-aware). Mandatory for every strategy/object/status comparison in the
 * deploy engine: `strategy == 'externalId'`, `objectName == 'Contact'`,
 * `refObj == 'User'`, `state == 'Failed'`. A hand-edited mapping of
 * `"DirectId"` works in Apex but breaks a raw TS `===`. Null semantics match
 * Apex: `null == null` → true, `null == 'x'` → false.
 *
 * Uses `toLowerCase` (NOT `toLocaleLowerCase`) so folding is locale-independent
 * and deterministic — Ids, field API names and strategy literals are all ASCII.
 */
export function ciEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Trap 19 — Apex `String.valueOf(Object)`: `null` → `null` (NOT the string
 * `'null'`, so callers' subsequent null-checks work, e.g. NameMatchResolver
 * L322), `Boolean` → `'true'`/`'false'`, numeric → a plain decimal string with
 * no exponent. Intended for match-field / lookup-value stringification; raw
 * currency/decimal scale is preserved elsewhere by passing source JSON through
 * untouched (trap 8), never through this helper.
 */
export function apexStringValueOf(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return numberToPlainString(v)
  return String(v)
}

/**
 * Trap 10 — **Java `String.split` takes a REGEX**, and with the default limit
 * (0) trailing empty strings are removed; but a pattern that never matches
 * returns the whole input as a single element (even when the input is empty).
 * JS `String.split` does neither, so callers like the multi-picklist `';'`
 * split (`sval.split(';')`) and `Junction_Parents__c.split(',')` need this.
 *
 * A string `pattern` is compiled as a regex exactly like Apex (`'\\.'` → the
 * escaped-dot regex, matching a literal `.`).
 */
export function splitRegex(input: string, pattern: string | RegExp): string[] {
  const re =
    typeof pattern === 'string'
      ? new RegExp(pattern)
      : new RegExp(pattern.source, pattern.flags.replace('g', ''))
  // Java: no match at all → the original string as the sole element (incl. '').
  if (!re.test(input)) return [input]
  const parts = input.split(re)
  // Java default limit 0: drop trailing empty strings.
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/**
 * Trap 13 — Apex `String.left(n)`: the first `n` characters (the whole string
 * if shorter), `''` for `n <= 0`. Reproduced only where log-format parity needs
 * it (rendered log/error strings); the truncated-field STATE that used to drive
 * `parseIdListSafe` is relational now, so that tolerance is a documented
 * no-port (transformMap §5 trap 13 / kill list).
 */
export function leftTruncate(s: string, n: number): string {
  if (n <= 0) return ''
  return s.length <= n ? s : s.slice(0, n)
}

/**
 * Expands JS exponential notation (`1e+21`) to a plain decimal string so a
 * numeric lookup value stringifies the way Apex `String.valueOf` would. Safe
 * integers and non-exponential values pass through `String(n)` unchanged.
 */
function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  const s = String(n)
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(s)
  if (!m) return s
  const sign = m[1] ?? ''
  const intPart = m[2] ?? ''
  const fracPart = m[3] ?? ''
  const exp = parseInt(m[4] ?? '0', 10)
  const digits = intPart + fracPart
  // Position of the decimal point relative to the start of `digits`.
  const point = intPart.length + exp
  if (point <= 0) {
    return `${sign}0.${'0'.repeat(-point)}${digits}`
  }
  if (point >= digits.length) {
    return `${sign}${digits}${'0'.repeat(point - digits.length)}`
  }
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
}

// escapeSingleQuotes is re-exported from scoping.ts at the top of this file
// (single source). It is the Apex `String.escapeSingleQuotes` SOQL-literal
// escaper (`'` → `\'`, backslashes untouched) — matched bug-for-bug for parity.
