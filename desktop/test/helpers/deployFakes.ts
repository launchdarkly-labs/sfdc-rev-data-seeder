/**
 * Shared scripted-DeployIo kit for the E4E.3+ engine tests (retry drain,
 * classify wiring, e2e). firstPass.test.ts keeps its own local kit (predates
 * this file); new engine suites build on this one — the FakeRunStore here
 * additionally implements a REAL in-memory retry queue and the current-truth
 * failure derivation the classifier reads.
 */
import type { DeployPlan, FrozenObjectPlan } from '../../src/main/engine/deploy/planFreeze'
import type {
  DeployEvent,
  DeployIo,
  DeployRunStore,
  FailedRecordInput,
  ObjectPassContext,
  OrphanedLinkGroup,
  QueryPage,
  RawInsertBatchResult,
  RecordResultInput,
  UpsertBatchResult
} from '../../src/main/engine/deploy/types'
import type { DescribeField } from '../../src/main/engine/deploy/transform/fieldFilter'

export function fld(apiName: string, over: Partial<DescribeField> = {}): DescribeField {
  return {
    apiName,
    dataType: 'string',
    isCreateable: true,
    isNillable: true,
    isReference: false,
    referenceTo: [],
    relationshipName: null,
    isAutoNumber: false,
    isCalculated: false,
    isExternalId: false,
    isRestrictedPicklist: false,
    picklistValues: null,
    ...over
  }
}

export function frozenObject(
  objectName: string,
  fields: string[],
  over: Partial<FrozenObjectPlan> = {}
): FrozenObjectPlan {
  return {
    objectName,
    sortOrder: 1,
    hasCircularReference: false,
    deferredFields: [],
    scope: { kind: 'all' },
    scopedFilterDisplay: null,
    recordCount: 0,
    apiStrategy: 'REST',
    gatingTier: null,
    requiresTriggerBypass: false,
    requiresAutomationDisable: false,
    restPageSize: null,
    recommendedBatchSize: 200,
    isJunction: false,
    junctionParents: null,
    junctionParentFields: null,
    fields,
    droppedFields: [],
    mappings: {},
    ...over
  }
}

export function planOf(...objects: FrozenObjectPlan[]): DeployPlan {
  return { objects, warnings: [], totalObjects: objects.length, totalRecords: 0 }
}

export const okResult = (n: number): UpsertBatchResult => ({
  successCount: n,
  failureCount: 0,
  errorDetails: [],
  failedExternalIds: [],
  typedErrors: []
})

/**
 * Pure-lane DeployRunStore: records rows, keeps a REAL insertion-ordered retry
 * queue, and derives `currentFailures` with the Persistent-mirror rule (failed
 * rows at the latest (attempt, retryPass) per object — the same overwrite
 * semantics as deployStore.currentFailures; the store-lane suite pins the SQL).
 */
export class FakeRunStore implements DeployRunStore {
  results: RecordResultInput[] = []
  failures: FailedRecordInput[] = []
  cancelled = false
  private queue: { objectApiName: string; sourceId: string; attempt: number }[] = []

  recordResults(_runId: number, rows: RecordResultInput[]): void {
    this.results.push(...rows)
  }
  recordFailures(_runId: number, rows: FailedRecordInput[]): void {
    this.failures.push(...rows)
  }
  isCancelRequested(): boolean {
    return this.cancelled
  }
  /** The Persistent mirror: failed_records at the latest (attempt, retryPass)
   *  per object — matches deployStore.currentFailures' overwrite rule
   *  (DDQ L1997-2003; healed/skipped/deleted records drop out). */
  currentFailures(): { objectApiName: string; sourceId: string }[] {
    const byObj = new Map<string, FailedRecordInput[]>()
    for (const f of this.failures) {
      if (f.pass !== 1) continue
      const arr = byObj.get(f.objectApiName) ?? []
      arr.push(f)
      byObj.set(f.objectApiName, arr)
    }
    const out: { objectApiName: string; sourceId: string }[] = []
    for (const [objectApiName, rows] of byObj) {
      const maxAttempt = Math.max(...rows.map((r) => r.objectAttempt))
      const atAttempt = rows.filter((r) => r.objectAttempt === maxAttempt)
      const maxPass = Math.max(...atAttempt.map((r) => r.retryPass))
      for (const r of atAttempt) {
        if (r.retryPass === maxPass) out.push({ objectApiName, sourceId: r.sourceId })
      }
    }
    return out
  }
  /** Mirrors deployStore.queriedSourceIds: distinct retry_pass-0 source ids at
   *  the latest attempt, insertion order (the store-lane suite pins the SQL). */
  queriedSourceIds(_runId: number, objectApiName: string): string[] {
    const mine = this.results.filter((r) => r.objectApiName === objectApiName && r.pass === 1)
    if (mine.length === 0) return []
    const maxAttempt = Math.max(...mine.map((r) => r.objectAttempt))
    const out: string[] = []
    const seen = new Set<string>()
    for (const r of mine) {
      if (r.objectAttempt !== maxAttempt || r.retryPass !== 0) continue
      if (seen.has(r.sourceId)) continue
      seen.add(r.sourceId)
      out.push(r.sourceId)
    }
    return out
  }
  /** S50 (A5): observability ledger — unused by these fakes. */
  recordStrippedRefs(): void {}
  orphanedLinkSummary(): OrphanedLinkGroup[] {
    return []
  }

  /** S49 (BUG-1 pt3): mirrors deployStore.skipReasonCounts — group skipped
   *  rows by the leading token of their reason. */
  skipReasonCounts(_runId: number): Array<{ reason: string; count: number }> {
    const byReason = new Map<string, number>()
    for (const r of this.results) {
      if (r.outcome !== 'skipped') continue
      const msg = r.errorMessage
      if (msg == null) continue
      const space = msg.indexOf(' ')
      const reason = space > 0 ? msg.substring(0, space) : msg
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
    }
    return [...byReason].map(([reason, count]) => ({ reason, count }))
  }

  /** Mirrors deployStore.deployedSourceIds: latest row per record at the latest
   *  attempt, outcome success, in winning-row insertion order. */
  deployedSourceIds(_runId: number, objectApiName: string): string[] {
    const mine = this.results.filter((r) => r.objectApiName === objectApiName && r.pass === 1)
    if (mine.length === 0) return []
    const maxAttempt = Math.max(...mine.map((r) => r.objectAttempt))
    const atAttempt = mine.filter((r) => r.objectAttempt === maxAttempt)
    const lastIdxBySource = new Map<string, number>()
    for (let i = 0; i < atAttempt.length; i++) lastIdxBySource.set(atAttempt[i]!.sourceId, i)
    return [...lastIdxBySource.entries()]
      .filter(([, idx]) => atAttempt[idx]!.outcome === 'success')
      .sort((a, b) => a[1] - b[1])
      .map(([sid]) => sid)
  }
  enqueueRetries(_runId: number, objectApiName: string, sourceIds: string[], attempt: number): void {
    for (const sourceId of sourceIds) {
      const existing = this.queue.find(
        (q) => q.objectApiName === objectApiName && q.sourceId === sourceId
      )
      if (existing != null) existing.attempt = attempt
      else this.queue.push({ objectApiName, sourceId, attempt })
    }
  }
  dequeueRetryChunk(_runId: number, objectApiName: string, limit: number): string[] {
    const mine = this.queue.filter((q) => q.objectApiName === objectApiName).slice(0, limit)
    const taken = new Set(mine.map((q) => q.sourceId))
    this.queue = this.queue.filter(
      (q) => q.objectApiName !== objectApiName || !taken.has(q.sourceId)
    )
    return mine.map((q) => q.sourceId)
  }
  retryQueueDepth(_runId: number, objectApiName?: string): number {
    return objectApiName == null
      ? this.queue.length
      : this.queue.filter((q) => q.objectApiName === objectApiName).length
  }
  clearRetryQueue(_runId: number, objectApiName: string): void {
    this.queue = this.queue.filter((q) => q.objectApiName !== objectApiName)
  }
  // — unused by the pass executors —
  getRun(): never {
    throw new Error('unused')
  }
  getPlanById(): never {
    throw new Error('unused')
  }
  setRunPhase(): void {}
  setResumePoint(): void {}
  setTeardownOutcome(): void {}
  markFinalizeDone(): void {}
  listFailures(): never {
    throw new Error('unused')
  }
  objectCounters(): never {
    throw new Error('unused')
  }
  runCounters(): never {
    throw new Error('unused')
  }
  maxObjectAttempt(): number {
    return -1
  }
  maxRetryPass(): number {
    return 0
  }
  failureCountAt(): number {
    return 0
  }
}

export interface HarnessOpts {
  sourceDescribe: DescribeField[]
  targetDescribe?: DescribeField[]
  /** Pages returned for every source query (unless onQuerySourcePages routes). */
  pages?: QueryPage[]
  /** Per-soql page routing (retry chunk queries etc.). */
  onQuerySourcePages?: (soql: string, call: number) => QueryPage[]
  onQueryTarget?: (soql: string) => Array<Record<string, unknown>> | undefined
  onQuerySource?: (soql: string) => Array<Record<string, unknown>> | undefined
  /** Scripted upsert result; default = all succeed. */
  onUpsert?: (
    records: Array<Record<string, unknown>>,
    call: number
  ) => UpsertBatchResult | Promise<UpsertBatchResult>
  /** Scripted raw composite insert (junction path); default = all succeed. */
  onInsert?: (
    records: Array<Record<string, unknown>>,
    call: number
  ) => RawInsertBatchResult | Promise<RawInsertBatchResult>
  targetUserId?: string | null
}

/** All-success raw insert result for n records (synthetic target ids). */
export const okInsert = (n: number): RawInsertBatchResult => ({
  ok: true,
  results: Array.from({ length: n }, (_, i) => ({
    success: true,
    id: `006INSERTED${String(i).padStart(6, '0')}`,
    errors: []
  }))
})

export interface Harness {
  io: DeployIo
  store: FakeRunStore
  events: DeployEvent[]
  logs: { level: string; message: string; detail?: string }[]
  upsertCalls: Array<{
    objectName: string
    records: Array<Record<string, unknown>>
    batchSize: number | null
  }>
  insertCalls: Array<{ objectName: string; records: Array<Record<string, unknown>> }>
  sourceSoqls: string[]
  targetSoqls: string[]
}

export function harness(opts: HarnessOpts): Harness {
  const store = new FakeRunStore()
  const events: DeployEvent[] = []
  const logs: Harness['logs'] = []
  const upsertCalls: Harness['upsertCalls'] = []
  const insertCalls: Harness['insertCalls'] = []
  const sourceSoqls: string[] = []
  const targetSoqls: string[] = []

  async function* arr(rows: Array<Record<string, unknown>>): AsyncGenerator<Record<string, unknown>> {
    for (const r of rows) yield r
  }

  const io: DeployIo = {
    describeSource: () => Promise.resolve(opts.sourceDescribe),
    describeTarget: () => Promise.resolve(opts.targetDescribe ?? opts.sourceDescribe),
    querySourcePages: (soql) => {
      const call = sourceSoqls.length
      sourceSoqls.push(soql)
      const pages = opts.onQuerySourcePages?.(soql, call) ?? opts.pages ?? []
      return (async function* (): AsyncGenerator<QueryPage> {
        for (const page of pages) yield page
      })()
    },
    getTargetUserId: () => Promise.resolve(opts.targetUserId ?? null),
    querySource: (soql) => arr(opts.onQuerySource?.(soql) ?? []),
    queryTarget: (soql) => {
      targetSoqls.push(soql)
      return arr(opts.onQueryTarget?.(soql) ?? [])
    },
    // S49 (BUG-9): unused by these fakes; rejecting keeps the record-type
    // picklist prefetch on its fail-open path.
    restGetTarget: (): Promise<unknown> => Promise.reject(new Error('not used')),
    upsertBatch: async (objectName, records, o) => {
      upsertCalls.push({ objectName, records, batchSize: o.batchSize })
      const res = opts.onUpsert?.(records, upsertCalls.length - 1)
      return res != null ? res : okResult(records.length)
    },
    insertCompositeBatch: async (objectName, records) => {
      insertCalls.push({ objectName, records })
      const res = opts.onInsert?.(records, insertCalls.length - 1)
      return res != null ? res : okInsert(records.length)
    },
    store,
    emit: (e) => {
      events.push(e)
      if (e.kind === 'log') {
        logs.push({
          level: String(e.data.level),
          message: String(e.data.message),
          ...(e.data.detail != null ? { detail: String(e.data.detail) } : {})
        })
      }
    },
    now: () => new Date(0),
    sleep: () => Promise.resolve()
  }
  return { io, store, events, logs, upsertCalls, insertCalls, sourceSoqls, targetSoqls }
}

export function passCtx(
  io: DeployIo,
  objectName: string,
  over: Partial<ObjectPassContext> = {}
): ObjectPassContext {
  return {
    runId: 1,
    object: {
      objectName,
      sortOrder: 1,
      hasCircularReference: false,
      isJunction: false,
      recordCount: 0
    },
    passKind: 'first',
    objectAttempt: 0,
    retryPass: 0,
    io,
    ...over
  }
}
