/**
 * Row scoping for a tier (plan §4.4 parentScope.ts): the generic form of the
 * reference tool's guided-form subtree walk.
 *
 *  - `subsets`     keep only the listed source Ids of an object (the kept roots)
 *  - `parentScope` keep a row when ANY of the listed lookups points at a source
 *                  Id KEPT in an earlier tier — the union over several lookups
 *                  is what a condition-logic object needs when its direct
 *                  parent lookup is null on most rows
 *
 * "Kept" means the row survived scoping in its own tier, whether or not it
 * then loaded — so a child scoped under a parent that FAILED to load still
 * follows the parent into the plan (and skips/nulls on its own lookup rules),
 * exactly as the reference did with `gf_subtree`.
 */
import type { SeedTemplate, SeedTier } from '../../../../shared/templates/types'

export class KeptIds {
  private readonly byObject = new Map<string, Set<string>>()

  add(object: string, ids: Iterable<string>): void {
    let s = this.byObject.get(object)
    if (!s) {
      s = new Set()
      this.byObject.set(object, s)
    }
    for (const id of ids) s.add(id)
  }

  has(object: string, id: string): boolean {
    return this.byObject.get(object)?.has(id) ?? false
  }

  count(object: string): number {
    return this.byObject.get(object)?.size ?? 0
  }
}

export function scopeRows(
  template: Pick<SeedTemplate, 'subsets'>,
  tier: SeedTier,
  rows: ReadonlyArray<Record<string, unknown>>,
  kept: KeptIds
): { rows: Array<Record<string, unknown>>; droppedBySubset: number; droppedByParent: number; missingSubsetIds: string[] } {
  let out = [...rows]
  let droppedBySubset = 0
  let droppedByParent = 0
  let missingSubsetIds: string[] = []
  const subset = template.subsets.find((s) => s.object === tier.object)
  if (subset) {
    const want = new Set(subset.ids.map((id) => id.slice(0, 15)))
    const before = out.length
    out = out.filter((r) => typeof r.Id === 'string' && want.has(r.Id.slice(0, 15)))
    droppedBySubset = before - out.length
    const found = new Set(out.map((r) => String(r.Id).slice(0, 15)))
    missingSubsetIds = subset.ids.filter((id) => !found.has(id.slice(0, 15)))
  }
  if (tier.parentScope) {
    const before = out.length
    out = out.filter((r) =>
      tier.parentScope!.anyOf.some((p) => {
        const v = r[p.field]
        return typeof v === 'string' && kept.has(p.object, v)
      })
    )
    droppedByParent = before - out.length
  }
  kept.add(
    tier.object,
    out.map((r) => String(r.Id))
  )
  return { rows: out, droppedBySubset, droppedByParent, missingSubsetIds }
}
