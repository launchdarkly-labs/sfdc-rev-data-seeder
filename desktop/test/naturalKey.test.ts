/**
 * S75 — natural-key resolution of lookups to CPQ config objects
 * (transform/naturalKey.ts). The 2026-11-10 seeds matched Product Option and
 * Dimension by `Name` and dropped every lookup; a repeated name would have
 * linked the wrong row. Scenarios: the same-Id org, the re-inserted-config org
 * (lookup parts translated), a parentless-on-the-line option (the key comes
 * from the config row, so it still resolves), duplicate pairs (tie-break, then
 * ambiguous — never last-wins), a missing key, a nested key (Discount Tier →
 * Schedule), a failed query, and the per-run cache.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveNaturalKey,
  type NaturalKeyCache,
  type NaturalKeyIo
} from '../src/main/engine/deploy/transform/naturalKey'
import { CONFIG_NATURAL_KEYS, naturalKeyLabel, naturalKeyOf } from '../src/shared/mappingPolicy'

type Row = Record<string, unknown>
type Data = Record<string, { source: Row[]; target: Row[] }>

const PO = 'SBQQ__ProductOption__c'
const DIM = 'SBQQ__Dimension__c'
const TIER = 'SBQQ__DiscountTier__c'
const SCHED = 'SBQQ__DiscountSchedule__c'

function mockIo(data: Data, fail?: (role: string, object: string) => boolean): { io: NaturalKeyIo; calls: string[] } {
  const calls: string[] = []
  const io: NaturalKeyIo = {
    async queryRows(role, objectName, fields) {
      calls.push(`${role}:${objectName}:${fields.join(',')}`)
      if (fail?.(role, objectName)) throw new Error(`INVALID_FIELD on ${objectName}`)
      return data[objectName]?.[role] ?? []
    }
  }
  return { io, calls }
}

const opt = (Id: string, cfg: string, optl: string, n: number | null = null, Name = Id): Row => ({
  Id,
  Name,
  SBQQ__ConfiguredSKU__c: cfg,
  SBQQ__OptionalSKU__c: optl,
  SBQQ__Number__c: n
})

describe('policy table', () => {
  it('lists the config objects and describes their keys', () => {
    expect(Object.keys(CONFIG_NATURAL_KEYS).sort()).toEqual(
      ['SBQQ__BlockPrice__c', DIM, SCHED, TIER, 'SBQQ__ProductFeature__c', PO].sort()
    )
    expect(naturalKeyOf('Product2')).toBeNull()
    expect(naturalKeyOf(undefined)).toBeNull()
    expect(naturalKeyLabel(PO)).toBe('ConfiguredSKU + OptionalSKU')
    expect(naturalKeyLabel('Account')).toBeNull()
  })
})

describe('resolveNaturalKey — Product Option', () => {
  it('maps by (ConfiguredSKU, OptionalSKU) when product Ids are shared and option Ids are not', async () => {
    const { io } = mockIo({
      [PO]: {
        source: [opt('sPO1', 'P_BUNDLE', 'P_SEATS', 10, 'PO-0001'), opt('sPO2', 'P_BUNDLE', 'P_MAU', 20, 'PO-0002')],
        // Auto-number names differ and even collide the wrong way round.
        target: [opt('tPO9', 'P_BUNDLE', 'P_MAU', 20, 'PO-0001'), opt('tPO8', 'P_BUNDLE', 'P_SEATS', 10, 'PO-0002')]
      }
    })
    const r = await resolveNaturalKey(io, PO)
    expect(r.map).toEqual({ sPO1: 'tPO8', sPO2: 'tPO9' })
    expect(r.unresolved).toEqual({})
    expect(r.error).toBeNull()
    expect(r.sourceRows).toBe(2)
    expect(r.targetRows).toBe(2)
  })

  it('translates product Ids through a unique ProductCode when the target products were re-inserted too', async () => {
    const { io } = mockIo({
      [PO]: {
        source: [opt('sPO1', 'sBUNDLE', 'sSEATS')],
        target: [opt('tPO1', 'tBUNDLE', 'tSEATS')]
      },
      Product2: {
        source: [
          { Id: 'sBUNDLE', ProductCode: 'BUNDLE' },
          { Id: 'sSEATS', ProductCode: 'SEATS' }
        ],
        target: [
          { Id: 'tBUNDLE', ProductCode: 'BUNDLE' },
          { Id: 'tSEATS', ProductCode: 'SEATS' }
        ]
      }
    })
    const r = await resolveNaturalKey(io, PO)
    expect(r.map).toEqual({ sPO1: 'tPO1' })
  })

  it('does not translate through a ProductCode carried by two target products', async () => {
    const { io } = mockIo({
      [PO]: { source: [opt('sPO1', 'sBUNDLE', 'sSEATS')], target: [opt('tPO1', 'tBUNDLE', 'tSEATS')] },
      Product2: {
        source: [
          { Id: 'sBUNDLE', ProductCode: 'BUNDLE' },
          { Id: 'sSEATS', ProductCode: 'SEATS' }
        ],
        target: [
          { Id: 'tBUNDLE', ProductCode: 'BUNDLE' },
          { Id: 'tSEATS', ProductCode: 'SEATS' },
          { Id: 'tSEATS2', ProductCode: 'SEATS' }
        ]
      }
    })
    const r = await resolveNaturalKey(io, PO)
    expect(r.map).toEqual({})
    expect(r.unresolved.sPO1).toMatch(/SBQQ__OptionalSKU__c .* points at Product2 sSEATS, which has no match on the target/)
  })

  it('duplicate pair on the target: the tie-break field decides; without a decider it is ambiguous, never last-wins', async () => {
    const { io } = mockIo({
      [PO]: {
        source: [opt('sA', 'B', 'X', 10), opt('sB', 'B', 'X', 20), opt('sC', 'B', 'X', 99)],
        target: [opt('tA', 'B', 'X', 10, 'PO-7'), opt('tB', 'B', 'X', 20, 'PO-8')]
      }
    })
    const r = await resolveNaturalKey(io, PO)
    expect(r.map).toEqual({ sA: 'tA', sB: 'tB' })
    expect(r.unresolved.sC).toMatch(/2 SBQQ__ProductOption__c rows on the target share the key .*PO-7, PO-8 — ambiguous, not linked/)
    expect(r.ambiguousKeys).toBe(1)
  })

  it('a pair with no target row is reported missing; a source row without a key part says which', async () => {
    const { io } = mockIo({
      [PO]: {
        source: [opt('sGone', 'B', 'X2', null, 'PO-0100'), { Id: 'sBroken', Name: 'PO-0101', SBQQ__ConfiguredSKU__c: null, SBQQ__OptionalSKU__c: 'B' }],
        // Both products exist on the target, but not as this pair.
        target: [opt('tA', 'B', 'X'), opt('tZ', 'Z', 'X2')]
      }
    })
    const r = await resolveNaturalKey(io, PO)
    expect(r.map).toEqual({})
    expect(r.unresolved.sGone).toMatch(/no SBQQ__ProductOption__c on the target with the key of source PO-0100/)
    expect(r.unresolved.sBroken).toBe('source SBQQ__ProductOption__c PO-0101 has no SBQQ__ConfiguredSKU__c')
  })

  it('a failed query resolves nothing and carries the error', async () => {
    const { io } = mockIo({}, (role) => role === 'target')
    const r = await resolveNaturalKey(io, PO)
    expect(r.map).toEqual({})
    expect(r.error).toMatch(/INVALID_FIELD/)
  })

  it('an object without a natural key is refused', async () => {
    const { io, calls } = mockIo({})
    const r = await resolveNaturalKey(io, 'Account')
    expect(r.error).toMatch(/no natural key/)
    expect(calls).toEqual([])
  })
})

describe('resolveNaturalKey — Dimension and nested keys', () => {
  it('Dimension: (Product, Name) keeps the dimensions of one product apart', async () => {
    const dim = (Id: string, p: string, Name: string): Row => ({ Id, Name, SBQQ__Product__c: p })
    const { io } = mockIo({
      [DIM]: {
        source: [dim('s1', 'P1', 'Year 1'), dim('s2', 'P1', 'Year 2'), dim('s3', 'P2', 'Year 1')],
        target: [dim('t3', 'P2', 'Year 1'), dim('t2', 'P1', 'Year 2'), dim('t1', 'P1', 'Year 1')]
      }
    })
    const r = await resolveNaturalKey(io, DIM)
    expect(r.map).toEqual({ s1: 't1', s2: 't2', s3: 't3' })
  })

  it('Discount Tier: the Schedule part is translated by the schedule\'s own natural key', async () => {
    const tier = (Id: string, sched: string, n: number, lower: number): Row => ({
      Id,
      Name: 'Tier ' + n,
      SBQQ__Schedule__c: sched,
      SBQQ__Number__c: n,
      SBQQ__LowerBound__c: lower
    })
    const { io } = mockIo({
      [TIER]: {
        source: [tier('sT1', 'sVOL', 1, 0), tier('sT2', 'sVOL', 2, 100), tier('sT3', 'sTERM', 1, 0)],
        target: [tier('tT3', 'tTERM', 1, 0), tier('tT1', 'tVOL', 1, 0), tier('tT2', 'tVOL', 2, 100)]
      },
      [SCHED]: {
        source: [
          { Id: 'sVOL', Name: 'Volume' },
          { Id: 'sTERM', Name: 'Term' }
        ],
        target: [
          { Id: 'tVOL', Name: 'Volume' },
          { Id: 'tTERM', Name: 'Term' }
        ]
      }
    })
    const r = await resolveNaturalKey(io, TIER)
    // "Tier 1" exists twice on the target — a Name match would have taken the last one for both.
    expect(r.map).toEqual({ sT1: 'tT1', sT2: 'tT2', sT3: 'tT3' })
  })
})

describe('per-run cache', () => {
  it('queries an object once however many callers ask', async () => {
    const { io, calls } = mockIo({ [PO]: { source: [opt('s', 'B', 'X')], target: [opt('t', 'B', 'X')] } })
    const cache: NaturalKeyCache = new Map()
    const [a, b] = await Promise.all([resolveNaturalKey(io, PO, cache), resolveNaturalKey(io, PO, cache)])
    expect(a).toBe(b)
    expect(calls).toHaveLength(2) // one source read, one target read
  })
})
