/**
 * E4E.3 — the FULL engine loop, end-to-end: runDeployment (E4E.1) driving the
 * REAL makeFirstPass (E4E.2) + makeRetryPass (E4E.3) against the REAL Store
 * (migration-005 views), with only the org I/O scripted.
 *
 * Proves the whole chain the Apex ran across queueable hops: first pass
 * records failures → the orchestrator's selection-time budget + progress gate
 * pick retry candidates and seed the retry_queue from failed_records → the
 * drain re-queries by Id chunk and re-records at retryPass N → the views
 * recompute the counters exactly as the Apex accumulators (retry zeroing,
 * deployed accumulation, root/cascade classification) → teardown.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Store } from '../../src/main/services/store'
import { runDeployment } from '../../src/main/engine/deploy/orchestrator'
import { makeFirstPass } from '../../src/main/engine/deploy/firstPass'
import { makeRetryPass } from '../../src/main/engine/deploy/retry'
import type { DeployPlan, FrozenObjectPlan } from '../../src/main/engine/deploy/planFreeze'
import type {
  DeployIo,
  PassExecutors,
  QueryPage,
  UpsertBatchResult
} from '../../src/main/engine/deploy/types'
import type { DescribeField } from '../../src/main/engine/deploy/transform/fieldFilter'
import { generateExternalId } from '../../src/main/engine/deploy/transform/sfid'

let store: Store

beforeEach(() => {
  store = new Store(':memory:')
  store.upsertConnections([
    {
      alias: 'src',
      username: 's@x.io',
      orgId: '00Dsrc00000000',
      instanceUrl: 'https://src.my.salesforce.com',
      connectedStatus: 'Connected',
      isSandbox: true
    },
    {
      alias: 'tgt',
      username: 't@x.io',
      orgId: '00Dtgt00000000',
      instanceUrl: 'https://tgt.my.salesforce.com',
      connectedStatus: 'Connected',
      isSandbox: true
    }
  ])
})
afterEach(() => store.close())

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

function frozenObject(objectName: string, fields: string[], over: Partial<FrozenObjectPlan> = {}): FrozenObjectPlan {
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

const A = ['001000000000001AAA', '001000000000002AAA', '001000000000003AAA']
const inIds = (soql: string): string[] => {
  const m = soql.match(/Id IN \(([^)]*)\)/)
  return m == null ? [] : m[1]!.split(',').map((s) => s.replace(/'/g, ''))
}

function newRun(plan: DeployPlan): number {
  const deploymentId = store.createDeployment({
    name: 'Acme',
    sourceConnectionId: 'src',
    targetConnectionId: 'tgt'
  })
  const planRow = store.deploy.savePlan(deploymentId, JSON.stringify(plan), 'hash-e4e3')
  return store.deploy.createRun(deploymentId, planRow.id).id
}

interface ScriptedIo {
  io: DeployIo
  logs: string[]
  upsertSoqls: { queries: string[]; upserts: Array<Record<string, unknown>>[] }
}

function makeIo(opts: {
  describes: Record<string, DescribeField[]>
  sourcePages: (soql: string) => QueryPage[]
  onUpsert: (objectName: string, records: Array<Record<string, unknown>>, call: number) => UpsertBatchResult
}): ScriptedIo {
  const logs: string[] = []
  const queries: string[] = []
  const upserts: Array<Record<string, unknown>>[] = []
  let upsertCall = 0
  async function* none(): AsyncGenerator<Record<string, unknown>> {}
  const io: DeployIo = {
    describeSource: (obj) => Promise.resolve(opts.describes[obj] ?? []),
    describeTarget: (obj) => Promise.resolve(opts.describes[obj] ?? []),
    querySourcePages: (soql) => {
      queries.push(soql)
      const pages = opts.sourcePages(soql)
      return (async function* (): AsyncGenerator<QueryPage> {
        for (const p of pages) yield p
      })()
    },
    getTargetUserId: () => Promise.resolve(null),
    querySource: () => none(),
    queryTarget: () => none(),
    // S49 (BUG-9): unused by these fakes; rejecting keeps the record-type
    // picklist prefetch on its fail-open path.
    restGetTarget: (): Promise<unknown> => Promise.reject(new Error('not used')),
    upsertBatch: async (objectName, records) => {
      upserts.push(records as Array<Record<string, unknown>>)
      return opts.onUpsert(objectName, records as Array<Record<string, unknown>>, upsertCall++)
    },
    insertCompositeBatch: () => Promise.reject(new Error('junction raw seam (E4E.5) — not used here')),
    store: store.deploy,
    emit: (e) => {
      if (e.kind === 'log') logs.push(String(e.data.message))
    },
    now: () => new Date(0),
    sleep: () => Promise.resolve()
  }
  return { io, logs, upsertSoqls: { queries, upserts } }
}

function passesFor(plan: DeployPlan): PassExecutors {
  return {
    firstPass: makeFirstPass(plan),
    retryPass: makeRetryPass(plan),
    secondPass: () => Promise.reject(new Error('second pass is E4E.4')),
    junctionPass: () => Promise.reject(new Error('junction pass is E4E.5'))
  }
}

const fail = (extIds: string[], code = 'REQUIRED_FIELD_MISSING', msg = 'boom'): Partial<UpsertBatchResult> => ({
  failureCount: extIds.length,
  errorDetails: extIds.map((e) => `${e} → ${code}: ${msg}; `),
  failedExternalIds: extIds,
  typedErrors: extIds.map((extId) => ({ extId, statusCode: code, message: msg, fields: [] }))
})

function result(total: number, failedExtIds: string[] = []): UpsertBatchResult {
  return {
    successCount: total - failedExtIds.length,
    errorDetails: [],
    failedExternalIds: [],
    typedErrors: [],
    failureCount: 0,
    ...fail(failedExtIds)
  }
}

describe('full engine loop: first pass → targeted retries → teardown (real store + views)', () => {
  it('progress-gated retries: 2 fail → retry heals 1 → retry stalls → completed w/ 1 persistent root', async () => {
    const plan: DeployPlan = {
      objects: [frozenObject('Account', ['Name'], { recordCount: 3 })],
      warnings: [],
      totalObjects: 1,
      totalRecords: 3
    }
    const runId = newRun(plan)
    const ext = (i: number): string => generateExternalId(A[i]!)

    const scripted = makeIo({
      describes: { Account: [fld('Name')] },
      sourcePages: (soql) =>
        soql.includes('Id IN')
          ? [{ records: inIds(soql).map((id) => ({ Id: id, Name: 'x' })), totalSize: inIds(soql).length }]
          : [{ records: A.map((id) => ({ Id: id, Name: 'x' })), totalSize: 3 }],
      onUpsert: (_obj, records, call) => {
        // call 0 = first pass (3 records): A2 + A3 fail
        // call 1 = retry 1 (2 records): A3 fails (progress: 2 → 1)
        // call 2 = retry 2 (1 record): A3 fails (no progress → give up)
        const failed =
          call === 0 ? [ext(1), ext(2)] : call === 1 ? [ext(2)] : [ext(2)]
        const present = new Set(records.map((r) => String(r['Data_Deployment_External_Id__c'])))
        return result(records.length, failed.filter((e) => present.has(e)))
      }
    })

    const outcome = await runDeployment(runId, scripted.io, passesFor(plan))
    expect(outcome).toBe('completed')

    // the retry drains re-queried exactly the failed sets
    expect(scripted.upsertSoqls.queries.filter((q) => q.includes('Id IN'))).toHaveLength(2)
    expect(inIds(scripted.upsertSoqls.queries[1]!).sort()).toEqual([A[1], A[2]].sort())
    expect(inIds(scripted.upsertSoqls.queries[2]!)).toEqual([A[2]])

    // counters straight from the views: retry zeroing + deployed accumulation
    expect(store.deploy.objectCounters(runId)).toEqual([
      {
        runId,
        objectApiName: 'Account',
        recordsQueried: 3, // first-pass-only
        recordsDeployed: 2, // A1 (pass 0) + A2 (healed retry 1)
        recordsFailed: 1, // A3, per its LATEST retry pass
        recordsFailedRoot: 1,
        recordsFailedCascade: 0,
        recordsSkipped: 0
      }
    ])

    // the Apex round + terminal log lines
    expect(scripted.logs).toContain(
      'Retrying 1 object(s) on failed records only: Account (retry 1, 2 failed)'
    )
    expect(scripted.logs).toContain(
      'Retrying 1 object(s) on failed records only: Account (retry 2, 1 failed)'
    )
    expect(scripted.logs).toContain(
      'Deployment completed with 1 persistent failures: Account (1 after 2 retries)'
    )

    // run is terminal + queue drained
    expect(store.deploy.getRun(runId)!.phase).toBe('Completed')
    expect(store.deploy.retryQueueDepth(runId)).toBe(0)
  })

  it('cascade classification end-to-end: downstream FK failure buckets cascade in the views', async () => {
    const contactId = '003000000000001AAA'
    const plan: DeployPlan = {
      objects: [
      // S50 (A1): a passive EMPTY-scope root at sortOrder 0. These cases are
      // about cascade/retry semantics for a NON-root parent, which the root
      // gate deliberately no longer allows for the root itself. An empty scope
      // is a legal no-op, so the gate stays quiet.
        frozenObject('Root__c', ['Name'], { sortOrder: 0, recordCount: 0 }),
        frozenObject('Account', ['Name'], { sortOrder: 1, recordCount: 1 }),
        frozenObject('Contact', ['LastName'], { sortOrder: 2, recordCount: 1 })
      ],
      warnings: [],
      totalObjects: 3,
      totalRecords: 2
    }
    const runId = newRun(plan)
    const accountExt = generateExternalId(A[0]!)
    const contactExt = generateExternalId(contactId)

    const scripted = makeIo({
      describes: { Root__c: [fld('Name')], Account: [fld('Name')], Contact: [fld('LastName')] },
      sourcePages: (soql) => {
        if (soql.includes('FROM Root__c')) return [{ records: [], totalSize: 0 }]
        if (soql.includes('FROM Account'))
          return [{ records: [{ Id: A[0], Name: 'acme' }], totalSize: 1 }]
        return [{ records: [{ Id: contactId, LastName: 'kim' }], totalSize: 1 }]
      },
      onUpsert: (obj, records) => {
        if (obj === 'Account') return result(records.length, [accountExt]) // parent fails (root)
        // Contact fails with an FK line pointing at the failed Account parent
        return {
          successCount: 0,
          failureCount: 1,
          errorDetails: [
            `${contactExt} → INVALID_FIELD: Foreign key external ID: ${accountExt} not found ` +
              `for field Data_Deployment_External_Id__c in entity Account; `
          ],
          failedExternalIds: [contactExt],
          typedErrors: [
            { extId: contactExt, statusCode: 'INVALID_FIELD', message: 'Foreign key…', fields: [] }
          ]
        }
      }
    })

    const outcome = await runDeployment(runId, scripted.io, passesFor(plan))
    expect(outcome).toBe('completed')

    const counters = store.deploy.objectCounters(runId)
    expect(counters.find((c) => c.objectApiName === 'Account')).toMatchObject({
      recordsFailed: 1,
      recordsFailedRoot: 1,
      recordsFailedCascade: 0
    })
    expect(counters.find((c) => c.objectApiName === 'Contact')).toMatchObject({
      recordsFailed: 1,
      recordsFailedRoot: 0,
      recordsFailedCascade: 1 // FK-to-failed-parent → cascade (DDQ pattern a)
    })
    const run = store.deploy.runCounters(runId)
    expect(run).toMatchObject({ recordsFailed: 2, recordsFailedRoot: 1, recordsFailedCascade: 1 })
  })

  it('abandoned-drain leftovers are DROPPED at the next seeding (Apex Retry_Pending_Ids overwrite, DDQ L2978)', async () => {
    // 320 first-pass failures. Retry 1: chunk 1 (150) re-fails 5; chunk 2's
    // source records were deleted → empty query → drain abandoned with 20
    // never-dequeued leftovers. Round 2 must drain EXACTLY the 5 re-failures
    // (review finding: leftovers merged ahead of the fresh seeds and could
    // starve the retryable records out of their round).
    const all = Array.from({ length: 320 }, (_, i) => `001${String(i + 1).padStart(12, '0')}AAA`)
    const plan: DeployPlan = {
      objects: [
      // S50 (A1): a passive EMPTY-scope root at sortOrder 0. These cases are
      // about cascade/retry semantics for a NON-root parent, which the root
      // gate deliberately no longer allows for the root itself. An empty scope
      // is a legal no-op, so the gate stays quiet.
        frozenObject('Root__c', ['Name'], { sortOrder: 0, recordCount: 0 }),
        frozenObject('Account', ['Name'], { recordCount: 320 })
      ],
      warnings: [],
      totalObjects: 2,
      totalRecords: 320
    }
    const runId = newRun(plan)
    const rows = (idsIn: string[]): QueryPage => ({
      records: idsIn.map((id) => ({ Id: id, Name: 'x' })),
      totalSize: idsIn.length
    })
    let idInCall = 0
    const failFive = all.slice(0, 5).map((id) => generateExternalId(id))

    const scripted = makeIo({
      describes: { Root__c: [fld('Name')], Account: [fld('Name')] },
      sourcePages: (soql) => {
        if (soql.includes('FROM Root__c')) return [{ records: [], totalSize: 0 }]
        if (!soql.includes('Id IN')) return [rows(all)] // first pass
        idInCall++
        // retry-1 chunk 2: the records were deleted on source
        return idInCall === 2 ? [{ records: [], totalSize: 0 }] : [rows(inIds(soql))]
      },
      onUpsert: (_obj, records, call) => {
        if (call === 0) return result(records.length, records.map((r) => String(r['Data_Deployment_External_Id__c']))) // all 320 fail
        // every later call: the 5 known ids keep failing, others succeed
        const present = records
          .map((r) => String(r['Data_Deployment_External_Id__c']))
          .filter((e) => failFive.includes(e))
        return result(records.length, present)
      }
    })

    const outcome = await runDeployment(runId, scripted.io, passesFor(plan))
    expect(outcome).toBe('completed')

    const idInQueries = scripted.upsertSoqls.queries.filter((q) => q.includes('Id IN')).map(inIds)
    // retry 1: two 150-id chunks dequeued (chunk 2 came back empty → abandon;
    // the remaining 20 leftovers stayed queued)
    expect(idInQueries[0]).toHaveLength(150)
    expect(idInQueries[1]).toHaveLength(150)
    // round 2: EXACTLY the 5 re-failures — the 20 stale leftovers were dropped
    // by the seeding-time queue clear, never merged into the drain
    expect(idInQueries[2]!.sort()).toEqual(all.slice(0, 5).sort())
    // no drain ever carries a never-attempted leftover id again
    const leftovers = new Set(all.slice(300))
    for (const q of idInQueries.slice(2)) {
      expect(q.some((id) => leftovers.has(id))).toBe(false)
    }
    expect(store.deploy.retryQueueDepth(runId)).toBe(0)
  })

  it('currentFailures mirrors the Apex Persistent overwrite: deleted-source records drop out after a retry pass', async () => {
    const plan: DeployPlan = {
      objects: [frozenObject('Account', ['Name'])],
      warnings: [],
      totalObjects: 1,
      totalRecords: 3
    }
    const runId = newRun(plan)
    const fr = (sourceId: string, retryPass: number, objectAttempt = 0): Parameters<typeof store.deploy.recordFailures>[1][number] => ({
      objectApiName: 'Account',
      pass: 1,
      retryPass,
      objectAttempt,
      sourceId,
      extId: generateExternalId(sourceId),
      errorCode: 'X',
      errorMessage: 'y',
      fieldsJson: null,
      classification: null
    })
    // pass 0: P1..P3 fail
    store.deploy.recordFailures(runId, [fr(A[0]!, 0), fr(A[1]!, 0), fr(A[2]!, 0)])
    expect(store.deploy.currentFailures(runId).map((f) => f.sourceId).sort()).toEqual([...A].sort())
    // retry pass 1 re-fails ONLY P3 (P1 deleted on source, P2 healed) — the
    // overwrite drops both from the classifier's set (Apex: root, not cascade)
    store.deploy.recordFailures(runId, [fr(A[2]!, 1)])
    expect(store.deploy.currentFailures(runId)).toEqual([
      { objectApiName: 'Account', sourceId: A[2] }
    ])
    // a fresh whole-object attempt supersedes everything before it
    store.deploy.recordFailures(runId, [fr(A[0]!, 0, 1)])
    expect(store.deploy.currentFailures(runId)).toEqual([
      { objectApiName: 'Account', sourceId: A[0] }
    ])
  })

  it('a fully-healed retry ends clean: failed 0, deployed = all, success summary line', async () => {
    const plan: DeployPlan = {
      objects: [frozenObject('Account', ['Name'], { recordCount: 2 })],
      warnings: [],
      totalObjects: 1,
      totalRecords: 2
    }
    const runId = newRun(plan)
    const scripted = makeIo({
      describes: { Account: [fld('Name')] },
      sourcePages: (soql) =>
        soql.includes('Id IN')
          ? [{ records: inIds(soql).map((id) => ({ Id: id, Name: 'x' })), totalSize: inIds(soql).length }]
          : [{ records: [{ Id: A[0], Name: 'x' }, { Id: A[1], Name: 'x' }], totalSize: 2 }],
      onUpsert: (_obj, records, call) =>
        call === 0 ? result(records.length, [generateExternalId(A[1]!)]) : result(records.length)
    })
    const outcome = await runDeployment(runId, scripted.io, passesFor(plan))
    expect(outcome).toBe('completed')
    expect(store.deploy.objectCounters(runId)[0]).toMatchObject({
      recordsQueried: 2,
      recordsDeployed: 2,
      recordsFailed: 0,
      recordsFailedRoot: 0,
      recordsFailedCascade: 0
    })
    expect(scripted.logs).toContain('Deployment completed successfully.')
  })
})
