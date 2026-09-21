/**
 * analysis — fidelity port of the plan-building pipeline of
 * force-app/main/default/classes/DeploymentAnalysisQueueable.cls
 * (buildPlanBatch + injectDetectedJunctions + countRecords + materializeIds +
 * the plan assembly from finalizePlan), orchestrating the already-ported
 * engines: dependencyResolver, objectPolicy, junctionDetector, scoping.
 *
 * Pure logic with injected I/O (AnalysisIo) so vitest needs no org; the live
 * adapter binds it to a GuardedOrg (services/analysisIo.ts).
 *
 * Pipeline (Apex order preserved):
 *   1. field describes per user-selected object (Phase 0)
 *   2. junction injection — auto-add known junctions whose parents are all in
 *      scope, with synthetic FK-only describes (end of Phase 0)
 *   3. dependency resolution (Kahn's) over ALL objects incl. junctions
 *   4. per object, in sorted order: scoped filter → record count → API
 *      strategy (policy + dup-rule override) → gating metadata (Phase 1)
 *   5. plan assembly + totals (the plan-JSON half of Phase 2 finalize)
 *
 * ── Deliberate deviations from the Apex original ─────────────────────────────
 * 1. NO BATCHING/CHAINING. The Apex splits work into 5-object hops chained via
 *    queueable/cron to dodge governor limits; the desktop has none, so the
 *    pipeline is one async pass. Phase boundaries, hop state (materializedIds
 *    JSON round-trip), heartbeats, terminal-status guards, and the callout
 *    budget guard have no equivalent and are not ported.
 * 2. DESCRIBES ARE NOT PRE-SLIMMED. Apex Phase 0 persists a slim
 *    createable-only describe into Cached_Field_Describe__c (an org-storage
 *    artifact); here the full FieldInfo list flows through, and the consumers
 *    (dependencyResolver, buildParentLookupMap) apply the identical
 *    isCreateable checks, so the outcome is the same.
 * 3. NO 255-CHAR FILTER SUMMARIZATION in plan entries. Apex truncates long
 *    Scoped_Filter__c copies to protect the 131KB Deployment_Plan__c blob;
 *    SQLite has no such cap, so plan entries carry the full display string.
 * 4. Target-side finalize checks (ExtId field presence, RecordType drift, FLS
 *    backfill) are Epic 3.8 — not part of this module.
 * 5. Junction Deployment_Object__c rows become PlannedObject entries with
 *    isJunction + junctionParents/junctionParentFields as arrays (Apex stores
 *    comma-joined strings).
 * 6. The duplicate-rule probe fails open in the ENGINE (Apex catches inside
 *    queryActiveDuplicateRuleObjects); an AnalysisIo that throws is treated
 *    exactly like the Apex catch — empty set, Bulk routing unchanged.
 * 7. Apex resets per-object engine state (retry queues, pass flags, counters)
 *    on re-analysis; desktop analysis returns a fresh result object every run,
 *    so there is no stale state to reset.
 */
import type { FieldInfo } from '../../shared/types'
import { resolve as resolveDependencies } from './dependencyResolver'
import type { DependencyInfo } from './dependencyResolver'
import {
  resolve as resolvePolicy,
  decideStrategy,
  recommendedBatchSize,
  STRATEGY_BULK,
  STRATEGY_REST
} from './objectPolicy'
import { detect as detectJunctions, buildSyntheticParentFieldInfos } from './junctionDetector'
import type { JunctionInfo } from './junctionDetector'
import {
  buildParentLookupMap,
  buildScopedFilterForObject,
  countQueriesForScope,
  queriesForScope,
  isBlank,
  type ScopedFilter,
  scopedFilterDisplay
} from './scoping'

/** In-org defaults from ExternalIdService (RDS_App_Setting__mdt fallbacks). */
export const DEFAULT_SOURCE_QUERY_RECORD_THRESHOLD = 600
export const DEFAULT_SOURCE_QUERY_OBJECT_THRESHOLD = 10

export class AnalysisError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnalysisError'
  }
}

// ─────────────────────────────── I/O contract ────────────────────────────────

export interface AnalysisIo {
  /** Source org: run a SELECT Id query with FULL pagination; return the ids. */
  queryIds(soql: string): Promise<string[]>
  /**
   * Source org: run a COUNT() (or `SELECT Id … LIMIT n`) query and return the
   * response's totalSize. Must reject on query failure — the engine converts
   * rejections into fail-loud AnalysisErrors (never a silent 0; FINDINGS #14).
   */
  countQuery(soql: string): Promise<number>
  /**
   * Source org: full field describe. Only called for user-selected objects —
   * auto-injected junctions use synthetic describes.
   */
  describeFields(objectApiName: string): Promise<FieldInfo[]>
  /**
   * TARGET org: sObject types with an ACTIVE duplicate rule (Bulk API 2.0
   * ignores the dup-rule bypass header, so those objects must route REST).
   * May reject — the engine fails open to an empty set, like the Apex.
   */
  queryActiveDuplicateRuleObjects(): Promise<Set<string>>
  log(level: 'Info' | 'Warning', message: string): void
}

// ────────────────────────────── input / output ───────────────────────────────

export interface AnalysisObjectInput {
  objectName: string
  /** The user's explicit filter clause (Filter_Clause__c), if any. */
  userFilter?: string | null
}

export interface AnalysisInput {
  objects: AnalysisObjectInput[]
  /** Size-based REST→Bulk routing thresholds; in-org defaults 600 / 10. */
  recordThreshold?: number
  objectThreshold?: number
}

export interface PlannedObject {
  objectName: string
  /** 1-based, from the dependency resolver. */
  sortOrder: number
  hasCircularReference: boolean
  deferredFields: string[]
  scope: ScopedFilter
  /** The Apex Scoped_Filter__c equivalent (null = unscoped) — parity surface. */
  scopedFilterDisplay: string | null
  recordCount: number
  /** REST | Bulk (post dup-rule override). */
  apiStrategy: string
  gatingTier: string | null
  requiresTriggerBypass: boolean
  requiresAutomationDisable: boolean
  restPageSize: number | null
  recommendedBatchSize: number
  isJunction: boolean
  junctionParents: string[] | null
  junctionParentFields: string[] | null
}

export interface AnalysisResult {
  /** Ordered by sortOrder ascending (the deploy order). */
  objects: PlannedObject[]
  totalObjects: number
  totalRecords: number
  /** Auto-injected junction object names (empty if none). */
  autoInjectedJunctions: string[]
  /** Advisory warnings (over-in-org-cap scopes, chunking, dup-rule probe skips). */
  warnings: string[]
}

// ────────────────────────────── the orchestrator ─────────────────────────────

export async function analyzeDeployment(
  input: AnalysisInput,
  io: AnalysisIo
): Promise<AnalysisResult> {
  const recordThreshold = input.recordThreshold ?? DEFAULT_SOURCE_QUERY_RECORD_THRESHOLD
  const objectThreshold = input.objectThreshold ?? DEFAULT_SOURCE_QUERY_OBJECT_THRESHOLD
  const warnings: string[] = []

  // Working set: user-selected objects + their filters.
  const objectNames = new Set<string>()
  const userFilters = new Map<string, string>()
  for (const o of input.objects) {
    objectNames.add(o.objectName)
    if (!isBlank(o.userFilter)) {
      userFilters.set(o.objectName, o.userFilter)
    }
  }

  // 1. Field describes (Phase 0). Apex caches a failed describe as '[]' and
  //    continues; the desktop propagates describe failures (fail-loud is the
  //    house rule post-FINDINGS #14, and there is no hop state to protect).
  const fieldMetadataByObject = new Map<string, FieldInfo[]>()
  for (const objName of objectNames) {
    fieldMetadataByObject.set(objName, await io.describeFields(objName))
  }

  // 2. Junction injection (end of Phase 0).
  //
  //    S49 FIX (BUG-4): junction-ness is a property of the OBJECT, never of how
  //    the object entered the plan. The Apex skipped `junctionMeta` for a
  //    user-selected junction ("leave it alone"), which left `isJunction:false`
  //    and routed it to the ExtId-upsert path — impossible for a junction,
  //    which by definition cannot host Data_Deployment_External_Id__c (see
  //    junctionDetector's header). Live proof: deployment 7 selected
  //    OpportunityContactRole explicitly and ALL 366 records failed with
  //    'Data_Deployment_External_Id__c does not match an External ID for
  //    OpportunityContactRole', while deployment 5 (same object auto-injected)
  //    deployed 51/52. Selecting an object must never make it fail.
  //
  //    So `junctionMeta` is now ALWAYS registered. What still differs for a
  //    user-selected junction is only the DESCRIBE: it keeps its real field
  //    metadata (the synthetic parent-only describe exists purely so an
  //    auto-injected object the user never picked still gets dependency edges).
  const junctionMeta = new Map<string, { parents: string[]; parentFields: string[] }>()
  const autoInjected: string[] = []
  for (const j of detectJunctions(objectNames)) {
    junctionMeta.set(j.objectName, { parents: [...j.parents], parentFields: [...j.parentFields] })
    if (objectNames.has(j.objectName)) continue // user picked it: keep the real describe
    objectNames.add(j.objectName)
    fieldMetadataByObject.set(j.objectName, await junctionFieldMetadata(io, j))
    autoInjected.push(j.objectName)
  }
  if (autoInjected.length > 0) {
    io.log(
      'Info',
      `Auto-included ${autoInjected.length} junction object(s): ${autoInjected.join(', ')}`
    )
  }

  // 3. Dependency resolution (no callouts).
  const sortedDeps: DependencyInfo[] = resolveDependencies(objectNames, fieldMetadataByObject)

  // Parent lookups + who has children (drives materialization).
  const objectToParentLookups = buildParentLookupMap(objectNames, fieldMetadataByObject)
  const objectsWithChildren = new Set<string>()
  for (const objName of objectNames) {
    const parentLookups = objectToParentLookups.get(objName)
    if (parentLookups != null) {
      for (const parent of parentLookups.keys()) objectsWithChildren.add(parent)
    }
  }

  // Dup-rule probe (target side): fails open like the Apex catch (deviation 6).
  let dupRuleObjects: Set<string>
  try {
    dupRuleObjects = await io.queryActiveDuplicateRuleObjects()
  } catch {
    dupRuleObjects = new Set<string>()
  }

  // Materialization: memoized per object, full pagination, fail-loud with the
  // Apex error text (message parity matters — tests pin it).
  const materializedIds = new Map<string, string[]>()
  async function materialize(objName: string, scope: ScopedFilter): Promise<void> {
    if (materializedIds.has(objName)) return
    const ids: string[] = []
    for (const soql of queriesForScope('SELECT Id', objName, scope)) {
      let chunkIdList: string[]
      try {
        chunkIdList = await io.queryIds(soql)
      } catch (e) {
        throw new AnalysisError(
          `Could not materialize in-scope ${objName} Ids for child scoping: ${errMsg(e)}`
        )
      }
      ids.push(...chunkIdList)
    }
    materializedIds.set(objName, ids)
  }

  const scopingCtx = {
    userFilters,
    parentLookups: objectToParentLookups,
    materializedIds,
    objectsWithChildren,
    materialize,
    warn(message: string): void {
      warnings.push(message)
      io.log('Warning', message)
    }
  }

  // 4. Per-object plan pass (Phase 1), in dependency order.
  const planned: PlannedObject[] = []
  let totalRecords = 0
  for (const depInfo of sortedDeps) {
    const objName = depInfo.objectName

    const scope = await buildScopedFilterForObject(objName, scopingCtx)
    const recordCount = await countRecords(io, objName, scope)

    const pol = resolvePolicy(objName)
    // totalObjectCount is the POST-injection count (Apex passes sortedDeps.size(),
    // which includes auto-injected junction rows).
    let strategy = decideStrategy(
      pol,
      recordCount,
      sortedDeps.length,
      recordThreshold,
      objectThreshold
    )
    // Active duplicate rule on TARGET forces REST (Bulk ignores the bypass header).
    if (strategy === STRATEGY_BULK && dupRuleObjects.has(objName)) {
      strategy = STRATEGY_REST
    }

    const jm = junctionMeta.get(objName) ?? null
    const entry: PlannedObject = {
      objectName: objName,
      sortOrder: depInfo.sortOrder,
      hasCircularReference: depInfo.hasCircularReference,
      deferredFields: [...depInfo.deferredFields],
      scope,
      scopedFilterDisplay: scopedFilterDisplay(scope),
      recordCount,
      apiStrategy: strategy,
      gatingTier: pol.tier,
      requiresTriggerBypass: pol.requiresTriggerBypass === true,
      requiresAutomationDisable: pol.requiresAutomationDisable === true,
      restPageSize: pol.restPageSize,
      recommendedBatchSize: recommendedBatchSize(pol, strategy),
      isJunction: jm != null,
      junctionParents: jm != null ? jm.parents : null,
      junctionParentFields: jm != null ? jm.parentFields : null
    }
    planned.push(entry)
    totalRecords += recordCount
  }

  // 5. Plan assembly (sortedDeps is already in deploy order; keep it).
  return {
    objects: planned,
    totalObjects: planned.length,
    totalRecords,
    autoInjectedJunctions: autoInjected,
    warnings
  }
}

/**
 * Apex countRecords, generalized over scope kinds: raw-with-LIMIT counts via
 * `SELECT Id … LIMIT n` totalSize; everything else via COUNT(); chunked
 * parentIn scopes sum one COUNT() per chunk (chunks partition the parent ids,
 * so the sum is exact). Failures throw with the Apex error text (FINDINGS #14:
 * a silent 0 here used to persist bogus counts and mis-size the API strategy).
 */
export async function countRecords(
  io: AnalysisIo,
  objName: string,
  scope: ScopedFilter
): Promise<number> {
  let total = 0
  for (const soql of countQueriesForScope(objName, scope)) {
    let n: number
    try {
      n = await io.countQuery(soql)
    } catch (e) {
      throw new AnalysisError(`Record count failed for ${objName}: ${errMsg(e)}`)
    }
    total += n
  }
  return total
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * S49 FIX (BUG-7, auto-injected half): field metadata for an auto-injected
 * junction.
 *
 * The synthetic parent-only describe (`buildSyntheticParentFieldInfos`) existed
 * because an auto-injected object was never described — but it also made the
 * plan's `fields` list EMPTY, and junction.ts then carried only the hardcoded
 * `Role, IsPrimary`. That silently dropped every other field: 26 of one account's 52
 * source OCRs had `NektarActions__c` set and all 51 rows written to the target
 * had it blank.
 *
 * So describe the junction for real, and re-harden the parent FKs to
 * `isNillable: false` — the ONE property the synthetic describe was relied on
 * for, since it makes the parent edges hard deps so the resolver sorts the
 * junction AFTER both parents. Any failure, an empty describe, or a describe
 * missing a parent FK falls back to the synthetic list (never worse than before).
 */
async function junctionFieldMetadata(io: AnalysisIo, j: JunctionInfo): Promise<FieldInfo[]> {
  let real: FieldInfo[]
  try {
    real = await io.describeFields(j.objectName)
  } catch {
    return buildSyntheticParentFieldInfos(j)
  }
  if (real.length === 0) return buildSyntheticParentFieldInfos(j)
  const parentFields = new Set(j.parentFields.map((f) => f.toLowerCase()))
  const present = new Set(real.map((f) => f.apiName.toLowerCase()))
  for (const pf of parentFields) {
    if (!present.has(pf)) return buildSyntheticParentFieldInfos(j)
  }
  return real.map((f) =>
    parentFields.has(f.apiName.toLowerCase()) ? { ...f, isNillable: false } : f
  )
}
