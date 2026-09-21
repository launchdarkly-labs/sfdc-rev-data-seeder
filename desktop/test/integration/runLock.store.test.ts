/**
 * S53 (item 2) — store side of the per-target-org run lock (sqlite lane:
 * `npm run rebuild:node` first). `deploymentsSharingTarget` must unify every
 * deployment whose target connection is the same ORG — including a superseded
 * alias and its live sibling (S52 F3: `onesolve` + `one_solve`, one org id) —
 * and must never return the deployment itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Store } from '../../src/main/services/store'

let store: Store

const cli = (alias: string, username: string, orgId: string) => ({
  alias,
  username,
  orgId,
  instanceUrl: `https://${alias}.my.salesforce.com`,
  connectedStatus: 'Connected',
  isSandbox: true as boolean | null
})

beforeEach(() => {
  store = new Store(':memory:')
  store.upsertConnections([
    cli('darkb_911', 'jz@ld.darkbox', '00DiY00000060gTUAQ'),
    cli('onesolve', 'jz@ld.onesolve', '00DTI000007RRUj2AO'),
    cli('one_solve', 'jz@ld.onesolve', '00DTI000007RRUj2AO'), // same org, renamed alias
    cli('sb1_830', 'jz@ld.jacksb1', '00DiY0000001vR9UAI')
  ])
})
afterEach(() => store.close())

const dep = (name: string, target: string): number =>
  store.createDeployment({ name, sourceConnectionId: 'darkb_911', targetConnectionId: target })

describe('Store.deploymentsSharingTarget', () => {
  it('returns the OTHER deployments on the same target connection, never itself', () => {
    const a = dep('11 ts', 'onesolve')
    const b = dep('onetry', 'onesolve')
    dep('stiefff', 'sb1_830')
    expect(store.deploymentsSharingTarget(a)).toEqual([{ id: b, name: 'onetry' }])
    expect(store.deploymentsSharingTarget(b)).toEqual([{ id: a, name: '11 ts' }])
  })

  it('unifies two connection rows for the SAME org id (superseded alias + live sibling)', () => {
    const a = dep('via old alias', 'onesolve')
    const b = dep('via new alias', 'one_solve')
    expect(store.deploymentsSharingTarget(a)).toEqual([{ id: b, name: 'via new alias' }])
  })

  it('does not match a different org', () => {
    const a = dep('a', 'onesolve')
    dep('b', 'sb1_830')
    expect(store.deploymentsSharingTarget(a)).toEqual([])
  })

  it('a connection with a blank org id matches on connection id only', () => {
    store.createOAuthConnection({
      id: 'oauth-1',
      label: 'unverified',
      username: '(verifying…)',
      orgId: '',
      instanceUrl: 'https://x.my.salesforce.com',
      loginUrl: 'https://test.salesforce.com',
      oauthClientId: 'CID',
      isSandbox: true
    })
    store.createOAuthConnection({
      id: 'oauth-2',
      label: 'unverified-2',
      username: '(verifying…)',
      orgId: '',
      instanceUrl: 'https://y.my.salesforce.com',
      loginUrl: 'https://test.salesforce.com',
      oauthClientId: 'CID',
      isSandbox: true
    })
    const a = dep('a', 'oauth-1')
    const b = dep('b', 'oauth-1')
    dep('c', 'oauth-2') // blank org id must NOT unify with oauth-1
    expect(store.deploymentsSharingTarget(a)).toEqual([{ id: b, name: 'b' }])
  })

  it('unknown deployment → empty', () => {
    expect(store.deploymentsSharingTarget(999)).toEqual([])
  })
})
