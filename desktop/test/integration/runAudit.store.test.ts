/**
 * S53 (item 1) — store side of the run audit (sqlite lane: `npm run rebuild:node`
 * first). Migration 010: findings table + the audit stamp on deploy_runs, and
 * their surfacing through buildDeployRunState.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Store } from '../../src/main/services/store'
import { buildDeployRunState } from '../../src/main/services/deployRunState'
import { JobManager } from '../../src/main/jobs'

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
    name: 'acme',
    sourceConnectionId: 'src',
    targetConnectionId: 'tgt'
  })
  const plan = store.deploy.savePlan(deploymentId, '{"objects":[],"totalRecords":0}', 'h')
  const run = store.deploy.createRun(deploymentId, plan.id)
  store.setCurrentRun(deploymentId, run.id)
  return { deploymentId, runId: run.id }
}

describe('run audit findings (migration 010)', () => {
  it('round-trips findings in insertion order, sample ids as JSON', () => {
    const { runId } = newRun()
    store.deploy.recordAuditFindings(runId, [
      {
        kind: 'pre_run_unkeyed',
        objectApiName: 'SBQQ__QuoteLine__c',
        refObject: 'SBQQ__Quote__c',
        refField: 'SBQQ__Quote__c',
        count: 137,
        sampleIds: []
      },
      {
        kind: 'automation_born',
        objectApiName: 'OpportunityLineItem',
        refObject: null,
        refField: null,
        count: 59,
        sampleIds: ['00k1', '00k2']
      }
    ])
    expect(store.deploy.auditFindings(runId)).toEqual([
      {
        kind: 'pre_run_unkeyed',
        objectApiName: 'SBQQ__QuoteLine__c',
        refObject: 'SBQQ__Quote__c',
        refField: 'SBQQ__Quote__c',
        count: 137,
        sampleIds: []
      },
      {
        kind: 'automation_born',
        objectApiName: 'OpportunityLineItem',
        refObject: null,
        refField: null,
        count: 59,
        sampleIds: ['00k1', '00k2']
      }
    ])
  })

  it('empty input writes nothing; unknown run reads empty', () => {
    const { runId } = newRun()
    store.deploy.recordAuditFindings(runId, [])
    expect(store.deploy.auditFindings(runId)).toEqual([])
    expect(store.deploy.auditFindings(999)).toEqual([])
  })

  it('audit stamp: null until marked; note null = clean', () => {
    const { runId } = newRun()
    expect(store.deploy.auditStatus(runId)).toEqual({ completedAt: null, note: null })
    store.deploy.markAuditComplete(runId, null)
    const s = store.deploy.auditStatus(runId)
    expect(s.completedAt).toBeGreaterThan(0)
    expect(s.note).toBeNull()
    store.deploy.markAuditComplete(runId, 'skipped: no user')
    expect(store.deploy.auditStatus(runId).note).toBe('skipped: no user')
    expect(() => store.deploy.markAuditComplete(999, null)).toThrow(/not found/)
  })

  it('findings cascade away with the run when the deployment is deleted', () => {
    const { deploymentId, runId } = newRun()
    store.deploy.recordAuditFindings(runId, [
      {
        kind: 'automation_born',
        objectApiName: 'Asset',
        refObject: null,
        refField: null,
        count: 1,
        sampleIds: []
      }
    ])
    // A run exists, so the F4 guard refuses a normal delete — remove the run
    // row directly to exercise the FK cascade.
    store.deploy.setRunPhase(runId, 'Failed')
    ;(store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
      .prepare('DELETE FROM deploy_runs WHERE id = ?')
      .run(runId)
    expect(store.deploy.auditFindings(runId)).toEqual([])
    void deploymentId
  })

  it('buildDeployRunState surfaces the audit for the current run', () => {
    const { deploymentId, runId } = newRun()
    store.deploy.setRunPhase(runId, 'Deploying')
    store.deploy.setRunPhase(runId, 'Completed')
    store.deploy.recordAuditFindings(runId, [
      {
        kind: 'automation_born',
        objectApiName: 'OpportunityLineItem',
        refObject: null,
        refField: null,
        count: 59,
        sampleIds: ['00k1']
      }
    ])
    store.deploy.markAuditComplete(runId, null)
    const view = buildDeployRunState(store, new JobManager(() => {}), deploymentId)
    expect(view.audit?.completedAt).toBeGreaterThan(0)
    expect(view.audit?.note).toBeNull()
    expect(view.audit?.findings).toEqual([
      {
        kind: 'automation_born',
        objectApiName: 'OpportunityLineItem',
        refObject: null,
        refField: null,
        count: 59,
        sampleIds: ['00k1']
      }
    ])
  })

  it('no run → audit null', () => {
    const deploymentId = store.createDeployment({
      name: 'draft',
      sourceConnectionId: 'src',
      targetConnectionId: 'tgt'
    })
    expect(buildDeployRunState(store, new JobManager(() => {}), deploymentId).audit).toBeNull()
  })
})
