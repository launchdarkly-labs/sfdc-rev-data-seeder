/**
 * S57 (B2 / B3) — scope advice, PURE and dependency-free (shared by renderer and main).
 *
 * Born from run 24 on sb1-915-git (2026-09-18): CampaignMember was in scope,
 * Campaign was not, `CampaignId` is required — 228 of 228 rows failed with
 * `REQUIRED_FIELD_MISSING` and nobody was told beforehand. The Mappings step
 * KNEW ("Ref → Campaign (not in deployment)") and so did the Fields step; the
 * knowledge just never became a suggestion. Three things live here:
 *
 *  1. `parentObjectsWithinScope` — which selected objects each selected object
 *     looks up to (mirror of engine/scoping.buildParentLookupMap, on describes
 *     the renderer already has). Drives the Scope-step "nothing will deploy"
 *     gate (B3): an unfiltered object with NO in-scope parent takes every record
 *     in the source org, so the total is not zero.
 *  2. `scopeIsEmpty` — the B3 gate: every filter validated to 0 AND no
 *     unfiltered root ⇒ nothing can deploy ⇒ "Next: readiness" is disabled.
 *  3. `outOfScopeRefs` / `buildParentSuggestions` / `requiredReferenceWarnings`
 *     — the B2 advisor: for every reference to an object outside the scope,
 *     suggest adding the parent (with a ready-made semi-join filter when SOQL
 *     allows one), say plainly when the reference is REQUIRED (a guaranteed
 *     100 % failure), and — via B1's TargetKeyInfo — say when the target already
 *     holds keyed rows so leaving the parent out is fine.
 *
 * Semi-join facts pinned by live tests on darkb_911 (2026-09-18):
 *   `WHERE Id IN (SELECT CampaignId FROM CampaignMember WHERE CampaignId='…')` → valid (104 rows)
 *   nested semi-join → "Nesting of semi join sub-selects is not supported"
 */

import {
  DIRECT_ID_DEFAULT_REFS,
  NAME_MATCH_OBJECTS,
  effectiveStrategy,
  isHiddenRefField,
  outOfScopeKeyState,
  type TargetKeyInfo
} from './mappingPolicy'
import type { FieldMapping } from './wizard'

/**
 * The minimal field shape this module needs — satisfied by the shared
 * `FieldInfo` (renderer) and by the freeze's `DescribeField` (golden shape,
 * where the flags are optional).
 */
export interface RefFieldLike {
  apiName: string
  isReference?: boolean
  referenceTo?: readonly string[] | null
  isCreateable?: boolean
  isNillable?: boolean
}

const isRef = (f: RefFieldLike): f is RefFieldLike & { referenceTo: readonly string[] } =>
  f.isReference === true && Array.isArray(f.referenceTo) && f.referenceTo.length > 0

// ───────────────────────────── B3: the empty-scope gate ─────────────────────────────

/**
 * objectName → the OTHER selected objects it has a createable lookup to
 * (deduped, in describe order). Mirrors `buildParentLookupMap` minus the
 * "which field" detail — the gate only needs to know whether a parent exists.
 */
export function parentObjectsWithinScope(
  selectedObjects: readonly string[],
  fieldsByObject: Readonly<Record<string, readonly RefFieldLike[] | undefined>>
): Record<string, string[]> {
  const selected = new Set(selectedObjects)
  const out: Record<string, string[]> = {}
  for (const obj of selectedObjects) {
    const parents: string[] = []
    for (const f of fieldsByObject[obj] ?? []) {
      if (!isRef(f) || f.isCreateable === false) continue
      for (const refTo of f.referenceTo) {
        if (refTo === obj || !selected.has(refTo)) continue
        if (!parents.includes(refTo)) parents.push(refTo)
      }
    }
    out[obj] = parents
  }
  return out
}

/** What the Scope step knows about one filter's COUNT() probe right now. */
export type FilterProbe =
  | { kind: 'busy' }
  | { kind: 'error' }
  | { kind: 'count'; count: number }

export interface ScopeEmptyInput {
  selectedObjects: readonly string[]
  /** objectName → WHERE clause (blank = no filter). */
  filters: Readonly<Record<string, string | undefined>>
  /** objectName → the latest probe for its filter (missing = not validated yet). */
  probes: Readonly<Record<string, FilterProbe | undefined>>
  /**
   * `parentObjectsWithinScope(...)`, or null while describes are still loading —
   * the gate stays OPEN until it can tell a scoped child from an unfiltered root.
   */
  parentsByObject: Readonly<Record<string, readonly string[]>> | null
}

/** Objects with a non-blank filter clause. */
export function filteredObjects(
  selectedObjects: readonly string[],
  filters: Readonly<Record<string, string | undefined>>
): string[] {
  return selectedObjects.filter((o) => (filters[o] ?? '').trim() !== '')
}

/**
 * TRUE only when nothing can deploy: at least one filter exists, EVERY filtered
 * object has validated to exactly 0 records, and every unfiltered object is
 * scoped under some selected object (an unfiltered ROOT would take every record
 * in the source org — the dep 37 Campaign case — so the total is not zero).
 * Busy, errored or not-yet-validated filters keep the gate open (B3, Jack's D3:
 * Next-only, never a false block).
 */
export function scopeIsEmpty(input: ScopeEmptyInput): boolean {
  const filtered = filteredObjects(input.selectedObjects, input.filters)
  if (filtered.length === 0) return false
  for (const obj of filtered) {
    const probe = input.probes[obj]
    if (probe == null || probe.kind !== 'count' || probe.count !== 0) return false
  }
  if (input.parentsByObject == null) return false
  const selected = new Set(input.selectedObjects)
  for (const obj of input.selectedObjects) {
    if (filtered.includes(obj)) continue
    const parents = (input.parentsByObject[obj] ?? []).filter((p) => selected.has(p))
    if (parents.length === 0) return false // an unfiltered root: takes every record
  }
  return true
}

export function scopeEmptyMessage(filtered: readonly string[]): string {
  const list = filtered.join(', ')
  return (
    `Nothing will deploy — ${filtered.length === 1 ? 'the filter on' : 'the filters on'} ${list} ` +
    `${filtered.length === 1 ? 'returns' : 'all return'} 0 records, and every other object is scoped under ` +
    `${filtered.length === 1 ? 'it' : 'them'}. Fix a filter or remove it to continue.`
  )
}

// ───────────────────────────── B2: the missing-parent advisor ─────────────────────────────

/** One reference from an in-scope object to an object OUTSIDE the scope. */
export interface OutOfScopeRef {
  objectName: string
  fieldName: string
  refTo: string
  /** The TARGET field is not nillable — a skipped reference fails the row. */
  required: boolean
}

/**
 * Every deployable reference field on a selected object whose (first) referenced
 * object is not selected and is not a stable name-match / directId-default object
 * (User, RecordType, Product2 …), excluding self-references and the hidden
 * RecordTypeId. `required` comes from the target describe when present.
 */
export function outOfScopeRefs(
  selectedObjects: readonly string[],
  sourceFieldsByObject: Readonly<Record<string, readonly RefFieldLike[] | undefined>>,
  targetFieldsByObject: Readonly<Record<string, readonly RefFieldLike[] | undefined>>
): OutOfScopeRef[] {
  const selected = new Set(selectedObjects)
  const out: OutOfScopeRef[] = []
  for (const obj of selectedObjects) {
    const targetByName = new Map((targetFieldsByObject[obj] ?? []).map((f) => [f.apiName, f]))
    for (const f of sourceFieldsByObject[obj] ?? []) {
      if (!isRef(f) || f.isCreateable === false) continue
      const refTo = f.referenceTo[0]!
      if (refTo === obj || selected.has(refTo)) continue
      if (NAME_MATCH_OBJECTS.has(refTo) || DIRECT_ID_DEFAULT_REFS.has(refTo)) continue
      if (isHiddenRefField(f.apiName, refTo)) continue
      const tf = targetByName.get(f.apiName)
      if (tf == null || tf.isCreateable === false) continue // not deployable on the target
      out.push({ objectName: obj, fieldName: f.apiName, refTo, required: tf.isNillable === false })
    }
  }
  return out
}

export interface ParentSuggestion {
  refTo: string
  refs: OutOfScopeRef[]
  /** Any referencing field is required on the target. */
  required: boolean
  /** A ready-made WHERE clause for the parent, or null (see `filterNote`). */
  suggestedFilter: string | null
  /** Why no filter could be generated (null when one was). */
  filterNote: string | null
  /** B1: the target already holds RDS-keyed rows of this object — leaving it out is fine. */
  keyedOnTarget: boolean
}

const SEMI_JOIN = /\bIN\s*\(\s*SELECT\b/i

/**
 * `WHERE Id IN (SELECT <ref field> FROM <child> <child filter>)` — valid only when
 * the child has an explicit filter that is not itself a semi-join (SOQL refuses to
 * nest them). Null otherwise.
 */
export function semiJoinFilterFor(
  ref: OutOfScopeRef,
  childFilter: string | undefined
): string | null {
  const clause = (childFilter ?? '').trim()
  if (clause === '') return null
  if (SEMI_JOIN.test(clause)) return null
  if (!/^WHERE\b/i.test(clause)) return null
  return `WHERE Id IN (SELECT ${ref.fieldName} FROM ${ref.objectName} ${clause})`
}

export function buildParentSuggestions(input: {
  refs: readonly OutOfScopeRef[]
  filters: Readonly<Record<string, string | undefined>>
  targetKeys?: TargetKeyInfo
}): ParentSuggestion[] {
  const byParent = new Map<string, OutOfScopeRef[]>()
  for (const r of input.refs) {
    const list = byParent.get(r.refTo) ?? []
    list.push(r)
    byParent.set(r.refTo, list)
  }
  const out: ParentSuggestion[] = []
  for (const [refTo, refs] of byParent) {
    // Prefer a required reference's child for the filter (that is the one that fails).
    const ordered = [...refs].sort((a, b) => Number(b.required) - Number(a.required))
    let suggestedFilter: string | null = null
    for (const r of ordered) {
      suggestedFilter = semiJoinFilterFor(r, input.filters[r.objectName])
      if (suggestedFilter != null) break
    }
    let filterNote: string | null = null
    if (suggestedFilter == null) {
      const childList = [...new Set(refs.map((r) => r.objectName))]
      const children = childList.join(', ')
      const one = childList.length === 1
      const anySemiJoin = refs.some((r) => SEMI_JOIN.test((input.filters[r.objectName] ?? '').trim()))
      filterNote = anySemiJoin
        ? `${children} ${one ? 'is' : 'are'} filtered with a semi-join, and SOQL cannot nest one inside another — give ${refTo} its own WHERE clause.`
        : `${children} ${one ? 'is' : 'are'} scoped through ${one ? 'its' : 'their'} parent, so no filter can be derived — give ${refTo} its own WHERE clause (an object with none takes every record in the source org).`
    }
    out.push({
      refTo,
      refs,
      required: refs.some((r) => r.required),
      suggestedFilter,
      filterNote,
      keyedOnTarget: input.targetKeys?.keyedRows.has(refTo) === true
    })
  }
  return out
}

/** Card headline: "CampaignMember references Campaign, which isn't in this deployment." */
export function suggestionHeadline(s: ParentSuggestion): string {
  const children = [...new Set(s.refs.map((r) => r.objectName))]
  return `${children.join(', ')} reference${children.length === 1 ? 's' : ''} ${s.refTo}, which isn't in this deployment.`
}

/** Card body — the consequence, then the humble suggestion. */
export function suggestionBody(s: ParentSuggestion): string[] {
  const lines: string[] = []
  const required = s.refs.filter((r) => r.required)
  if (required.length > 0) {
    const fields = required.map((r) => `${r.objectName}.${r.fieldName}`).join(', ')
    lines.push(
      `${fields} ${required.length === 1 ? 'is' : 'are'} required, so every ` +
        `${[...new Set(required.map((r) => r.objectName))].join(' and ')} row will fail ` +
        `(REQUIRED_FIELD_MISSING) unless the reference can resolve.`
    )
  } else {
    lines.push('The link will be left blank on the target.')
  }
  if (s.keyedOnTarget) {
    lines.push(
      `The target already holds RDS-keyed ${s.refTo} rows, so leaving it out is fine — ` +
        `the reference resolves against them (a missing parent is still blanked or fails as today).`
    )
  } else {
    lines.push(`You should probably add ${s.refTo}.`)
  }
  return lines
}

// ───────────────────────────── FB-3: required references that will be skipped ─────────────────────────────

/**
 * For one object: every reference field whose EFFECTIVE strategy is 'skip' while
 * the target field is REQUIRED — a guaranteed `REQUIRED_FIELD_MISSING` for every
 * row. Runs at analysis (→ Plan step, before Deploy) and at freeze (→ job log);
 * both callers pass the same policy inputs so the two never disagree.
 */
export function requiredReferenceWarnings(input: {
  objectName: string
  sourceFields: readonly RefFieldLike[]
  targetFields: readonly RefFieldLike[]
  selectedObjects: readonly string[]
  overrides: Readonly<Record<string, FieldMapping>> | undefined
  targetKeys?: TargetKeyInfo
}): string[] {
  const { objectName, selectedObjects, targetKeys } = input
  const targetByName = new Map(input.targetFields.map((f) => [f.apiName, f]))
  const out: string[] = []
  for (const f of input.sourceFields) {
    if (!isRef(f) || f.isCreateable === false) continue
    const refTo = f.referenceTo[0]!
    if (refTo === objectName) continue // deferred second pass owns self-refs
    if (isHiddenRefField(f.apiName, refTo)) continue
    const tf = targetByName.get(f.apiName)
    if (tf == null || tf.isCreateable === false || tf.isNillable !== false) continue
    const effective = effectiveStrategy(
      refTo,
      objectName,
      selectedObjects,
      input.overrides?.[f.apiName]?.strategy,
      targetKeys
    )
    if (effective !== 'skip') continue
    const state = outOfScopeKeyState(refTo, selectedObjects, targetKeys)
    const tail =
      state === 'inScope'
        ? ` The mapping for ${f.apiName} is set to Skip — change it on the Mappings step.`
        : state === 'fieldOnly'
          ? ` Add ${refTo} on the Scope step, or deploy ${refTo} first so the reference can resolve against RDS-keyed rows on the target.`
          : state === 'keyedRows'
            ? ` The mapping for ${f.apiName} is set to Skip — set it to External ID to resolve against the RDS-keyed ${refTo} rows on the target.`
            : ` Add ${refTo} on the Scope step.`
    out.push(
      `${objectName}.${f.apiName} is required and ${refTo} is not ` +
        `${state === 'inScope' ? 'being resolved' : 'in this deployment'} — every ${objectName} row ` +
        `will fail with REQUIRED_FIELD_MISSING.${tail}`
    )
  }
  return out
}
