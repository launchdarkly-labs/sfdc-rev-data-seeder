/**
 * E4A.6 — automation_ledger_mirror facade methods on DeployStore: write-ahead
 * (transactional, fail-loud), disabled/confirmed stamps, the unconfirmed work
 * list, the E4E.6 launch-recovery scan, and the §4.3(2) run-scoped
 * deployedSourceIds accessor the Contract-activation ExtId scope is built from
 * (S46 E1 — the target-Id variant was removed: the upsert path never records
 * target ids, so it selected nothing live).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Store } from '../../src/main/services/store'

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

function newRun(): { deploymentId: number; runId: number } {
  const deploymentId = store.createDeployment({
    name: 'Acme',
    sourceConnectionId: 'src',
    targetConnectionId: 'tgt'
  })
  const plan = store.deploy.savePlan(deploymentId, '{"objects":[]}', 'hash-1')
  const run = store.deploy.createRun(deploymentId, plan.id)
  return { deploymentId, runId: run.id }
}

const rows = [
  {
    itemType: 'ValidationRule',
    itemId: '03d000000000001',
    itemName: 'VR_1',
    restoreVersionNumber: null,
    detail: '{"objectName":"Account"}'
  },
  {
    itemType: 'Flow',
    itemId: '301000000000001',
    itemName: 'Flow_1',
    restoreVersionNumber: 7,
    detail: null
  },
  {
    itemType: 'DuplicateRule',
    itemId: null, // fullName-keyed — the 18-char Item_Id trap is dead by design
    itemName: 'Account.Standard_Account_Duplicate_Rule_With_A_Very_Long_FullName',
    restoreVersionNumber: null,
    detail: null
  }
]

describe('automation ledger mirror (E4A.6)', () => {
  it('writeAhead inserts rows and returns ids in input order; unconfirmed returns them until confirmed', () => {
    const { deploymentId } = newRun()
    const ids = store.deploy.ledgerWriteAhead(deploymentId, 'run-1', rows)
    expect(ids).toHaveLength(3)

    const unconfirmed = store.deploy.ledgerUnconfirmed('run-1')
    expect(unconfirmed.map((r) => r.itemType)).toEqual(['ValidationRule', 'Flow', 'DuplicateRule'])
    expect(unconfirmed[1]!.restoreVersionNumber).toBe(7)
    expect(unconfirmed[2]!.itemId).toBeNull()
    expect(unconfirmed[2]!.itemName).toContain('Very_Long_FullName') // no truncation

    store.deploy.ledgerConfirmRestored([ids[0]!, ids[1]!])
    expect(store.deploy.ledgerUnconfirmed('run-1').map((r) => r.itemName)).toEqual([
      rows[2]!.itemName
    ])
  })

  it('rows are scoped by run_uuid — a second run never sees the first run’s work list', () => {
    const { deploymentId } = newRun()
    store.deploy.ledgerWriteAhead(deploymentId, 'run-1', [rows[0]!])
    store.deploy.ledgerWriteAhead(deploymentId, 'run-2', [rows[1]!])
    expect(store.deploy.ledgerUnconfirmed('run-1').map((r) => r.itemType)).toEqual([
      'ValidationRule'
    ])
    expect(store.deploy.ledgerUnconfirmed('run-2').map((r) => r.itemType)).toEqual(['Flow'])
  })

  it('writeAhead THROWS for an unknown deployment (fail-loud, D4)', () => {
    expect(() => store.deploy.ledgerWriteAhead(9999, 'run-x', rows)).toThrow('not found')
  })

  it('ledgerMarkDisabled stamps disabled_at without touching confirmation', () => {
    const { deploymentId } = newRun()
    const ids = store.deploy.ledgerWriteAhead(deploymentId, 'run-1', [rows[0]!])
    store.deploy.ledgerMarkDisabled(ids)
    expect(store.deploy.ledgerUnconfirmed('run-1')).toHaveLength(1) // still unconfirmed
  })

  it('ledgerUnconfirmedAll groups the launch-recovery scan by run/deployment (E4E.6)', () => {
    const { deploymentId } = newRun()
    const ids = store.deploy.ledgerWriteAhead(deploymentId, 'run-1', rows)
    store.deploy.ledgerWriteAhead(deploymentId, 'run-2', [rows[0]!])
    store.deploy.ledgerConfirmRestored(ids) // run-1 fully restored
    const scan = store.deploy.ledgerUnconfirmedAll()
    expect(scan).toEqual([{ runUuid: 'run-2', deploymentId, count: 1 }])
  })

  it('deployedSourceIds returns current-truth success SOURCE ids for the object — with target_id NULL, as the upsert path records them (§4.3(2) activation scope, S46 E1)', () => {
    const { runId } = newRun()
    store.deploy.recordResults(runId, [
      {
        objectApiName: 'Contract',
        sourceId: '800S1',
        targetId: null, // the first-pass upsert never knows the target id
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'success',
        errorCode: null,
        errorMessage: null
      },
      {
        objectApiName: 'Contract',
        sourceId: '800S2',
        targetId: null,
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'failed',
        errorCode: 'X',
        errorMessage: 'nope'
      },
      {
        objectApiName: 'Account',
        sourceId: '001S1',
        targetId: null,
        pass: 1,
        retryPass: 0,
        objectAttempt: 0,
        outcome: 'success',
        errorCode: null,
        errorMessage: null
      }
    ])
    expect(store.deploy.deployedSourceIds(runId, 'Contract')).toEqual(['800S1'])
    // A healed retry counts; a regression does not (latest row per record).
    store.deploy.recordResults(runId, [
      {
        objectApiName: 'Contract',
        sourceId: '800S2',
        targetId: null,
        pass: 1,
        retryPass: 1,
        objectAttempt: 0,
        outcome: 'success',
        errorCode: null,
        errorMessage: null
      }
    ])
    expect(store.deploy.deployedSourceIds(runId, 'Contract')).toEqual(['800S1', '800S2'])
  })
})

describe('review pins (E4A.6/5B.9 adversarial review)', () => {
  it('ledgerMarkDisabled really stamps disabled_at in SQL — and only on the given ids', () => {
    const { deploymentId } = newRun()
    const ids = store.deploy.ledgerWriteAhead(deploymentId, 'run-1', [rows[0]!, rows[1]!])
    store.deploy.ledgerMarkDisabled([ids[0]!])
    const back = store.deploy.ledgerUnconfirmed('run-1')
    expect(back.find((r) => r.id === ids[0])!.disabledAt).toBeGreaterThan(0)
    expect(back.find((r) => r.id === ids[1])!.disabledAt).toBeNull()
  })

  it('ledgerWriteAhead is TRANSACTIONAL — a mid-batch constraint failure persists ZERO rows (D4 fail-loud, no phantom work list)', () => {
    const { deploymentId } = newRun()
    expect(() =>
      store.deploy.ledgerWriteAhead(deploymentId, 'run-1', [
        rows[0]!,
        { ...rows[1]!, itemName: null as unknown as string } // NOT NULL violation mid-batch
      ])
    ).toThrow()
    expect(store.deploy.ledgerUnconfirmed('run-1')).toEqual([])
    expect(store.deploy.ledgerUnconfirmedAll()).toEqual([])
  })
})
