/**
 * The in-memory source→target Id map for one seed run, with the resume split
 * (rows an earlier apply loaded are remapped, not reloaded) and the stale
 * guard (the target must hold exactly the rows the map says were loaded, or a
 * resume would insert duplicates — the reference's `stale_objects`).
 *
 * Dry runs record `dry:<sourceId>` markers so later tiers can plan their
 * remaps; markers are never persisted (`persistable()` filters them).
 */
import type { IdMapRow } from '../../../services/templateStore'

export const DRY_PREFIX = 'dry:'

export class SeedIdMap {
  private readonly map = new Map<string, string>()
  private readonly byObject = new Map<string, Map<string, string>>()
  /** Rows loaded by an EARLIER run (resume) — excluded from this run's counts. */
  readonly resumed = new Set<string>()

  constructor(resumeRows: ReadonlyArray<IdMapRow> = []) {
    for (const r of resumeRows) {
      this.set(r.objectApiName, r.sourceId, r.targetId)
      this.resumed.add(r.sourceId)
    }
  }

  get(sourceId: string): string | undefined {
    return this.map.get(sourceId)
  }

  has(sourceId: string): boolean {
    return this.map.has(sourceId)
  }

  set(object: string, sourceId: string, targetId: string): void {
    this.map.set(sourceId, targetId)
    let m = this.byObject.get(object)
    if (!m) {
      m = new Map()
      this.byObject.set(object, m)
    }
    m.set(sourceId, targetId)
  }

  /** source Id → target Id for one object (both resumed and this run's). */
  loaded(object: string): ReadonlyMap<string, string> {
    return this.byObject.get(object) ?? new Map()
  }

  loadedCount(object: string): number {
    return this.byObject.get(object)?.size ?? 0
  }

  /** Target Ids of an object's loaded rows (real ones only). */
  targetIds(object: string): string[] {
    return [...this.loaded(object).values()].filter((v) => !v.startsWith(DRY_PREFIX))
  }

  get readonly(): ReadonlyMap<string, string> {
    return this.map
  }

  /** Rows of one object that should be persisted (no dry markers), for `putIdMap`. */
  persistable(object: string): IdMapRow[] {
    const out: IdMapRow[] = []
    for (const [sourceId, targetId] of this.loaded(object)) {
      if (targetId.startsWith(DRY_PREFIX) || this.resumed.has(sourceId)) continue
      out.push({ objectApiName: object, sourceId, targetId })
    }
    return out
  }
}

/**
 * Resume stale guard: for every tier, the target's row count (with the tier's
 * where) must equal the map's count for that object. Returns the mismatches.
 */
export function staleObjects(
  counts: ReadonlyArray<{ object: string; target: number; mapped: number }>
): string[] {
  return counts.filter((c) => c.target !== c.mapped).map((c) => `${c.object}: target ${c.target}, id map ${c.mapped}`)
}
