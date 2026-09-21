/**
 * E4E.2 — first-pass batch loop against the REAL Store (migration-005 views).
 *
 * The E4E.2 acceptance criterion: run the loop end-to-end with a mocked
 * transport on fixture data and assert the counters COME OUT OF THE VIEWS
 * exactly as the Apex accumulators would have recorded them
 * (Records_Queried = recordCount + batchSkipCount on fresh pages, DDQ L1992;
 * deployed/failed from the upsert result; skipped first-pass-only;
 * classification defaults to root).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Store } from '../../src/main/services/store'
import { runFirstPass } from '../../src/main/engine/deploy/firstPass'
import type { DeployPlan, FrozenObjectPlan } from '../../src/main/engine/deploy/planFreeze'
import type {
  DeployIo,
  ObjectPassContext,
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

// OLI ids for the skip fixture
const PBE_INACTIVE = '01u000000000001AAA'
const IDS = ['001000000000001AAA', '001000000000002AAA', '001000000000003AAA', '001000000000004AAA', '001000000000005AAA']

function makeIo(opts: {
  sourceDescribe: DescribeField[]
  pages: QueryPage[]
  onQueryTarget?: (soql: string) => Array<Record<string, unknown>> | undefined
  onUpsert?: (records: Array<Record<string, unknown>>) => UpsertBatchResult
}): DeployIo {
  async function* arr(rows: Array<Record<string, unknown>>): AsyncGenerator<Record<string, unknown>> {
    for (const r of rows) yield r
  }
  return {
    describeSource: () => Promise.resolve(opts.sourceDescribe),
    describeTarget: () => Promise.resolve(opts.sourceDescribe),
    querySourcePages: () =>
      (async function* (): AsyncGenerator<QueryPage> {
        for (const p of opts.pages) yield p
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
    insertCompositeBatch: () => Promise.reject(new Error('junction raw seam (E4E.5) — not used here')),
    store: store.deploy,
    emit: () => {},
    now: () => new Date(0),
    sleep: () => Promise.resolve()
  }
}

function newRun(planJson: string): number {
  const deploymentId = store.createDeployment({
    name: 'Acme',
    sourceConnectionId: 'src',
    targetConnectionId: 'tgt'
  })
  const plan = store.deploy.savePlan(deploymentId, planJson, 'hash-e4e2')
  return store.deploy.createRun(deploymentId, plan.id).id
}

describe('firstPass → real counter views (E4E.2 AC)', () => {
  it('5-record OLI page (3 success, 1 failed, 1 skipped) → the exact Apex sextet', async () => {
    const plan: DeployPlan = {
      objects: [
        frozenObject('OpportunityLineItem', ['UnitPrice', 'PricebookEntryId'], {
          mappings: {
            PricebookEntryId: { strategy: 'directId', matchField: null, customValue: null }
          }
        })
      ],
      warnings: [],
      totalObjects: 1,
      totalRecords: 5
    }
    const runId = newRun(JSON.stringify(plan))
    const failExt = generateExternalId(IDS[3]!)

    const io = makeIo({
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
            { Id: IDS[0], UnitPrice: 1, PricebookEntryId: '01u000000000009AAA' },
            { Id: IDS[1], UnitPrice: 2, PricebookEntryId: '01u000000000009AAA' },
            { Id: IDS[2], UnitPrice: 3, PricebookEntryId: '01u000000000009AAA' },
            { Id: IDS[3], UnitPrice: 4, PricebookEntryId: '01u000000000009AAA' }, // upsert-fails
            { Id: IDS[4], UnitPrice: 5, PricebookEntryId: PBE_INACTIVE } // transform-skips
          ],
          totalSize: 5
        }
      ],
      onQueryTarget: (soql) => {
        if (soql.includes('FROM PricebookEntry WHERE IsActive = false')) {
          return [{ Id: PBE_INACTIVE, Product2Id: '01t000000000001AAA', Pricebook2Id: '01s000000000001AAA' }]
        }
        return []
      },
      onUpsert: (records) => ({
        successCount: records.length - 1,
        failureCount: 1,
        errorDetails: [`${failExt} → FIELD_INTEGRITY_EXCEPTION: boom; `],
        failedExternalIds: [failExt],
        typedErrors: [
          { extId: failExt, statusCode: 'FIELD_INTEGRITY_EXCEPTION', message: 'boom', fields: [] }
        ]
      })
    })

    const ctx: ObjectPassContext = {
      runId,
      object: {
        objectName: 'OpportunityLineItem',
        sortOrder: 1,
        hasCircularReference: false,
        isJunction: false,
        recordCount: 5
      },
      passKind: 'first',
      objectAttempt: 0,
      retryPass: 0,
      io
    }
    await runFirstPass(plan, ctx)

    // The Apex accumulators for this page (DDQ L1968-2013):
    //   Records_Queried  = recordCount(4) + batchSkipCount(1) = 5
    //   Records_Deployed = 3, Records_Failed = 1 (root-default), Skipped = 1
    const counters = store.deploy.objectCounters(runId)
    expect(counters).toEqual([
      {
        runId,
        objectApiName: 'OpportunityLineItem',
        recordsQueried: 5,
        recordsDeployed: 3,
        recordsFailed: 1,
        recordsFailedRoot: 1,
        recordsFailedCascade: 0,
        recordsSkipped: 1
      }
    ])
    const run = store.deploy.runCounters(runId)
    expect(run).toMatchObject({ recordsQueried: 5, recordsDeployed: 3, recordsFailed: 1, recordsSkipped: 1 })

    // failed_records carries the retry input for E4E.3; the classifier stamps
    // root (no FK-to-failed-parent pattern in the error line).
    const failures = store.deploy.listFailures(runId, 'OpportunityLineItem', 0, 0)
    expect(failures).toEqual([{ sourceId: IDS[3], classification: 'root' }])
  })

  it('two pages append within the same attempt (multi-batch accumulation)', async () => {
    const plan: DeployPlan = {
      objects: [frozenObject('Account', ['Name'])],
      warnings: [],
      totalObjects: 1,
      totalRecords: 4
    }
    const runId = newRun(JSON.stringify(plan))
    const io = makeIo({
      sourceDescribe: [fld('Name')],
      pages: [
        { records: [{ Id: IDS[0], Name: 'a' }, { Id: IDS[1], Name: 'b' }], totalSize: 4 },
        { records: [{ Id: IDS[2], Name: 'c' }, { Id: IDS[3], Name: 'd' }], totalSize: 4 }
      ]
    })
    const ctx: ObjectPassContext = {
      runId,
      object: { objectName: 'Account', sortOrder: 1, hasCircularReference: false, isJunction: false, recordCount: 4 },
      passKind: 'first',
      objectAttempt: 0,
      retryPass: 0,
      io
    }
    await runFirstPass(plan, ctx)
    expect(store.deploy.objectCounters(runId)[0]).toMatchObject({
      recordsQueried: 4,
      recordsDeployed: 4,
      recordsFailed: 0,
      recordsSkipped: 0
    })
  })

  it('a bounded whole-object rerun at attempt 1 supersedes attempt 0 rows (views count latest only)', async () => {
    const plan: DeployPlan = {
      objects: [frozenObject('Account', ['Name'])],
      warnings: [],
      totalObjects: 1,
      totalRecords: 2
    }
    const runId = newRun(JSON.stringify(plan))
    const failExt = generateExternalId(IDS[1]!)

    // Attempt 0: 1 success + 1 failure.
    const io0 = makeIo({
      sourceDescribe: [fld('Name')],
      pages: [{ records: [{ Id: IDS[0], Name: 'a' }, { Id: IDS[1], Name: 'b' }], totalSize: 2 }],
      onUpsert: (records) => ({
        successCount: records.length - 1,
        failureCount: 1,
        errorDetails: [`${failExt} → X: y; `],
        failedExternalIds: [failExt],
        typedErrors: [{ extId: failExt, statusCode: 'X', message: 'y', fields: [] }]
      })
    })
    const baseCtx = {
      runId,
      object: { objectName: 'Account', sortOrder: 1, hasCircularReference: false, isJunction: false, recordCount: 2 },
      passKind: 'first' as const,
      retryPass: 0
    }
    await runFirstPass(plan, { ...baseCtx, objectAttempt: 0, io: io0 })
    expect(store.deploy.objectCounters(runId)[0]).toMatchObject({ recordsFailed: 1 })

    // Attempt 1 (the orchestrator's bounded rerun): clean pass — the old
    // attempt's failure disappears from the counters (Apex zeroed all six).
    const io1 = makeIo({
      sourceDescribe: [fld('Name')],
      pages: [{ records: [{ Id: IDS[0], Name: 'a' }, { Id: IDS[1], Name: 'b' }], totalSize: 2 }]
    })
    await runFirstPass(plan, { ...baseCtx, objectAttempt: 1, io: io1 })
    expect(store.deploy.objectCounters(runId)[0]).toMatchObject({
      recordsQueried: 2,
      recordsDeployed: 2,
      recordsFailed: 0,
      recordsSkipped: 0
    })
    expect(store.deploy.maxObjectAttempt(runId, 'Account')).toBe(1)
  })
})
