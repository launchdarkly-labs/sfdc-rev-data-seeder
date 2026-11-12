/**
 * S75 — natural-key resolution of lookups to CPQ CONFIGURATION objects.
 *
 * `nameMatch.ts` maps source Id → target Id by ONE shared name field, last row
 * wins. That is wrong for config objects whose `Name` is not an identity
 * (Product Option: auto-number; Dimension / Discount Tier: repeated per parent)
 * — deployments 68/69 dropped every option and dimension lookup that way, and a
 * repeated name would have linked the WRONG row without a word.
 *
 * For an object listed in `shared/mappingPolicy.ts` `CONFIG_NATURAL_KEYS` this
 * module builds the same `sourceId → targetId` map from the config row's own
 * key, read on both orgs:
 *
 *   source rows + target rows (Id, Name, key parts, tie-break fields)
 *   → translate each lookup part of a SOURCE key to the target:
 *       the same Id when a target row carries it (sibling / copied org), else
 *       the referenced object's own natural key, else its unique default name
 *   → index target rows by key
 *   → per source row: exactly one target row → mapped
 *                     several → tie-break fields; still several → AMBIGUOUS
 *                     none    → MISSING
 *
 * Nothing is guessed: an ambiguous or missing key resolves nothing, and every
 * unresolved source row carries a reason the caller logs. A failed query
 * resolves nothing for that object and is reported as `error` (the run goes on;
 * the lookup population check fails the affected fields).
 *
 * ENGINE-PURE: org reads go through the injected `NaturalKeyIo`.
 */

import { naturalKeyOf, type NaturalKeySpec } from '../../../../shared/mappingPolicy'
import { getResolverMatchField } from './nameMatch'

type Row = Record<string, unknown>

/** The read seam: every row of `objectName` with the given fields. Rejections propagate. */
export interface NaturalKeyIo {
  queryRows(role: 'source' | 'target', objectName: string, fields: readonly string[]): Promise<Row[]>
}

export interface NaturalKeyResolution {
  objectName: string
  /** source config Id → target config Id. */
  map: Record<string, string>
  /** source config Id → why it did not resolve. */
  unresolved: Record<string, string>
  sourceRows: number
  targetRows: number
  /** Distinct keys shared by several target rows that a source row asked for. */
  ambiguousKeys: number
  /** Set when a query failed — `map` is then empty. */
  error: string | null
}

/** Run-scoped cache: one resolution per object, shared by every pass. */
export type NaturalKeyCache = Map<string, Promise<NaturalKeyResolution>>

const SEP = '\u0000'

function str(v: unknown): string | null {
  if (v == null) return null
  const s = String(v)
  return s === '' ? null : s
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function rowLabel(row: Row): string {
  return str(row['Name']) ?? String(row['Id'])
}

/**
 * Unique-only name map for a referenced object WITHOUT a natural key (Product2
 * by ProductCode, Pricebook2 by Name, …): a name carried by several target
 * rows, or by none, maps nothing.
 */
async function strictNameMap(io: NaturalKeyIo, objectName: string): Promise<Record<string, string>> {
  const field = getResolverMatchField(objectName)
  if (field == null) return {}
  const [src, tgt] = await Promise.all([
    io.queryRows('source', objectName, ['Id', field]),
    io.queryRows('target', objectName, ['Id', field])
  ])
  const idsByName = new Map<string, string[]>()
  for (const r of tgt) {
    const name = str(r[field])
    const id = str(r['Id'])
    if (name == null || id == null) continue
    const arr = idsByName.get(name) ?? []
    arr.push(id)
    idsByName.set(name, arr)
  }
  const out: Record<string, string> = {}
  for (const r of src) {
    const name = str(r[field])
    const id = str(r['Id'])
    if (name == null || id == null) continue
    const ids = idsByName.get(name)
    if (ids != null && ids.length === 1) out[id] = ids[0]!
  }
  return out
}

/** Resolve one config object by its natural key (cached per run when a cache is given). */
export function resolveNaturalKey(
  io: NaturalKeyIo,
  objectName: string,
  cache?: NaturalKeyCache
): Promise<NaturalKeyResolution> {
  const hit = cache?.get(objectName)
  if (hit) return hit
  const p = resolveUncached(io, objectName, cache)
  cache?.set(objectName, p)
  return p
}

async function resolveUncached(
  io: NaturalKeyIo,
  objectName: string,
  cache: NaturalKeyCache | undefined
): Promise<NaturalKeyResolution> {
  const out: NaturalKeyResolution = {
    objectName,
    map: {},
    unresolved: {},
    sourceRows: 0,
    targetRows: 0,
    ambiguousKeys: 0,
    error: null
  }
  const spec: NaturalKeySpec | null = naturalKeyOf(objectName)
  if (spec == null) {
    out.error = `${objectName} has no natural key`
    return out
  }

  const fields = [...new Set(['Id', 'Name', ...spec.parts.map((p) => p.field), ...(spec.tieBreak ?? [])])]
  let src: Row[]
  let tgt: Row[]
  try {
    src = await io.queryRows('source', objectName, fields)
    tgt = await io.queryRows('target', objectName, fields)
  } catch (e) {
    out.error = errorText(e)
    return out
  }
  out.sourceRows = src.length
  out.targetRows = tgt.length

  // ── Translators for the lookup parts (built only when an Id is not shared) ──
  const translate = new Map<string, (sourceId: string) => string | null>()
  try {
    for (const part of spec.parts) {
      if (part.ref == null) continue
      const onTarget = new Set<string>()
      for (const r of tgt) {
        const v = str(r[part.field])
        if (v != null) onTarget.add(v)
      }
      let needsMap = false
      for (const r of src) {
        const v = str(r[part.field])
        if (v != null && !onTarget.has(v)) {
          needsMap = true
          break
        }
      }
      let viaKey: Record<string, string> = {}
      if (needsMap) {
        viaKey =
          naturalKeyOf(part.ref) != null
            ? (await resolveNaturalKey(io, part.ref, cache)).map
            : await strictNameMap(io, part.ref)
      }
      translate.set(part.field, (s) => (onTarget.has(s) ? s : (viaKey[s] ?? null)))
    }
  } catch (e) {
    out.error = errorText(e)
    return out
  }

  // ── Target index: key → rows ──
  const byKey = new Map<string, Row[]>()
  for (const r of tgt) {
    if (r['Id'] == null) continue
    const parts: string[] = []
    let whole = true
    for (const part of spec.parts) {
      const v = str(r[part.field])
      if (v == null) {
        whole = false
        break
      }
      parts.push(v)
    }
    if (!whole) continue
    const key = parts.join(SEP)
    const arr = byKey.get(key) ?? []
    arr.push(r)
    byKey.set(key, arr)
  }

  // ── Resolve every source row ──
  const ambiguous = new Set<string>()
  for (const r of src) {
    const sourceId = str(r['Id'])
    if (sourceId == null) continue
    const parts: string[] = []
    let reason: string | null = null
    for (const part of spec.parts) {
      const v = str(r[part.field])
      if (v == null) {
        reason = `source ${objectName} ${rowLabel(r)} has no ${part.field}`
        break
      }
      if (part.ref == null) {
        parts.push(v)
        continue
      }
      const t = translate.get(part.field)!(v)
      if (t == null) {
        reason = `${part.field} of source ${objectName} ${rowLabel(r)} points at ${part.ref} ${v}, which has no match on the target`
        break
      }
      parts.push(t)
    }
    if (reason != null) {
      out.unresolved[sourceId] = reason
      continue
    }
    const key = parts.join(SEP)
    let hits = byKey.get(key) ?? []
    if (hits.length > 1 && (spec.tieBreak?.length ?? 0) > 0) {
      const narrowed = hits.filter((h) => spec.tieBreak!.every((f) => str(h[f]) === str(r[f])))
      if (narrowed.length === 1) hits = narrowed
    }
    if (hits.length === 1) {
      out.map[sourceId] = String(hits[0]!['Id'])
    } else if (hits.length === 0) {
      out.unresolved[sourceId] =
        `no ${objectName} on the target with the key of source ${rowLabel(r)} (${keyText(spec, r)})`
    } else {
      ambiguous.add(key)
      out.unresolved[sourceId] =
        `${hits.length} ${objectName} rows on the target share the key of source ${rowLabel(r)} (${keyText(spec, r)}): ` +
        hits.map(rowLabel).join(', ') +
        ' — ambiguous, not linked'
    }
  }
  out.ambiguousKeys = ambiguous.size
  return out
}

function keyText(spec: NaturalKeySpec, row: Row): string {
  return spec.parts.map((p) => `${p.field}=${str(row[p.field]) ?? '∅'}`).join(', ')
}
