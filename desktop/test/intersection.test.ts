import { describe, it, expect } from 'vitest'
import { computeIntersection, namespaceOf } from '../src/main/intersection'
import type { ObjectInfo } from '../src/shared/types'

function obj(apiName: string, label = apiName, custom = false): ObjectInfo {
  return { apiName, label, custom, queryable: true, createable: true }
}

describe('namespaceOf', () => {
  it('extracts a managed-package namespace only for ≥3 __ segments', () => {
    expect(namespaceOf('SBQQ__Quote__c')).toBe('SBQQ')
    expect(namespaceOf('blng__Invoice__c')).toBe('blng')
    expect(namespaceOf('Quote__c')).toBeNull() // plain custom
    expect(namespaceOf('Account')).toBeNull() // standard
  })
})

describe('computeIntersection', () => {
  const source = [
    obj('Account'),
    obj('Contact'),
    obj('SBQQ__Quote__c'),
    obj('Legacy__c', 'Legacy', true)
  ]
  const target = [
    obj('Account'),
    obj('Contact'),
    obj('SBQQ__Quote__c'),
    obj('OnlyThere__c', 'OnlyThere', true)
  ]

  it('counts common / source-only / target-only', () => {
    const r = computeIntersection(source, target)
    expect(r.common).toBe(3) // Account, Contact, SBQQ__Quote__c
    expect(r.sourceOnly).toBe(1) // Legacy__c
    expect(r.targetOnly).toBe(1) // OnlyThere__c
  })

  it('produces a sorted union with presence flags + namespace', () => {
    const r = computeIntersection(source, target)
    expect(r.objects.map((o) => o.apiName)).toEqual([
      'Account',
      'Contact',
      'Legacy__c',
      'OnlyThere__c',
      'SBQQ__Quote__c'
    ])
    const legacy = r.objects.find((o) => o.apiName === 'Legacy__c')!
    expect(legacy).toMatchObject({ inSource: true, inTarget: false })
    const only = r.objects.find((o) => o.apiName === 'OnlyThere__c')!
    expect(only).toMatchObject({ inSource: false, inTarget: true })
    expect(r.objects.find((o) => o.apiName === 'SBQQ__Quote__c')!.namespace).toBe('SBQQ')
  })

  it('handles empty orgs', () => {
    expect(computeIntersection([], [])).toEqual({
      objects: [],
      common: 0,
      sourceOnly: 0,
      targetOnly: 0
    })
    const r = computeIntersection([obj('Account')], [])
    expect(r).toMatchObject({ common: 0, sourceOnly: 1, targetOnly: 0 })
  })
})
