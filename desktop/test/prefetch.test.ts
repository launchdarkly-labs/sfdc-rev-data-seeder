import { describe, it, expect } from 'vitest'
import {
  needsTargetUser,
  fetchInactiveTargetUserIds,
  buildTargetPicklistAllowedValues,
  fetchInactivePbeSubstitutes,
  buildPrefetchContext,
  type PrefetchIo
} from '../src/main/engine/deploy/transform/prefetch'
import type { DescribeField } from '../src/main/engine/deploy/transform/fieldFilter'
import type { GoldenFieldInfo, GoldenMapping } from '../src/main/engine/deploy/golden/fixture'

/**
 * E4X.6 — prefetch bundle suite (Apex DDQ L1621-1679, L2314-2474). Headline is
 * the fail-LOUD (inactive users) vs fail-OPEN (PBE subs) split, plus dual-form
 * 15/18 Ids and (Product2, Pricebook2) substitute matching.
 */

const gf = (apiName: string, o: Partial<GoldenFieldInfo> = {}): GoldenFieldInfo => ({
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
  ...o
})

const dfPicklist = (apiName: string, values: string[] | null, restricted = true): DescribeField => ({
  ...(gf(apiName) as DescribeField),
  dataType: 'picklist',
  isRestrictedPicklist: restricted,
  picklistValues: values
})

/** Mock IO: `responder` maps a SOQL string to records; `reject` throws for a match. */
function mockIo(opts: {
  targetUserId?: string | null
  responder?: (soql: string) => Array<Record<string, unknown>>
  reject?: (soql: string) => boolean
  restGetTarget?: (path: string) => Promise<unknown>
}): PrefetchIo {
  return {
    async getTargetUserId() {
      return opts.targetUserId ?? null
    },
    async queryTarget(soql) {
      if (opts.reject?.(soql)) throw new Error('query failed')
      return opts.responder ? opts.responder(soql) : []
    },
    // S49 (BUG-9): overridable; the default rejection keeps the record-type
    // picklist prefetch fail-open, so these cases assert pre-S49 behaviour.
    restGetTarget: opts.restGetTarget ?? ((): Promise<unknown> => Promise.reject(new Error('no ui-api')))
  }
}

describe('needsTargetUser', () => {
  const m = (strategy: string): GoldenMapping => ({ strategy, matchField: null, customValue: null })

  it('is true when any field references User (case-insensitive)', () => {
    expect(
      needsTargetUser([gf('OwnerId', { isReference: true, referenceTo: ['user'] })], {})
    ).toBe(true)
  })

  it('is true when any mapping is setToMe (case-insensitive)', () => {
    expect(needsTargetUser([gf('Name')], { OwnerId: m('SetToMe') })).toBe(true)
  })

  it('is false when neither a User ref nor a setToMe mapping is present', () => {
    expect(needsTargetUser([gf('AccountId', { isReference: true, referenceTo: ['Account'] })], {
      AccountId: m('directId')
    })).toBe(false)
  })
})

describe('fetchInactiveTargetUserIds — fail-LOUD', () => {
  it('collects Ids and stores the 15-char form of any 18-char Id', async () => {
    const io = mockIo({
      responder: () => [{ Id: '005000000000018AAA' }, { Id: '005000000000015' }, { Id: null }]
    })
    const set = await fetchInactiveTargetUserIds(io)
    expect(set.has('005000000000018AAA')).toBe(true)
    expect(set.has('005000000000018')).toBe(true) // 18 → +15
    expect(set.has('005000000000015')).toBe(true) // 15 stays as-is
    expect(set.size).toBe(3)
  })

  it('PROPAGATES a query failure (fail-LOUD)', async () => {
    const io = mockIo({ reject: (soql) => soql.includes('User') })
    await expect(fetchInactiveTargetUserIds(io)).rejects.toThrow()
  })
})

describe('buildTargetPicklistAllowedValues', () => {
  it('maps restricted picklists to their allowed values; skips non-restricted / null', () => {
    const out = buildTargetPicklistAllowedValues([
      dfPicklist('Stage', ['Won', 'Lost']),
      dfPicklist('Free', ['x'], false), // non-restricted → skipped
      dfPicklist('NoValues', null) // null values → skipped
    ])
    expect(out).toEqual({ Stage: ['Won', 'Lost'] })
  })
})

describe('fetchInactivePbeSubstitutes — fail-OPEN', () => {
  const INACTIVE_18 = 'a0B000000000018AAA'
  const INACTIVE_NOSUB = 'a0B000000000099AAA'
  const ACTIVE = 'a0B000000000ACTAAA'

  const responder = (soql: string): Array<Record<string, unknown>> => {
    if (soql.includes('IsActive = false')) {
      return [
        { Id: INACTIVE_18, Product2Id: 'P1', Pricebook2Id: 'PB1' }, // has active sub
        { Id: INACTIVE_NOSUB, Product2Id: 'P2', Pricebook2Id: 'PB1' } // no active sub
      ]
    }
    // active query — only P1/PB1 has an active PBE
    return [{ Id: ACTIVE, Product2Id: 'P1', Pricebook2Id: 'PB1' }]
  }

  it('substitutes matching (Product2, Pricebook2) pairs and leaves null when none', async () => {
    const { inactivePbeIds, pbeSubstitutes } = await fetchInactivePbeSubstitutes(mockIo({ responder }))
    expect(inactivePbeIds.has(INACTIVE_18)).toBe(true)
    expect(inactivePbeIds.has('a0B000000000018')).toBe(true) // 18 → +15
    expect(pbeSubstitutes[INACTIVE_18]).toBe(ACTIVE)
    expect(pbeSubstitutes['a0B000000000018']).toBe(ACTIVE) // 15-form key too
    expect(pbeSubstitutes[INACTIVE_NOSUB]).toBeNull() // no active pair → null (skip OLI)
  })

  it('returns empty WITHOUT throwing when the query fails (fail-OPEN)', async () => {
    const { inactivePbeIds, pbeSubstitutes } = await fetchInactivePbeSubstitutes(
      mockIo({ reject: () => true })
    )
    expect(inactivePbeIds.size).toBe(0)
    expect(pbeSubstitutes).toEqual({})
  })
})

describe('buildPrefetchContext — orchestration', () => {
  const m = (strategy: string): GoldenMapping => ({ strategy, matchField: null, customValue: null })

  it('skips user/PBE fetches when not needed (no User ref, non-OLI)', async () => {
    const seen: string[] = []
    const io: PrefetchIo = {
      async getTargetUserId() {
        seen.push('user')
        return 'u'
      },
      async queryTarget(soql) {
        seen.push(soql)
        return []
      },
      restGetTarget: (): Promise<unknown> => Promise.reject(new Error('no ui-api'))
    }
    const bundle = await buildPrefetchContext(
      io,
      'Account',
      [gf('Name')],
      {},
      [dfPicklist('Stage', ['Won'])]
    )
    expect(bundle.targetUserId).toBeNull()
    expect(bundle.inactiveUserIds).toEqual([])
    expect(bundle.targetPicklistAllowedValues).toEqual({ Stage: ['Won'] })
    expect(bundle.inactivePbeIds).toEqual([])
    // S49 (BUG-9): the object HAS a restricted picklist (Stage), so the
    // record-type prefetch legitimately fires one RecordType query. The
    // UI-API call behind it rejects in this fake, leaving the gate fail-open.
    expect(seen).toEqual([
      "SELECT Id FROM RecordType WHERE IsActive = true AND SobjectType = 'Account'"
    ])
    expect(bundle.recordTypePicklists).toEqual({})
  })

  it('fetches user + inactive users when a User ref is present', async () => {
    const io = mockIo({ targetUserId: 'u1', responder: () => [{ Id: '005000000000015' }] })
    const bundle = await buildPrefetchContext(
      io,
      'Account',
      [gf('OwnerId', { isReference: true, referenceTo: ['User'] })],
      { OwnerId: m('directId') },
      []
    )
    expect(bundle.targetUserId).toBe('u1')
    expect(bundle.inactiveUserIds).toEqual(['005000000000015'])
  })

  it('propagates a fail-LOUD inactive-user error through the orchestration', async () => {
    const io = mockIo({ targetUserId: 'u1', reject: (soql) => soql.includes('User') })
    await expect(
      buildPrefetchContext(
        io,
        'Account',
        [gf('OwnerId', { isReference: true, referenceTo: ['User'] })],
        { OwnerId: m('directId') },
        []
      )
    ).rejects.toThrow()
  })

  it('runs the PBE prefetch only for OpportunityLineItem', async () => {
    const io = mockIo({
      responder: (soql) =>
        soql.includes('IsActive = false')
          ? [{ Id: 'a0B000000000015', Product2Id: 'P1', Pricebook2Id: 'PB1' }]
          : []
    })
    const bundle = await buildPrefetchContext(io, 'OpportunityLineItem', [gf('Quantity')], {}, [])
    expect(bundle.inactivePbeIds).toContain('a0B000000000015')
    expect(bundle.pbeSubstitutes['a0B000000000015']).toBeNull() // no active pair
  })
})
