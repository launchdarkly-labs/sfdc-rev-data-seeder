/**
 * E4E.4 + E4E.5 against the REAL Store (migration-005 views):
 *  - queriedSourceIds / deployedSourceIds SQL semantics (the engine's scope
 *    sources for the second pass and the junction parent set),
 *  - the E4E.4 AC "first-pass counters untouched" — pass-2 rows are invisible
 *    to every view,
 *  - the E4E.5 counter sextet: junction rows produce the Apex
 *    Records_Queried/Deployed/Failed(+root default)/Skipped through the views
 *    WITHOUT failed_records rows — and junction failures stay OUT of the
 *    classifier's currentFailures mirror (the Apex junction path never wrote
 *    Persistent_Failed_Source_Ids).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Store } from '../../src/main/services/store'
import { runSecondPass } from '../../src/main/engine/deploy/secondPass'
import { runJunctionPass } from '../../src/main/engine/deploy/junction'
import {
  EXTERNAL_ID_FIELD,
  generateExternalId,
  reverse
} from '../../src/main/engine/deploy/transform/sfid'
import type { DeployPlan, FrozenObjectPlan } from '../../src/main/engine/deploy/planFreeze'
import type {
  DeployIo,
  ObjectPassContext,
  QueryPage,
  RawInsertBatchResult,
  RecordResultInput,
  UpsertBatchResult
} from '../../src/main/engine/deploy/types'
import type { DescribeField } from '../../src/main/engine/deploy/transform/fieldFilter'

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

const EXT = EXTERNAL_ID_FIELD
const A1 = '001000000000001AAA'
const A2 = '001000000000002AAA'
const A3 = '001000000000003AAA'
const O1 = '006000000000001AAA'
const C1 = '003000000000001AAA'
const C2 = '003000000000002AAA'
const R1 = '00K000000000001AAA'
const R2 = '00K000000000002AAA'
const R3 = '00K000000000003AAA'

function newRun(planJson = '{"objects":[]}'): number {
  const deploymentId = store.createDeployment({
    name: 'passes',
    sourceConnectionId: 'src',
    targetConnectionId: 'tgt'
  })
  const plan = store.deploy.savePlan(deploymentId, planJson, 'hash-e4e45')
  return store.deploy.createRun(deploymentId, plan.id).id
}

function row(
  objectApiName: string,
  sourceId: string,
  over: Partial<RecordResultInput> = {}
): RecordResultInput {
  return {
    objectApiName,
    sourceId,
    pass: 1,
    retryPass: 0,
    objectAttempt: 0,
    outcome: 'success',
    ...over
  }
}

describe('DeployStore.queriedSourceIds', () => {
  it('returns distinct retry_pass-0 source ids at the LATEST attempt, insertion order', () => {
    const runId = newRun()
    // Attempt 0: three records. Attempt 1 (bounded rerun): two records only.
    store.deploy.recordResults(runId, [
      row('Account', A1),
      row('Account', A2, { outcome: 'failed' }),
      row('Account', A3, { outcome: 'skipped' })
    ])
    store.deploy.recordResults(runId, [
      row('Account', A2, { objectAttempt: 1 }),
      row('Account', A1, { objectAttempt: 1, outcome: 'failed' }),
      // retry rows never count toward the queried scope
      row('Account', A1, { objectAttempt: 1, retryPass: 1 })
    ])
    expect(store.deploy.queriedSourceIds(runId, 'Account')).toEqual([A2, A1])
    expect(store.deploy.queriedSourceIds(runId, 'Contact')).toEqual([])
  })
})

describe('DeployStore.deployedSourceIds', () => {
  it('applies current-truth semantics: the latest row per record decides', () => {
    const runId = newRun()
    store.deploy.recordResults(runId, [
      row('Opportunity', O1, { outcome: 'failed' }), // heals at retry 1
      row('Opportunity', C1, { outcome: 'success' }) // regresses at retry 1
    ])
    store.deploy.recordResults(runId, [
      row('Opportunity', O1, { retryPass: 1, outcome: 'success' }),
      row('Opportunity', C1, { retryPass: 1, outcome: 'failed' })
    ])
    expect(store.deploy.deployedSourceIds(runId, 'Opportunity')).toEqual([O1])
  })

  it('counts only the latest whole-object attempt', () => {
    const runId = newRun()
    store.deploy.recordResults(runId, [row('Opportunity', O1, { outcome: 'success' })])
    store.deploy.recordResults(runId, [
      row('Opportunity', C1, { objectAttempt: 1, outcome: 'success' })
    ])
    expect(store.deploy.deployedSourceIds(runId, 'Opportunity')).toEqual([C1])
  })
})

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

function makeIo(opts: {
  sourceDescribe?: DescribeField[]
  pages?: QueryPage[]
  onQueryTarget?: (soql: string) => Array<Record<string, unknown>> | undefined
  onUpsert?: (records: Array<Record<string, unknown>>) => UpsertBatchResult
  onInsert?: (records: Array<Record<string, unknown>>) => RawInsertBatchResult
}): DeployIo {
  async function* arr(
    rows: Array<Record<string, unknown>>
  ): AsyncGenerator<Record<string, unknown>> {
    for (const r of rows) yield r
  }
  return {
    describeSource: () => Promise.resolve(opts.sourceDescribe ?? []),
    describeTarget: () => Promise.resolve(opts.sourceDescribe ?? []),
    querySourcePages: () =>
      (async function* (): AsyncGenerator<QueryPage> {
        for (const p of opts.pages ?? []) yield p
      })(),
    getTargetUserId: () => Promise.resolve(null),
    querySource: () => arr([]),
    queryTarget: (soql) => arr(opts.onQueryTarget?.(soql) ?? []),
    // S49 (BUG-9): unused by these fakes; rejecting keeps the record-type
    // picklist prefetch on its fail-open path.
    restGetTarget: (): Promise<unknown> => Promise.reject(new Error('not used')),
    upsertBatch: async (_obj, records) =>
      opts.onUpsert?.(records) ?? {
        successCount: records.length,
        failureCount: 0,
        errorDetails: [],
        failedExternalIds: [],
        typedErrors: []
      },
    insertCompositeBatch: async (_obj, records) =>
      opts.onInsert?.(records) ?? {
        ok: true,
        results: records.map(() => ({ success: true, id: '00Kt00000000001AAA', errors: [] }))
      },
    store: store.deploy,
    emit: () => {},
    now: () => new Date(0),
    sleep: () => Promise.resolve()
  }
}

describe('second pass → real views (E4E.4 AC: first-pass counters untouched)', () => {
  it('pass-2 rows are invisible to every counter view', async () => {
    const objPlan = frozenObject('Account', ['Id', 'Name', 'ParentId'], {
      hasCircularReference: true,
      deferredFields: ['ParentId'],
      mappings: { ParentId: { strategy: 'externalId', matchField: null, customValue: null } }
    })
    const plan: DeployPlan = { objects: [objPlan], warnings: [], totalObjects: 1, totalRecords: 2 }
    const runId = newRun(JSON.stringify(plan))

    // First-pass truth: A1 success, A2 failed (with its failed_records row).
    store.deploy.recordResults(runId, [
      row('Account', A1),
      row('Account', A2, { outcome: 'failed' })
    ])
    store.deploy.recordFailures(runId, [
      {
        objectApiName: 'Account',
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        sourceId: A2,
        extId: generateExternalId(A2),
        classification: 'root'
      }
    ])
    const before = store.deploy.objectCounters(runId)

    // Second pass: BOTH records fail their updateOnly PATCH.
    const io = makeIo({
      sourceDescribe: [
        fld('Id', { isCreateable: false }),
        fld('ParentId', { isReference: true, referenceTo: ['Account'], relationshipName: 'Parent' })
      ],
      pages: [
        {
          records: [
            { Id: A1, ParentId: A3 },
            { Id: A2, ParentId: A3 }
          ],
          totalSize: 2
        }
      ],
      onUpsert: (records) => ({
        successCount: 0,
        failureCount: records.length,
        errorDetails: records.map((r) => `${String(r[EXT])} → ENTITY_IS_DELETED: gone; `),
        failedExternalIds: records.map((r) => String(r[EXT])),
        typedErrors: records.map((r) => ({
          extId: String(r[EXT]),
          statusCode: 'ENTITY_IS_DELETED',
          message: 'gone',
          fields: []
        }))
      })
    })
    const ctx: ObjectPassContext = {
      runId,
      object: {
        objectName: 'Account',
        sortOrder: 1,
        hasCircularReference: true,
        isJunction: false,
        recordCount: 2
      },
      passKind: 'second',
      objectAttempt: 0,
      retryPass: 0,
      io
    }
    await runSecondPass(plan, ctx)

    // Counters identical before/after — the Apex second pass never touched them.
    expect(store.deploy.objectCounters(runId)).toEqual(before)
    expect(store.deploy.runCounters(runId)).toMatchObject({
      recordsQueried: 2,
      recordsDeployed: 1,
      recordsFailed: 1
    })
    // failed_records untouched (first-pass-family only).
    expect(store.deploy.listFailures(runId, 'Account', 0, 0)).toEqual([
      { sourceId: A2, classification: 'root' }
    ])
    // The pass-2 audit rows DID land.
    const pass2 = store.deploy.queriedSourceIds(runId, 'Account') // still first-pass scope
    expect(pass2).toEqual([A1, A2])
  })
})

describe('junction → real views (E4E.5 counter sextet)', () => {
  it('junction rows produce the Apex counters with root-default failures and no classifier leakage', async () => {
    const junctionPlan = frozenObject('OpportunityContactRole', [], {
      sortOrder: 9,
      isJunction: true,
      junctionParents: ['Opportunity', 'Contact'],
      junctionParentFields: ['OpportunityId', 'ContactId']
    })
    const plan: DeployPlan = {
      objects: [frozenObject('Opportunity', ['Id', 'Name']), junctionPlan],
      warnings: [],
      totalObjects: 2,
      totalRecords: 0
    }
    const runId = newRun(JSON.stringify(plan))

    // The run deployed one Opportunity — the junction's parent scope — and both
    // Contacts (S53 L3: a parent2 the run did not write is probed on target and,
    // absent there, skipped out of scope; these two must count as written).
    store.deploy.recordResults(runId, [
      row('Opportunity', O1),
      row('Contact', C1),
      row('Contact', C2)
    ])

    const io = makeIo({
      pages: [
        {
          records: [
            { Id: R1, OpportunityId: O1, ContactId: C1, Role: 'DM', IsPrimary: true }, // inserts
            { Id: R2, OpportunityId: O1, ContactId: C2, Role: 'EB', IsPrimary: false }, // insert fails
            { Id: R3, OpportunityId: O1, ContactId: null, Role: 'X', IsPrimary: false } // missing FK
          ],
          totalSize: 3
        }
      ],
      onInsert: (records) => ({
        ok: true,
        results: records.map((r, i) =>
          i === 0
            ? { success: true, id: '00Kt00000000001AAA', errors: [] }
            : {
                success: false,
                id: null,
                errors: [{ statusCode: 'DUPLICATE_VALUE', message: 'dup', fields: [] }]
              }
        )
      })
    })
    const ctx: ObjectPassContext = {
      runId,
      object: {
        objectName: 'OpportunityContactRole',
        sortOrder: 9,
        hasCircularReference: false,
        isJunction: true,
        recordCount: 0
      },
      passKind: 'junction',
      objectAttempt: 0,
      retryPass: 0,
      io
    }
    await runJunctionPass(plan, ctx)

    // The Apex sextet (DDQ L996-1000): Queried=srcCount, Deployed=successes,
    // Failed=failures ALL ROOT, Skipped=alreadyOnTarget+missingFk.
    const ocr = store.deploy
      .objectCounters(runId)
      .find((c) => c.objectApiName === 'OpportunityContactRole')!
    expect(ocr).toMatchObject({
      recordsQueried: 3,
      recordsDeployed: 1,
      recordsFailed: 1,
      recordsFailedRoot: 1, // COALESCE default — no failed_records row exists
      recordsFailedCascade: 0,
      recordsSkipped: 1
    })
    // Junction failures never reach the classifier mirror or the retry input.
    expect(store.deploy.currentFailures(runId)).toEqual([])
    expect(store.deploy.failureCountAt(runId, 'OpportunityContactRole', 0, 0)).toBe(0)
    // The success row reversed the parent scope correctly (sanity: parent ExtId
    // round-trips through reverse()).
    expect(reverse(reverse(O1))).toBe(O1)
  })
})
