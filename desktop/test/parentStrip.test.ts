import { describe, it, expect } from 'vitest'
import {
  stripMissingParentRefs,
  stripMissingDirectIdRefs,
  type ParentStripIo
} from '../src/main/engine/deploy/transform/parentStrip'
import { EXTERNAL_ID_FIELD } from '../src/main/engine/deploy/transform/sfid'
import type { GoldenFieldInfo } from '../src/main/engine/deploy/golden/fixture'

/**
 * E4X.7 — parent-strip suite (Apex DDQ L2490-2691). Covers fail-LOUD (nested
 * externalId) vs fail-OPEN (flat directId), User/self exclusions, 15/18 dual-form,
 * and the byte-exact combined Warning line.
 */

const base: Omit<GoldenFieldInfo, 'apiName'> = {
  dataType: 'reference',
  isCreateable: true,
  isNillable: true,
  isReference: true,
  referenceTo: [],
  relationshipName: null,
  isAutoNumber: false,
  isCalculated: false,
  isExternalId: false,
  isRestrictedPicklist: false
}
const nestedF = (apiName: string, relationshipName: string, refObj: string): GoldenFieldInfo => ({
  ...base,
  apiName,
  referenceTo: [refObj],
  relationshipName
})
const directF = (apiName: string, refObj: string): GoldenFieldInfo => ({
  ...base,
  apiName,
  referenceTo: [refObj],
  relationshipName: null
})

type Found = (refObj: string, field: string, chunk: string[]) => string[]
function mockIo(
  opts: { found?: Found; reject?: (refObj: string, field: string) => boolean } = {}
): {
  io: ParentStripIo
  calls: Array<{ refObj: string; field: string; chunk: string[] }>
} {
  const calls: Array<{ refObj: string; field: string; chunk: string[] }> = []
  return {
    calls,
    io: {
      async queryExisting(refObj, field, chunk) {
        calls.push({ refObj, field, chunk })
        if (opts.reject?.(refObj, field)) throw new Error('query failed')
        return opts.found ? opts.found(refObj, field, chunk) : []
      }
    }
  }
}

describe('stripMissingDirectIdRefs — fail-OPEN', () => {
  const fields = [directF('Cat__c', 'SBQQ__ProductOption__c')]

  it('keeps a directId ref that exists on target', async () => {
    const payloads = [{ Cat__c: 'a0oEXISTS' }]
    const parts = await stripMissingDirectIdRefs(
      mockIo({ found: () => ['a0oEXISTS'] }).io,
      'SBQQ__QuoteLine__c',
      fields,
      payloads
    )
    expect(payloads[0]!.Cat__c).toBe('a0oEXISTS')
    expect(parts).toEqual([])
  })

  it('drops a missing directId ref and reports it', async () => {
    const payloads = [{ Cat__c: 'a0oMISSING' }]
    const parts = await stripMissingDirectIdRefs(
      mockIo({ found: () => [] }).io,
      'SBQQ__QuoteLine__c',
      fields,
      payloads
    )
    expect(payloads[0]!).not.toHaveProperty('Cat__c')
    expect(parts).toEqual(['Cat__c → SBQQ__ProductOption__c (1, directId not on target)'])
  })

  it('excludes User references (handled by inactive-owner substitution)', async () => {
    const payloads = [{ OwnerId: '005MISSING' }]
    const parts = await stripMissingDirectIdRefs(
      mockIo({ found: () => [] }).io,
      'Account',
      [directF('OwnerId', 'User')],
      payloads
    )
    expect(payloads[0]!.OwnerId).toBe('005MISSING') // untouched
    expect(parts).toEqual([])
  })

  it('excludes self references', async () => {
    const payloads = [{ ParentId: 'a0xMISSING' }]
    const parts = await stripMissingDirectIdRefs(
      mockIo({ found: () => [] }).io,
      'Widget__c',
      [directF('ParentId', 'Widget__c')],
      payloads
    )
    expect(payloads[0]!.ParentId).toBe('a0xMISSING')
    expect(parts).toEqual([])
  })

  it('matches 15/18 dual-form Ids either direction', async () => {
    // payload carries the 15-char form; target returns the 18-char → 15-prefix matches.
    const payloads = [{ Cat__c: 'a0X000000000015' }, { Cat__c: 'a0X000000000018AAB' }]
    const parts = await stripMissingDirectIdRefs(
      mockIo({ found: () => ['a0X000000000015AAA', 'a0X000000000018AAB'] }).io,
      'SBQQ__QuoteLine__c',
      fields,
      payloads
    )
    expect(payloads[0]!.Cat__c).toBe('a0X000000000015') // 15 in found via 18→15
    expect(payloads[1]!.Cat__c).toBe('a0X000000000018AAB') // exact 18 match
    expect(parts).toEqual([])
  })

  it('leaves fields UNTOUCHED when the existence query errors (fail-OPEN)', async () => {
    const payloads = [{ Cat__c: 'a0oANY' }]
    const parts = await stripMissingDirectIdRefs(
      mockIo({ reject: () => true }).io,
      'SBQQ__QuoteLine__c',
      fields,
      payloads
    )
    expect(payloads[0]!.Cat__c).toBe('a0oANY') // not stripped — unqueryable
    expect(parts).toEqual([])
  })
})

describe('stripMissingParentRefs — fail-LOUD nested', () => {
  const fields = [nestedF('AccountId', 'Account', 'Account')]

  it('keeps a nested externalId ref whose parent exists', async () => {
    const payloads = [{ [EXTERNAL_ID_FIELD]: 'SELF', Account: { [EXTERNAL_ID_FIELD]: 'PEXT' } }]
    const warning = await stripMissingParentRefs(
      mockIo({ found: () => ['PEXT'] }).io,
      'Contact',
      fields,
      payloads
    )
    expect(payloads[0]!.Account).toEqual({ [EXTERNAL_ID_FIELD]: 'PEXT' })
    expect(warning).toBeNull()
  })

  it('drops a nested ref whose parent is missing and returns the combined warning', async () => {
    const payloads = [{ Account: { [EXTERNAL_ID_FIELD]: 'PEXT' } }]
    const warning = await stripMissingParentRefs(
      mockIo({ found: () => [] }).io,
      'Contact',
      fields,
      payloads
    )
    expect(payloads[0]!).not.toHaveProperty('Account')
    expect(warning).toBe(
      'Dropped unresolvable reference(s) on Contact — referenced record(s) not on target; ' +
        'field left empty instead of failing the row: Account → Account (1)'
    )
  })

  it('PROPAGATES a query failure (fail-LOUD)', async () => {
    const payloads = [{ Account: { [EXTERNAL_ID_FIELD]: 'PEXT' } }]
    await expect(
      stripMissingParentRefs(
        mockIo({ reject: (o, field) => field === EXTERNAL_ID_FIELD }).io,
        'Contact',
        fields,
        payloads
      )
    ).rejects.toThrow()
  })

  it('excludes self-referential nested parents (deferred second pass handles them)', async () => {
    const payloads = [{ Parent__r: { [EXTERNAL_ID_FIELD]: 'PEXT' } }]
    const { io, calls } = mockIo({ found: () => [] })
    const warning = await stripMissingParentRefs(
      io,
      'Widget__c',
      [nestedF('Parent__c', 'Parent__r', 'Widget__c')],
      payloads
    )
    expect(payloads[0]!.Parent__r).toEqual({ [EXTERNAL_ID_FIELD]: 'PEXT' }) // untouched
    expect(warning).toBeNull()
    expect(calls).toEqual([]) // no query issued
  })

  it('returns null for empty payloads or no reference fields', async () => {
    expect(await stripMissingParentRefs(mockIo().io, 'Contact', fields, [])).toBeNull()
    expect(await stripMissingParentRefs(mockIo().io, 'Contact', [], [{ Name: 'x' }])).toBeNull()
  })

  it('does NOT run the directId strip when the batch has no nested externalId refs (Apex L2518 early-return)', async () => {
    // A field with a relationshipName (so relToRefObj is non-empty) but the
    // payload carries only a FLAT directId string — no nested `{Rel:{ExtId}}`.
    // Apex returns null before the directId pass, so the field is RETAINED.
    const payloads = [{ Cat__c: 'a0oMISSING' }]
    const { io, calls } = mockIo({ found: () => [] })
    const warning = await stripMissingParentRefs(
      io,
      'SBQQ__QuoteLine__c',
      [nestedF('Cat__c', 'Cat__r', 'SBQQ__ProductOption__c')],
      payloads
    )
    expect(warning).toBeNull()
    expect(payloads[0]!.Cat__c).toBe('a0oMISSING') // retained — directId pass never ran
    expect(calls).toEqual([]) // no existence query issued
  })

  it('combines nested + directId drops into one warning (nested first)', async () => {
    const fields2 = [
      nestedF('SBQQ__Quote__c', 'SBQQ__Quote__r', 'SBQQ__Quote__c'),
      directF('SBQQ__ProductOption__c', 'SBQQ__ProductOption__c')
    ]
    const payloads = [
      { SBQQ__Quote__r: { [EXTERNAL_ID_FIELD]: 'QEXT' }, SBQQ__ProductOption__c: 'a0oMISSING' }
    ]
    const warning = await stripMissingParentRefs(
      mockIo({ found: () => [] }).io,
      'SBQQ__QuoteLine__c',
      fields2,
      payloads
    )
    expect(payloads[0]!).not.toHaveProperty('SBQQ__Quote__r')
    expect(payloads[0]!).not.toHaveProperty('SBQQ__ProductOption__c')
    expect(warning).toBe(
      'Dropped unresolvable reference(s) on SBQQ__QuoteLine__c — referenced record(s) not on target; ' +
        'field left empty instead of failing the row: ' +
        'SBQQ__Quote__r → SBQQ__Quote__c (1), SBQQ__ProductOption__c → SBQQ__ProductOption__c (1, directId not on target)'
    )
  })
})

// ── S53 (A1 at N>1): the SCOPE parent is never stripped — the record is withheld ──
describe('stripMissingParentRefs — scopeParentField withholds instead of stripping (S53)', () => {
  const fields = [
    nestedF('AccountId', 'Account', 'Account'),
    nestedF('Primary_Contact__c', 'Primary_Contact__r', 'Contact')
  ]

  it('keeps the scope-parent link on the payload and reports the record through withheldOut', async () => {
    const rec = {
      Account: { [EXTERNAL_ID_FIELD]: 'ACC_EXT' },
      Primary_Contact__r: { [EXTERNAL_ID_FIELD]: 'CON_EXT' }
    }
    const withheldOut = new Map<Record<string, unknown>, unknown>()
    const warning = await stripMissingParentRefs(
      mockIo({ found: () => [] }).io, // NEITHER parent is on target
      'Opportunity',
      fields,
      [rec],
      { scopeParentField: 'AccountId', withheldOut: withheldOut as never }
    )
    // The scope parent (Account) stays; the ordinary lookup (Contact) is stripped as before.
    expect(rec.Account).toEqual({ [EXTERNAL_ID_FIELD]: 'ACC_EXT' })
    expect(rec).not.toHaveProperty('Primary_Contact__r')
    expect(withheldOut.get(rec)).toMatchObject({
      fieldName: 'AccountId',
      relationshipName: 'Account',
      refObject: 'Account',
      parentExtId: 'ACC_EXT',
      nillable: true
    })
    // The combined warning covers only what was actually dropped.
    expect(warning).toBe(
      'Dropped unresolvable reference(s) on Opportunity — referenced record(s) not on target; ' +
        'field left empty instead of failing the row: Primary_Contact__r → Contact (1)'
    )
  })

  it('a scope parent that IS on target changes nothing (no withhold, no drop)', async () => {
    const rec = { Account: { [EXTERNAL_ID_FIELD]: 'ACC_EXT' } }
    const withheldOut = new Map<Record<string, unknown>, unknown>()
    const warning = await stripMissingParentRefs(
      mockIo({ found: () => ['ACC_EXT'] }).io,
      'Contact',
      [nestedF('AccountId', 'Account', 'Account')],
      [rec],
      { scopeParentField: 'AccountId', withheldOut: withheldOut as never }
    )
    expect(rec.Account).toEqual({ [EXTERNAL_ID_FIELD]: 'ACC_EXT' })
    expect(withheldOut.size).toBe(0)
    expect(warning).toBeNull()
  })

  it('matches the scope-parent field case-insensitively and ignores it when null/blank', async () => {
    const a = { Account: { [EXTERNAL_ID_FIELD]: 'X' } }
    const b = { Account: { [EXTERNAL_ID_FIELD]: 'X' } }
    const outA = new Map<Record<string, unknown>, unknown>()
    const outB = new Map<Record<string, unknown>, unknown>()
    const f = [nestedF('AccountId', 'Account', 'Account')]
    await stripMissingParentRefs(mockIo({ found: () => [] }).io, 'Contact', f, [a], {
      scopeParentField: 'accountid',
      withheldOut: outA as never
    })
    await stripMissingParentRefs(mockIo({ found: () => [] }).io, 'Contact', f, [b], {
      scopeParentField: null,
      withheldOut: outB as never
    })
    expect(outA.size).toBe(1)
    expect(a).toHaveProperty('Account')
    expect(outB.size).toBe(0)
    expect(b).not.toHaveProperty('Account') // pre-S53 behaviour when unset
  })

  it('directId scope parent: withheld too, and the fail-OPEN behaviour for other refs is unchanged', async () => {
    const rec = { OpportunityId: '006000000000001AAA', Cat__c: '0Aa000000000001AAA' }
    const withheldOut = new Map<Record<string, unknown>, unknown>()
    const parts = await stripMissingDirectIdRefs(
      mockIo({ found: () => [] }).io,
      'OpportunityLineItem',
      [directF('OpportunityId', 'Opportunity'), directF('Cat__c', 'SBQQ__ProductOption__c')],
      [rec],
      { scopeParentField: 'OpportunityId', withheldOut: withheldOut as never }
    )
    expect(rec).toHaveProperty('OpportunityId') // kept
    expect(rec).not.toHaveProperty('Cat__c') // stripped as before
    expect(withheldOut.get(rec)).toMatchObject({
      fieldName: 'OpportunityId',
      refObject: 'Opportunity',
      parentExtId: '006000000000001AAA'
    })
    expect(parts).toEqual(['Cat__c → SBQQ__ProductOption__c (1, directId not on target)'])
  })
})
