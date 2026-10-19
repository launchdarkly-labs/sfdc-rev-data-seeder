/**
 * S63 — the text-Id relink pass: `PassExecutors.relinkPass`.
 *
 * The first and second passes remap a field only when the describe says
 * `isReference`. CPQ also stores record Ids in plain TEXT fields
 * (`SBQQ__Subscription__c.SBQQ__RequiredById__c` / `SBQQ__RootId__c`,
 * `SBQQ__QuoteLine__c.SBQQ__OriginalQuoteLineId__c`, pricebook / template /
 * record-type ids on Quote, Opportunity and Contract) and those land on the
 * target holding SOURCE Ids — deployment 50 → sb1 left 103 of 127
 * subscriptions pointing at the source org, invisible to every lookup check.
 *
 * This pass runs ONCE per run, after the last second pass and before
 * Finalizing (contract activation walks the subscription tree), over the
 * EXPLICIT list in shared/fieldPolicy.ts `TEXT_ID_FIELDS` — never a
 * describe-wide "18-char text" heuristic (Opportunity carries NetSuite /
 * GCLID / Consensus / Gearset id text that must never be touched).
 *
 * Per object with listed fields present on BOTH describes:
 *   scope = the run's own deployed source ids (store.deployedSourceIds)
 *   → source query: Id + listed fields WHERE any is non-null, scoped Id IN (…)
 *   → resolve each value:
 *       'run'     keyed → target row whose RDS key = generateExternalId(value)
 *                 keyless → io.idMap.lookup(refObject, values)
 *       catalog   source row's Name/DeveloperName → the target row with that
 *                 key (ambiguous or missing → unresolved)
 *   → locate the target row + READ ITS CURRENT VALUES (keyed: by RDS key;
 *     keyless: by mapped Id), send only rows whose value differs
 *   → REST PATCH through io.upsertBatch(updateOnly) — the same seam the
 *     second pass uses, so keyed = upsert-by-key, keyless = PATCH by mapped Id
 *   → text_id_relinks ledger row per (record, field): relinked /
 *     already_current / unresolved / not_an_id / failed.
 *
 * UNRESOLVED VALUES ARE NEVER NULLED AND NEVER REWRITTEN. They stay as the
 * source Id so the evidence survives, and every one is logged with a reason.
 * The goal is ONE run that links everything: an in-run value is unresolved
 * only when its parent row failed (already a counted failure) or sits outside
 * the deployment's scope (the Plan step warns before the run).
 *
 * Pure over DeployIo: no jsforce, no better-sqlite3, no clock.
 */

import { TEXT_ID_FIELDS, type TextIdField } from '../../../shared/fieldPolicy'
import { buildInClause, chunkIds, maxIdsForSoql } from '../scoping'
import { EXTERNAL_ID_FIELD, decodeExternalId, generateExternalId } from './transform/sfid'
import type { DescribeField } from './transform/fieldFilter'
import type { DeployPlan } from './planFreeze'
import type { DeployIo, TextIdRelinkInput, TextIdRelinkOutcome } from './types'

const SF_ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/

/** Is this a well-formed Salesforce Id (15 or 18 alphanumerics)? */
export function looksLikeSfId(v: unknown): v is string {
  return typeof v === 'string' && SF_ID.test(v)
}

/** 15-char Id → 18-char via the sfid helper's rule (generateExternalId reverses to18). */
function to18(v: string): string {
  return decodeExternalId(generateExternalId(v))
}

export function makeTextIdRelinkPass(plan: DeployPlan): (runId: number, io: DeployIo) => Promise<void> {
  return (runId, io) => runTextIdRelink(plan, runId, io)
}

interface Resolution {
  targetValue: string | null
  reason: string | null
}

/** A catalog key: matchField value plus any alsoMatch values, joined. */
function catalogKey(row: Record<string, unknown>, spec: Exclude<TextIdField['resolve'], 'run'>): string | null {
  const main = row[spec.matchField]
  if (main == null || String(main) === '') return null
  const parts = [String(main)]
  for (const f of spec.alsoMatch ?? []) parts.push(String(row[f] ?? ''))
  return parts.join('\u0000')
}

function keyLabel(key: string): string {
  return key.split('\u0000').filter((p) => p !== '').join(' / ')
}

async function collect(io: DeployIo, soql: string, side: 'source' | 'target'): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  const it = side === 'source' ? io.querySource(soql) : io.queryTarget(soql)
  for await (const r of it) out.push(r)
  return out
}

function quoted(values: readonly string[]): string {
  return values.map((v) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(',')
}

export async function runTextIdRelink(plan: DeployPlan, runId: number, io: DeployIo): Promise<void> {
  const keyless = io.idMap != null
  const catalogCache = new Map<string, Map<string, Resolution>>() // `${catalog}` → value18 → resolution

  for (const objPlan of plan.objects) {
    if (objPlan.isJunction) continue
    const objectName = objPlan.objectName
    const listed = TEXT_ID_FIELDS.filter((t) => t.object.toLowerCase() === objectName.toLowerCase())
    if (listed.length === 0) continue
    if (io.store.isCancelRequested(runId)) return

    // Fields present on BOTH orgs (an org without MDQ has no RootId problem).
    const src = await io.describeSource(objectName)
    const tgt = await io.describeTarget(objectName)
    const srcBy = byLowerName(src)
    const tgtBy = byLowerName(tgt)
    const fields = listed
      .map((t) => {
        const s = srcBy.get(t.field.toLowerCase())
        const g = tgtBy.get(t.field.toLowerCase())
        return s && g ? { spec: t, apiName: s.apiName, targetApiName: g.apiName } : null
      })
      .filter((x): x is { spec: TextIdField; apiName: string; targetApiName: string } => x != null)
    if (fields.length === 0) continue

    const scopeIds = io.store.deployedSourceIds(runId, objectName)
    if (scopeIds.length === 0) continue

    // 1. Source rows with at least one listed value.
    const fieldNames = fields.map((f) => f.apiName)
    const baseSoql =
      `SELECT Id, ${fieldNames.join(', ')} FROM ${objectName} WHERE (` +
      fieldNames.map((f) => `${f} != null`).join(' OR ') +
      ')'
    const rows = new Map<string, Record<string, unknown>>()
    for (const chunk of chunkIds(scopeIds, maxIdsForSoql(baseSoql.length))) {
      for (const r of await collect(io, baseSoql + ' AND Id IN (' + buildInClause(chunk) + ')', 'source')) {
        if (r['Id'] != null) rows.set(String(r['Id']), r)
      }
    }
    if (rows.size === 0) continue

    // 2. Resolve every distinct value per field.
    const ledger: TextIdRelinkInput[] = []
    const resolvedByField = new Map<string, Map<string, Resolution>>() // apiName → value18 → resolution
    for (const f of fields) {
      const values = new Set<string>()
      for (const r of rows.values()) {
        const v = r[f.apiName]
        if (looksLikeSfId(v)) values.add(to18(v))
      }
      const res =
        f.spec.resolve === 'run'
          ? await resolveInRun(io, keyless, f.spec.refObject, [...values])
          : await resolveCatalog(io, f.spec.resolve, f.spec.refObject, [...values], catalogCache)
      resolvedByField.set(f.apiName, res)
    }

    // 3. Locate the target rows and their current values.
    const sourceIds = [...rows.keys()]
    const current = await readTargetRows(io, keyless, objectName, sourceIds, fields.map((f) => f.targetApiName))

    // 4. Build patches: only values that resolve AND differ from the target's current value.
    const patches: Array<Record<string, unknown>> = []
    const patchFields = new Map<string, Array<{ f: (typeof fields)[number]; value18: string; targetValue: string }>>()
    for (const [sourceId, r] of rows) {
      const cur = current.get(sourceId)
      const patch: Record<string, unknown> = { [EXTERNAL_ID_FIELD]: generateExternalId(sourceId) }
      let any = false
      for (const f of fields) {
        const raw = r[f.apiName]
        if (raw == null || raw === '') continue
        if (!looksLikeSfId(raw)) {
          ledger.push(entry(objectName, sourceId, cur?.id ?? null, f, String(raw), null, 'not_an_id', 'value is not a Salesforce Id'))
          continue
        }
        const value18 = to18(raw)
        const res = resolvedByField.get(f.apiName)?.get(value18)
        if (cur == null) {
          ledger.push(entry(objectName, sourceId, null, f, String(raw), res?.targetValue ?? null, 'unresolved', 'this row was not found on the target'))
          continue
        }
        if (res == null || res.targetValue == null) {
          ledger.push(entry(objectName, sourceId, cur.id, f, String(raw), null, 'unresolved', res?.reason ?? unresolvedReason(f.spec, keyless)))
          continue
        }
        const curVal = cur.values[f.targetApiName]
        if (looksLikeSfId(curVal) && to18(curVal) === res.targetValue) {
          ledger.push(entry(objectName, sourceId, cur.id, f, String(raw), res.targetValue, 'already_current', null))
          continue
        }
        patch[f.targetApiName] = res.targetValue
        any = true
        const arr = patchFields.get(sourceId) ?? []
        arr.push({ f, value18, targetValue: res.targetValue })
        patchFields.set(sourceId, arr)
      }
      if (any) {
        patch['attributes'] = { type: objectName }
        patches.push(patch)
      }
    }

    // 5. PATCH (keyed: upsert-by-key updateOnly; keyless: PATCH by mapped Id).
    if (patches.length > 0) {
      const result = await io.upsertBatch(objectName, patches, { updateOnly: true, batchSize: objPlan.recommendedBatchSize })
      const failed = new Map<string, string>()
      for (const d of result.errorDetails) {
        const sep = d.indexOf(' → ')
        if (sep >= 0) failed.set(decodeExternalId(d.slice(0, sep)), d.slice(sep + 3))
      }
      for (const ext of result.failedExternalIds) {
        const sid = decodeExternalId(ext)
        if (!failed.has(sid)) failed.set(sid, 'PATCH failed')
      }
      const unchanged = new Set((result.unchangedExtIds ?? []).map(decodeExternalId))
      for (const p of patches) {
        const sourceId = decodeExternalId(String(p[EXTERNAL_ID_FIELD]))
        const cur = current.get(sourceId)
        const outcome: TextIdRelinkOutcome = failed.has(sourceId) ? 'failed' : unchanged.has(sourceId) ? 'already_current' : 'relinked'
        for (const pf of patchFields.get(sourceId) ?? []) {
          ledger.push(entry(objectName, sourceId, cur?.id ?? null, pf.f, String(rows.get(sourceId)?.[pf.f.apiName] ?? ''), pf.targetValue, outcome, failed.get(sourceId) ?? null))
        }
      }
    }

    // 6. Ledger + log lines, one per field.
    io.store.recordTextIdRelinks(runId, ledger)
    for (const f of fields) {
      const mine = ledger.filter((l) => l.fieldName === f.apiName)
      if (mine.length === 0) continue
      const n = (o: TextIdRelinkOutcome): number => mine.filter((l) => l.outcome === o).length
      const unresolved = mine.filter((l) => l.outcome === 'unresolved' || l.outcome === 'failed')
      const level = unresolved.length > 0 ? 'Warning' : 'Info'
      const summary =
        `Relink ${objectName}.${f.apiName}: ${n('relinked')} relinked, ${n('already_current')} already current` +
        `${n('unresolved') > 0 ? `, ${n('unresolved')} unresolved (left as the source Id)` : ''}` +
        `${n('failed') > 0 ? `, ${n('failed')} failed` : ''}` +
        `${n('not_an_id') > 0 ? `, ${n('not_an_id')} not an Id` : ''}`
      const detail =
        unresolved.length > 0
          ? unresolved
              .slice(0, 10)
              .map((u) => `${u.sourceId} ${u.fieldName}=${u.sourceValue}: ${u.reason ?? u.outcome}`)
              .join('\n') + (unresolved.length > 10 ? `\n… ${unresolved.length - 10} more` : '')
          : null
      io.emit({
        kind: 'log',
        data: { runId, level, message: summary, detail, objectName, field: f.apiName }
      })
    }
  }
}

function byLowerName(fields: ReadonlyArray<DescribeField>): Map<string, DescribeField> {
  const m = new Map<string, DescribeField>()
  for (const f of fields) m.set(f.apiName.toLowerCase(), f)
  return m
}

function entry(
  objectApiName: string,
  sourceId: string,
  targetId: string | null,
  f: { spec: TextIdField; apiName: string },
  sourceValue: string,
  resolvedValue: string | null,
  outcome: TextIdRelinkOutcome,
  reason: string | null
): TextIdRelinkInput {
  return { objectApiName, sourceId, targetId, fieldName: f.apiName, refObject: f.spec.refObject, sourceValue, resolvedValue, outcome, reason }
}

function unresolvedReason(spec: TextIdField, keyless: boolean): string {
  if (spec.resolve === 'run') {
    return keyless
      ? `no ${spec.refObject} row with this source Id in the id map (its row failed, or it is outside this deployment's scope)`
      : `no ${spec.refObject} row on the target carries this source Id's RDS key (its row failed, or it is outside this deployment's scope)`
  }
  return `source ${spec.refObject} row not found`
}

/** 'run' resolution: value → the target Id of the row THIS deployment (or an earlier one, keyless) loaded. */
async function resolveInRun(io: DeployIo, keyless: boolean, refObject: string, values18: string[]): Promise<Map<string, Resolution>> {
  const out = new Map<string, Resolution>()
  if (values18.length === 0) return out
  if (keyless) {
    const m = await io.idMap!.lookup(refObject, values18)
    for (const v of values18) {
      const t = m.get(v)
      out.set(v, { targetValue: t ?? null, reason: null })
    }
    return out
  }
  const base = `SELECT Id, ${EXTERNAL_ID_FIELD} FROM ${refObject} WHERE ${EXTERNAL_ID_FIELD} IN (`
  for (const chunk of chunkIds(values18, maxIdsForSoql(base.length + 1))) {
    const soql = base + quoted(chunk.map((v) => generateExternalId(v))) + ')'
    for (const r of await collect(io, soql, 'target')) {
      const ext = r[EXTERNAL_ID_FIELD]
      if (ext == null || r['Id'] == null) continue
      out.set(decodeExternalId(String(ext)), { targetValue: String(r['Id']), reason: null })
    }
  }
  return out
}

/** catalog resolution: source row's name key → the target row with the same key (cached per run). */
async function resolveCatalog(
  io: DeployIo,
  spec: Exclude<TextIdField['resolve'], 'run'>,
  refObject: string,
  values18: string[],
  cache: Map<string, Map<string, Resolution>>
): Promise<Map<string, Resolution>> {
  let known = cache.get(spec.catalog)
  if (!known) cache.set(spec.catalog, (known = new Map()))
  const todo = values18.filter((v) => !known!.has(v))
  if (todo.length > 0) {
    const selectFields = ['Id', spec.matchField, ...(spec.alsoMatch ?? [])].join(', ')
    // source: Id → key
    const keyBySource = new Map<string, string | null>()
    const base = `SELECT ${selectFields} FROM ${refObject} WHERE Id IN (`
    for (const chunk of chunkIds(todo, maxIdsForSoql(base.length + 1))) {
      for (const r of await collect(io, base + buildInClause(chunk) + ')', 'source')) {
        if (r['Id'] == null) continue
        keyBySource.set(to18(String(r['Id'])), catalogKey(r, spec))
      }
    }
    // target: key → ids
    const keys = [...new Set([...keyBySource.values()].filter((k): k is string => k != null))]
    const idsByKey = new Map<string, string[]>()
    if (keys.length > 0) {
      const names = [...new Set(keys.map((k) => k.split('\u0000')[0]!))]
      for (let i = 0; i < names.length; i += 200) {
        const soql = `SELECT ${selectFields} FROM ${refObject} WHERE ${spec.matchField} IN (${quoted(names.slice(i, i + 200))})`
        for (const r of await collect(io, soql, 'target')) {
          const k = catalogKey(r, spec)
          if (k == null || r['Id'] == null) continue
          const arr = idsByKey.get(k) ?? []
          arr.push(String(r['Id']))
          idsByKey.set(k, arr)
        }
      }
    }
    for (const v of todo) {
      const key = keyBySource.get(v)
      if (key === undefined) {
        known.set(v, { targetValue: null, reason: `source ${refObject} ${v} not found (deleted or not visible)` })
        continue
      }
      if (key === null) {
        known.set(v, { targetValue: null, reason: `source ${refObject} ${v} has no ${spec.matchField}` })
        continue
      }
      const ids = idsByKey.get(key) ?? []
      if (ids.length === 1) known.set(v, { targetValue: ids[0]!, reason: null })
      else if (ids.length === 0) known.set(v, { targetValue: null, reason: `no ${refObject} named "${keyLabel(key)}" on the target` })
      else known.set(v, { targetValue: null, reason: `${ids.length} ${refObject} rows named "${keyLabel(key)}" on the target (ambiguous)` })
    }
  }
  const out = new Map<string, Resolution>()
  for (const v of values18) out.set(v, known.get(v) ?? { targetValue: null, reason: null })
  return out
}

/** The target rows for these source ids, with the current values of the listed fields. */
async function readTargetRows(
  io: DeployIo,
  keyless: boolean,
  objectName: string,
  sourceIds: string[],
  targetFields: string[]
): Promise<Map<string, { id: string; values: Record<string, unknown> }>> {
  const out = new Map<string, { id: string; values: Record<string, unknown> }>()
  const select = ['Id', ...targetFields].join(', ')
  if (keyless) {
    const m = await io.idMap!.lookup(objectName, sourceIds)
    const bySourceOfTarget = new Map<string, string>()
    for (const [s, t] of m) bySourceOfTarget.set(t, s)
    const targetIds = [...new Set(m.values())]
    const base = `SELECT ${select} FROM ${objectName} WHERE Id IN (`
    for (const chunk of chunkIds(targetIds, maxIdsForSoql(base.length + 1))) {
      for (const r of await collect(io, base + buildInClause(chunk) + ')', 'target')) {
        const tid = r['Id'] == null ? null : String(r['Id'])
        const sid = tid == null ? undefined : bySourceOfTarget.get(tid)
        if (tid != null && sid != null) out.set(sid, { id: tid, values: r })
      }
    }
    return out
  }
  const base = `SELECT ${select}, ${EXTERNAL_ID_FIELD} FROM ${objectName} WHERE ${EXTERNAL_ID_FIELD} IN (`
  for (const chunk of chunkIds(sourceIds, maxIdsForSoql(base.length + 1))) {
    const soql = base + quoted(chunk.map((s) => generateExternalId(s))) + ')'
    for (const r of await collect(io, soql, 'target')) {
      const ext = r[EXTERNAL_ID_FIELD]
      if (ext == null || r['Id'] == null) continue
      out.set(decodeExternalId(String(ext)), { id: String(r['Id']), values: r })
    }
  }
  return out
}
