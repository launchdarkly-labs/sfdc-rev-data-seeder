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
  insertBatchRaw,
  upsertByExtId,
  type CollectionsHttpResult,
  type CollectionsTransport,
  type CompositeMethod
} from './transport/collections'
import type { DeployStore } from './deployStore'
import type { DeployEvent, DeployIo, QueryPage } from '../engine/deploy/types'
import type { DescribeField } from '../engine/deploy/transform/fieldFilter'

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
  /** Injected for tests; real defaults otherwise. */
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

export function makeDeployIo(opts: DeployIoOptions): DeployIo {
  const { source, target, store, emit } = opts
  const transport = makeCollectionsTransport(target)
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
      upsertByExtId(transport, objectName, records, {
        updateOnly: o.updateOnly,
        batchSize: o.batchSize
      }),
    // Junction raw seam (E4E.5): one composite POST, dup-rule bypass header via
    // the transport; the engine owns batching/rendering/tripwire (Apex parity).
    insertCompositeBatch: (_objectName, records) => insertBatchRaw(transport, records),
    store,
    emit,
    now: opts.now ?? ((): Date => new Date()),
    sleep: opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))
  }
}
