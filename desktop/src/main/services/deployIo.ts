/**
 * E4E.1 — the DeployIo binding (deployDesign §1.1): connects the pure deploy
 * engine to GuardedOrg (auth + write gate) + DeployStore (run state) + the
 * E4T.1 collections transport. The parity-testing seam's LIVE implementation;
 * tests use scripted fakes instead.
 *
 * Every write goes through `target.assertWritable` — role!=='target' or LD
 * prod throws before any callout, so "wrote to the wrong org" stays
 * structurally impossible (subsumes Apex validateDeploymentRoles).
 */
import type { GuardedOrg } from './salesforce'
import { runQuery } from './analysisIo'
import {
  DUPLICATE_RULE_BYPASS_HEADER,
  emptyCollectionsResult,
  insertBatchRaw,
  insertByVirtualKey,
  updateByVirtualKey,
  upsertByExtId,
  type CollectionsHttpResult,
  type CollectionsResult,
  type CollectionsTransport,
  type CompositeMethod
} from './transport/collections'
import type { DeployStore } from './deployStore'
import type { DeployEvent, DeployIdMapIo, DeployIo, QueryPage } from '../engine/deploy/types'
import type { DescribeField } from '../engine/deploy/transform/fieldFilter'
import { EXTERNAL_ID_FIELD, decodeExternalId } from '../engine/deploy/transform/sfid'

/**
 * The E4T.1 transport adapter: one composite/sobjects call with the dup-rule
 * bypass header; 401→refresh→retry-once is jsforce-native beneath (A5
 * refreshFn). A thrown HTTP/network error becomes the whole-batch failure
 * shape the collections client renders as all-failed (Apex parity).
 */
export function makeCollectionsTransport(target: GuardedOrg): CollectionsTransport {
  return {
    async request(
      method: CompositeMethod,
      endpoint: string,
      body: string
    ): Promise<CollectionsHttpResult> {
      target.assertWritable(`${method} ${endpoint}`)
      try {
        const res = await target.conn.request({
          method,
          url: endpoint,
          body,
          headers: { 'Content-Type': 'application/json', ...DUPLICATE_RULE_BYPASS_HEADER }
        })
        return { success: true, body: JSON.stringify(res) }
      } catch (e) {
        return { success: false, errorMessage: e instanceof Error ? e.message : String(e) }
      }
    }
  }
}

/** Full-pagination record stream (nextRecordsUrl walk; composite wrap inside runQuery). */
async function* queryPages(
  org: GuardedOrg,
  soql: string
): AsyncGenerator<Record<string, unknown>, void, undefined> {
  let res = await runQuery(org.conn, soql)
  for (;;) {
    for (const rec of res.records) yield rec
    if (res.done || res.nextRecordsUrl == null) break
    res = (await org.conn.request(res.nextRecordsUrl)) as Awaited<ReturnType<typeof runQuery>>
  }
}

/**
 * Page-boundary-preserving walk (E4E.2): each REST query page is yielded whole
 * — the Apex "batch". Always yields at least the first page (even empty), so
 * the engine's 0-record guard fires.
 */
async function* queryPageWalk(
  org: GuardedOrg,
  soql: string
): AsyncGenerator<QueryPage, void, undefined> {
  let res = await runQuery(org.conn, soql)
  for (;;) {
    yield { records: res.records, totalSize: res.totalSize ?? null }
    if (res.done || res.nextRecordsUrl == null) break
    res = (await org.conn.request(res.nextRecordsUrl)) as Awaited<ReturnType<typeof runQuery>>
  }
}

/**
 * Deploy-time field describe → the engine's `DescribeField` projection. Fetched
 * FRESH per call (the Apex re-described every hop, DDQ L1324-1327); NOT the
 * shared describe cache, whose FieldInfo lacks `relationshipName` (load-bearing
 * for nested-ExtId payloads/parentStrip) and `dataType`.
 */
export async function describeDeployFields(
  org: GuardedOrg,
  objectApiName: string
): Promise<DescribeField[]> {
  const res = await org.conn.describe(objectApiName)
  return res.fields.map((f) => ({
    apiName: f.name,
    dataType: f.type ?? null,
    isCreateable: f.createable ?? false,
    isNillable: f.nillable ?? true,
    isReference: (f.referenceTo?.length ?? 0) > 0,
    referenceTo: (f.referenceTo ?? []).filter((r): r is string => !!r),
    relationshipName: f.relationshipName ?? null,
    isAutoNumber: f.autoNumber ?? false,
    isCalculated: f.calculated ?? false,
    isExternalId: f.externalId ?? false,
    isRestrictedPicklist: f.restrictedPicklist ?? false,
    // S50 (BUG-14): enforced lookup filter. jsforce types filteredLookupInfo as
    // a bare `object`, so read the one property we need defensively.
    hasEnforcedLookupFilter:
      f.filteredLookupInfo != null &&
      (f.filteredLookupInfo as { optionalFilter?: boolean }).optionalFilter !== true,
    // S49 (BUG-9): names the controlling field of a dependent picklist.
    controllerName: f.controllerName ?? null,
    picklistValues: (f.picklistValues ?? [])
      .filter((pv) => pv.active !== false)
      .map((pv) => pv.value)
      .filter((v): v is string => v != null)
  }))
}

export interface DeployIoOptions {
  source: GuardedOrg
  target: GuardedOrg
  /** Store.deploy — the migration-005 facade. */
  store: DeployStore
  emit: (event: DeployEvent) => void
  /** S61 (U-5): present ⇔ KEYLESS mode — see `makeDeployIdMap`. */
  idMap?: DeployIdMapIo
  /** Injected for tests; real defaults otherwise. */
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

/** S62-3: `SELECT Id, f1, f2… FROM {object} WHERE Id IN (…)` in 200-id chunks → current values by Id. */
async function readCurrentValues(
  org: GuardedOrg,
  objectApiName: string,
  ids: ReadonlyArray<string>,
  fields: ReadonlyArray<string>
): Promise<ReadonlyMap<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>()
  const select = ['Id', ...fields.filter((f) => f !== 'Id')].join(', ')
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const soql = `SELECT ${select} FROM ${objectApiName} WHERE Id IN (${chunk.map((id) => `'${id}'`).join(',')})`
    for await (const rec of queryPages(org, soql)) if (rec.Id != null) out.set(String(rec.Id), rec)
  }
  return out
}

/** `SELECT Id FROM {object} WHERE Id IN (…)` in 200-id chunks — which rows still exist. */
async function existingIds(org: GuardedOrg, objectApiName: string, ids: ReadonlyArray<string>): Promise<ReadonlySet<string>> {
  const out = new Set<string>()
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const soql = `SELECT Id FROM ${objectApiName} WHERE Id IN (${chunk.map((id) => "'" + id.replace(/'/g, '') + "'").join(',')})`
    for await (const rec of queryPages(org, soql)) if (rec.Id != null) out.add(String(rec.Id))
  }
  return out
}

/**
 * S61 (U-5): the live id-map seam for a keyless deployment — the sqlite `id_map` table (per
 * TARGET org, so an earlier deployment's rows count) plus a target existence probe.
 */
export function makeDeployIdMap(store: DeployStore, target: GuardedOrg, deploymentId: number): DeployIdMapIo {
  return {
    lookup: async (objectApiName, sourceIds) => store.idMapLookup(target.orgId, objectApiName, sourceIds),
    record: async (objectApiName, pairs) => {
      store.idMapPut(target.orgId, deploymentId, objectApiName, pairs)
    },
    existingTargetIds: (objectApiName, targetIds) => existingIds(target, objectApiName, targetIds)
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * S61 (U-5) — the keyless write. The engine hands us the SAME payloads it would upsert: a virtual
 * key per record and `{ Rel: { ExtId } }` parent references for in-deployment parents (the
 * parent-strip already removed the ones the map does not have). Here:
 *   1. nested references become flat lookup Ids through the id map;
 *   2. first pass: rows already mapped AND still on the target are reported as successes without
 *      a write (the re-run idempotency the map affords); the rest are INSERTED and their new ids
 *      recorded;
 *   3. second pass (updateOnly): the row's own target Id comes from the map and the record is
 *      PATCHed by Id; an unmapped row is a synthetic failure, never a blind write.
 * Payloads are copied, never mutated — the engine still reads its key off them afterwards.
 */
export async function keylessWrite(
  transport: CollectionsTransport,
  idMap: DeployIdMapIo,
  describeTarget: (objectName: string) => Promise<DescribeField[]>,
  objectName: string,
  records: ReadonlyArray<Record<string, unknown>>,
  o: {
    updateOnly: boolean
    batchSize: number | null
    /**
     * S62-3: the current TARGET values of the given fields for the given target ids (one query per
     * 200 ids). When present, the second pass compares each PATCH against the row it would rewrite
     * and does not send rows whose every value already matches — a keyless re-run then touches
     * nothing (tgt_b run 32 re-PATCHed 17 Opportunities + 4 Contracts with identical values,
     * bumping LastModifiedDate and firing target automation for no change). Absent → every row is
     * sent, exactly as before.
     */
    readCurrent?: (objectName: string, targetIds: ReadonlyArray<string>, fields: ReadonlyArray<string>) => Promise<ReadonlyMap<string, Record<string, unknown>>>
  }
): Promise<CollectionsResult> {
  const fields = await describeTarget(objectName)
  const fieldByRel = new Map<string, DescribeField>()
  for (const f of fields) if (f.relationshipName) fieldByRel.set(f.relationshipName, f)

  // 1. Resolve every nested parent reference through the map, one lookup per referenced object.
  const wantedByObject = new Map<string, Set<string>>()
  for (const rec of records) {
    for (const [k, v] of Object.entries(rec)) {
      if (k === 'attributes' || !isPlainObject(v)) continue
      const fi = fieldByRel.get(k)
      const ext = v[EXTERNAL_ID_FIELD]
      const refObj = fi?.referenceTo[0]
      if (!fi || ext == null || refObj == null) continue
      let set = wantedByObject.get(refObj)
      if (!set) wantedByObject.set(refObj, (set = new Set()))
      set.add(decodeExternalId(String(ext)))
    }
  }
  const mapsByObject = new Map<string, ReadonlyMap<string, string>>()
  for (const [refObj, ids] of wantedByObject) mapsByObject.set(refObj, await idMap.lookup(refObj, [...ids]))
  const prepared = records.map((rec) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rec)) {
      if (k !== 'attributes' && isPlainObject(v) && fieldByRel.has(k)) {
        const fi = fieldByRel.get(k)!
        const ext = v[EXTERNAL_ID_FIELD]
        const tid = ext == null ? undefined : mapsByObject.get(fi.referenceTo[0]!)?.get(decodeExternalId(String(ext)))
        if (tid != null) out[fi.apiName] = tid // unmapped → the reference is left off (parent-strip semantics)
        continue
      }
      out[k] = v
    }
    return out
  })

  const keyOf = (rec: Record<string, unknown>): string => String(rec[EXTERNAL_ID_FIELD])
  const sourceIds = prepared.map((rec) => decodeExternalId(keyOf(rec)))
  const mine = await idMap.lookup(objectName, sourceIds)

  if (o.updateOnly) {
    // 3. Second pass — PATCH by the mapped Id.
    const result = emptyCollectionsResult()
    const toSend: Array<Record<string, unknown>> = []
    for (const rec of prepared) {
      const tid = mine.get(decodeExternalId(keyOf(rec)))
      if (tid == null) {
        const ext = keyOf(rec)
        result.failureCount++
        result.failedExternalIds.push(ext)
        result.errorDetails.push(`${ext} → NOT_MAPPED: this source record has no target id in the id map; `)
        result.typedErrors.push({ extId: ext, statusCode: 'NOT_MAPPED', message: 'this source record has no target id in the id map', fields: [] })
        continue
      }
      toSend.push({ ...rec, Id: tid })
    }
    // S62-3: drop the rows that would not change anything.
    const unchanged = o.readCurrent ? await partitionUnchanged(o.readCurrent, objectName, toSend) : []
    if (unchanged.length > 0) {
      const drop = new Set(unchanged)
      const kept = toSend.filter((r) => !drop.has(r))
      toSend.length = 0
      toSend.push(...kept)
      result.successCount += unchanged.length
      ;(result.successIds ??= []).push(...unchanged.map((r) => ({ extId: keyOf(r), id: String(r['Id']) })))
      result.unchangedExtIds = unchanged.map((r) => keyOf(r))
    }
    if (toSend.length > 0) {
      const res = await updateByVirtualKey(transport, objectName, toSend, { batchSize: o.batchSize })
      result.successCount += res.successCount
      result.failureCount += res.failureCount
      result.errorDetails.push(...res.errorDetails)
      result.failedExternalIds.push(...res.failedExternalIds)
      result.typedErrors.push(...res.typedErrors)
      if (res.successIds?.length) (result.successIds ??= []).push(...res.successIds)
    }
    return result
  }

  // 2. First pass — skip what the map already has (and the target still holds), INSERT the rest.
  const alive = mine.size > 0 ? await idMap.existingTargetIds(objectName, [...new Set(mine.values())]) : new Set<string>()
  const toInsert: Array<Record<string, unknown>> = []
  const already: Array<{ extId: string; id: string }> = []
  for (const rec of prepared) {
    const tid = mine.get(decodeExternalId(keyOf(rec)))
    if (tid != null && alive.has(tid)) already.push({ extId: keyOf(rec), id: tid })
    else toInsert.push(rec)
  }
  const result = toInsert.length > 0 ? await insertByVirtualKey(transport, objectName, toInsert, { batchSize: o.batchSize }) : emptyCollectionsResult()
  if (result.successIds && result.successIds.length > 0) {
    await idMap.record(
      objectName,
      result.successIds.map((s) => ({ sourceId: decodeExternalId(s.extId), targetId: s.id }))
    )
  }
  if (already.length > 0) {
    result.successCount += already.length
    ;(result.successIds ??= []).push(...already)
    // S62: say WHICH successes were not writes, so the record rows carry the ALREADY_ON_TARGET tag.
    result.alreadyOnTargetExtIds = already.map((a) => a.extId)
  }
  return result
}

/**
 * S62-3: the subset of `patches` (each carrying `Id` plus the fields to write) whose every field
 * already holds the same value on the target. Values compare as strings after null/undefined → ''
 * (the API returns ids and picklists as strings; a lookup set to the same id is the whole point).
 * A read failure returns [] — every row is then sent, the pre-S62 behaviour; a compare must never
 * block a write it cannot judge.
 */
export async function partitionUnchanged(
  readCurrent: NonNullable<Parameters<typeof keylessWrite>[5]['readCurrent']>,
  objectName: string,
  patches: ReadonlyArray<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
  if (patches.length === 0) return []
  const fieldSet = new Set<string>()
  for (const p of patches) for (const k of Object.keys(p)) if (k !== 'Id' && k !== 'attributes' && k !== EXTERNAL_ID_FIELD) fieldSet.add(k)
  if (fieldSet.size === 0) return []
  const fieldList = [...fieldSet]
  let current: ReadonlyMap<string, Record<string, unknown>>
  try {
    current = await readCurrent(objectName, patches.map((p) => String(p['Id'])), fieldList)
  } catch {
    return []
  }
  const norm = (v: unknown): string => (v == null ? '' : String(v))
  const out: Array<Record<string, unknown>> = []
  for (const p of patches) {
    const row = current.get(String(p['Id']))
    if (!row) continue
    let same = true
    for (const f of fieldList) {
      if (!(f in p)) continue
      if (norm(p[f]) !== norm(row[f])) {
        same = false
        break
      }
    }
    if (same) out.push(p)
  }
  return out
}

export function makeDeployIo(opts: DeployIoOptions): DeployIo {
  const { source, target, store, emit, idMap } = opts
  const transport = makeCollectionsTransport(target)
  // Keyless needs relationshipName → field for the nested references it flattens; one describe per object.
  const targetDescribes = new Map<string, Promise<DescribeField[]>>()
  const describeTargetOnce = (objectName: string): Promise<DescribeField[]> => {
    let p = targetDescribes.get(objectName)
    if (!p) {
      p = describeDeployFields(target, objectName)
      targetDescribes.set(objectName, p)
    }
    return p
  }
  // The connected target user. The Apex oracle (DataSeederController.
  // getOrgUserId, L869-886) is fail-SILENT — ANY failure returns null and the
  // deploy proceeds (setToMe drops via blank-drop; inactive-owner substitution
  // disarms) — and it re-resolved every object hop. So: resolve null on
  // failure AND clear the memo, letting the next object (or bounded retry)
  // try again — never pin one transient rejection for the run's lifetime
  // (E4E.2 review finding: a cached rejected promise structurally defeated
  // MAX_OBJECT_RETRIES and failed every User-ref object in the run).
  let targetUserId: Promise<string | null> | null = null
  return {
    describeSource: (objectName) => describeDeployFields(source, objectName),
    describeTarget: (objectName) => describeDeployFields(target, objectName),
    querySourcePages: (soql) => queryPageWalk(source, soql),
    getTargetUserId: () => {
      targetUserId ??= target.conn.identity().then(
        (id) => (id.user_id != null ? String(id.user_id) : null),
        () => {
          targetUserId = null
          return null
        }
      )
      return targetUserId
    },
    querySource: (soql) => queryPages(source, soql),
    queryTarget: (soql) => queryPages(target, soql),
    // S49 (BUG-9): read-only GET against TARGET (UI-API picklist endpoint).
    // No assertWritable — this is a GET, and the source org is never touched.
    restGetTarget: (path) => target.conn.request(path) as Promise<unknown>,
    upsertBatch: (objectName, records, o) =>
      idMap
        ? keylessWrite(transport, idMap, describeTargetOnce, objectName, records, {
            ...o,
            readCurrent: (obj, ids, flds) => readCurrentValues(target, obj, ids, flds)
          })
        : upsertByExtId(transport, objectName, records, {
            updateOnly: o.updateOnly,
            batchSize: o.batchSize
          }),
    // Junction raw seam (E4E.5): one composite POST, dup-rule bypass header via
    // the transport; the engine owns batching/rendering/tripwire (Apex parity).
    insertCompositeBatch: (_objectName, records) => insertBatchRaw(transport, records),
    store,
    emit,
    now: opts.now ?? ((): Date => new Date()),
    sleep: opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))),
    ...(idMap ? { idMap } : {})
  }
}
