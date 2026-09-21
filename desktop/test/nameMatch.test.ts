import { describe, it, expect } from 'vitest'
import {
  getResolverMatchField,
  effectiveMatchField,
  buildNameToId,
  resolveNameToTargetMap,
  resolveNameMatch,
  buildNameMatchMaps,
  RESOLVER_DEFAULT_MATCH_FIELDS,
  type NameMatchIo,
  type NameMatchQueryOpts
} from '../src/main/engine/deploy/transform/nameMatch'
import type { GoldenFieldInfo, GoldenMapping } from '../src/main/engine/deploy/golden/fixture'

/**
 * E4X.5 — NameMatchResolver port unit suite. Mocked-IO responses cover the AC:
 * duplicate match values (last-wins), inactive RecordTypes (source-incl vs
 * target-active asymmetry), sandbox-suffixed usernames (no match → drop), the
 * RecordTypeId force-by-DeveloperName, default-match-field null-skip, and the
 * A13/A14 map-building loop (dedup + RT force).
 */

interface RecordedCall {
  role: 'source' | 'target'
  objectName: string
  matchField: string
  opts: NameMatchQueryOpts
}

type Responder = (
  role: 'source' | 'target',
  objectName: string,
  matchField: string,
  opts: NameMatchQueryOpts
) => Array<Record<string, unknown>>

function mockIo(responder: Responder): { io: NameMatchIo; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const io: NameMatchIo = {
    async queryNames(role, objectName, matchField, opts) {
      calls.push({ role, objectName, matchField, opts })
      return responder(role, objectName, matchField, opts)
    }
  }
  return { io, calls }
}

const rf = (apiName: string, referenceTo: string): GoldenFieldInfo => ({
  apiName,
  dataType: 'reference',
  isCreateable: true,
  isNillable: true,
  isReference: true,
  referenceTo: [referenceTo],
  relationshipName: null,
  isAutoNumber: false,
  isCalculated: false,
  isExternalId: false,
  isRestrictedPicklist: false
})

const map = (strategy: string, matchField: string | null = null): GoldenMapping => ({
  strategy,
  matchField,
  customValue: null
})

describe('getResolverMatchField / effectiveMatchField', () => {
  it('carries BusinessHours/Organization (unlike the UI table) and returns null for unknowns', () => {
    expect(getResolverMatchField('RecordType')).toBe('DeveloperName')
    expect(getResolverMatchField('User')).toBe('Username')
    expect(getResolverMatchField('BusinessHours')).toBe('Name')
    expect(getResolverMatchField('Organization')).toBe('Name')
    expect(getResolverMatchField('Widget__c')).toBeNull()
    expect(RESOLVER_DEFAULT_MATCH_FIELDS.Product2).toBe('ProductCode')
  })

  it('prefers a caller-provided field, else the default, else null', () => {
    expect(effectiveMatchField('User', 'Email')).toBe('Email')
    expect(effectiveMatchField('User', '   ')).toBe('Username') // blank → default
    expect(effectiveMatchField('User', null)).toBe('Username')
    expect(effectiveMatchField('Widget__c', null)).toBeNull() // unknown + blank → null
  })
})

describe('buildNameToId', () => {
  it('maps matchValue → recordId, LAST duplicate wins', () => {
    const m = buildNameToId(
      [
        { Id: '001A', Name: 'Acme' },
        { Id: '001B', Name: 'Beta' },
        { Id: '001C', Name: 'Acme' } // dup 'Acme' → last (001C) wins
      ],
      'Name'
    )
    expect(m.get('Acme')).toBe('001C')
    expect(m.get('Beta')).toBe('001B')
    expect(m.size).toBe(2)
  })

  it('skips rows with a null Id or a null/absent match value', () => {
    const m = buildNameToId(
      [
        { Id: null, Name: 'X' },
        { Id: '001A', Name: null },
        { Id: '001B' }, // no Name key
        { Id: '001C', Name: 'Keep' }
      ],
      'Name'
    )
    expect([...m.entries()]).toEqual([['Keep', '001C']])
  })

  it('stringifies the match value via apexStringValueOf and keeps keys case-SENSITIVE', () => {
    const m = buildNameToId(
      [
        { Id: '001A', Code: 42 },
        { Id: '001B', Code: true },
        { Id: '001c', Name: 'Hot' },
        { Id: '001d', Name: 'hot' }
      ],
      'Code'
    )
    expect(m.get('42')).toBe('001A')
    expect(m.get('true')).toBe('001B')
    const byName = buildNameToId(
      [
        { Id: '1', Name: 'Hot' },
        { Id: '2', Name: 'hot' }
      ],
      'Name'
    )
    expect(byName.get('Hot')).toBe('1')
    expect(byName.get('hot')).toBe('2') // distinct keys — case-sensitive
  })
})

describe('resolveNameToTargetMap', () => {
  it('maps sourceId → targetId on matching names and drops unmatched source names', () => {
    const src = new Map([
      ['Business', '012src_active'],
      ['Legacy', '012src_inactive']
    ])
    const tgt = new Map([['Business', '012tgt_active']]) // Legacy absent (target active-only)
    expect(resolveNameToTargetMap(src, tgt)).toEqual({ '012src_active': '012tgt_active' })
  })
})

describe('resolveNameMatch — RecordType asymmetry', () => {
  it('resolves active RTs, drops a source-inactive RT missing from the active target, and queries with the right opts', async () => {
    const { io, calls } = mockIo((role) =>
      role === 'source'
        ? [
            { Id: '012srcA', DeveloperName: 'Business' },
            { Id: '012srcL', DeveloperName: 'Legacy' } // inactive on target
          ]
        : [{ Id: '012tgtA', DeveloperName: 'Business' }] // target active-only
    )
    const out = await resolveNameMatch(io, 'RecordType', 'DeveloperName', 'Account')
    expect(out).toEqual({ '012srcA': '012tgtA' })

    const source = calls.find((c) => c.role === 'source')!
    const target = calls.find((c) => c.role === 'target')!
    expect(source.opts).toEqual({ sObjectType: 'Account', activeOnly: false })
    expect(target.opts).toEqual({ sObjectType: 'Account', activeOnly: true }) // RT target → active-only
  })

  it('applies no SObjectType filter when the RecordType context is blank', async () => {
    const { io, calls } = mockIo(() => [])
    await resolveNameMatch(io, 'RecordType', 'DeveloperName', null)
    expect(calls.every((c) => c.opts.sObjectType === null)).toBe(true)
    expect(calls.find((c) => c.role === 'target')!.opts.activeOnly).toBe(true)
  })
})

describe('resolveNameMatch — User (sandbox-suffixed usernames)', () => {
  it('matches identical usernames and drops sandbox-suffixed mismatches; target is NOT active-filtered', async () => {
    const { io, calls } = mockIo((role) =>
      role === 'source'
        ? [
            { Id: '005srcJoe', Username: 'joe@acme.com' },
            { Id: '005srcAmy', Username: 'amy@acme.com' }
          ]
        : [
            { Id: '005tgtJoe', Username: 'joe@acme.com' },
            { Id: '005tgtAmy', Username: 'amy@acme.com.sandbox' } // suffixed → no match
          ]
    )
    const out = await resolveNameMatch(io, 'User', 'Username')
    expect(out).toEqual({ '005srcJoe': '005tgtJoe' })
    // User is not a RecordType → neither side is active-filtered, no SObjectType.
    for (const c of calls) expect(c.opts).toEqual({ sObjectType: null, activeOnly: false })
  })

  it('ignores an SObjectType context on a non-RecordType object', async () => {
    const { io, calls } = mockIo(() => [])
    await resolveNameMatch(io, 'User', 'Username', 'Account')
    expect(calls.every((c) => c.opts.sObjectType === null)).toBe(true)
  })
})

describe('resolveNameMatch — no effective match field', () => {
  it('returns an empty map WITHOUT querying when the object is unknown and no field is given', async () => {
    const { io, calls } = mockIo(() => [{ Id: 'x', Name: 'y' }])
    const out = await resolveNameMatch(io, 'Widget__c', null)
    expect(out).toEqual({})
    expect(calls).toHaveLength(0)
  })
})

describe('buildNameMatchMaps — A13/A14 loop', () => {
  // source and target share exactly one match value ('v') so each resolve yields
  // out = { src_<obj>: tgt_<obj> } — enough to assert WHICH objects got resolved.
  const shared: Responder = (role, objectName) =>
    [{ Id: `${role === 'source' ? 'src' : 'tgt'}_${objectName}`, DeveloperName: 'v', Name: 'v', Username: 'v', ProductCode: 'v' }]

  it('resolves each nameMatch reference once and skips non-nameMatch / non-reference fields', async () => {
    const { io, calls } = mockIo(shared)
    const out = await buildNameMatchMaps(
      io,
      'Opportunity',
      [
        rf('Pricebook2Id', 'Pricebook2'),
        rf('OwnerId', 'User'),
        rf('AccountId', 'Account'), // directId → not resolved
        { ...rf('Amount', 'X'), isReference: false } // non-reference → skipped
      ],
      {
        Pricebook2Id: map('nameMatch'),
        OwnerId: map('nameMatch'),
        AccountId: map('directId')
      }
    )
    expect(Object.keys(out).sort()).toEqual(['Pricebook2', 'User'])
    expect(out.Pricebook2).toEqual({ src_Pricebook2: 'tgt_Pricebook2' })
    const resolved = calls.filter((c) => c.role === 'source').map((c) => c.objectName)
    expect(resolved.sort()).toEqual(['Pricebook2', 'User'])
  })

  it('dedups two fields referencing the same object (resolved once)', async () => {
    const { io, calls } = mockIo(shared)
    await buildNameMatchMaps(
      io,
      'Opportunity',
      [rf('OwnerId', 'User'), rf('Creator__c', 'User')],
      { OwnerId: map('nameMatch'), Creator__c: map('nameMatch') }
    )
    expect(calls.filter((c) => c.role === 'source' && c.objectName === 'User')).toHaveLength(1)
  })

  it('force-resolves RecordType by DeveloperName even with no saved mapping (A14)', async () => {
    const { io, calls } = mockIo(shared)
    const out = await buildNameMatchMaps(
      io,
      'Account',
      [rf('RecordTypeId', 'RecordType')], // no mapping entry at all
      {}
    )
    expect(out).toHaveProperty('RecordType')
    const rtCall = calls.find((c) => c.role === 'source' && c.objectName === 'RecordType')!
    expect(rtCall.matchField).toBe('DeveloperName')
    expect(rtCall.opts.sObjectType).toBe('Account')
    // target side active-only for RecordType
    expect(calls.find((c) => c.role === 'target' && c.objectName === 'RecordType')!.opts.activeOnly).toBe(
      true
    )
  })

  it('does not double-resolve RecordType when a custom RT nameMatch field already resolved it', async () => {
    const { io, calls } = mockIo(shared)
    await buildNameMatchMaps(
      io,
      'Account',
      [rf('RecordTypeId', 'RecordType'), rf('Custom_RT__c', 'RecordType')],
      { Custom_RT__c: map('nameMatch', 'DeveloperName') }
    )
    const rtSource = calls.filter((c) => c.role === 'source' && c.objectName === 'RecordType')
    expect(rtSource).toHaveLength(1)
    // A13 path (resolved via the mapped Custom_RT__c, not the A14 force) still
    // passes the owning object as the SObjectType context.
    expect(rtSource[0]!.opts.sObjectType).toBe('Account')
  })

  it('forwards a custom cfg.matchField to the resolve (not just the default)', async () => {
    const { io, calls } = mockIo(shared)
    await buildNameMatchMaps(io, 'Opportunity', [rf('OwnerId', 'User')], {
      OwnerId: map('nameMatch', 'Email')
    })
    const src = calls.find((c) => c.role === 'source' && c.objectName === 'User')!
    expect(src.matchField).toBe('Email') // NOT the 'Username' default
  })
})
