/**
 * Pure source∩target object-intersection computation (wizard Step 1). Given two
 * global-describe object lists, produce the union with per-object presence flags
 * plus the common / source-only / target-only counts the banner shows. Only
 * objects present in BOTH orgs are deployable; the UI filters on the flags.
 *
 * Pure (no sqlite/jsforce) → unit-tested in the default lane; the IPC handler
 * feeds it cached describeGlobal results.
 */
import type { DeployableObject, ObjectInfo, ObjectIntersectionResult } from '../shared/types'

/**
 * Namespace of an API name: the leading segment only when there are ≥3
 * `__`-delimited parts (`SBQQ__Quote__c` → `SBQQ`). A plain custom object
 * (`Quote__c`) or standard object (`Account`) has no namespace.
 */
export function namespaceOf(apiName: string): string | null {
  const parts = apiName.split('__')
  return parts.length >= 3 ? parts[0]! : null
}

export function computeIntersection(
  source: ObjectInfo[],
  target: ObjectInfo[]
): ObjectIntersectionResult {
  const srcByName = new Map(source.map((o) => [o.apiName, o]))
  const tgtByName = new Map(target.map((o) => [o.apiName, o]))
  const names = [...new Set([...srcByName.keys(), ...tgtByName.keys()])].sort()

  const objects: DeployableObject[] = names.map((apiName) => {
    const s = srcByName.get(apiName)
    const t = tgtByName.get(apiName)
    const base = s ?? t! // present in at least one map by construction
    return {
      apiName,
      label: base.label,
      custom: base.custom,
      namespace: namespaceOf(apiName),
      inSource: s !== undefined,
      inTarget: t !== undefined
    }
  })

  let common = 0
  let sourceOnly = 0
  let targetOnly = 0
  for (const o of objects) {
    if (o.inSource && o.inTarget) common++
    else if (o.inSource) sourceOnly++
    else targetOnly++
  }
  return { objects, common, sourceOnly, targetOnly }
}
