/**
 * E4E.2 — first-pass batch loop (REST) against a fully scripted DeployIo.
 *
 * Asserts the port's parity surface (DDQ L1318-2056):
 *  - the Apex batch == the query page; batch numbering starts at 0
 *  - byte-exact log lines: strategy / picklist drop / skip / parent drop /
 *    contract idempotency / batch result / no-records
 *  - one record_results row per source record at the ObjectPassContext
 *    coordinates; failures also land in failed_records (classification null)
 *  - Contract already-Activated partition counted as deployed (DDQ L1937-1940)
 *  - tripwire propagates before the next page; cancel stops between batches
 *  - PA filter from the FULL source describe; nameMatch/prefetch wiring
 */
import { describe, expect, it } from 'vitest'
import { makeFirstPass, runFirstPass } from '../src/main/engine/deploy/firstPass'
import type { DeployPlan, FrozenObjectPlan } from '../src/main/engine/deploy/planFreeze'
import type {
  DeployEvent,
  DeployIo,
  DeployRunStore,
  FailedRecordInput,
  ObjectPassContext,
  OrphanedLinkGroup,
  StrippedRefInput,
  QueryPage,
  RecordResultInput,
  UpsertBatchResult
} from '../src/main/engine/deploy/types'
import type { DescribeField } from '../src/main/engine/deploy/transform/fieldFilter'
import { EXTERNAL_ID_FIELD, generateExternalId } from '../src/main/engine/deploy/transform/sfid'
import { CpqTriggersActiveError } from '../src/main/services/transport/collections'

// ─────────────────────────────── fixture kit ────────────────────────────────

function fld(apiName: string, over: Partial<DescribeField> = {}): DescribeField {
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

function frozenObject(
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

function planOf(...objects: FrozenObjectPlan[]): DeployPlan {
  return { objects, warnings: [], totalObjects: objects.length, totalRecords: 0 }
}

const ok = (n: number): UpsertBatchResult => ({
  successCount: n,
  failureCount: 0,
  errorDetails: [],
  failedExternalIds: [],
  typedErrors: []
})

/** Minimal DeployRunStore — firstPass touches only 3 members. */
class FakeRunStore implements DeployRunStore {
  results: RecordResultInput[] = []
  failures: FailedRecordInput[] = []
  cancelled = false
  recordResults(_runId: number, rows: RecordResultInput[]): void {
    this.results.push(...rows)
  }
  recordFailures(_runId: number, rows: FailedRecordInput[]): void {
    this.failures.push(...rows)
  }
  isCancelRequested(): boolean {
    return this.cancelled
  }
  /** The Persistent mirror (see deployFakes.ts): failed rows at the latest
   *  (attempt, retryPass) per object. */
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
  // — unused by firstPass —
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
  enqueueRetries(): void {}
  dequeueRetryChunk(): never {
    throw new Error('unused')
  }
  retryQueueDepth(): number {
    return 0
  }
  clearRetryQueue(): void {}
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
  queriedSourceIds(): string[] {
    return []
  }
  deployedSourceIds(): string[] {
    return []
  }
  skipReasonCounts(): Array<{ reason: string; count: number }> {
    return []
  }
  /** S50 (A5): observability ledger — captured so tests can assert on it. */
  strippedRefs: StrippedRefInput[] = []
  recordStrippedRefs(_runId: number, rows: StrippedRefInput[]): void {
    this.strippedRefs.push(...rows)
  }
  orphanedLinkSummary(): OrphanedLinkGroup[] {
    return []
  }
}

interface HarnessOpts {
  sourceDescribe: DescribeField[]
  targetDescribe?: DescribeField[]
  pages: QueryPage[]
  /** Router for target-side helper queries (nameMatch/prefetch/strip/contracts). */
  onQueryTarget?: (soql: string) => Array<Record<string, unknown>> | undefined
  /** Router for source-side nameMatch queries. */
  onQuerySource?: (soql: string) => Array<Record<string, unknown>> | undefined
  /** Scripted upsert result; default = all succeed. */
  onUpsert?: (
    records: Array<Record<string, unknown>>,
    call: number
  ) => UpsertBatchResult | Promise<UpsertBatchResult>
  targetUserId?: string | null
}

interface Harness {
  io: DeployIo
  store: FakeRunStore
  events: DeployEvent[]
  logs: { level: string; message: string; detail?: string }[]
  upsertCalls: Array<{
    objectName: string
    records: Array<Record<string, unknown>>
    batchSize: number | null
  }>
  sourceSoqls: string[]
  pagesPulled: () => number
}

function harness(opts: HarnessOpts): Harness {
  const store = new FakeRunStore()
  const events: DeployEvent[] = []
  const logs: { level: string; message: string; detail?: string }[] = []
  const upsertCalls: Harness['upsertCalls'] = []
  const sourceSoqls: string[] = []
  let pulled = 0

  async function* arr(
    rows: Array<Record<string, unknown>>
  ): AsyncGenerator<Record<string, unknown>> {
    for (const r of rows) yield r
  }

  const io: DeployIo = {
    describeSource: () => Promise.resolve(opts.sourceDescribe),
    describeTarget: () => Promise.resolve(opts.targetDescribe ?? opts.sourceDescribe),
    querySourcePages: (soql) => {
      sourceSoqls.push(soql)
      return (async function* (): AsyncGenerator<QueryPage> {
        for (const page of opts.pages) {
          pulled++
          yield page
        }
      })()
    },
    getTargetUserId: () => Promise.resolve(opts.targetUserId ?? null),
    querySource: (soql) => arr(opts.onQuerySource?.(soql) ?? []),
    queryTarget: (soql) => arr(opts.onQueryTarget?.(soql) ?? []),
    // S49 (BUG-9): unused by these fakes; rejecting keeps the record-type
    // picklist prefetch on its fail-open path.
    restGetTarget: (): Promise<unknown> => Promise.reject(new Error('not used')),
    upsertBatch: async (objectName, records, o) => {
      upsertCalls.push({ objectName, records, batchSize: o.batchSize })
      const res = opts.onUpsert?.(records, upsertCalls.length - 1)
      return res != null ? res : ok(records.length)
    },
    insertCompositeBatch: () =>
      Promise.reject(new Error('junction raw seam (E4E.5) — not used here')),
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
  return { io, store, events, logs, upsertCalls, sourceSoqls, pagesPulled: () => pulled }
}

function passCtx(
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

// Realistic 18-char source ids (generateExternalId round-trips these).
const A1 = '001000000000001AAA'
const A2 = '001000000000002AAA'

// ─────────────────────────────────── tests ──────────────────────────────────

describe('firstPass — happy path', () => {
  it('deploys one page: rows at ctx coordinates + exact strategy/batch log lines', async () => {
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [
        {
          records: [
            { Id: A1, Name: 'Acme' },
            { Id: A2, Name: 'Globex' }
          ],
          totalSize: 2
        }
      ]
    })
    const plan = planOf(frozenObject('Account', ['Name']))
    await runFirstPass(plan, passCtx(h.io, 'Account'))

    // one upsert with both payloads (attributes stamped, ExtId computed)
    expect(h.upsertCalls).toHaveLength(1)
    expect(h.upsertCalls[0]!.objectName).toBe('Account')
    expect(h.upsertCalls[0]!.batchSize).toBe(200)
    expect(h.upsertCalls[0]!.records).toHaveLength(2)
    expect(h.upsertCalls[0]!.records[0]![EXTERNAL_ID_FIELD]).toBe(generateExternalId(A1))
    expect(h.upsertCalls[0]!.records[0]!['attributes']).toEqual({ type: 'Account' })

    // rows: exactly one per source record, success, at (1, 0, 0)
    expect(h.store.results).toEqual([
      {
        objectApiName: 'Account',
        sourceId: A1,
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'success'
      },
      {
        objectApiName: 'Account',
        sourceId: A2,
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'success'
      }
    ])
    expect(h.store.failures).toEqual([])

    // exact Apex log lines
    expect(h.logs).toEqual([
      { level: 'Info', message: 'Account v2 strategy: REST (2 records)' },
      { level: 'Info', message: 'REST upsert batch 0: 2 succeeded, 0 failed for Account' }
    ])
    // the SELECT is buildSourceQueryV2's (Id first, then createable fields)
    expect(h.sourceSoqls).toEqual(['SELECT Id, Name FROM Account'])
  })

  it('makeFirstPass closes over the plan (PassExecutors seam)', async () => {
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [{ records: [{ Id: A1, Name: 'x' }], totalSize: 1 }]
    })
    const firstPass = makeFirstPass(planOf(frozenObject('Account', ['Name'])))
    await firstPass(passCtx(h.io, 'Account'))
    expect(h.store.results).toHaveLength(1)
  })

  it('writes rows at NON-ZERO ctx coordinates verbatim (bounded-rerun attempt)', async () => {
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [{ records: [{ Id: A1, Name: 'x' }], totalSize: 1 }]
    })
    const plan = planOf(frozenObject('Account', ['Name']))
    await runFirstPass(plan, passCtx(h.io, 'Account', { objectAttempt: 2 }))
    expect(h.store.results[0]).toMatchObject({ objectAttempt: 2, retryPass: 0, pass: 1 })
  })

  it('multi-page: batch numbers 0/1, strategy line per hop, rows appended', async () => {
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [
        { records: [{ Id: A1, Name: 'a' }], totalSize: 2 },
        { records: [{ Id: A2, Name: 'b' }], totalSize: 2 }
      ]
    })
    await runFirstPass(planOf(frozenObject('Account', ['Name'])), passCtx(h.io, 'Account'))
    expect(h.upsertCalls).toHaveLength(2)
    expect(h.store.results).toHaveLength(2)
    expect(h.logs.map((l) => l.message)).toEqual([
      'Account v2 strategy: REST (2 records)',
      'REST upsert batch 0: 1 succeeded, 0 failed for Account',
      'Account v2 strategy: REST (2 records)',
      'REST upsert batch 1: 1 succeeded, 0 failed for Account'
    ])
  })

  it('strategy line renders the frozen A5 dropped-field count + detail', async () => {
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [{ records: [{ Id: A1, Name: 'x' }], totalSize: 1 }]
    })
    const plan = planOf(
      frozenObject('Account', ['Name'], {
        droppedFields: ['Foo__c (not on target)', 'Bar__c (read-only on target: formula/rollup)']
      })
    )
    await runFirstPass(plan, passCtx(h.io, 'Account'))
    expect(h.logs[0]).toEqual({
      level: 'Info',
      message: 'Account v2 strategy: REST (1 records, 2 fields dropped (not writable on target))',
      detail: 'Foo__c (not on target)\nBar__c (read-only on target: formula/rollup)'
    })
  })
})

describe('firstPass — no records / guards', () => {
  it('empty first page: Apex skip line, no rows, no upsert', async () => {
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [{ records: [], totalSize: 0 }]
    })
    await runFirstPass(planOf(frozenObject('Account', ['Name'])), passCtx(h.io, 'Account'))
    expect(h.logs).toEqual([{ level: 'Info', message: 'Skipped Account — no records on source' }])
    expect(h.upsertCalls).toHaveLength(0)
    expect(h.store.results).toHaveLength(0)
  })

  it('a binding that yields no page at all still logs the skip line', async () => {
    const h = harness({ sourceDescribe: [fld('Name')], pages: [] })
    await runFirstPass(planOf(frozenObject('Account', ['Name'])), passCtx(h.io, 'Account'))
    expect(h.logs).toEqual([{ level: 'Info', message: 'Skipped Account — no records on source' }])
  })

  it('junction objects are refused (routed to junctionPass)', async () => {
    const h = harness({ sourceDescribe: [], pages: [] })
    const plan = planOf(frozenObject('OpportunityContactRole', [], { isJunction: true }))
    await expect(runFirstPass(plan, passCtx(h.io, 'OpportunityContactRole'))).rejects.toThrow(
      /junction object/
    )
  })

  it('an object missing from the frozen plan is refused', async () => {
    const h = harness({ sourceDescribe: [], pages: [] })
    await expect(
      runFirstPass(planOf(frozenObject('Account', [])), passCtx(h.io, 'Contact'))
    ).rejects.toThrow('No frozen plan object for Contact')
  })

  it('a frozen field missing from the live source describe fails LOUD (stale plan)', async () => {
    const h = harness({ sourceDescribe: [fld('Name')], pages: [] })
    const plan = planOf(frozenObject('Account', ['Name', 'Ghost__c']))
    await expect(runFirstPass(plan, passCtx(h.io, 'Account'))).rejects.toThrow(
      'Frozen plan for Account references field(s) missing from the live source describe: Ghost__c — re-freeze the plan'
    )
  })

  it('a non-REST plan strategy warns and still runs REST (E4T.3 pending)', async () => {
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [{ records: [{ Id: A1, Name: 'x' }], totalSize: 1 }]
    })
    const plan = planOf(frozenObject('Account', ['Name'], { apiStrategy: 'Bulk' }))
    await runFirstPass(plan, passCtx(h.io, 'Account'))
    expect(h.logs[0]).toEqual({
      level: 'Warning',
      message:
        "Account plan strategy 'Bulk' is not implemented in the desktop engine yet — using REST (E4T.3)"
    })
    expect(h.upsertCalls).toHaveLength(1)
  })
})

describe('firstPass — failures', () => {
  it('failed extIds → failed rows + failed_records (classified root), Warning batch line with detail', async () => {
    const failExt = generateExternalId(A2)
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [
        {
          records: [
            { Id: A1, Name: 'ok' },
            { Id: A2, Name: 'bad' }
          ],
          totalSize: 2
        }
      ],
      onUpsert: () => ({
        successCount: 1,
        failureCount: 1,
        errorDetails: [
          `${failExt} → REQUIRED_FIELD_MISSING: Required fields are missing: [Name] fields=["Name"]; `
        ],
        failedExternalIds: [failExt],
        typedErrors: [
          {
            extId: failExt,
            statusCode: 'REQUIRED_FIELD_MISSING',
            message: 'Required fields are missing: [Name]',
            fields: ['Name']
          }
        ]
      })
    })
    await runFirstPass(planOf(frozenObject('Account', ['Name'])), passCtx(h.io, 'Account'))

    expect(h.store.results).toEqual([
      {
        objectApiName: 'Account',
        sourceId: A1,
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'success'
      },
      {
        objectApiName: 'Account',
        sourceId: A2,
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'failed',
        errorCode: 'REQUIRED_FIELD_MISSING',
        errorMessage: 'REQUIRED_FIELD_MISSING: Required fields are missing: [Name]'
      }
    ])
    expect(h.store.failures).toEqual([
      {
        objectApiName: 'Account',
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        sourceId: A2,
        extId: failExt,
        errorCode: 'REQUIRED_FIELD_MISSING',
        errorMessage: 'REQUIRED_FIELD_MISSING: Required fields are missing: [Name]',
        fieldsJson: '["Name"]',
        classification: 'root' // no FK-to-failed-parent pattern → root (E4E.3)
      }
    ])
    const batchLine = h.logs.at(-1)!
    expect(batchLine.level).toBe('Warning')
    expect(batchLine.message).toBe('REST upsert batch 0: 1 succeeded, 1 failed for Account')
    expect(batchLine.detail).toBe(
      `${failExt} → REQUIRED_FIELD_MISSING: Required fields are missing: [Name] fields=["Name"]; `
    )
  })

  // ── S49 BUG-10, end to end ────────────────────────────────────────────
  // Not just the classifier helper: this proves firstPass actually threads the
  // stripped-ref map from stripMissingParentRefs into the classification loop.
  // (BUG-7 in S49 was a fix that looked correct in isolation and never took,
  // because a hardcoded value upstream starved it — hence the e2e pin.)
  it('REQUIRED_FIELD_MISSING from a stripped parent that FAILED is classified cascade', async () => {
    const OPP = '006TR00000XIwc0YAD' // the run-6 root failure
    const OLI = '00kTR00000AAAAAAAA'
    const failExt = generateExternalId(OLI)
    const h = harness({
      sourceDescribe: [
        fld('OpportunityId', {
          isReference: true,
          isNillable: false,
          referenceTo: ['Opportunity'],
          relationshipName: 'Opportunity'
        })
      ],
      // The parent Opportunity is NOT on target → strip removes the ref.
      onQueryTarget: () => [],
      pages: [{ records: [{ Id: OLI, OpportunityId: OPP }], totalSize: 1 }],
      onUpsert: () => ({
        successCount: 0,
        failureCount: 1,
        errorDetails: [
          `${failExt} → REQUIRED_FIELD_MISSING: Required fields are missing: [OpportunityId] fields=["OpportunityId"]; `
        ],
        failedExternalIds: [failExt],
        typedErrors: [
          {
            extId: failExt,
            statusCode: 'REQUIRED_FIELD_MISSING',
            message: 'Required fields are missing: [OpportunityId]',
            fields: ['OpportunityId']
          }
        ]
      })
    })
    // The parent failed earlier in this same run.
    h.store.recordFailures(1, [
      {
        objectApiName: 'Opportunity',
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        sourceId: OPP,
        classification: 'root'
      }
    ])

    await runFirstPass(
      planOf(
        frozenObject('OpportunityLineItem', ['OpportunityId'], {
          mappings: {
            OpportunityId: { strategy: 'externalId', matchField: null, customValue: null }
          }
        })
      ),
      passCtx(h.io, 'OpportunityLineItem')
    )

    // Was 'root' before S49 — the message names the FIELD and nothing else, so
    // neither line-based pattern could see the parent behind it. (The seeded
    // Opportunity row is the ROOT; only the OLI's classification is under test.)
    const oliFailure = h.store.failures.find((f) => f.objectApiName === 'OpportunityLineItem')
    expect(oliFailure?.classification).toBe('cascade')
    expect(h.store.failures.map((f) => f.classification)).toEqual(['root', 'cascade'])
  })

  // ── S50 A5: the stripped-reference ledger ───────────────────────────────
  it('records a stripped NILLABLE lookup as an orphaned link', async () => {
    const ACC = '001TR00000AAAAAAAA'
    const CON = '003TR00000BBBBBBBB'
    const h = harness({
      sourceDescribe: [
        fld('AccountId', {
          isReference: true,
          isNillable: true, // nillable -> the row deploys with a null FK
          referenceTo: ['Account'],
          relationshipName: 'Account'
        })
      ],
      onQueryTarget: () => [], // parent absent -> stripped
      pages: [{ records: [{ Id: CON, AccountId: ACC }], totalSize: 1 }]
    })
    await runFirstPass(
      planOf(
        frozenObject('Contact', ['AccountId'], {
          mappings: { AccountId: { strategy: 'externalId', matchField: null, customValue: null } }
        })
      ),
      passCtx(h.io, 'Contact')
    )

    // The row DEPLOYED — that is the defect: success, minus the link.
    expect(h.store.results.map((r) => r.outcome)).toEqual(['success'])
    expect(h.store.strippedRefs).toHaveLength(1)
    expect(h.store.strippedRefs[0]).toMatchObject({
      objectApiName: 'Contact',
      sourceId: CON,
      fieldName: 'AccountId',
      relationshipName: 'Account',
      refObject: 'Account',
      // reverse() preserves case, so this is the ORIGINAL source id — which is
      // what record_results.source_id holds, so the orphan roll-up's join
      // works under SQLite's case-SENSITIVE comparison. A lowercased value
      // here would join to nothing and silently report 0 relinkable parents.
      parentSourceId: ACC
    })
  })

  it('does NOT record a stripped REQUIRED lookup — that one fails loudly and self-heals', async () => {
    const OPP = '006TR00000CCCCCCCC'
    const OLI = '00kTR00000DDDDDDDD'
    const h = harness({
      sourceDescribe: [
        fld('OpportunityId', {
          isReference: true,
          isNillable: false, // REQUIRED
          referenceTo: ['Opportunity'],
          relationshipName: 'Opportunity'
        })
      ],
      onQueryTarget: () => [],
      pages: [{ records: [{ Id: OLI, OpportunityId: OPP }], totalSize: 1 }]
    })
    await runFirstPass(
      planOf(
        frozenObject('OpportunityLineItem', ['OpportunityId'], {
          mappings: {
            OpportunityId: { strategy: 'externalId', matchField: null, customValue: null }
          }
        })
      ),
      passCtx(h.io, 'OpportunityLineItem')
    )
    // Required strips surface as REQUIRED_FIELD_MISSING and are retried; a
    // ledger row would double-report a problem the engine already recovers.
    expect(h.store.strippedRefs).toEqual([])
  })

  // ── S50 B2: the SOQL statement ceiling, end to end ──────────────────────
  // The helper is unit-tested in scoping.test.ts; this pins the WIRING, which
  // is the half that silently does nothing if the budget never reaches
  // effectiveFilters. (BUG-7 in S49 was exactly that shape: a correct-looking
  // fix starved by a hardcoded value upstream.)
  it('sub-splits a frozen id chunk when the object SELECT leaves no room for it', async () => {
    const parentIds = Array.from({ length: 30 }, (_, i) => `001${String(i).padStart(15, '0')}`)
    // The SELECT has to be wide enough to actually consume the 100,000-char
    // statement budget — ~2,400 fields of ~40 chars. Opportunity's real plan is
    // 590 fields / 13,835 chars, which leaves 7 ids of headroom at a 4,000
    // chunk; this exaggerates the same shape so the split is unambiguous.
    // (A SELECT that alone exceeds 100,000 chars is NOT reachable on a real
    // object — Salesforce caps custom fields around 800-900 — so this is sized
    // to leave a small but non-zero id budget, which is the realistic shape.)
    const wideFields = Array.from({ length: 2_120 }, (_, i) =>
      fld(`Very_Long_Custom_Field_Name_Padding_${String(i).padStart(5, '0')}__c`)
    )
    const h = harness({
      sourceDescribe: wideFields,
      pages: [{ records: [], totalSize: 0 }]
    })
    const plan = planOf(
      frozenObject(
        'Account',
        wideFields.map((f) => f.apiName),
        {
          scope: {
            kind: 'parentIn',
            lookupField: 'ParentId',
            parentObject: 'Account',
            idChunks: [parentIds] // ONE frozen chunk of 30
          }
        }
      )
    )
    await runFirstPass(plan, passCtx(h.io, 'Account'))

    // One frozen chunk became several real queries...
    expect(h.sourceSoqls.length).toBeGreaterThan(1)
    // ...every one of them under the statement ceiling...
    for (const soql of h.sourceSoqls) expect(soql.length).toBeLessThanOrEqual(100_000)
    // ...and the ids partition exactly — none lost, none repeated.
    const seen = h.sourceSoqls.flatMap((q) => [...q.matchAll(/'(001[^']+)'/g)].map((m) => m[1]!))
    expect(seen.sort()).toEqual([...parentIds].sort())
  })

  it('leaves a within-budget single chunk on the byte-identical display path', async () => {
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [{ records: [], totalSize: 0 }]
    })
    const plan = planOf(
      frozenObject('Account', ['Name'], {
        scopedFilterDisplay: "WHERE ParentId IN ('001aaa')",
        scope: {
          kind: 'parentIn',
          lookupField: 'ParentId',
          parentObject: 'Account',
          idChunks: [['001aaa']]
        }
      })
    )
    await runFirstPass(plan, passCtx(h.io, 'Account'))
    expect(h.sourceSoqls).toHaveLength(1)
    expect(h.sourceSoqls[0]).toContain("WHERE ParentId IN ('001aaa')")
  })

  it('whole-batch HTTP failure: all records failed with the shared Batch HTTP error line', async () => {
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [{ records: [{ Id: A1, Name: 'x' }], totalSize: 1 }],
      onUpsert: (records) => ({
        successCount: 0,
        failureCount: records.length,
        errorDetails: ['Batch HTTP error: socket hang up'],
        failedExternalIds: records.map((r) => String(r[EXTERNAL_ID_FIELD])),
        typedErrors: []
      })
    })
    await runFirstPass(planOf(frozenObject('Account', ['Name'])), passCtx(h.io, 'Account'))
    expect(h.store.results[0]).toMatchObject({
      outcome: 'failed',
      errorCode: null,
      errorMessage: 'Batch HTTP error: socket hang up'
    })
    expect(h.store.failures[0]).toMatchObject({
      extId: generateExternalId(A1),
      errorMessage: 'Batch HTTP error: socket hang up',
      fieldsJson: null
    })
  })

  it('unattributable failures (blank extId in response) emit the desktop-only Warning', async () => {
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [{ records: [{ Id: A1, Name: 'x' }], totalSize: 1 }],
      onUpsert: () => ({
        successCount: 0,
        failureCount: 1,
        errorDetails: [' → INVALID_FIELD: boom; '],
        failedExternalIds: [], // the client filters blank extIds out
        typedErrors: []
      })
    })
    await runFirstPass(planOf(frozenObject('Account', ['Name'])), passCtx(h.io, 'Account'))
    expect(
      h.logs.some(
        (l) =>
          l.level === 'Warning' &&
          l.message ===
            'Account batch 0: 1 failure(s) could not be attributed to source records ' +
              '(blank/unknown ExternalId in the composite response) — counters may undercount vs the legacy engine'
      )
    ).toBe(true)
    // the record still got its (wrong-in-Apex-too) success row? NO — it stays a
    // success row because the extId never came back; the Warning is the signal.
    expect(h.store.results[0]).toMatchObject({ outcome: 'success' })
  })
})

describe('firstPass — skips + picklist drops', () => {
  function oliFixture(): { h: Harness; plan: DeployPlan } {
    const pbeInactive = '01u000000000001AAA'
    const pbeActive = '01u000000000002AAA'
    const h = harness({
      sourceDescribe: [
        fld('UnitPrice', { dataType: 'currency' }),
        fld('PricebookEntryId', {
          dataType: 'reference',
          isReference: true,
          referenceTo: ['PricebookEntry'],
          relationshipName: 'PricebookEntry'
        })
      ],
      pages: [
        {
          records: [
            { Id: A1, UnitPrice: 10, PricebookEntryId: pbeInactive }, // → skip
            { Id: A2, UnitPrice: 20, PricebookEntryId: pbeActive } // → deploys
          ],
          totalSize: 2
        }
      ],
      onQueryTarget: (soql) => {
        if (soql.includes('FROM PricebookEntry WHERE IsActive = false')) {
          return [
            {
              Id: pbeInactive,
              Product2Id: '01t000000000001AAA',
              Pricebook2Id: '01s000000000001AAA'
            }
          ]
        }
        if (soql.includes('FROM PricebookEntry WHERE IsActive = true')) {
          return [] // no active substitute → the OLI is skipped
        }
        return []
      }
    })
    const plan = planOf(
      frozenObject('OpportunityLineItem', ['UnitPrice', 'PricebookEntryId'], {
        mappings: {
          PricebookEntryId: { strategy: 'directId', matchField: null, customValue: null }
        }
      })
    )
    return { h, plan }
  }

  it('inactive-PBE skip: skipped row + exact Apex skip line; skipped excluded from upsert', async () => {
    const { h, plan } = oliFixture()
    await runFirstPass(plan, passCtx(h.io, 'OpportunityLineItem'))

    expect(h.upsertCalls[0]!.records).toHaveLength(1)
    expect(h.store.results).toEqual([
      {
        objectApiName: 'OpportunityLineItem',
        sourceId: A1,
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'skipped',
        errorMessage: 'inactive_pbe_no_substitute'
      },
      {
        objectApiName: 'OpportunityLineItem',
        sourceId: A2,
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'success'
      }
    ])
    expect(
      h.logs.some(
        (l) =>
          l.level === 'Info' &&
          l.message ===
            '1 record(s) skipped on OpportunityLineItem batch 0 (inactive_pbe_no_substitute=1)'
      )
    ).toBe(true)
    // batch line counts only the upserted record
    expect(h.logs.at(-1)!.message).toBe(
      'REST upsert batch 0: 1 succeeded, 0 failed for OpportunityLineItem'
    )
  })

  it('restricted-picklist drops aggregate into the exact per-batch Warning', async () => {
    const h = harness({
      sourceDescribe: [fld('Name'), fld('Industry', { dataType: 'picklist' })],
      targetDescribe: [
        fld('Name'),
        fld('Industry', {
          dataType: 'picklist',
          isRestrictedPicklist: true,
          picklistValues: ['Tech']
        })
      ],
      pages: [
        {
          records: [
            { Id: A1, Name: 'a', Industry: 'Legacy' },
            { Id: A2, Name: 'b', Industry: 'Obsolete' }
          ],
          totalSize: 2
        }
      ]
    })
    await runFirstPass(
      planOf(frozenObject('Account', ['Name', 'Industry'])),
      passCtx(h.io, 'Account')
    )
    expect(
      h.logs.some(
        (l) =>
          l.level === 'Warning' &&
          l.message ===
            'Picklist drop summary for Account batch 0: Industry — sample values not allowed on target: Legacy, Obsolete'
      )
    ).toBe(true)
    // the offending values were dropped from the payloads, records still deploy
    expect(h.upsertCalls[0]!.records).toHaveLength(2)
    expect(h.upsertCalls[0]!.records[0]!['Industry']).toBeUndefined()
    expect(h.store.results.every((r) => r.outcome === 'success')).toBe(true)
  })
})

describe('firstPass — parent strip + contract idempotency', () => {
  it('nested externalId refs missing on target are stripped with the combined Warning', async () => {
    const parentId = '003000000000001AAA'
    const h = harness({
      sourceDescribe: [
        fld('Name'),
        fld('AccountId', {
          dataType: 'reference',
          isReference: true,
          referenceTo: ['Account'],
          relationshipName: 'Account'
        })
      ],
      pages: [{ records: [{ Id: A1, Name: 'c', AccountId: parentId }], totalSize: 1 }],
      onQueryTarget: (soql) => {
        if (soql.includes(`SELECT ${EXTERNAL_ID_FIELD} FROM Account`)) return [] // parent missing
        return []
      }
    })
    const plan = planOf(
      frozenObject('Contact', ['Name', 'AccountId'], {
        mappings: { AccountId: { strategy: 'externalId', matchField: null, customValue: null } }
      })
    )
    await runFirstPass(plan, passCtx(h.io, 'Contact'))

    // the nested ref was stripped; the row still deployed
    expect(h.upsertCalls[0]!.records[0]!['Account']).toBeUndefined()
    expect(
      h.logs.some(
        (l) =>
          l.level === 'Warning' &&
          l.message ===
            'Dropped unresolvable reference(s) on Contact — referenced record(s) not on target; ' +
              'field left empty instead of failing the row: Account → Account (1)'
      )
    ).toBe(true)
  })

  it('already-Activated Contracts partition out, count as deployed, exact Info line', async () => {
    const c1 = '800000000000001AAA'
    const c2 = '800000000000002AAA'
    const h = harness({
      sourceDescribe: [fld('Description')],
      pages: [
        {
          records: [
            { Id: c1, Description: 'one' },
            { Id: c2, Description: 'two' }
          ],
          totalSize: 2
        }
      ],
      onQueryTarget: (soql) => {
        if (soql.includes("FROM Contract WHERE Status = 'Activated'")) {
          return [{ [EXTERNAL_ID_FIELD]: generateExternalId(c1) }]
        }
        return []
      }
    })
    await runFirstPass(planOf(frozenObject('Contract', ['Description'])), passCtx(h.io, 'Contract'))

    // only c2 was upserted; c1 counted as deployed
    expect(h.upsertCalls[0]!.records).toHaveLength(1)
    expect(h.upsertCalls[0]!.records[0]![EXTERNAL_ID_FIELD]).toBe(generateExternalId(c2))
    expect(h.store.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: c1, outcome: 'success' }),
        expect.objectContaining({ sourceId: c2, outcome: 'success' })
      ])
    )
    expect(h.logs[0]).toEqual({
      level: 'Info',
      message:
        '1 Contract(s) already Activated on target — skipped Draft re-write (idempotent re-run).'
    })
    expect(h.logs.at(-1)!.message).toBe('REST upsert batch 0: 2 succeeded, 0 failed for Contract')
  })
})

describe('firstPass — tripwire + cancel', () => {
  it('CpqTriggersActiveError propagates before the next page is pulled', async () => {
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [
        { records: [{ Id: A1, Name: 'a' }], totalSize: 2 },
        { records: [{ Id: A2, Name: 'b' }], totalSize: 2 }
      ],
      onUpsert: () => {
        throw new CpqTriggersActiveError('SBQQ__Quote__c', 'SBQQ.QuoteTrigger: boom')
      }
    })
    const plan = planOf(frozenObject('SBQQ__Quote__c', ['Name']))
    await expect(runFirstPass(plan, passCtx(h.io, 'SBQQ__Quote__c'))).rejects.toMatchObject({
      name: 'CpqTriggersActiveError'
    })
    expect(h.pagesPulled()).toBe(1) // page 1 never dispatched
    expect(h.upsertCalls).toHaveLength(1)
  })

  it('cancel between batches stops dispatch cleanly (no throw, no page-1 rows)', async () => {
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [
        { records: [{ Id: A1, Name: 'a' }], totalSize: 2 },
        { records: [{ Id: A2, Name: 'b' }], totalSize: 2 }
      ],
      onUpsert: (records) => {
        h.store.cancelled = true // cancel arrives while batch 0 is in flight
        return ok(records.length)
      }
    })
    await runFirstPass(planOf(frozenObject('Account', ['Name'])), passCtx(h.io, 'Account'))
    expect(h.upsertCalls).toHaveLength(1)
    expect(h.store.results).toHaveLength(1) // batch 0 rows only
  })
})

describe('firstPass — review regressions (wf_74e521c5)', () => {
  const P1 = '001000000000011AAA'
  const P2 = '001000000000012AAA'

  it('multi-chunk parentIn scope walks one REAL query per chunk (never the display summary)', async () => {
    const h = harness({
      sourceDescribe: [fld('LastName')],
      pages: [{ records: [{ Id: A1, LastName: 'x' }], totalSize: 1 }]
    })
    const plan = planOf(
      frozenObject('Contact', ['LastName'], {
        scope: {
          kind: 'parentIn',
          lookupField: 'AccountId',
          parentObject: 'Account',
          idChunks: [[P1], [P2]]
        },
        scopedFilterDisplay: 'WHERE AccountId IN (<2 Account ids across 2 chunks>)' // the summary — must NOT be sent
      })
    )
    await runFirstPass(plan, passCtx(h.io, 'Contact'))
    expect(h.sourceSoqls).toEqual([
      `SELECT Id, LastName FROM Contact WHERE AccountId IN ('${P1}')`,
      `SELECT Id, LastName FROM Contact WHERE AccountId IN ('${P2}')`
    ])
    // both chunks' pages processed; batch numbering continues across chunks
    expect(
      h.logs.filter((l) => l.message.startsWith('REST upsert batch')).map((l) => l.message)
    ).toEqual([
      'REST upsert batch 0: 1 succeeded, 0 failed for Contact',
      'REST upsert batch 1: 1 succeeded, 0 failed for Contact'
    ])
    expect(h.store.results).toHaveLength(2)
  })

  it('single-chunk parentIn still uses the frozen display string (byte parity with Scoped_Filter__c)', async () => {
    const h = harness({
      sourceDescribe: [fld('LastName')],
      pages: [{ records: [], totalSize: 0 }]
    })
    const plan = planOf(
      frozenObject('Contact', ['LastName'], {
        scope: {
          kind: 'parentIn',
          lookupField: 'AccountId',
          parentObject: 'Account',
          idChunks: [[P1]]
        },
        scopedFilterDisplay: `WHERE AccountId IN ('${P1}')`
      })
    )
    await runFirstPass(plan, passCtx(h.io, 'Contact'))
    expect(h.sourceSoqls).toEqual([`SELECT Id, LastName FROM Contact WHERE AccountId IN ('${P1}')`])
  })

  it('an empty chunk advances to the next chunk; skip line only when ALL chunks are empty', async () => {
    // Harness yields the same scripted pages per query — script per-soql instead.
    const store2: Array<Record<string, unknown>> = [{ Id: A2, LastName: 'y' }]
    let call = 0
    const h = harness({
      sourceDescribe: [fld('LastName')],
      pages: [] // unused — querySourcePages overridden below
    })
    h.io.querySourcePages = () =>
      (async function* (): AsyncGenerator<QueryPage> {
        call++
        yield call === 1 ? { records: [], totalSize: 0 } : { records: store2, totalSize: 1 }
      })()
    const plan = planOf(
      frozenObject('Contact', ['LastName'], {
        scope: {
          kind: 'parentIn',
          lookupField: 'AccountId',
          parentObject: 'Account',
          idChunks: [[P1], [P2]]
        },
        scopedFilterDisplay: 'WHERE AccountId IN (<2 Account ids across 2 chunks>)'
      })
    )
    await runFirstPass(plan, passCtx(h.io, 'Contact'))
    expect(h.store.results).toHaveLength(1) // chunk 2's record deployed
    expect(h.logs.some((l) => l.message === 'Skipped Contact — no records on source')).toBe(false)
  })

  it('an empty CONTINUATION page logs the Apex skip line and abandons further pages (DDQ every-hop guard)', async () => {
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [
        { records: [{ Id: A1, Name: 'a' }], totalSize: 3 },
        { records: [], totalSize: 3 }, // mid-cursor empty page
        { records: [{ Id: A2, Name: 'b' }], totalSize: 3 } // must never be pulled
      ]
    })
    await runFirstPass(planOf(frozenObject('Account', ['Name'])), passCtx(h.io, 'Account'))
    expect(h.pagesPulled()).toBe(2)
    expect(h.store.results).toHaveLength(1) // page 0 only
    expect(h.logs.at(-1)).toEqual({
      level: 'Info',
      message: 'Skipped Account — no records on source'
    })
  })

  it('typed-error-less failures get THEIR sub-batch HTTP error line, not the first one', async () => {
    const ext1 = generateExternalId(A1)
    const ext2 = generateExternalId(A2)
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [
        {
          records: [
            { Id: A1, Name: 'a' },
            { Id: A2, Name: 'b' }
          ],
          totalSize: 2
        }
      ],
      onUpsert: () => ({
        successCount: 0,
        failureCount: 2,
        // one HTTP line per failed sub-batch, dispatch order (DDS L611-618)
        errorDetails: [
          'Batch HTTP error: read timeout',
          'Batch HTTP error: 503 Service Unavailable'
        ],
        failedExternalIds: [ext1, ext2],
        typedErrors: []
      })
    })
    // recommendedBatchSize 1 → record 0 is sub-batch 0, record 1 is sub-batch 1
    const plan = planOf(frozenObject('Account', ['Name'], { recommendedBatchSize: 1 }))
    await runFirstPass(plan, passCtx(h.io, 'Account'))
    expect(h.store.failures.map((f) => f.errorMessage)).toEqual([
      'Batch HTTP error: read timeout',
      'Batch HTTP error: 503 Service Unavailable'
    ])
  })

  it('a frozen field no longer writable on the live TARGET describe fails LOUD (stale plan)', async () => {
    const h = harness({
      sourceDescribe: [fld('Name'), fld('Amount__c', { dataType: 'currency' })],
      targetDescribe: [fld('Name'), fld('Amount__c', { dataType: 'currency', isCalculated: true })], // turned formula post-freeze
      pages: []
    })
    const plan = planOf(frozenObject('Account', ['Name', 'Amount__c']))
    await expect(runFirstPass(plan, passCtx(h.io, 'Account'))).rejects.toThrow(
      'Frozen plan for Account references field(s) no longer writable on the live target describe: Amount__c — re-freeze the plan'
    )
  })

  it('same-batch failures never classify against themselves (classifier read precedes the write)', async () => {
    // Two Account records fail in ONE page: A1 plain, A2 with an FK line
    // pointing at A1 (Account.ParentId shape — entity Account IS a deployment
    // object). The classifier's failed set is read BEFORE this batch's rows
    // are recorded (the Apex per-hop SOQL, DDQ L2245 before the L2012 DML),
    // so A2 must classify ROOT — a refactor hoisting the row write above the
    // classification loop would silently flip this to cascade.
    const parentExt = generateExternalId(A1)
    const childExt = generateExternalId(A2)
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [
        {
          records: [
            { Id: A1, Name: 'p' },
            { Id: A2, Name: 'c' }
          ],
          totalSize: 2
        }
      ],
      onUpsert: () => ({
        successCount: 0,
        failureCount: 2,
        errorDetails: [
          `${parentExt} → REQUIRED_FIELD_MISSING: boom; `,
          `${childExt} → INVALID_FIELD: Foreign key external ID: ${parentExt} not found ` +
            `for field Data_Deployment_External_Id__c in entity Account; `
        ],
        failedExternalIds: [parentExt, childExt],
        typedErrors: [
          { extId: parentExt, statusCode: 'REQUIRED_FIELD_MISSING', message: 'boom', fields: [] },
          { extId: childExt, statusCode: 'INVALID_FIELD', message: 'Foreign key…', fields: [] }
        ]
      })
    })
    await runFirstPass(planOf(frozenObject('Account', ['Name'])), passCtx(h.io, 'Account'))
    expect(h.store.failures.map((f) => f.classification)).toEqual(['root', 'root'])
  })

  it('a frozen field DELETED from the live target describe fails LOUD too', async () => {
    const h = harness({
      sourceDescribe: [fld('Name'), fld('Gone__c')],
      targetDescribe: [fld('Name')],
      pages: []
    })
    const plan = planOf(frozenObject('Account', ['Name', 'Gone__c']))
    await expect(runFirstPass(plan, passCtx(h.io, 'Account'))).rejects.toThrow(
      /no longer writable on the live target describe: Gone__c/
    )
  })
})

describe('firstPass — query build + context wiring', () => {
  it('Contact PA filter comes from the FULL source describe and composes with the frozen filter', async () => {
    const h = harness({
      sourceDescribe: [
        fld('LastName'),
        fld('IsPersonAccount', { dataType: 'boolean', isCreateable: false })
      ],
      pages: [{ records: [], totalSize: 0 }]
    })
    const plan = planOf(
      frozenObject('Contact', ['LastName'], {
        scopedFilterDisplay: "WHERE AccountId = '001000000000009AAA'"
      })
    )
    await runFirstPass(plan, passCtx(h.io, 'Contact'))
    expect(h.sourceSoqls).toEqual([
      "SELECT Id, LastName FROM Contact WHERE IsPersonAccount = false AND AccountId = '001000000000009AAA'"
    ])
  })

  it('PricebookEntry gets ORDER BY Pricebook2.IsStandard DESC', async () => {
    const h = harness({
      sourceDescribe: [fld('UnitPrice', { dataType: 'currency' })],
      pages: [{ records: [], totalSize: 0 }]
    })
    await runFirstPass(
      planOf(frozenObject('PricebookEntry', ['UnitPrice'])),
      passCtx(h.io, 'PricebookEntry')
    )
    expect(h.sourceSoqls[0]).toBe(
      'SELECT Id, UnitPrice FROM PricebookEntry ORDER BY Pricebook2.IsStandard DESC'
    )
  })

  it('nameMatch mapping resolves through source+target queries into the payload', async () => {
    const srcFoo = 'a00000000000001AAA'
    const tgtFoo = 'a00000000000002AAA'
    const h = harness({
      sourceDescribe: [
        fld('Name'),
        fld('Custom_Ref__c', {
          dataType: 'reference',
          isReference: true,
          referenceTo: ['Foo__c'],
          relationshipName: 'Custom_Ref__r'
        })
      ],
      pages: [{ records: [{ Id: A1, Name: 'x', Custom_Ref__c: srcFoo }], totalSize: 1 }],
      onQuerySource: (soql) =>
        soql === 'SELECT Id, Name FROM Foo__c' ? [{ Id: srcFoo, Name: 'Widget' }] : [],
      onQueryTarget: (soql) =>
        soql === 'SELECT Id, Name FROM Foo__c' ? [{ Id: tgtFoo, Name: 'Widget' }] : []
    })
    const plan = planOf(
      frozenObject('Account', ['Name', 'Custom_Ref__c'], {
        mappings: {
          Custom_Ref__c: { strategy: 'nameMatch', matchField: 'Name', customValue: null }
        }
      })
    )
    await runFirstPass(plan, passCtx(h.io, 'Account'))
    expect(h.upsertCalls[0]!.records[0]!['Custom_Ref__c']).toBe(tgtFoo)
  })

  it('setToMe resolves via getTargetUserId', async () => {
    const h = harness({
      sourceDescribe: [
        fld('Name'),
        fld('OwnerId', {
          dataType: 'reference',
          isReference: true,
          referenceTo: ['User'],
          relationshipName: 'Owner'
        })
      ],
      pages: [{ records: [{ Id: A1, Name: 'x', OwnerId: '005000000000001AAA' }], totalSize: 1 }],
      targetUserId: '005TGT0000000001AA'
    })
    const plan = planOf(
      frozenObject('Account', ['Name', 'OwnerId'], {
        mappings: { OwnerId: { strategy: 'setToMe', matchField: null, customValue: null } }
      })
    )
    await runFirstPass(plan, passCtx(h.io, 'Account'))
    expect(h.upsertCalls[0]!.records[0]!['OwnerId']).toBe('005TGT0000000001AA')
  })

  it('recommendedBatchSize flows into upsertBatch (gated-object gentler batches)', async () => {
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [{ records: [{ Id: A1, Name: 'x' }], totalSize: 1 }]
    })
    const plan = planOf(frozenObject('Account', ['Name'], { recommendedBatchSize: 50 }))
    await runFirstPass(plan, passCtx(h.io, 'Account'))
    expect(h.upsertCalls[0]!.batchSize).toBe(50)
  })
})

describe('firstPass — S49 (BUG-1): records the TARGET id of each successful upsert', () => {
  it('captures successIds onto record_results, and exposes a collapse as a repeated id', async () => {
    // Live gap this closes: record_results.target_id was NULL for all 942 rows
    // of run 2, so two OpportunityTeamMembers whose inactive owners substituted
    // to the SAME target user — colliding on the unique (OpportunityId, UserId)
    // index — looked like 2 successes while only 1 row existed on the target
    // (27 in, 25 written, counters reporting 27 deployed / 0 failed).
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [
        {
          records: [
            { Id: A1, Name: 'first' },
            { Id: A2, Name: 'second' }
          ],
          totalSize: 2
        }
      ],
      // Both upserts "succeed" but resolve to the SAME target record.
      onUpsert: (records) => ({
        successCount: records.length,
        failureCount: 0,
        errorDetails: [],
        failedExternalIds: [],
        typedErrors: [],
        successIds: records.map((r) => ({
          extId: String(r[EXTERNAL_ID_FIELD]),
          id: '001TARGETCOLLAPSE1'
        }))
      })
    })
    await runFirstPass(planOf(frozenObject('Account', ['Name'])), passCtx(h.io, 'Account'))

    const rows = h.store.results.filter((r) => r.outcome === 'success')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.targetId)).toEqual(['001TARGETCOLLAPSE1', '001TARGETCOLLAPSE1'])
    // 2 "deployed" but only 1 distinct target row — the signal a reconcile needs
    expect(new Set(rows.map((r) => r.targetId)).size).toBe(1)
  })

  it('omits targetId entirely when the transport reports no ids (pre-S49 shape)', async () => {
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [{ records: [{ Id: A1, Name: 'x' }], totalSize: 1 }]
    })
    await runFirstPass(planOf(frozenObject('Account', ['Name'])), passCtx(h.io, 'Account'))
    const row = h.store.results.find((r) => r.outcome === 'success')!
    expect(row.targetId).toBeUndefined()
  })
})

describe('firstPass — S49 (BUG-1 pt2): unique-constraint collision is skipped, not overwritten', () => {
  // OpportunityTeamMember has a unique index on (OpportunityId, UserId). Owner
  // substitution mapped two inactive source users onto ONE target user, so the
  // 2nd upsert overwrote the 1st row's TeamMemberRole while both reported
  // success (27 source rows -> 25 target rows, both 'BDR' roles lost).
  const OTM1 = '00K100000000001AAA'
  const OTM2 = '00K100000000002AAA'

  it('keeps the FIRST record and skips the later colliding one', async () => {
    const h = harness({
      sourceDescribe: [fld('OpportunityId'), fld('UserId'), fld('TeamMemberRole')],
      pages: [
        {
          records: [
            { Id: OTM1, OpportunityId: '006X', UserId: '005SUB', TeamMemberRole: 'BDR' },
            {
              Id: OTM2,
              OpportunityId: '006X',
              UserId: '005SUB',
              TeamMemberRole: 'Opportunity Owner'
            }
          ],
          totalSize: 2
        }
      ]
    })
    await runFirstPass(
      planOf(frozenObject('OpportunityTeamMember', ['OpportunityId', 'UserId', 'TeamMemberRole'])),
      passCtx(h.io, 'OpportunityTeamMember')
    )

    // only ONE record reaches the API — no silent overwrite
    expect(h.upsertCalls).toHaveLength(1)
    expect(h.upsertCalls[0]!.records).toHaveLength(1)
    expect(h.upsertCalls[0]!.records[0]!.TeamMemberRole).toBe('BDR')

    const skipped = h.store.results.filter((r) => r.outcome === 'skipped')
    expect(skipped).toHaveLength(1)
    expect(skipped[0]!.sourceId).toBe(OTM2)
    expect(skipped[0]!.errorMessage).toContain('unique_constraint_collision')
    expect(skipped[0]!.errorMessage).toContain(OTM1)
  })

  it('leaves distinct keys alone', async () => {
    const h = harness({
      sourceDescribe: [fld('OpportunityId'), fld('UserId')],
      pages: [
        {
          records: [
            { Id: OTM1, OpportunityId: '006X', UserId: '005A' },
            { Id: OTM2, OpportunityId: '006X', UserId: '005B' }
          ],
          totalSize: 2
        }
      ]
    })
    await runFirstPass(
      planOf(frozenObject('OpportunityTeamMember', ['OpportunityId', 'UserId'])),
      passCtx(h.io, 'OpportunityTeamMember')
    )
    expect(h.upsertCalls[0]!.records).toHaveLength(2)
    expect(h.store.results.filter((r) => r.outcome === 'skipped')).toHaveLength(0)
  })

  it('does not touch objects without a registered constraint', async () => {
    const h = harness({
      sourceDescribe: [fld('Name')],
      pages: [
        {
          records: [
            { Id: A1, Name: 'dup' },
            { Id: A2, Name: 'dup' }
          ],
          totalSize: 2
        }
      ]
    })
    await runFirstPass(planOf(frozenObject('Account', ['Name'])), passCtx(h.io, 'Account'))
    expect(h.upsertCalls[0]!.records).toHaveLength(2)
  })
})

// ── S53 (A1 at N>1 — "skip the subtree"): a record whose SCOPE parent is not on
//    target is WITHHELD (failed, retryable), never written detached ─────────────
describe('firstPass — scope-parent withhold (S53)', () => {
  const ACC_OK = '001TR00000AAAAAAAA'
  const ACC_BAD = '001TR00000BBBBBBBB'
  const CON_1 = '003TR00000CCCCCCCC'
  const CON_2 = '003TR00000DDDDDDDD'
  const accountLookup = fld('AccountId', {
    isReference: true,
    isNillable: true, // nillable — pre-S53 this row DEPLOYED with a null FK
    referenceTo: ['Account'],
    relationshipName: 'Account'
  })
  const contactPlan = (): DeployPlan =>
    planOf(
      frozenObject('Account', ['Name']),
      frozenObject('Contact', ['AccountId'], {
        sortOrder: 2,
        scope: {
          kind: 'parentIn',
          lookupField: 'AccountId',
          parentObject: 'Account',
          idChunks: [[ACC_OK, ACC_BAD]]
        },
        mappings: { AccountId: { strategy: 'externalId', matchField: null, customValue: null } }
      })
    )

  it('withholds the child of a missing scope parent as FAILED (cascade when that parent failed) and writes the rest', async () => {
    const h = harness({
      sourceDescribe: [accountLookup],
      // Only ACC_OK's ExtId exists on target.
      onQueryTarget: (soql) =>
        soql.includes(`FROM Account`) ? [{ [EXTERNAL_ID_FIELD]: generateExternalId(ACC_OK) }] : [],
      pages: [
        {
          records: [
            { Id: CON_1, AccountId: ACC_OK },
            { Id: CON_2, AccountId: ACC_BAD }
          ],
          totalSize: 2
        }
      ]
    })
    // The root Account ACC_BAD failed earlier in this run.
    h.store.failures.push({
      objectApiName: 'Account',
      pass: 1,
      retryPass: 0,
      objectAttempt: 0,
      sourceId: ACC_BAD,
      classification: 'root'
    })
    await runFirstPass(contactPlan(), passCtx(h.io, 'Contact'))

    // Only CON_1 went to the API.
    expect(h.upsertCalls).toHaveLength(1)
    expect(h.upsertCalls[0]!.records.map((r) => r[EXTERNAL_ID_FIELD])).toEqual([
      generateExternalId(CON_1)
    ])
    // CON_2: failed, not skipped, not deployed detached.
    const byId = new Map(h.store.results.map((r) => [r.sourceId, r]))
    expect(byId.get(CON_1)?.outcome).toBe('success')
    expect(byId.get(CON_2)).toMatchObject({
      outcome: 'failed',
      errorCode: 'SCOPE_PARENT_NOT_ON_TARGET'
    })
    expect(byId.get(CON_2)?.errorMessage).toContain(`Account ${ACC_BAD} (via AccountId)`)
    // failed_records row → the retry drain picks it up; classified cascade.
    const failure = h.store.failures.find((f) => f.sourceId === CON_2)
    expect(failure).toMatchObject({
      objectApiName: 'Contact',
      classification: 'cascade',
      errorCode: 'SCOPE_PARENT_NOT_ON_TARGET',
      fieldsJson: JSON.stringify(['AccountId'])
    })
    // No stripped-ref ledger row: nothing was stripped, nothing detached landed.
    expect(h.store.strippedRefs).toEqual([])
    // The Warning names the parent object and the count.
    expect(
      h.logs.some(
        (l) =>
          l.level === 'Warning' &&
          l.message.startsWith('1 Contact record(s) withheld on batch 0') &&
          l.message.includes('Account (1)')
      )
    ).toBe(true)
  })

  it('classifies ROOT when the missing scope parent is NOT in the run’s failed set (e.g. it was skipped)', async () => {
    const h = harness({
      sourceDescribe: [accountLookup],
      onQueryTarget: () => [],
      pages: [{ records: [{ Id: CON_2, AccountId: ACC_BAD }], totalSize: 1 }]
    })
    await runFirstPass(contactPlan(), passCtx(h.io, 'Contact'))
    // Nothing reaches the API (the collections client issues no HTTP call for an
    // empty list — chunking yields zero sub-batches).
    expect(h.upsertCalls[0]!.records).toEqual([])
    expect(h.store.failures.map((f) => f.classification)).toEqual(['root'])
  })

  it('an ORDINARY nillable lookup to a missing parent still strips-and-deploys (S50 A5 behaviour kept)', async () => {
    // Same describe, but Contact is the ROOT here (raw scope) — AccountId is not
    // its scope parent, so the pre-S53 strip + orphan ledger applies unchanged.
    const h = harness({
      sourceDescribe: [accountLookup],
      onQueryTarget: () => [],
      pages: [{ records: [{ Id: CON_2, AccountId: ACC_BAD }], totalSize: 1 }]
    })
    await runFirstPass(
      planOf(
        frozenObject('Contact', ['AccountId'], {
          scope: { kind: 'raw', where: "WHERE Name = 'x'" },
          mappings: { AccountId: { strategy: 'externalId', matchField: null, customValue: null } }
        })
      ),
      passCtx(h.io, 'Contact')
    )
    expect(h.store.results.map((r) => r.outcome)).toEqual(['success'])
    expect(h.store.strippedRefs).toHaveLength(1)
  })
})
