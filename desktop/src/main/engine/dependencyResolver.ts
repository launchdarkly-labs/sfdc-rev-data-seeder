/**
 * DependencyResolver — fidelity port of
 * force-app/main/default/classes/DependencyResolver.cls.
 *
 * Pure logic: no Node/Electron imports. Input field shapes come from the
 * shared FieldInfo type (the TS mirror of SchemaService.FieldInfo).
 *
 * Semantics ported 1:1, including quirks:
 *  - Hard vs soft classification: a createable reference field that is
 *    non-nillable => HARD dependency (master-detail); nillable => SOFT
 *    dependency (lookup).
 *  - References to objects NOT in the migration set are ignored entirely
 *    (this is the only "OwnerId/User/RecordType" handling the Apex has —
 *    there is no explicit special-case list; such refs simply fall out
 *    because User/RecordType are not in the set).
 *  - Self-references are checked BEFORE the nillable check, so even a
 *    NON-nillable self-reference lands in softDeps and gets deferred.
 *  - Ordering runs Kahn's algorithm over the UNION of hard + soft edges
 *    (self-edges excluded). When no node has combined in-degree 0, the
 *    cycle is broken by emitting a node whose HARD in-degree is 0; if even
 *    that fails (pathological hard cycle), any remaining node is emitted so
 *    the loop terminates. Ties always break lexicographically (ready[0]
 *    after sorting) — exactly one node is emitted per iteration.
 *  - Circular detection: an object is flagged hasCircularReference when it
 *    has a soft dep on a target at the SAME or LATER sort position
 *    (depOrder >= i — self-references satisfy this). EVERY field pointing
 *    at that target is deferred (multiple ref fields can share a target,
 *    e.g. Quote's four Contract lookups). Hard cycles are NOT flagged
 *    (only softDeps are inspected) — a deliberate Apex quirk kept as-is.
 *  - A polymorphic field whose referenceTo hits several deferred targets is
 *    appended once PER TARGET, so it can appear multiple times in
 *    deferredFields (Apex addAll behavior, kept).
 *
 * Deliberate deviations from the Apex original:
 *  1. hardDependencies / softDependencies / deferredFields array order:
 *     Apex materializes them from Set<String>, whose iteration order is
 *     unspecified; here JS Sets give deterministic field-iteration
 *     (insertion) order. No caller depends on a specific order.
 *  2. Apex String `==` / `!=` are case-insensitive. The two places the Apex
 *     applies them to object names (self-reference detection, self-edge
 *     exclusion from ordering) are ported with an explicit case-insensitive
 *     compare (apexStringEquals). Set/Map membership stays case-sensitive,
 *     matching Apex Set<String>/Map<String,...> (which use case-sensitive
 *     equals/hashCode).
 *  3. Tie-break sort: Apex List<String>.sort() sorts Strings
 *     case-insensitively (uppercase before lowercase on case-only ties, per
 *     platform sort order); ported via apexStringSortCompare instead of the
 *     JS default UTF-16 code-unit sort. For typical SF API names the two
 *     agree; they diverge only on mixed-case ties (e.g. 'a_x__c' vs 'Ab').
 *  4. Idiomatic TS: DependencyInfo is an interface (was an inner @AuraEnabled
 *     class); functions are module-level exports. sortOrder stays 1-based.
 */

import type { FieldInfo } from '../../shared/types'

export interface DependencyInfo {
  objectName: string
  sortOrder: number
  /** master-detail parents (non-nullable refs) */
  hardDependencies: string[]
  /** lookup parents (nullable refs) */
  softDependencies: string[]
  hasCircularReference: boolean
  /** nullable lookups to defer for circular refs */
  deferredFields: string[]
}

/**
 * Builds dependency graph and returns topologically sorted list.
 * @param objectNames the set of objects to analyze
 * @param fieldMetadataByObject Map<objectName, FieldInfo[]>
 * @returns DependencyInfo[] in insertion order
 */
export function resolve(
  objectNames: ReadonlySet<string>,
  fieldMetadataByObject: ReadonlyMap<string, readonly FieldInfo[]>
): DependencyInfo[] {
  // Build adjacency lists
  const hardDeps = new Map<string, Set<string>>() // non-nullable references
  const softDeps = new Map<string, Set<string>>() // nullable references
  // objectName -> (targetObj -> fieldName[]).
  // Multiple ref fields can point at the same target (e.g., Quote has
  // SBQQ__MasterContract__c, SBQQ__MasterEvergreenContract__c,
  // Amendment_of_Contract__c, Renewal_of_Contract__c — all point to
  // Contract). Earlier versions used a single-field map here, which
  // silently dropped all but the LAST field iterated, so only one of the
  // forward refs got deferred and the rest blew up at deploy time with
  // INVALID_FIELD on the missing parent ExtId.
  const softDepFields = new Map<string, Map<string, string[]>>()

  for (const objName of objectNames) {
    hardDeps.set(objName, new Set<string>())
    softDeps.set(objName, new Set<string>())
    softDepFields.set(objName, new Map<string, string[]>())

    const fields = fieldMetadataByObject.get(objName)
    if (fields == null) continue

    for (const fi of fields) {
      if (!fi.isReference || fi.referenceTo == null || fi.referenceTo.length === 0) continue
      if (!fi.isCreateable) continue

      for (const refTo of fi.referenceTo) {
        // Only care about references to objects in our migration set
        if (!objectNames.has(refTo)) continue
        // Skip self-references for hard deps (handled as circular)
        if (apexStringEquals(refTo, objName)) {
          softDeps.get(objName)!.add(refTo)
          appendSoftField(softDepFields.get(objName)!, refTo, fi.apiName)
          continue
        }

        if (!fi.isNillable) {
          // Non-nullable = hard dependency (master-detail)
          hardDeps.get(objName)!.add(refTo)
        } else {
          // Nullable = soft dependency (lookup)
          softDeps.get(objName)!.add(refTo)
          appendSoftField(softDepFields.get(objName)!, refTo, fi.apiName)
        }
      }
    }
  }

  // Topological sort using Kahn's algorithm on the UNION of hard +
  // soft dependencies. Ordering on hard deps alone left real parents that
  // are referenced only via NULLABLE lookups (Account, Contact, Opportunity
  // in a Sales/CPQ graph) at in-degree 0, so Kahn seeded them in arbitrary
  // set iteration order and a root could land after its children.
  //
  // Soft edges are treated as BREAKABLE: when they form a genuine cycle
  // (e.g. a true nullable A<->B back-reference, or a self-reference) the
  // cycle-aware sort drops the offending soft edge from ORDERING only. The
  // unchanged deferred-field detection below (which keys off the final sort
  // order) then defers exactly those fields. Hard edges are never broken.
  const orderDeps = new Map<string, Set<string>>()
  for (const objName of objectNames) {
    const combined = new Set<string>()
    for (const h of hardDeps.get(objName)!) combined.add(h)
    // Self-references live only in softDeps; exclude them from ordering
    // (a node cannot precede itself) — they are handled as circular and
    // deferred via the detection block below.
    for (const s of softDeps.get(objName)!) {
      if (!apexStringEquals(s, objName)) combined.add(s)
    }
    orderDeps.set(objName, combined)
  }
  const sorted = topologicalSort(objectNames, orderDeps, hardDeps)

  // Build result with circular reference detection for soft deps
  const orderMap = new Map<string, number>()
  for (let i = 0; i < sorted.length; i++) {
    orderMap.set(sorted[i]!, i)
  }

  const result: DependencyInfo[] = []
  for (let i = 0; i < sorted.length; i++) {
    const objName = sorted[i]!
    const info: DependencyInfo = {
      objectName: objName,
      sortOrder: i + 1,
      hardDependencies: [...hardDeps.get(objName)!],
      softDependencies: [...softDeps.get(objName)!],
      hasCircularReference: false,
      deferredFields: []
    }

    // Check for circular soft dependencies:
    // If this object has a soft dep on an object that comes AFTER it in sort
    // order, EVERY field referencing that target needs to be deferred (insert
    // with null, update later). Note: defer ALL fields, not just one — see
    // softDepFields comment.
    for (const softDep of softDeps.get(objName)!) {
      const depOrder = orderMap.get(softDep)
      if (depOrder != null && depOrder >= i) {
        info.hasCircularReference = true
        const deferredForTarget = softDepFields.get(objName)!.get(softDep)
        if (deferredForTarget != null) {
          info.deferredFields.push(...deferredForTarget)
        }
      }
    }

    result.push(info)
  }

  return result
}

/** Appends `fieldName` to the per-target list, creating the list if absent. */
function appendSoftField(
  perTarget: Map<string, string[]>,
  targetObj: string,
  fieldName: string
): void {
  let existing = perTarget.get(targetObj)
  if (existing == null) {
    existing = []
    perTarget.set(targetObj, existing)
  }
  if (!existing.includes(fieldName)) existing.push(fieldName)
}

/**
 * Cycle-aware topological sort (Kahn's algorithm) over the combined
 * hard+soft dependency graph.
 *
 * `orderDeps[node]` = the set of objects that must be emitted BEFORE `node`
 * (the union of hard and soft dependencies, self-references excluded).
 * `hardDeps[node]` = the hard-only (non-nullable / master-detail) subset,
 * which must NEVER be violated.
 *
 * Normal case: emit nodes whose dependencies are all satisfied (in-degree 0).
 * Cycle case: SF hard-dep graphs are acyclic, so any cycle in the combined
 * graph is closed by a SOFT edge. When no node has in-degree 0 we break the
 * cycle by emitting a remaining node whose HARD in-degree is already 0 — i.e.
 * only soft back-edges still pin it. Dropping that soft edge from ORDERING is
 * safe: the deferred-field detection in resolve() keys off the final order and
 * will defer exactly those fields. This guarantees hard parent-before-child is
 * never violated and that no node is ever emitted in arbitrary set order.
 * Ties are broken lexicographically so the output is deterministic.
 */
function topologicalSort(
  nodes: ReadonlySet<string>,
  orderDeps: ReadonlyMap<string, ReadonlySet<string>>,
  hardDeps: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
  // In-degrees: combined (drives normal emission) and hard-only (drives the
  // cycle-break selection). Both are decremented as nodes are emitted.
  const inDegree = new Map<string, number>()
  const hardInDegree = new Map<string, number>()
  for (const node of nodes) {
    let combinedDeg = 0
    const od = orderDeps.get(node)
    if (od != null) {
      for (const dep of od) {
        if (nodes.has(dep)) combinedDeg++
      }
    }
    inDegree.set(node, combinedDeg)

    let hardDeg = 0
    const hd = hardDeps.get(node)
    if (hd != null) {
      for (const dep of hd) {
        if (nodes.has(dep)) hardDeg++
      }
    }
    hardInDegree.set(node, hardDeg)
  }

  const sorted: string[] = []
  const emitted = new Set<string>()

  while (emitted.size < nodes.size) {
    // Candidates whose dependencies are all satisfied (in-degree 0).
    const ready: string[] = []
    for (const node of nodes) {
      if (!emitted.has(node) && inDegree.get(node) === 0) {
        ready.push(node)
      }
    }

    if (ready.length === 0) {
      // Cycle in the combined graph: break it by emitting a node with
      // NO unsatisfied HARD dependency (only soft back-edges remain).
      for (const node of nodes) {
        if (!emitted.has(node) && hardInDegree.get(node) === 0) {
          ready.push(node)
        }
      }
      // Pathological hard cycle (shouldn't happen in SF): emit any
      // remaining node so the loop always terminates.
      if (ready.length === 0) {
        for (const node of nodes) {
          if (!emitted.has(node)) ready.push(node)
        }
      }
    }

    // Deterministic tie-break: emit the lexicographically smallest.
    ready.sort(apexStringSortCompare)
    // Loop invariant: at least one un-emitted node exists, so ready is
    // non-empty (the pathological branch backfills every remaining node).
    const current = ready[0]!
    emitted.add(current)
    sorted.push(current)

    // Decrement in-degrees of everything still depending on `current`.
    for (const node of nodes) {
      if (emitted.has(node)) continue
      const od = orderDeps.get(node)
      if (od != null && od.has(current)) {
        inDegree.set(node, inDegree.get(node)! - 1)
      }
      const hd = hardDeps.get(node)
      if (hd != null && hd.has(current)) {
        hardInDegree.set(node, hardInDegree.get(node)! - 1)
      }
    }
  }

  return sorted
}

/**
 * Apex String `==` / `!=` are case-insensitive — used ONLY where the Apex
 * source used `==`/`!=` on object names. Set/Map lookups stay case-sensitive.
 */
function apexStringEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Mirrors Apex List<String>.sort(): case-insensitive ascending, with the
 * raw (uppercase-first) comparison as the tie-break for case-only ties.
 */
function apexStringSortCompare(a: string, b: string): number {
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  if (la < lb) return -1
  if (la > lb) return 1
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
