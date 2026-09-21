/**
 * scoping — fidelity port of the scoping/materialization half of
 * force-app/main/default/classes/DeploymentAnalysisQueueable.cls:
 * buildScopedFilterForObject, materializeIds' filter handling, buildInClause,
 * stripToConditions, extractLimitClause, buildParentLookupMap.
 *
 * Pure logic: no Node/Electron imports, no I/O. Materialization queries are
 * issued by the caller (analysis.ts) through the query strings this module
 * builds; buildScopedFilterForObject receives an async `materialize` callback
 * so the priority logic stays 1:1 with the Apex while the transport stays out.
 *
 * Priority order (identical to Apex, including the over-cap skips):
 *   1. explicit user filter on the object — always wins; materialize if the
 *      object has children in scope.
 *   2. parent with materialized Ids — exact IN-clause scope (first parent in
 *      lookup-map iteration order with a NON-EMPTY id list). A parent over
 *      IN_ORG_MATERIALIZED_ID_CAP is SKIPPED here exactly like the Apex, so
 *      the next parent — or Priority 3 — can still scope the object with the
 *      same choice the in-org engine makes.
 *   3. subquery fallback from a parent's user filter (parent materialized
 *      empty, or not yet materialized) — including the Apex skip of an
 *      over-cap parent whose filter carries LIMIT (stripToConditions drops
 *      the LIMIT, so the subquery would match MORE parents than the user chose).
 *   4. where the Apex THROWS "cannot be scoped" (only over-cap parents left):
 *      the desktop instead scopes by the first over-cap parent with CHUNKED
 *      IN-clause queries and warns (deviation 1). True no-scope → whole object.
 *
 * ── Deliberate deviations from the Apex original (ROADMAP 3.4) ──────────────
 * 1. NO "cannot be scoped" THROW. The in-org engine caps materialized parent
 *    lists at 1,000 (MATERIALIZED_ID_CAP) because the literal IN-clause must
 *    persist in Scoped_Filter__c (LongTextArea 32K) and re-run as ONE SOQL
 *    statement; when nothing below the cap can scope an object it throws.
 *    The desktop has no storage field and no single-statement constraint, so
 *    ONLY in that throw case it proceeds: the over-cap parent's full id list
 *    becomes a `parentIn` scope CHUNKED at 4,000 ids/query (the real ~100K-char
 *    SOQL statement ceiling) and callers union results across chunks, with a
 *    warning naming the in-org failure it replaced. Every case where the Apex
 *    SUCCEEDS (below-cap parent, subquery fallback) picks the same parent the
 *    same way — over-cap handling changes outcomes only where in-org analysis
 *    would have failed.
 * 2. Scopes are STRUCTURED (ScopedFilter union), not WHERE strings. The exact
 *    Apex Scoped_Filter__c text is recoverable via scopedFilterDisplay() —
 *    byte-identical for every scope the in-org engine can produce (single
 *    chunk ≤ 4,000 ids) — which is what the parity harness diffs.
 * 3. Materialization paginates FULLY (no CAP+1 early stop — that existed only
 *    to keep cross-hop JSON state small). Over-cap detection therefore sees
 *    the TRUE list size, where the Apex sees the trimmed CAP+1 signal; both
 *    classify >CAP identically.
 * 4. Apex Map<String,String> iteration order is unspecified-but-deterministic
 *    (hash order); JS Maps iterate in insertion order (field-describe order).
 *    Priority 2/3 take the FIRST qualifying parent, so a multi-parent object
 *    could pick a different parent than Apex does. The parity harness flags
 *    any real divergence; single-parent scopes (the common case) are immune.
 * 5. WHITESPACE IS APEX-EXACT, not JS-default. Apex string semantics are
 *    Java's: regex \s matches ASCII [ \t\n\x0B\f\r] only, String.trim strips
 *    chars <= U+0020 only, and String.isBlank uses Character.isWhitespace
 *    (which EXCLUDES the non-breaking spaces U+00A0/U+2007/U+202F and U+FEFF).
 *    JS \s / trim() / trim-based blank checks all treat NBSP & friends as
 *    whitespace, which would make the desktop strip ORDER BY / LIMIT (or skip
 *    a filter as blank) where the in-org engine does not. The helpers below
 *    (the WS regex class, apexTrim, isBlank) reproduce the Java behavior.
 */
import type { FieldInfo } from '../../shared/types'

/** Real per-SOQL-statement ceiling: ~100K chars ≈ 4,000 quoted 18-char ids. */
export const IN_CLAUSE_MAX_IDS = 4000

/**
 * The in-org engine's DataDeploymentService.MATERIALIZED_ID_CAP. Parents over
 * this are skipped in Priority 2 exactly like the Apex; they only ever scope
 * an object as the last-resort chunked fallback (deviation 1).
 */
export const IN_ORG_MATERIALIZED_ID_CAP = 1000

// ───────────────────────────── scope descriptor ──────────────────────────────

/** No scoping — the whole object deploys (Apex Scoped_Filter__c = null). */
export interface ScopeAll {
  kind: 'all'
}

/** The user's explicit filter clause, verbatim (may carry LIMIT / ORDER BY). */
export interface ScopeRaw {
  kind: 'raw'
  where: string
}

/**
 * Exact parent-id scoping (Apex "WHERE <lookup> IN ('id',...)"), chunked at
 * IN_CLAUSE_MAX_IDS ids per query. Chunks partition the parent ids, so per-chunk
 * results are disjoint and union without dedupe.
 */
export interface ScopeParentIn {
  kind: 'parentIn'
  lookupField: string
  parentObject: string
  idChunks: string[][]
}

/** Subquery fallback (Apex "WHERE <lookup> IN (SELECT Id FROM <parent> WHERE ...)"). */
export interface ScopeParentSubquery {
  kind: 'parentSubquery'
  lookupField: string
  parentObject: string
  conditions: string
}

export type ScopedFilter = ScopeAll | ScopeRaw | ScopeParentIn | ScopeParentSubquery

// ──────────────── Apex/Java-exact whitespace (deviation 5) ───────────────────

/** Java regex \s (default Pattern flags): ASCII whitespace only. */
const WS = ' \\t\\n\\x0B\\f\\r'
const ORDER_BY_RE = new RegExp(`[${WS}]*ORDER[${WS}]+BY[${WS}]+[\\w.,${WS}]+(ASC|DESC)?`, 'gi')
const LIMIT_STRIP_RE = new RegExp(`[${WS}]*LIMIT[${WS}]+\\d+`, 'gi')
const LIMIT_EXTRACT_RE = new RegExp(`(LIMIT[${WS}]+\\d+)`, 'i')

/** Java String.trim: strips leading/trailing chars <= U+0020 (NBSP survives). */
export function apexTrim(s: string): string {
  let start = 0
  let end = s.length
  while (start < end && s.charCodeAt(start) <= 0x20) start++
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end--
  return s.substring(start, end)
}

/**
 * Java Character.isWhitespace: Unicode space separators EXCEPT the
 * non-breaking ones (U+00A0, U+2007, U+202F), plus \t \n \x0B \f \r and
 * the ASCII separator controls \x1C-\x1F. U+FEFF is NOT whitespace.
 */
function isApexWhitespaceChar(ch: string): boolean {
  if (ch === '\u00A0' || ch === '\u2007' || ch === '\u202F') return false
  if (/[\p{Zs}\p{Zl}\p{Zp}]/u.test(ch)) return true
  const code = ch.charCodeAt(0)
  return (code >= 0x09 && code <= 0x0d) || (code >= 0x1c && code <= 0x1f)
}

/** Apex String.isBlank: null/undefined/empty/Java-whitespace-only. */
export function isBlank(s: string | null | undefined): s is null | undefined | '' {
  if (s == null || s.length === 0) return true
  for (const ch of s) {
    if (!isApexWhitespaceChar(ch)) return false
  }
  return true
}

// ─────────────────────────── string-level helpers ────────────────────────────

/** Apex String.escapeSingleQuotes: backslash-escape every single quote. */
export function escapeSingleQuotes(s: string): string {
  return s.replace(/'/g, "\\'")
}

/**
 * Apex stripToConditions: drop ORDER BY / LIMIT, strip a leading WHERE, trim.
 * Regexes and trims are Java-exact (deviation 5).
 */
export function stripToConditions(filter: string | null | undefined): string {
  if (isBlank(filter)) return ''
  let result = apexTrim(filter)
  result = result.replace(ORDER_BY_RE, '')
  result = result.replace(LIMIT_STRIP_RE, '')
  result = apexTrim(result)
  if (result.toUpperCase().startsWith('WHERE ')) result = apexTrim(result.substring(6))
  return result
}

/** Apex extractLimitClause: first "LIMIT n" (case-insensitive), space-prefixed. */
export function extractLimitClause(filter: string | null | undefined): string {
  if (isBlank(filter)) return ''
  const m = LIMIT_EXTRACT_RE.exec(filter)
  return m ? ' ' + m[1] : ''
}

/**
 * Apex materializeIds' filter-clause handling: a clause starting WHERE / LIMIT /
 * ORDER is appended as-is; anything else is treated as bare conditions and gets
 * a WHERE prefix. Blank clauses leave the SOQL untouched.
 */
export function applyFilterToSoql(soql: string, filterClause: string | null | undefined): string {
  if (isBlank(filterClause)) return soql
  const fc = apexTrim(filterClause)
  const up = fc.toUpperCase()
  if (up.startsWith('WHERE ') || up.startsWith('LIMIT ') || up.startsWith('ORDER ')) {
    return soql + ' ' + fc
  }
  return soql + ' WHERE ' + fc
}

/**
 * Apex buildInClause: quote + escape each id, comma-join. The 4,000-id throw is
 * kept as a per-chunk invariant — chunkIds() upstream makes it unreachable, but
 * silently over-long IN clauses must never be emitted (FINDINGS #14 lesson).
 */
export function buildInClause(ids: readonly string[]): string {
  if (ids.length > IN_CLAUSE_MAX_IDS) {
    throw new Error(
      `IN clause exceeds the ${IN_CLAUSE_MAX_IDS}-Id SOQL ceiling (${ids.length} Ids)`
    )
  }
  return ids.map((id) => `'${escapeSingleQuotes(id)}'`).join(',')
}

/**
 * Partition ids into chunks (empty input → no chunks). `size` defaults to
 * IN_CLAUSE_MAX_IDS so the FROZEN plan's `scope.idChunks` are byte-identical to
 * before — callers that must respect the SOQL statement ceiling pass a smaller
 * size computed by {@link maxIdsForSoql}.
 */
export function chunkIds(ids: readonly string[], size: number = IN_CLAUSE_MAX_IDS): string[][] {
  const step = size > 0 ? size : IN_CLAUSE_MAX_IDS
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += step) {
    chunks.push(ids.slice(i, i + step))
  }
  return chunks
}

/** Salesforce's SOQL STATEMENT ceiling (distinct from the URL length limit,
 *  which the POST /composite shim already handles). */
export const SOQL_STATEMENT_MAX = 100_000
/** Headroom for the ORDER BY / LIMIT / typeof clauses appended downstream. */
const SOQL_SAFETY_MARGIN = 2_000
/** One quoted, comma-separated 18-char Id: 18 + 2 quotes + 1 comma. */
const ID_LITERAL_COST = 21

/**
 * S50 (B2) — how many Ids fit in an `IN (…)` alongside a given query.
 *
 * `IN_CLAUSE_MAX_IDS = 4000` is calibrated for `SELECT Id` (4,000 x 21 = 84,000
 * chars, comfortably under the 100,000-char statement ceiling). The DEPLOY
 * queries select the plan's whole field list, and that assumption stops holding.
 *
 * MEASURED against the live frozen plan (2026-09-07): Opportunity selects 590
 * fields = a 13,835-char SELECT, which leaves room for **4,007** ids against a
 * 4,000-id chunk — SEVEN ids of headroom, 0.2%. Not broken today; one added
 * field away from it, and it would fail org-side as MALFORMED_QUERY, which in
 * analysis is a fail-loud AnalysisError and in deploy is a first-page throw →
 * bounded whole-object retry → the object marked failed. Nothing about that
 * error would point at query length.
 *
 * Returns at least 1 (a single enormous SELECT still gets to make progress one
 * id at a time) and never more than IN_CLAUSE_MAX_IDS.
 */
export function maxIdsForSoql(baseSoqlLength: number): number {
  const room = SOQL_STATEMENT_MAX - SOQL_SAFETY_MARGIN - baseSoqlLength
  const n = Math.floor(room / ID_LITERAL_COST)
  if (n < 1) return 1
  return n > IN_CLAUSE_MAX_IDS ? IN_CLAUSE_MAX_IDS : n
}

// ───────────────────────────── parent lookup map ─────────────────────────────

/**
 * Apex buildParentLookupMap: for each object, which in-scope parents it looks
 * up to and via which field. Quirks preserved:
 *  - only createable reference fields count;
 *  - self-references and out-of-scope targets are skipped;
 *  - field choice per parent: the FIRST field wins unless a LATER field is
 *    non-nillable, which overwrites (including overwriting an earlier
 *    non-nillable — Apex `!containsKey || !isNillable` puts unconditionally).
 */
export function buildParentLookupMap(
  deploymentObjects: ReadonlySet<string>,
  fieldMetadata: ReadonlyMap<string, readonly FieldInfo[]>
): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>()
  for (const objName of deploymentObjects) {
    const parentLookups = new Map<string, string>()
    const fields = fieldMetadata.get(objName)
    if (fields != null) {
      for (const fi of fields) {
        if (!fi.isReference || fi.referenceTo == null || fi.referenceTo.length === 0) continue
        if (!fi.isCreateable) continue
        for (const refTo of fi.referenceTo) {
          if (!deploymentObjects.has(refTo)) continue
          if (apexStringEquals(refTo, objName)) continue
          if (!parentLookups.has(refTo) || !fi.isNillable) {
            parentLookups.set(refTo, fi.apiName)
          }
        }
      }
    }
    result.set(objName, parentLookups)
  }
  return result
}

// ─────────────────────────── scoped-filter builder ───────────────────────────

export interface ScopingContext {
  /** objectName → the user's explicit Filter_Clause__c (blank entries omitted). */
  userFilters: ReadonlyMap<string, string>
  /** buildParentLookupMap output: objectName → (parentObject → lookupField). */
  parentLookups: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** objectName → materialized in-scope ids (filled by `materialize`). */
  materializedIds: ReadonlyMap<string, readonly string[]>
  /** Objects some other in-scope object looks up to. */
  objectsWithChildren: ReadonlySet<string>
  /**
   * Materialize this object's in-scope ids under `scope` into materializedIds
   * (memoized by the implementation; throws on query failure — fail-loud).
   */
  materialize(objName: string, scope: ScopedFilter): Promise<void>
  /** Advisory warnings (over-cap fallbacks, chunked scopes). */
  warn(message: string): void
}

/**
 * Apex buildScopedFilterForObject. Returns a ScopedFilter instead of a WHERE
 * string; the "cannot be scoped" throw is replaced by the chunked over-cap
 * fallback (deviation 1) — every Apex-succeeding path picks the same parent.
 */
export async function buildScopedFilterForObject(
  objName: string,
  ctx: ScopingContext
): Promise<ScopedFilter> {
  const hasChildren = ctx.objectsWithChildren.has(objName)
  const parentLookups = ctx.parentLookups.get(objName)

  // Priority 1: user filter always wins.
  const userFilter = ctx.userFilters.get(objName)
  if (!isBlank(userFilter)) {
    const scope: ScopedFilter = { kind: 'raw', where: userFilter }
    if (hasChildren) {
      await ctx.materialize(objName, scope)
    }
    return scope
  }

  // Priority 2: parent with materialized ids → exact IN-clause scope. Over-cap
  // parents are skipped exactly like the Apex (overCapParents + continue) so a
  // later below-cap parent — or Priority 3 — makes the same choice in-org
  // analysis would; they are remembered for the last-resort fallback below.
  const overCapParents = new Map<string, { lookupField: string; ids: readonly string[] }>()
  if (parentLookups != null) {
    for (const [parentObj, lookupField] of parentLookups) {
      const parentIds = ctx.materializedIds.get(parentObj)
      if (parentIds != null && parentIds.length > 0) {
        if (parentIds.length > IN_ORG_MATERIALIZED_ID_CAP) {
          overCapParents.set(parentObj, { lookupField, ids: parentIds })
          continue
        }
        const scope: ScopedFilter = {
          kind: 'parentIn',
          lookupField,
          parentObject: parentObj,
          idChunks: chunkIds(parentIds)
        }
        if (hasChildren) {
          await ctx.materialize(objName, scope)
        }
        return scope
      }
    }
  }

  // Priority 3: subquery fallback from a parent's user filter — including the
  // Apex skip of an over-cap parent whose filter carries LIMIT (the subquery
  // can't include LIMIT, so it would match MORE parents than the user chose).
  if (parentLookups != null) {
    for (const [parentObj, lookupField] of parentLookups) {
      const parentUserFilter = ctx.userFilters.get(parentObj)
      if (!isBlank(parentUserFilter)) {
        if (overCapParents.has(parentObj) && parentUserFilter.toUpperCase().includes('LIMIT')) {
          continue
        }
        const conditions = stripToConditions(parentUserFilter)
        if (!isBlank(conditions)) {
          const scope: ScopedFilter = {
            kind: 'parentSubquery',
            lookupField,
            parentObject: parentObj,
            conditions
          }
          if (hasChildren) {
            await ctx.materialize(objName, scope)
          }
          return scope
        }
      }
    }
  }

  // Deviation 1: HERE the Apex throws "<obj> cannot be scoped: more than 1000
  // in-scope records of parent …". The desktop scopes by the first over-cap
  // parent instead, chunking the full id list, and says so.
  if (overCapParents.size > 0) {
    const [parentObj, { lookupField, ids }] = overCapParents.entries().next().value!
    const idChunks = chunkIds(ids)
    ctx.warn(
      `${objName}: scoped by over-cap parent ${parentObj} (${ids.length} in-scope ids — the ` +
        `in-org engine would fail here with "cannot be scoped: more than ` +
        `${IN_ORG_MATERIALIZED_ID_CAP} in-scope records"). Proceeding with ${idChunks.length} ` +
        `chunked quer${idChunks.length === 1 ? 'y' : 'ies'} of ≤${IN_CLAUSE_MAX_IDS} ids.`
    )
    const scope: ScopedFilter = { kind: 'parentIn', lookupField, parentObject: parentObj, idChunks }
    if (hasChildren) {
      await ctx.materialize(objName, scope)
    }
    return scope
  }

  // S50 (A4): nothing scoped this object — no user filter, and no parent whose
  // ids we materialized. It will therefore query EVERY record of the object in
  // the source org. That is a legitimate outcome (it is how you deploy a small
  // reference table), but it is also the single easiest way to turn a
  // 400-record account deploy into a 300,000-record one, and until now it
  // happened SILENTLY — the only warning in this module was the over-cap one.
  // The risk scales with the multi-account work: the more objects in play, the
  // likelier one of them has no path back to the filtered root.
  ctx.warn(
    `${objName}: no filter and no in-scope parent — this will deploy EVERY ` +
      `${objName} record in the source org. Add a WHERE clause on the Scope step, ` +
      'or deselect it, if that is not what you want.'
  )
  return { kind: 'all' }
}

// ─────────────────────── SOQL builders per scope kind ────────────────────────

/**
 * The SELECT queries that enumerate a scope (one per chunk for parentIn).
 * `selectClause` is e.g. 'SELECT Id' — materialization uses Id-only; the deploy
 * engine will pass full field lists. Object names are quote-escaped exactly as
 * the Apex ('SELECT Id FROM ' + String.escapeSingleQuotes(objName)).
 */
export function queriesForScope(
  selectClause: string,
  objectName: string,
  scope: ScopedFilter
): string[] {
  const base = `${selectClause} FROM ${escapeSingleQuotes(objectName)}`
  switch (scope.kind) {
    case 'all':
      return [base]
    case 'raw':
      return [applyFilterToSoql(base, scope.where)]
    case 'parentIn':
      return scope.idChunks.map(
        (chunk) => `${base} WHERE ${scope.lookupField} IN (${buildInClause(chunk)})`
      )
    case 'parentSubquery':
      return [
        `${base} WHERE ${scope.lookupField} IN (SELECT Id FROM ${scope.parentObject} WHERE ${scope.conditions})`
      ]
  }
}

/**
 * The count queries for a scope, ported from Apex countRecords:
 *  - a raw filter carrying LIMIT counts via `SELECT Id … LIMIT n` (COUNT()
 *    can't take LIMIT; the response's totalSize reflects the limit);
 *  - everything else counts via `SELECT COUNT()`;
 *  - parentIn counts one COUNT() per chunk — chunks partition the parent ids,
 *    so the caller sums the results.
 */
export function countQueriesForScope(objectName: string, scope: ScopedFilter): string[] {
  const obj = escapeSingleQuotes(objectName)
  switch (scope.kind) {
    case 'all':
      return [`SELECT COUNT() FROM ${obj}`]
    case 'raw': {
      const conditions = stripToConditions(scope.where)
      const hasLimit = scope.where.toUpperCase().includes('LIMIT')
      if (hasLimit) {
        let soql = `SELECT Id FROM ${obj}`
        if (!isBlank(conditions)) soql += ` WHERE ${conditions}`
        soql += extractLimitClause(scope.where)
        return [soql]
      }
      let soql = `SELECT COUNT() FROM ${obj}`
      if (!isBlank(conditions)) soql += ` WHERE ${conditions}`
      return [soql]
    }
    case 'parentIn':
      return scope.idChunks.map(
        (chunk) =>
          `SELECT COUNT() FROM ${obj} WHERE ${scope.lookupField} IN (${buildInClause(chunk)})`
      )
    case 'parentSubquery':
      return [
        `SELECT COUNT() FROM ${obj} WHERE ${scope.lookupField} IN (SELECT Id FROM ${scope.parentObject} WHERE ${scope.conditions})`
      ]
  }
}

/**
 * The Apex Scoped_Filter__c string for this scope — byte-identical for every
 * scope the in-org engine can produce (parity-diff surface). Multi-chunk
 * parentIn scopes (impossible in-org) render a summary, not valid SOQL.
 */
export function scopedFilterDisplay(scope: ScopedFilter): string | null {
  switch (scope.kind) {
    case 'all':
      return null
    case 'raw':
      return scope.where
    case 'parentIn': {
      if (scope.idChunks.length === 1) {
        return `WHERE ${scope.lookupField} IN (${buildInClause(scope.idChunks[0]!)})`
      }
      const total = scope.idChunks.reduce((n, c) => n + c.length, 0)
      return `WHERE ${scope.lookupField} IN (<${total} ${scope.parentObject} ids across ${scope.idChunks.length} chunks>)`
    }
    case 'parentSubquery':
      return `WHERE ${scope.lookupField} IN (SELECT Id FROM ${scope.parentObject} WHERE ${scope.conditions})`
  }
}

/** Apex String `==` (case-insensitive) — used only where the Apex used it. */
function apexStringEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
