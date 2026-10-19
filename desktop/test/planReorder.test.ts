import { describe, it, expect } from 'vitest'
import { slotRefillReorder } from '../src/main/engine/planReorder'

/**
 * Golden tests for the slot-refill invariant, ported from the Apex behavior of
 * `DataSeederController.applyDeploymentPlan` (the Session-16 fix) including the
 * regression case from
 * `DataSeederControllerTest.testApplyDeploymentPlan_PartialPlanKeepsOmittedObjectsInPlace`.
 */
describe('slotRefillReorder (5B.8)', () => {
  it('partial reorder keeps omitted objects in place (Apex regression golden)', () => {
    // Analysis order: Account, Contact, Opportunity, SBQQ__Quote__c.
    // The user (or a partial plan) names only Quote + Opportunity, reversed.
    const result = slotRefillReorder(
      ['Account', 'Contact', 'Opportunity', 'SBQQ__Quote__c'],
      ['SBQQ__Quote__c', 'Opportunity']
    )
    // Omitted parents stay ahead — NOT appended to the end.
    expect(result).toEqual(['Account', 'Contact', 'SBQQ__Quote__c', 'Opportunity'])
    expect(result.indexOf('Account')).toBeLessThan(result.indexOf('Opportunity'))
    expect(result.indexOf('Account')).toBeLessThan(result.indexOf('SBQQ__Quote__c'))
    expect(result.indexOf('Contact')).toBeLessThan(result.indexOf('Opportunity'))
  })

  it('the Session-16 Acme shape: a 4-object plan over a 10-object analysis keeps Account #1', () => {
    const analysis = [
      'Account',
      'Contact',
      'Opportunity',
      'SBQQ__Quote__c',
      'OpportunityContactRole',
      'SBQQ__QuoteTerm__c',
      'Contract',
      'OpportunityLineItem',
      'SBQQ__QuoteLine__c',
      'SBQQ__Subscription__c'
    ]
    // The old broken plan: Quote Terms first, then Opp/Quote/Contract.
    const plan = ['SBQQ__QuoteTerm__c', 'Opportunity', 'SBQQ__Quote__c', 'Contract']
    const result = slotRefillReorder(analysis, plan)
    expect(result[0]).toBe('Account') // never displaced
    expect(result[1]).toBe('Contact')
    // The four plan objects reshuffle ONLY the slots they already occupied (2,3,5,6).
    expect(result).toEqual([
      'Account',
      'Contact',
      'SBQQ__QuoteTerm__c',
      'Opportunity',
      'OpportunityContactRole',
      'SBQQ__Quote__c',
      'Contract',
      'OpportunityLineItem',
      'SBQQ__QuoteLine__c',
      'SBQQ__Subscription__c'
    ])
  })

  it('a junction omitted from the desired order never moves', () => {
    const result = slotRefillReorder(
      ['Account', 'OpportunityContactRole', 'Opportunity'],
      ['Opportunity', 'Account']
    )
    expect(result).toEqual(['Opportunity', 'OpportunityContactRole', 'Account'])
    expect(result[1]).toBe('OpportunityContactRole')
  })

  it('a full reorder is applied verbatim', () => {
    expect(slotRefillReorder(['A', 'B', 'C'], ['C', 'A', 'B'])).toEqual(['C', 'A', 'B'])
  })

  it('names not present in the plan are ignored (dropped, not inserted)', () => {
    expect(slotRefillReorder(['A', 'B', 'C'], ['C', 'Ghost', 'B'])).toEqual(['A', 'C', 'B'])
  })

  it('duplicate names in the desired order are de-duplicated (first occurrence wins)', () => {
    expect(slotRefillReorder(['A', 'B', 'C'], ['B', 'A', 'B'])).toEqual(['B', 'A', 'C'])
  })

  it('an empty desired order is a no-op', () => {
    expect(slotRefillReorder(['A', 'B', 'C'], [])).toEqual(['A', 'B', 'C'])
  })

  it('always returns a permutation of the current order (no loss, no duplication)', () => {
    const current = ['A', 'B', 'C', 'D', 'E']
    const cases = [['E', 'A'], ['B'], ['E', 'D', 'C', 'B', 'A'], ['C', 'Ghost'], []]
    for (const desired of cases) {
      const result = slotRefillReorder(current, desired)
      expect([...result].sort()).toEqual([...current].sort())
    }
  })

  it('does not mutate its inputs', () => {
    const current = ['A', 'B', 'C']
    const desired = ['C', 'A']
    slotRefillReorder(current, desired)
    expect(current).toEqual(['A', 'B', 'C'])
    expect(desired).toEqual(['C', 'A'])
  })
})
