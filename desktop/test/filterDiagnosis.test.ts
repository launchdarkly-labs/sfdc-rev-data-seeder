/**
 * S54 (F1 / L4): why a Scope-step filter matched zero records. Pinned wording —
 * these sentences are what the operator reads under the amber line.
 */
import { describe, it, expect } from 'vitest'
import {
  STANDARD_KEY_PREFIXES,
  buildPrefixIndex,
  extractLiteralIds,
  idsPlausibleFor,
  keyPrefixOf,
  prefixMismatchHint,
  wrongOrgHint,
  zeroMatchMessage
} from '../src/main/engine/filterDiagnosis'

const OPP = '006TR00000gALnoYAG' // an Opportunity Id pasted into the Account filter
const SB3_ACCT = '001iY000000oCEBQA2' // the target org's copy of the account
const ACCT15 = '0014100000EKIya'

describe('extractLiteralIds', () => {
  it('finds quoted 18- and 15-char Ids, in order, de-duplicated', () => {
    expect(
      extractLiteralIds(`Id IN ('${OPP}', '${ACCT15}', '${OPP}') OR ParentId = '${SB3_ACCT}'`)
    ).toEqual([OPP, ACCT15, SB3_ACCT])
  })
  it('ignores ordinary string literals and unquoted tokens', () => {
    expect(extractLiteralIds(`Name LIKE 'Acme%' AND Type = 'Customer' AND Id = ${OPP}`)).toEqual(
      []
    )
    expect(extractLiteralIds('')).toEqual([])
  })
})

describe('buildPrefixIndex', () => {
  it('starts from the fixed standard table', () => {
    const idx = buildPrefixIndex()
    expect(idx.byPrefix.get('006')).toBe('Opportunity')
    expect(idx.byObject.get('Account')).toBe('001')
    expect(Object.keys(STANDARD_KEY_PREFIXES).length).toBeGreaterThan(15)
  })
  it('adds custom/managed prefixes from the global describe and lets describe win on conflict', () => {
    const idx = buildPrefixIndex([
      { apiName: 'SBQQ__Quote__c', keyPrefix: 'a0S' },
      { apiName: 'Account', keyPrefix: '001' },
      { apiName: 'NoPrefix__c', keyPrefix: null },
      { apiName: 'Weird', keyPrefix: '00' } // malformed → ignored
    ])
    expect(idx.byPrefix.get('a0S')).toBe('SBQQ__Quote__c')
    expect(idx.byObject.get('SBQQ__Quote__c')).toBe('a0S')
    expect(idx.byObject.has('NoPrefix__c')).toBe(false)
    expect(idx.byObject.has('Weird')).toBe(false)
  })
})

describe('prefixMismatchHint (case 1: an Id of another object)', () => {
  const idx = buildPrefixIndex([{ apiName: 'SBQQ__Quote__c', keyPrefix: 'a0S' }])
  it('names the object the Id belongs to and the object the filter is on', () => {
    expect(prefixMismatchHint('Account', [OPP], idx)).toBe(
      `${OPP} is an Opportunity Id — this filter is on Account, so it can never match.`
    )
  })
  it('uses "a" before a consonant', () => {
    expect(prefixMismatchHint('Account', ['a0S000000000001AAA'], idx)).toMatch(
      /is a SBQQ__Quote__c Id/
    )
  })
  it('a matching prefix is not a mismatch', () => {
    expect(prefixMismatchHint('Account', [SB3_ACCT, ACCT15], idx)).toBeNull()
  })
  it('an unknown prefix still says what is wrong', () => {
    expect(prefixMismatchHint('Account', ['zzz000000000001AAA'], idx)).toBe(
      'zzz000000000001AAA has key prefix zzz, which is not Account (001) — this filter is on Account, so it can never match.'
    )
  })
  it("stays silent when the filtered object's own prefix is unknown (no describe, no table)", () => {
    expect(prefixMismatchHint('Mystery__c', [OPP], idx)).toBeNull()
  })
  it('keyPrefixOf is the first three characters', () => {
    expect(keyPrefixOf(OPP)).toBe('006')
  })
})

describe('idsPlausibleFor', () => {
  const idx = buildPrefixIndex()
  it('keeps only Ids whose prefix could belong to the object', () => {
    expect(idsPlausibleFor('Account', [OPP, SB3_ACCT], idx)).toEqual([SB3_ACCT])
  })
  it("keeps everything when the object's prefix is unknown", () => {
    expect(idsPlausibleFor('Mystery__c', [OPP, SB3_ACCT], idx)).toEqual([OPP, SB3_ACCT])
  })
})

describe('wrongOrgHint (case 2: the record lives on the target)', () => {
  it('names the target, says filters run on the source, and asks for the source Id', () => {
    expect(wrongOrgHint('Account', [SB3_ACCT], 'darkb_911', 'sb3_912')).toBe(
      `${SB3_ACCT} is an Account record on sb3_912 (the target). Filters run against the source, darkb_911 — use the source Id.`
    )
  })
  it('pluralises', () => {
    expect(wrongOrgHint('Account', [SB3_ACCT, ACCT15], 'darkb_911', 'sb3_912')).toMatch(
      /are Account records on sb3_912/
    )
  })
  // S57 (FB-9): Jack read "a Account record" on the V2 click — the article follows the noun.
  it('picks the article by the object name (FB-9)', () => {
    expect(wrongOrgHint('Contact', ['003TR00001TigbvYAB'], 'src', 'tgt')).toMatch(/is a Contact record/)
    expect(wrongOrgHint('Opportunity', ['006TR00000gALnoYAG'], 'src', 'tgt')).toMatch(
      /is an Opportunity record/
    )
    expect(wrongOrgHint('Account', [SB3_ACCT], 'src', 'tgt')).not.toMatch(/ {2}/)
  })
})

describe('zeroMatchMessage', () => {
  it('says the deployment under this object will be empty', () => {
    expect(zeroMatchMessage('Account')).toBe(
      '0 records — nothing will deploy for Account, or for anything scoped under it.'
    )
  })
})
