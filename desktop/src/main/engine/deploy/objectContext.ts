/**
 * E4E.2 — per-object deploy context build: the Phase-A prefetch section of
 * `DataDeploymentQueueable.executeNormalModeV2` (DDQ L1318-1679) minus
 * everything the plan freeze (E2.6) already decided:
 *
 *   live describes (L1324-1327) → PA detection from the FULL source describe
 *   (L1335-1341) → kept fields = the FROZEN A5 survivors matched against the
 *   live describe → nameMatch maps incl. the RecordTypeId force (L1586-1614,
 *   via E4X.5 buildNameMatchMaps) → prefetch bundle: target user / inactive
 *   users / restricted picklists / PBE substitutes (L1621-1679, via E4X.6
 *   buildPrefetchContext) → the assembled `GoldenContext` for transformRecordV3.
 *
 * A5/A7/A9/A10/A12 and strategy selection do NOT re-run here — they are frozen
 * in the plan (E2.6). The live describes only supply field METADATA for the
 * frozen field NAMES.
 *
 * DESIGN DIVERGENCE (frozen-plan contract, flagged in-line): a frozen field
 * missing from the live SOURCE describe, or no longer writable on the live
 * TARGET describe (missing / createable revoked / turned formula-auto-number),
 * is a STALE PLAN → throw (bounded whole-object retry → exhaustion, with a
 * clear message). The Apex re-ran the intersection per hop and silently
 * deployed without the field; silently deploying a different field set than
 * the frozen plan would contradict the freeze contract (deployDesign §1.2 —
 * the orchestrator reads ONLY the frozen plan; edits require a re-freeze).
 *
 * Also home to the four engine-pure IO adapters that turn `DeployIo` streams
 * into the module seams (NameMatchIo / PrefetchIo / ParentStripIo /
 * ContractsIo), each carrying its Apex failure mode:
 *   - nameMatch: FAIL-SILENT per side (NameMatchResolver L311-314 returns an
 *     empty map on a failed query; a failed continuation page keeps the pages
 *     already accumulated, L332-337).
 *   - prefetch: REJECTIONS PROPAGATE — buildPrefetchContext itself decides
 *     loud (inactive users) vs open (PBE substitutes).
 *   - parentStrip: REJECTIONS PROPAGATE — stripMissingParentRefs decides loud
 *     (nested ExtId) vs open (flat directId).
 *   - contracts: REJECTIONS PROPAGATE — fetchActivatedContractExtIds is
 *     fail-open around it.
 *
 * Pure over DeployIo: no jsforce, no better-sqlite3, no clock.
 */

import { buildNameMatchMaps, type NameMatchIo } from './transform/nameMatch'
import { buildPrefetchContext, type PrefetchIo } from './transform/prefetch'
import type { ParentStripIo } from './transform/parentStrip'
import type { ContractsIo } from './transform/contracts'
import { ciEquals, escapeSingleQuotes, isBlank } from './transform/apexSemantics'
import { EXTERNAL_ID_FIELD } from './transform/sfid'
import type { DescribeField } from './transform/fieldFilter'
import type { GoldenContext, GoldenMapping } from './golden/fixture'
import type { DeployIo } from './types'
import type { FrozenObjectPlan } from './planFreeze'

/**
 * Drains an AsyncIterable into an array. On a MID-stream rejection the pages
 * already yielded are KEPT and returned (Apex pagination `break`s with what
 * accumulated); a first-page rejection rejects before anything accumulates.
 * Callers that must not swallow errors use `collectLoud`.
 */
async function collectSilent(
  stream: AsyncIterable<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  try {
    for await (const rec of stream) out.push(rec)
  } catch {
    // fail-silent — keep whatever accumulated (empty on a first-page failure)
  }
  return out
}

/** Drains an AsyncIterable; any rejection propagates to the caller. */
async function collectLoud(
  stream: AsyncIterable<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for await (const rec of stream) out.push(rec)
  return out
}

/**
 * NameMatchIo over DeployIo. SOQL per NameMatchResolver.cls L77-106:
 * `SELECT Id, {matchField} FROM {objectName}` + RecordType's SObjectType filter
 * (BOTH sides) + `IsActive = true` (target RecordType only — the opts carry the
 * asymmetry). Query failures are FAIL-SILENT (empty/partial map) like the Apex.
 */
export function nameMatchIoFor(io: DeployIo): NameMatchIo {
  return {
    async queryNames(role, objectName, matchField, opts): Promise<Array<Record<string, unknown>>> {
      let where = ''
      if (!isBlank(opts.sObjectType)) {
        where = " WHERE SobjectType = '" + escapeSingleQuotes(opts.sObjectType as string) + "'"
      }
      if (opts.activeOnly) {
        where = where === '' ? ' WHERE IsActive = true' : where + ' AND IsActive = true'
      }
      const soql =
        'SELECT Id, ' +
        escapeSingleQuotes(matchField) +
        ' FROM ' +
        escapeSingleQuotes(objectName) +
        where
      return collectSilent(role === 'source' ? io.querySource(soql) : io.queryTarget(soql))
    }
  }
}

/** PrefetchIo over DeployIo — rejections propagate (prefetch owns loud/open). */
export function prefetchIoFor(io: DeployIo): PrefetchIo {
  return {
    getTargetUserId: () => io.getTargetUserId(),
    queryTarget: (soql) => collectLoud(io.queryTarget(soql)),
    // S49 (BUG-9): raw target GET for the UI-API record-type picklist endpoint.
    restGetTarget: (path) => io.restGetTarget(path)
  }
}

/**
 * ParentStripIo over DeployIo: one `SELECT {field} FROM {refObj} WHERE {field}
 * IN (…)` existence probe per ≤200-value chunk (DDQ L2526/L2639). Values are
 * quoted + escaped; rejections propagate (parentStrip owns loud/open).
 */
export function parentStripIoFor(io: DeployIo): ParentStripIo {
  return {
    async queryExisting(refObj, field, chunk): Promise<string[]> {
      const quoted = chunk.map((v) => "'" + escapeSingleQuotes(v) + "'").join(',')
      const soql = 'SELECT ' + field + ' FROM ' + refObj + ' WHERE ' + field + ' IN (' + quoted + ')'
      const rows = await collectLoud(io.queryTarget(soql))
      const out: string[] = []
      for (const r of rows) {
        const v = r[field]
        if (v != null) out.push(String(v))
      }
      return out
    }
  }
}

/** ContractsIo over DeployIo — runs the module-built SOQL, returns the ExtIds. */
export function contractsIoFor(io: DeployIo): ContractsIo {
  return {
    async queryExtIds(soql): Promise<string[]> {
      const rows = await collectLoud(io.queryTarget(soql))
      const out: string[] = []
      for (const r of rows) {
        const v = r[EXTERNAL_ID_FIELD]
        if (v != null) out.push(String(v))
      }
      return out
    }
  }
}

/** Everything a pass executor needs for one object, built once per pass. */
export interface ObjectDeployContext {
  objPlan: FrozenObjectPlan
  /** The frozen A5 survivors with live metadata, SOURCE describe order. */
  keptFields: DescribeField[]
  /** FULL live target describe (Apex tctx.targetFieldsByName was the full map). */
  targetFields: DescribeField[]
  /** From the FULL source describe (DDQ L1329-1341 — the intersection filter
   *  drops the non-createable IsPersonAccount, so kept fields can't detect it). */
  sourceHasIsPersonAccount: boolean
  /** The assembled transform context for transformRecordV3. */
  tctx: GoldenContext
  /**
   * S49 (BUG-1 pt2): composite unique key → the FIRST source Id that claimed it,
   * for objects in `UNIQUE_CONSTRAINTS`. Lives on the object context so the check
   * spans every page of the object's pass, not just one batch.
   */
  uniqueKeySeen: Map<string, string>
}

export async function buildObjectContext(
  objPlan: FrozenObjectPlan,
  io: DeployIo
): Promise<ObjectDeployContext> {
  const objectName = objPlan.objectName
  const sourceFields = await io.describeSource(objectName)
  const targetFields = await io.describeTarget(objectName)

  let sourceHasIsPersonAccount = false
  for (const fi of sourceFields) {
    if (ciEquals(fi.apiName, 'IsPersonAccount')) {
      sourceHasIsPersonAccount = true
      break
    }
  }

  // Kept fields: frozen A5 survivors, matched EXACTLY (case-sensitive Set —
  // plan.fields came from these same describes' apiNames at freeze time).
  const planFields = new Set(objPlan.fields)
  const keptFields = sourceFields.filter((fi) => planFields.has(fi.apiName))
  if (keptFields.length !== planFields.size) {
    const live = new Set(keptFields.map((f) => f.apiName))
    const missing = objPlan.fields.filter((f) => !live.has(f))
    // Stale frozen plan (see header) — loud beats silently deploying a
    // different field set than the user froze.
    throw new Error(
      `Frozen plan for ${objectName} references field(s) missing from the live source describe: ` +
        missing.join(', ') +
        ' — re-freeze the plan'
    )
  }

  // Null-prototype for parity-faithful Map.get semantics (fieldFilter's rule).
  const targetFieldsByName: Record<string, DescribeField> = Object.create(null) as Record<
    string,
    DescribeField
  >
  for (const tfi of targetFields) targetFieldsByName[tfi.apiName] = tfi

  // The SAME freeze-contract guard on the TARGET side (E4E.2 review finding):
  // the Apex re-ran the A5 target drops EVERY hop (DDQ L1374-1385) and quietly
  // deployed without a field the target had lost (deleted / createable
  // revoked / turned formula). Under the frozen plan, silently deploying a
  // different field set is forbidden — and NOT checking is worse than either
  // behavior: every payload would carry the dead field and every sub-batch
  // would 400 whole ('Batch HTTP error: …', 100% failed) with no hint. At
  // freeze time every kept field passed exactly this predicate (fieldFilter),
  // so only post-freeze drift can trip it.
  const notWritable: string[] = []
  for (const fi of keptFields) {
    const tfi = targetFieldsByName[fi.apiName]
    if (tfi == null || !tfi.isCreateable || tfi.isCalculated || tfi.isAutoNumber) {
      notWritable.push(fi.apiName)
    }
  }
  if (notWritable.length > 0) {
    throw new Error(
      `Frozen plan for ${objectName} references field(s) no longer writable on the live target describe: ` +
        notWritable.join(', ') +
        ' — re-freeze the plan'
    )
  }

  // FrozenMapping → GoldenMapping (shape-compatible; copied so the transform
  // can never mutate the frozen plan object).
  const mappings: Record<string, GoldenMapping> = {}
  for (const [apiName, m] of Object.entries(objPlan.mappings)) {
    mappings[apiName] = { strategy: m.strategy, matchField: m.matchField, customValue: m.customValue }
  }

  const nameMatchMaps = await buildNameMatchMaps(nameMatchIoFor(io), objectName, keptFields, mappings)
  const bundle = await buildPrefetchContext(
    prefetchIoFor(io),
    objectName,
    keptFields,
    mappings,
    targetFields
  )

  const tctx: GoldenContext = {
    objectName,
    fields: keptFields,
    deferredFields: [...objPlan.deferredFields],
    mappings,
    nameMatchMaps,
    useBulkFormat: false, // E4E.2 is the REST path (Bulk = E4T.3)
    targetUserId: bundle.targetUserId,
    inactiveUserIds: bundle.inactiveUserIds,
    targetFieldsByName,
    targetPicklistAllowedValues: bundle.targetPicklistAllowedValues,
    inactivePbeIds: bundle.inactivePbeIds,
    pbeSubstitutes: bundle.pbeSubstitutes,
    knownPbeIds: bundle.knownPbeIds,
    recordTypePicklists: bundle.recordTypePicklists,
    recordTypeDefaultId: bundle.recordTypeDefaultId,
    recordTypeCandidateCount: bundle.recordTypeCandidateCount
  }

  return {
    objPlan,
    keptFields,
    targetFields,
    sourceHasIsPersonAccount,
    tctx,
    uniqueKeySeen: new Map<string, string>()
  }
}
