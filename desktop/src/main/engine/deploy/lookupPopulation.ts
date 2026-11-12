/**
 * S75 — the lookup population check: `PassExecutors.populationCheck`.
 *
 * Every earlier check looked only at fields the engine MAPS, so a lookup that
 * was populated on the source and landed empty on EVERY target row was
 * invisible unless its strategy happened to log (deployments 68/69:
 * `SBQQ__ProductOption__c` 607 → 0 and 1,485 → 0, found by a person reading
 * the org two days later).
 *
 * This pass runs ONCE per run, after the text-Id relink and before Finalizing,
 * and compares — per plan object, for EVERY reference field on both describes,
 * mapped or not — the number of non-null values over the rows this run
 * deployed:
 *
 *   source: SELECT COUNT(Id) n, COUNT(f) … WHERE Id IN (deployed source ids)
 *   target: the same over the rows those ids became (keyed: by RDS key;
 *           keyless: by mapped Id)
 *
 *   dropped      source > 0, target = 0, and the plan MAPS the field   → FAIL
 *   notDeployed  source > 0, target = 0, field skipped / not in plan   → warning
 *   partial      0 < target < source                                   → warning
 *   ok           target ≥ source
 *
 * A `dropped` field does not abort the run — contracts still activate and
 * automation is still restored — but it is logged as an Error, stored
 * (lookup_population, migration 016) and shown on the deployment page as a
 * failed check. Read-only on both orgs.
 *
 * Junction objects are not compared: their rows are inserted without an RDS
 * key or an id-map entry, so the target rows cannot be addressed one-for-one.
 *
 * Pure over DeployIo: no jsforce, no better-sqlite3, no clock.
 */

import { buildInClause, chunkIds, maxIdsForSoql } from '../scoping'
import { ciEquals } from './transform/apexSemantics'
import { EXTERNAL_ID_FIELD, generateExternalId } from './transform/sfid'
import type { DescribeField } from './transform/fieldFilter'
import type { DeployPlan, FrozenObjectPlan } from './planFreeze'
import type { DeployIo, LookupPopulationInput, LookupPopulationStatus } from './types'

/** COUNT() expressions per aggregate query. */
const FIELDS_PER_QUERY = 20

export interface LookupPopulationResult {
  /** Fields compared (source populated). */
  compared: number
  dropped: number
  partial: number
  notDeployed: number
}

export function makeLookupPopulationCheck(
  plan: DeployPlan
): (runId: number, io: DeployIo) => Promise<LookupPopulationResult> {
  return (runId, io) => runLookupPopulationCheck(plan, runId, io)
}

/** The status of one field from its two counts and whether the plan maps it. */
export function classifyPopulation(sourceCount: number, targetCount: number, mapped: boolean): LookupPopulationStatus | null {
  if (sourceCount <= 0) return null
  if (targetCount <= 0) return mapped ? 'dropped' : 'notDeployed'
  if (targetCount < sourceCount) return 'partial'
  return 'ok'
}

/** Does the frozen plan write this reference field (kept, and not on Skip)? */
export function planMapsField(objPlan: FrozenObjectPlan, apiName: string): boolean {
  if (!objPlan.fields.includes(apiName)) return false
  const strategy = objPlan.mappings[apiName]?.strategy
  return strategy == null || !ciEquals(strategy, 'skip')
}

export async function runLookupPopulationCheck(
  plan: DeployPlan,
  runId: number,
  io: DeployIo
): Promise<LookupPopulationResult> {
  const total: LookupPopulationResult = { compared: 0, dropped: 0, partial: 0, notDeployed: 0 }
  const keyless = io.idMap != null

  for (const objPlan of plan.objects) {
    if (io.store.isCancelRequested(runId)) return total
    const objectName = objPlan.objectName
    if (objPlan.isJunction) continue

    const sourceIds = io.store.deployedSourceIds(runId, objectName)
    if (sourceIds.length === 0) continue

    const tgtBy = new Map<string, DescribeField>()
    for (const f of await io.describeTarget(objectName)) tgtBy.set(f.apiName.toLowerCase(), f)
    const fields = (await io.describeSource(objectName)).filter(
      (f) => f.isReference === true && tgtBy.has(f.apiName.toLowerCase()) && f.apiName !== EXTERNAL_ID_FIELD
    )
    if (fields.length === 0) continue
    const names = fields.map((f) => f.apiName)
    const targetNames = fields.map((f) => tgtBy.get(f.apiName.toLowerCase())!.apiName)

    let src: Counts
    let tgt: Counts
    try {
      src = await countSide(io, 'source', objectName, names, { field: 'Id', values: sourceIds, quote: false })
      if (keyless) {
        const mapped = await io.idMap!.lookup(objectName, sourceIds)
        tgt = await countSide(io, 'target', objectName, targetNames, {
          field: 'Id',
          values: [...new Set(mapped.values())],
          quote: false
        })
      } else {
        tgt = await countSide(io, 'target', objectName, targetNames, {
          field: EXTERNAL_ID_FIELD,
          values: sourceIds.map((s) => generateExternalId(s)),
          quote: true
        })
      }
    } catch (e) {
      log(io, runId, 'Warning', `Lookup check ${objectName}: could not be read (${e instanceof Error ? e.message : String(e)}) — not compared`, objectName)
      continue
    }
    if (tgt.rows === 0) {
      log(io, runId, 'Warning', `Lookup check ${objectName}: none of the ${src.rows} deployed row(s) could be found on the target — not compared`, objectName)
      continue
    }

    const rows: LookupPopulationInput[] = []
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]!
      const sourceCount = src.counts[i] ?? 0
      const targetCount = tgt.counts[i] ?? 0
      const mapped = planMapsField(objPlan, f.apiName)
      const status = classifyPopulation(sourceCount, targetCount, mapped)
      if (status == null) continue
      rows.push({
        objectApiName: objectName,
        fieldName: f.apiName,
        refObject: f.referenceTo?.[0] ?? null,
        strategy: objPlan.fields.includes(f.apiName) ? (objPlan.mappings[f.apiName]?.strategy ?? null) : 'notInPlan',
        sourceRows: src.rows,
        targetRows: tgt.rows,
        sourceCount,
        targetCount,
        status
      })
    }
    io.store.recordLookupPopulation(runId, objectName, rows)

    const of = (s: LookupPopulationStatus): LookupPopulationInput[] => rows.filter((r) => r.status === s)
    total.compared += rows.length
    total.dropped += of('dropped').length
    total.partial += of('partial').length
    total.notDeployed += of('notDeployed').length

    const line = (r: LookupPopulationInput): string =>
      `${r.fieldName} → ${r.refObject ?? '?'}: source ${r.sourceCount}, target ${r.targetCount}` +
      (r.strategy != null ? ` (${r.strategy === 'notInPlan' ? 'not in the plan' : r.strategy})` : '')
    if (of('dropped').length > 0) {
      log(
        io,
        runId,
        'Error',
        `Lookup check ${objectName}: ${of('dropped').length} mapped lookup(s) populated on the source are EMPTY on every deployed row`,
        objectName,
        of('dropped').map(line).join('\n')
      )
    }
    const soft = [...of('partial'), ...of('notDeployed')]
    if (soft.length > 0) {
      log(
        io,
        runId,
        'Warning',
        `Lookup check ${objectName}: ${of('partial').length} lookup(s) partly populated, ${of('notDeployed').length} not deployed (skipped or not in the plan)`,
        objectName,
        soft.map(line).join('\n')
      )
    }
  }

  log(
    io,
    runId,
    total.dropped > 0 ? 'Error' : 'Info',
    total.dropped > 0
      ? `Lookup population check FAILED: ${total.dropped} of ${total.compared} populated lookup field(s) landed empty`
      : `Lookup population check passed: ${total.compared} populated lookup field(s) compared, ${total.partial} partly populated, ${total.notDeployed} not deployed`,
    null
  )
  return total
}

interface Counts {
  rows: number
  /** Aligned with the field list passed in. */
  counts: number[]
}

/** COUNT(Id) + COUNT(field) over the scoped rows of one side, summed across id chunks and field slices. */
async function countSide(
  io: DeployIo,
  side: 'source' | 'target',
  objectName: string,
  fields: readonly string[],
  scope: { field: string; values: readonly string[]; quote: boolean }
): Promise<Counts> {
  const out: Counts = { rows: 0, counts: fields.map(() => 0) }
  if (scope.values.length === 0) return out
  for (let at = 0; at < fields.length; at += FIELDS_PER_QUERY) {
    const slice = fields.slice(at, at + FIELDS_PER_QUERY)
    const base =
      `SELECT COUNT(Id) n, ${slice.map((f, i) => `COUNT(${f}) c${i}`).join(', ')} FROM ${objectName} WHERE ${scope.field} IN (`
    let rows = 0
    for (const chunk of chunkIds(scope.values as string[], maxIdsForSoql(base.length + 1))) {
      const inList = scope.quote ? chunk.map((v) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(',') : buildInClause(chunk)
      const it = side === 'source' ? io.querySource(base + inList + ')') : io.queryTarget(base + inList + ')')
      for await (const r of it) {
        rows += num(r['n'])
        for (let i = 0; i < slice.length; i++) out.counts[at + i]! += num(r[`c${i}`])
      }
    }
    // Every slice counts the same rows; keep the first slice's total.
    if (at === 0) out.rows = rows
  }
  return out
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function log(
  io: DeployIo,
  runId: number,
  level: 'Info' | 'Warning' | 'Error',
  message: string,
  objectName: string | null,
  detail: string | null = null
): void {
  io.emit({
    kind: 'log',
    data: { runId, level, message, ...(detail != null ? { detail } : {}), ...(objectName != null ? { objectName } : {}) }
  })
}
