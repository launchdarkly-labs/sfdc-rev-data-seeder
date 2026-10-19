import { describe, it, expect } from 'vitest'
import { filterFields, type DescribeField } from '../src/main/engine/deploy/transform/fieldFilter'
import { EXTERNAL_ID_FIELD } from '../src/main/engine/deploy/transform/sfid'

/**
 * E4X.6 — field intersection filter suite (Apex DDQ L1335-1410). Covers the
 * drop-precedence ladder + byte-exact drop-log strings + PA detection.
 */

const df = (apiName: string, o: Partial<DescribeField> = {}): DescribeField => ({
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
  picklistValues: null,
  ...o
})

// A source∩target pair with identical flags on both sides for a given name.
const both = (apiName: string, o: Partial<DescribeField> = {}): [DescribeField, DescribeField] => [
  df(apiName, o),
  df(apiName, o)
]

describe('filterFields — keep + drop reasons', () => {
  it('keeps fields present + createable on both sides', () => {
    const [sa, ta] = both('Name')
    const [sb, tb] = both('Industry')
    const r = filterFields({ sourceFields: [sa, sb], targetFields: [ta, tb] })
    expect(r.fields.map((f) => f.apiName)).toEqual(['Name', 'Industry'])
    expect(r.droppedFieldNames).toEqual([])
  })

  it('drops a field not present on target', () => {
    const r = filterFields({ sourceFields: [df('OnlySource__c')], targetFields: [] })
    expect(r.fields).toEqual([])
    expect(r.droppedFieldNames).toEqual(['OnlySource__c (not on target)'])
  })

  it('drops read-only-on-target fields with the right reason', () => {
    const r = filterFields({
      sourceFields: [df('Formula__c'), df('Auto__c'), df('RO__c')],
      targetFields: [
        df('Formula__c', { isCalculated: true }),
        df('Auto__c', { isAutoNumber: true }),
        df('RO__c', { isCreateable: false })
      ]
    })
    expect(r.fields).toEqual([])
    expect(r.droppedFieldNames).toEqual([
      'Formula__c (read-only on target: formula/rollup)',
      'Auto__c (read-only on target: auto-number)',
      'RO__c (read-only on target: createable=false)'
    ])
  })

  it('drops a FOREIGN external-Id field but keeps our own ExtId', () => {
    const r = filterFields({
      sourceFields: [df('GearsetExternalId__c'), df(EXTERNAL_ID_FIELD)],
      targetFields: [
        df('GearsetExternalId__c', { isExternalId: true }),
        df(EXTERNAL_ID_FIELD, { isExternalId: true })
      ]
    })
    expect(r.fields.map((f) => f.apiName)).toEqual([EXTERNAL_ID_FIELD])
    expect(r.droppedFieldNames).toEqual([
      'GearsetExternalId__c (foreign external Id; would collide on re-deploy)'
    ])
  })

  it('drops per-org user-excluded ExtIds on source and target with distinct reasons', () => {
    const r = filterFields({
      sourceFields: [df('SrcEx__c'), df('TgtEx__c')],
      targetFields: [df('SrcEx__c'), df('TgtEx__c')],
      sourceUserExcludedExtIds: ['SrcEx__c'],
      targetUserExcludedExtIds: ['TgtEx__c']
    })
    expect(r.fields).toEqual([])
    expect(r.droppedFieldNames).toEqual([
      'SrcEx__c (user-excluded on source via Org Settings)',
      'TgtEx__c (user-excluded on target via Org Settings)'
    ])
  })

  it('silently drops user-excluded + SYSTEM_MANAGED fields (no log line)', () => {
    const r = filterFields({
      sourceFields: [df('Excluded__c'), df('CreatedById'), df('Name')],
      targetFields: [df('Excluded__c'), df('CreatedById'), df('Name')],
      excludedFieldSet: ['Excluded__c']
    })
    expect(r.fields.map((f) => f.apiName)).toEqual(['Name'])
    expect(r.droppedFieldNames).toEqual([]) // both silent
  })

  it('user-excluded wins over not-on-target (precedence: excluded checked first, silent)', () => {
    const r = filterFields({
      sourceFields: [df('X__c')],
      targetFields: [], // not on target...
      excludedFieldSet: ['X__c'] // ...but excluded first → silent
    })
    expect(r.droppedFieldNames).toEqual([])
  })
})

describe('filterFields — targetByName + PA detection', () => {
  it('builds the target-by-name lookup and detects IsPersonAccount on the source', () => {
    const r = filterFields({
      sourceFields: [df('LastName'), df('IsPersonAccount', { isCreateable: false })],
      targetFields: [df('LastName'), df('Industry')]
    })
    expect(Object.keys(r.targetByName).sort()).toEqual(['Industry', 'LastName'])
    expect(r.sourceHasIsPersonAccount).toBe(true)
  })

  it('sourceHasIsPersonAccount is false when the source lacks the field', () => {
    const r = filterFields({ sourceFields: [df('Name')], targetFields: [df('Name')] })
    expect(r.sourceHasIsPersonAccount).toBe(false)
  })
})

describe('filterFields — parity-boundary hardening (review)', () => {
  it('detects IsPersonAccount case-INSENSITIVELY (Apex ==)', () => {
    const r = filterFields({
      sourceFields: [df('ISPERSONACCOUNT', { isCreateable: false })],
      targetFields: []
    })
    expect(r.sourceHasIsPersonAccount).toBe(true)
  })

  it('keeps a case-variant of our ExtId field (foreign-ExtId compare is case-INSENSITIVE)', () => {
    const variant = EXTERNAL_ID_FIELD.toUpperCase() // same field, different case
    const r = filterFields({
      sourceFields: [df(variant)],
      targetFields: [df(variant, { isExternalId: true })]
    })
    expect(r.fields.map((f) => f.apiName)).toEqual([variant]) // NOT dropped as foreign
    expect(r.droppedFieldNames).toEqual([])
  })

  it('treats an Object.prototype-named field as "not on target" (null-proto lookup parity)', () => {
    // A plain-object lookup would resolve `targetByName['toString']` to the
    // inherited Function and misclassify the drop reason. SF names can't be
    // these, but the null-prototype map matches Apex Map.get for all keys.
    const r = filterFields({ sourceFields: [df('toString')], targetFields: [] })
    expect(r.droppedFieldNames).toEqual(['toString (not on target)'])
  })
})
