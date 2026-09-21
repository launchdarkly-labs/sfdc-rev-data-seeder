/**
 * S52 — store side of the role fixes (sqlite lane: `npm run rebuild:node` first).
 *   F1  createDeploymentAssigningRoles: assigns the never-assigned, atomically.
 *   F2  assignDeploymentRoles: the same write for an existing draft.
 *   F3  upsertConnections supersession: alias rename / sandbox refresh leaves a
 *       sibling row; classify it, copy the live org id, carry the role once.
 *   F4  deleteDeployment: a pre-run Failed deletes; one with a run does not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Store } from '../../src/main/services/store'
import { RdsHandlerError } from '../../src/main/errors'

let store: Store

const cli = (alias: string, username: string, orgId: string, connectedStatus = 'Connected') => ({
  alias,
  username,
  orgId,
  instanceUrl: `https://${alias}.my.salesforce.com`,
  connectedStatus,
  isSandbox: true as boolean | null
})

beforeEach(() => {
  store = new Store(':memory:')
  store.upsertConnections([
    cli('darkb_911', 'jz@ld.darkbox', '00DiY00000060gTUAQ'),
    cli('onesolve', 'jz@ld.onesolve', '00DTI000007RRUj2AO'),
    cli('sb1_830', 'jz@ld.jacksb1', '00DiY0000001vR9UAI')
  ])
})
afterEach(() => store.close())

const role = (id: string): string => store.getConnection(id)!.role
const deploymentCount = (): number => store.listDrafts().length

describe('F1 createDeploymentAssigningRoles', () => {
  it('assigns source + target to two unassigned rows and creates the draft', () => {
    const r = store.createDeploymentAssigningRoles({
      name: '11 ts',
      sourceConnectionId: 'darkb_911',
      targetConnectionId: 'onesolve'
    })
    expect(r.assigned).toEqual({ source: true, target: true })
    expect(role('darkb_911')).toBe('source')
    expect(role('onesolve')).toBe('target')
    expect(store.loadDraft(r.id)?.status).toBe('Draft')
  })

  it('a second deployment on the same pair writes nothing', () => {
    store.createDeploymentAssigningRoles({ name: 'a', sourceConnectionId: 'darkb_911', targetConnectionId: 'onesolve' })
    const r = store.createDeploymentAssigningRoles({ name: 'b', sourceConnectionId: 'darkb_911', targetConnectionId: 'onesolve' })
    expect(r.assigned).toEqual({ source: false, target: false })
  })

  it('never re-promotes: a TARGET picked as source refuses and inserts no row', () => {
    store.setRole('sb1_830', 'target')
    const before = deploymentCount()
    expect(() =>
      store.createDeploymentAssigningRoles({
        name: 'bad',
        sourceConnectionId: 'sb1_830',
        targetConnectionId: 'onesolve'
      })
    ).toThrow(RdsHandlerError)
    expect(deploymentCount()).toBe(before) // atomic: nothing half-created
    expect(role('onesolve')).toBe('unassigned') // and the fixable side was NOT written either
  })

  it('never lets prod become a target, even though its stored role is unassigned', () => {
    store.upsertConnections([cli('prod_729', 'jz@ld', '00D41000000UvVnEAK', 'Connected')])
    expect(() =>
      store.createDeploymentAssigningRoles({
        name: 'bad',
        sourceConnectionId: 'darkb_911',
        targetConnectionId: 'prod_729'
      })
    ).toThrow(/production/i)
  })

  it('unknown connection ids are NOT_FOUND', () => {
    expect(() =>
      store.createDeploymentAssigningRoles({
        name: 'x',
        sourceConnectionId: 'nope',
        targetConnectionId: 'onesolve'
      })
    ).toThrow(/Unknown connection: nope/)
  })
})

describe('F2 assignDeploymentRoles', () => {
  it('fixes an old draft created before F1 (dep 21/22 shape)', () => {
    const id = store.createDeployment({
      name: 'old draft',
      sourceConnectionId: 'darkb_911',
      targetConnectionId: 'onesolve'
    })
    expect(role('onesolve')).toBe('unassigned')
    const assigned = store.assignDeploymentRoles(id)
    expect(assigned).toEqual({ source: true, target: true })
    expect(role('onesolve')).toBe('target')
  })

  it('is NOT_FOUND for a missing deployment', () => {
    expect(() => store.assignDeploymentRoles(9999)).toThrow(/not found/)
  })
})

describe('F3 connection supersession on refresh', () => {
  it('marks the old alias superseded, copies the live org id, carries the role once', () => {
    // Jack renamed darkb_829 → darkb_911 across a sandbox refresh. Seed the OLD row
    // with the pre-refresh org id and a role, then enumerate the new alias only.
    store.upsertConnections([cli('darkb_829', 'jz@ld.darkbox', '00DTH000009EAtZ2AW')])
    store.setRole('darkb_829', 'source')
    store.setRole('darkb_911', 'unassigned')

    store.upsertConnections([
      cli('darkb_911', 'jz@ld.darkbox', '00DiY00000060gTUAQ'),
      cli('onesolve', 'jz@ld.onesolve', '00DTI000007RRUj2AO'),
      cli('sb1_830', 'jz@ld.jacksb1', '00DiY0000001vR9UAI')
    ])

    const old = store.getConnection('darkb_829')!
    expect(old.supersededBy).toBe('darkb_911')
    expect(old.orgId).toBe('00DiY00000060gTUAQ') // truthful: same auth now points at the refreshed org
    expect(old.role).toBe('source') // kept — a deployment may still reference this row
    expect(role('darkb_911')).toBe('source') // Decision A: carried over
    expect(store.getConnection('darkb_911')!.supersededBy).toBeNull()
  })

  it('does not overwrite a role the live row already has', () => {
    store.upsertConnections([cli('onesolve_old', 'jz@ld.onesolve', '00DTI000007RRUj2AO')])
    store.setRole('onesolve_old', 'target')
    store.setRole('onesolve', 'source') // the live row was deliberately made a source
    store.upsertConnections([cli('onesolve', 'jz@ld.onesolve', '00DTI000007RRUj2AO')])
    expect(store.getConnection('onesolve_old')!.supersededBy).toBe('onesolve')
    expect(role('onesolve')).toBe('source')
  })

  it('un-supersedes a row when its alias is listed again', () => {
    store.upsertConnections([cli('darkb_829', 'jz@ld.darkbox', '00DTH000009EAtZ2AW')])
    store.upsertConnections([cli('darkb_911', 'jz@ld.darkbox', '00DiY00000060gTUAQ')])
    expect(store.getConnection('darkb_829')!.supersededBy).toBe('darkb_911')
    store.upsertConnections([cli('darkb_829', 'jz@ld.darkbox', '00DiY00000060gTUAQ')])
    expect(store.getConnection('darkb_829')!.supersededBy).toBeNull()
  })

  it("marks a row whose username vanished (sf org logout) as 'Not in CLI'", () => {
    store.upsertConnections([cli('darkb_911', 'jz@ld.darkbox', '00DiY00000060gTUAQ')])
    const gone = store.getConnection('sb1_830')!
    expect(gone.supersededBy).toBeNull()
    expect(gone.cliStatus).toBe('Not in CLI')
    // ...and comes back when listed again.
    store.upsertConnections([cli('sb1_830', 'jz@ld.jacksb1', '00DiY0000001vR9UAI')])
    expect(store.getConnection('sb1_830')!.cliStatus).toBe('Connected')
  })

  it('never carries a role onto a prod row', () => {
    store.upsertConnections([cli('prod_old', 'jz@ld', '00D41000000UvVnEAK')])
    store.setRole('prod_old', 'source')
    store.upsertConnections([cli('prod_729', 'jz@ld', '00D41000000UvVnEAK')])
    expect(store.getConnection('prod_old')!.supersededBy).toBe('prod_729')
    // prodPinned reports 'source' regardless; the stored row must not have been written to.
    expect(store.getConnection('prod_729')!.prodPinned).toBe(true)
  })

  it('a superseded row can be removed once nothing references it, not before', () => {
    store.upsertConnections([cli('darkb_829', 'jz@ld.darkbox', '00DTH000009EAtZ2AW')])
    const id = store.createDeployment({ name: 'uses old', sourceConnectionId: 'darkb_829', targetConnectionId: 'onesolve' })
    store.upsertConnections([cli('darkb_911', 'jz@ld.darkbox', '00DiY00000060gTUAQ'), cli('onesolve', 'jz@ld.onesolve', '00DTI000007RRUj2AO')])
    expect(() => store.deleteConnection('darkb_829')).toThrow(/used by a deployment/)
    store.deleteDeployment(id)
    store.deleteConnection('darkb_829')
    expect(store.getConnection('darkb_829')).toBeUndefined()
  })
})

describe('F4 deleteDeployment (pre-run only)', () => {
  function draft(): number {
    return store.createDeployment({ name: 'd', sourceConnectionId: 'darkb_911', targetConnectionId: 'onesolve' })
  }

  it('deletes a Failed deployment that never ran (dep 23: refused at deploy start)', () => {
    const id = draft()
    store.markDeployStarted(id)
    store.markDeployFailedBeforeRun(id, "Org 'onesolve' cannot be a deploy target (role 'unassigned')")
    expect(store.loadDraft(id)?.status).toBe('Failed')
    expect(store.listDrafts().find((d) => d.id === id)?.runCount).toBe(0)
    store.deleteDeployment(id)
    expect(store.loadDraft(id)).toBeNull()
  })

  it('deletes a Cancelled deployment that never ran', () => {
    const id = draft()
    store.markDeployStarted(id)
    store.markDeployCancelledBeforeRun(id)
    store.deleteDeployment(id)
    expect(store.loadDraft(id)).toBeNull()
  })

  it('refuses a Failed deployment that HAS a run — its evidence stays', () => {
    const id = draft()
    const plan = store.deploy.savePlan(id, '{"objects":[]}', 'hash-1')
    store.deploy.createRun(id, plan.id)
    // Force the mirrored status the way a failed run leaves it.
    store.markDeployStarted(id)
    store.markDeployFailedBeforeRun(id, 'x')
    expect(store.listDrafts().find((d) => d.id === id)?.runCount).toBe(1)
    expect(() => store.deleteDeployment(id)).toThrow(/run history/)
  })
})
