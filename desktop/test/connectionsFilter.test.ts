/**
 * S70 (UAT U-2 / U-3): the Org Connections list filter — pure lane.
 */
import { describe, it, expect } from 'vitest'
import {
  effectiveRole,
  filterConnections,
  instanceHost,
  matchesConnectionQuery,
  ROLE_FILTERS
} from '../src/shared/connectionsFilter'
import type { OrgConnection } from '../src/shared/types'

function org(over: Partial<OrgConnection>): OrgConnection {
  return {
    id: over.id ?? 'id',
    label: 'srcbox_1',
    cliAlias: 'srcbox_1',
    loginUrl: null,
    username: 'jack@srcbox.example',
    orgId: '00D000000000FakeAA',
    instanceUrl: 'https://srcbox.my.salesforce.com',
    role: 'source',
    authKind: 'cli',
    status: 'Active',
    cliStatus: 'Connected',
    isSandbox: true,
    lastVerifiedAt: null,
    prodPinned: false,
    supersededBy: null,
    ...over
  } as OrgConnection
}

describe('matchesConnectionQuery', () => {
  const o = org({})
  it('matches label, alias, username, org Id and instance host, case-insensitively', () => {
    expect(matchesConnectionQuery(o, 'SRCBOX_1')).toBe(true)
    expect(matchesConnectionQuery(o, 'jack@')).toBe(true)
    expect(matchesConnectionQuery(o, '00d000000000fake')).toBe(true)
    expect(matchesConnectionQuery(o, 'srcbox.my.salesforce')).toBe(true)
  })
  it('does not match the URL scheme and ignores surrounding whitespace', () => {
    expect(matchesConnectionQuery(o, 'https')).toBe(false)
    expect(matchesConnectionQuery(o, '  jack  ')).toBe(true)
  })
  it('an empty query matches everything, including rows with null fields', () => {
    expect(matchesConnectionQuery(org({ cliAlias: null, username: '', orgId: '', instanceUrl: '' }), '')).toBe(true)
    expect(matchesConnectionQuery(org({ cliAlias: null, username: '', orgId: '', instanceUrl: '' }), 'zz')).toBe(false)
  })
})

describe('instanceHost', () => {
  it('returns the host, the raw string when unparseable, and "" for empty', () => {
    expect(instanceHost('https://a.my.salesforce.com/')).toBe('a.my.salesforce.com')
    expect(instanceHost('not a url')).toBe('not a url')
    expect(instanceHost(null)).toBe('')
  })
})

describe('effectiveRole + filterConnections', () => {
  const rows = [
    org({ id: 'a', label: 'prod', role: 'unassigned', prodPinned: true }),
    org({ id: 'b', label: 'tgt_a', role: 'target', username: 'jack@tgt.example' }),
    org({ id: 'c', label: 'spare', role: 'unassigned' }),
    org({ id: 'd', label: 'srcbox_2', role: 'source' })
  ]
  it('a prod-pinned org is a source whatever its stored role', () => {
    expect(effectiveRole(rows[0]!)).toBe('source')
    expect(effectiveRole(rows[2]!)).toBe('unassigned')
  })
  it('role filter uses the effective role; "all" keeps every row', () => {
    expect(filterConnections(rows, { query: '', role: 'all' }).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(filterConnections(rows, { query: '', role: 'source' }).map((r) => r.id)).toEqual(['a', 'd'])
    expect(filterConnections(rows, { query: '', role: 'target' }).map((r) => r.id)).toEqual(['b'])
    expect(filterConnections(rows, { query: '', role: 'unassigned' }).map((r) => r.id)).toEqual(['c'])
  })
  it('query and role combine', () => {
    expect(filterConnections(rows, { query: 'tgt', role: 'target' }).map((r) => r.id)).toEqual(['b'])
    expect(filterConnections(rows, { query: 'tgt', role: 'source' })).toEqual([])
  })
  it('the control offers exactly all + the three roles, in that order', () => {
    expect(ROLE_FILTERS.map((f) => f.value)).toEqual(['all', 'source', 'target', 'unassigned'])
  })
})
